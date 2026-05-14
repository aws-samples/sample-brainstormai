"""
Jobs Lambda — create and query artifact generation jobs.

Routes:
  GET    /notebooks/{notebookId}/jobs
  POST   /notebooks/{notebookId}/jobs
  GET    /notebooks/{notebookId}/jobs/{jobId}
  DELETE /notebooks/{notebookId}/jobs/{jobId}   (cancel if QUEUED)

Concurrency guard: each user may have at most 3 RUNNING jobs at once.
Enforced via atomic counter on brainstormai-user-job-counts DynamoDB table.
"""

import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr, Key

dynamodb = boto3.resource("dynamodb")
sqs_client = boto3.client("sqs")

notebooks_table = dynamodb.Table(os.environ["NOTEBOOKS_TABLE"])
sources_table = dynamodb.Table(os.environ["SOURCES_TABLE"])
jobs_table = dynamodb.Table(os.environ["JOBS_TABLE"])
user_job_counts_table = dynamodb.Table("brainstormai-user-job-counts")

QUEUE_URLS = {
    "podcast": os.environ["PODCAST_QUEUE_URL"],
    "mindmap": os.environ["MINDMAP_QUEUE_URL"],
    "quiz": os.environ["QUIZ_QUEUE_URL"],
    "summary": os.environ["SUMMARY_QUEUE_URL"],
}
MAX_CONCURRENT_JOBS = 3

# Estimated worst-case tokens per job per depth level.
# Used for a pre-flight budget check — actual usage is recorded by the worker.
ESTIMATED_TOKENS = {
    "brief":            40_000,
    "important_points": 60_000,
    "in_depth":         90_000,
}
DAILY_TOKEN_LIMIT = int(os.environ.get("DAILY_TOKEN_LIMIT", 1_000_000))

VALID_GENRES = {"debate", "educational", "sporty"}
VALID_DEPTHS = {"brief", "important_points", "in_depth"}
VALID_LANGUAGES = {"english", "hindi", "mandarin", "spanish", "french"}


def lambda_handler(event, context):
    method = event["httpMethod"]
    path = event["resource"]
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    notebook_id = event["pathParameters"]["notebookId"]

    _authorize_notebook(user_id, notebook_id)

    try:
        if path == "/notebooks/{notebookId}/jobs":
            if method == "GET":
                return list_jobs(notebook_id)
            if method == "POST":
                return create_job(user_id, notebook_id, json.loads(event["body"] or "{}"))

        if path == "/notebooks/{notebookId}/jobs/{jobId}":
            job_id = event["pathParameters"]["jobId"]
            if method == "GET":
                return get_job(user_id, job_id)
            if method == "DELETE":
                return cancel_job(user_id, job_id)

        return resp(404, {"error": "Not found"})
    except ValueError as e:
        return resp(400, {"error": str(e)})
    except PermissionError as e:
        return resp(403, {"error": str(e)})


def list_jobs(notebook_id: str):
    items = jobs_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
        ScanIndexForward=False,
    )["Items"]
    return resp(200, {"jobs": items})


def create_job(user_id: str, notebook_id: str, body: dict):
    job_type = (body.get("type") or "").lower()
    if job_type not in QUEUE_URLS:
        raise ValueError(f"type must be one of: {', '.join(QUEUE_URLS)}")

    params = body.get("params") or {}
    _validate_params(job_type, params)

    # Ensure notebook has ready sources; also capture updatedAt for cache key
    notebook = notebooks_table.get_item(Key={"notebookId": notebook_id}).get("Item", {})
    notebook_updated_at = notebook.get("updatedAt", "")

    sources = sources_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
    )["Items"]
    ready_sources = [s for s in sources if s["status"] == "READY"]
    if not ready_sources:
        raise ValueError("No ready sources in this notebook. Wait for ingestion to complete.")

    # Cache check: if an identical artifact exists for the current notebook state, reuse it
    cached = _find_cached_artifact(notebook_id, job_type, params, notebook_updated_at)
    if cached:
        job_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        job = {
            "jobId": job_id,
            "userId": user_id,
            "notebookId": notebook_id,
            "type": job_type,
            "status": "COMPLETED",
            "params": params,
            "artifactId": cached["artifactId"],
            "cached": True,
            "createdAt": now,
            "updatedAt": now,
        }
        jobs_table.put_item(Item=job)
        return resp(201, job)

    # Check daily token budget before accepting the job
    _check_token_budget(user_id, params.get("depth", "important_points"))

    # Enforce concurrency limit (atomic increment + conditional check)
    try:
        user_job_counts_table.update_item(
            Key={"userId": user_id},
            UpdateExpression="SET runningJobs = if_not_exists(runningJobs, :zero) + :one",
            ConditionExpression=Attr("runningJobs").lt(MAX_CONCURRENT_JOBS)
                               | Attr("runningJobs").not_exists(),
            ExpressionAttributeValues={":one": 1, ":zero": 0},
        )
    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        raise ValueError(
            f"You already have {MAX_CONCURRENT_JOBS} running jobs. "
            "Wait for one to complete before starting another."
        )

    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    job = {
        "jobId": job_id,
        "userId": user_id,
        "notebookId": notebook_id,
        "type": job_type,
        "status": "QUEUED",
        "params": params,
        "createdAt": now,
        "updatedAt": now,
    }
    jobs_table.put_item(Item=job)

    sqs_client.send_message(
        QueueUrl=QUEUE_URLS[job_type],
        MessageBody=json.dumps({"jobId": job_id, "userId": user_id,
                                "notebookId": notebook_id, "type": job_type, "params": params,
                                "notebookUpdatedAt": notebook_updated_at}),
    )
    return resp(201, job)


def get_job(user_id: str, job_id: str):
    item = _get_and_authorize(user_id, job_id)
    return resp(200, item)


def cancel_job(user_id: str, job_id: str):
    item = _get_and_authorize(user_id, job_id)
    if item["status"] != "QUEUED":
        raise ValueError("Only QUEUED jobs can be cancelled")

    jobs_table.update_item(
        Key={"jobId": job_id},
        UpdateExpression="SET #s = :cancelled, updatedAt = :u",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":cancelled": "CANCELLED",
            ":u": datetime.now(timezone.utc).isoformat(),
        },
    )
    _decrement_job_count(user_id)
    return resp(200, {"jobId": job_id, "status": "CANCELLED"})


def _find_cached_artifact(notebook_id: str, job_type: str, params: dict, notebook_updated_at: str) -> dict | None:
    """Return a matching artifact if one exists for this notebook state, else None."""
    if not notebook_updated_at:
        return None

    artifacts_table = dynamodb.Table(os.environ["ARTIFACTS_TABLE"])
    items = artifacts_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
        FilterExpression=Attr("type").eq(job_type) & Attr("notebookUpdatedAt").eq(notebook_updated_at),
    )["Items"]

    for item in items:
        if item.get("params") == params:
            return item
    return None


def _validate_params(job_type: str, params: dict):
    if job_type == "podcast":
        genre = (params.get("genre") or "").lower()
        depth = (params.get("depth") or "").lower()
        language = (params.get("language") or "english").lower()
        if genre not in VALID_GENRES:
            raise ValueError(f"genre must be one of: {', '.join(VALID_GENRES)}")
        if depth not in VALID_DEPTHS:
            raise ValueError(f"depth must be one of: {', '.join(VALID_DEPTHS)}")
        if language not in VALID_LANGUAGES:
            raise ValueError(f"language must be one of: {', '.join(VALID_LANGUAGES)}")
        params["genre"] = genre
        params["depth"] = depth
        params["language"] = language

    elif job_type in ("mindmap", "quiz", "summary"):
        depth = (params.get("depth") or "").lower()
        if depth not in VALID_DEPTHS:
            raise ValueError(f"depth must be one of: {', '.join(VALID_DEPTHS)}")
        params["depth"] = depth


def _check_token_budget(user_id: str, depth: str):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    record = user_job_counts_table.get_item(Key={"userId": user_id}).get("Item", {})

    # If the stored date is today, use the running total; otherwise the day has reset.
    if record.get("dailyTokensDate") == today:
        used = int(record.get("dailyTokens", 0))
    else:
        used = 0

    estimated = ESTIMATED_TOKENS.get(depth, 60_000)
    if used + estimated > DAILY_TOKEN_LIMIT:
        remaining = max(0, DAILY_TOKEN_LIMIT - used)
        raise ValueError(
            f"Daily token limit reached ({used:,} / {DAILY_TOKEN_LIMIT:,} tokens used today). "
            f"Estimated cost for this job: ~{estimated:,} tokens. "
            f"Remaining budget: {remaining:,} tokens. Limit resets at midnight UTC."
        )


def _get_and_authorize(user_id: str, job_id: str) -> dict:
    item = jobs_table.get_item(Key={"jobId": job_id}).get("Item")
    if not item:
        raise ValueError("Job not found")
    if item["userId"] != user_id:
        raise PermissionError("Access denied")
    return item


def _decrement_job_count(user_id: str):
    user_job_counts_table.update_item(
        Key={"userId": user_id},
        UpdateExpression="SET runningJobs = runningJobs - :one",
        ConditionExpression=Attr("runningJobs").gt(0),
        ExpressionAttributeValues={":one": 1},
    )


def _authorize_notebook(user_id: str, notebook_id: str):
    item = notebooks_table.get_item(Key={"notebookId": notebook_id}).get("Item")
    if not item:
        raise ValueError("Notebook not found")
    if item["userId"] != user_id:
        raise PermissionError("Access denied")


def resp(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(body, default=str),
    }
