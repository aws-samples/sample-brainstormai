"""
Generation worker — polls podcast/mindmap/quiz SQS queues and generates artifacts.

Each job:
  1. Mark job RUNNING, decrement user job counter on failure
  2. Retrieve top-k chunks from pgvector (RAG)
  3. Run Generation Agent → produce raw artifact
  4. Run Validation Agent → check coverage
  5. Retry generation up to 2 times if validation fails
  6. Post-process (TTS for podcast, JSON schema validation for mindmap/quiz)
  7. Write artifact to S3 + DynamoDB
  8. Mark job COMPLETED, push WebSocket notification
"""

import json
import logging
import os
import signal
import threading
import time
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr

from retriever import retrieve_chunks
from generators.podcast import generate_podcast
from generators.mindmap import generate_mindmap
from generators.quiz import generate_quiz
from generators.summary import generate_summary
from agents.validation_agent import validate_artifact
from metrics import emit_job_metrics

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

sqs = boto3.client("sqs")
dynamodb = boto3.resource("dynamodb")
jobs_table = dynamodb.Table(os.environ["JOBS_TABLE"])
artifacts_table = dynamodb.Table(os.environ["ARTIFACTS_TABLE"])
ws_connections_table = dynamodb.Table(os.environ["WS_CONNECTIONS_TABLE"])
user_job_counts_table = dynamodb.Table("brainstormai-user-job-counts")

QUEUE_URLS = {
    "podcast": os.environ["PODCAST_QUEUE_URL"],
    "mindmap": os.environ["MINDMAP_QUEUE_URL"],
    "quiz": os.environ["QUIZ_QUEUE_URL"],
    "summary": os.environ["SUMMARY_QUEUE_URL"],
}

WS_ENDPOINT = os.environ.get("WS_ENDPOINT", "")
MAX_RETRIES = 2

# ~40K tokens/job × 3 concurrent jobs × 10 jobs/day = 1.2M/day hard ceiling.
# Set conservatively at 500K total tokens/day per user (~12-15 podcasts).
DAILY_TOKEN_LIMIT = int(os.environ.get("DAILY_TOKEN_LIMIT", 3_000_000))

_running = True


def main():
    signal.signal(signal.SIGTERM, lambda *_: globals().update(_running=False))
    log.info("Generation worker started")

    # Poll all queues in round-robin using threads
    threads = [
        threading.Thread(target=poll_queue, args=(queue_type, url), daemon=True)
        for queue_type, url in QUEUE_URLS.items()
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def poll_queue(queue_type: str, queue_url: str):
    log.info("Polling %s queue: %s", queue_type, queue_url)
    while _running:
        messages = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=20,
            VisibilityTimeout=900,
        ).get("Messages", [])

        for msg in messages:
            receipt = msg["ReceiptHandle"]
            try:
                payload = json.loads(msg["Body"])
                process_job(payload)
            except Exception as e:
                log.exception("Job processing failed: %s", e)
            finally:
                # Always delete — job outcome is already written to DynamoDB.
                # Leaving the message in SQS would cause spurious retries of FAILED jobs.
                sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt)


def process_job(payload: dict):
    job_id = payload["jobId"]
    user_id = payload["userId"]
    notebook_id = payload["notebookId"]
    job_type = payload["type"]
    params = payload.get("params", {})

    log.info("Processing job %s type=%s", job_id, job_type)

    job = jobs_table.get_item(Key={"jobId": job_id}).get("Item")
    if not job or job["status"] in ("CANCELLED", "FAILED", "COMPLETED"):
        log.info("Job %s is %s, skipping", job_id, job.get("status") if job else "missing")
        return

    _update_job_status(job_id, "RUNNING")
    start_time = time.monotonic()

    try:
        depth = params.get("depth", "important_points")
        if job_type == "summary":
            k_map = {"brief": 40, "important_points": 80, "in_depth": 120}
        else:
            k_map = {"brief": 20, "important_points": 40, "in_depth": 60}
        top_k = k_map.get(depth, k_map["important_points"])

        chunks = retrieve_chunks(notebook_id, _query_hint(job_type, params), top_k)

        if job_type == "podcast":
            artifact_data = _run_with_validation(generate_podcast, chunks, params, job_id)
        elif job_type == "mindmap":
            artifact_data = _run_with_validation(generate_mindmap, chunks, params, job_id)
        elif job_type == "quiz":
            artifact_data = _run_with_validation(generate_quiz, chunks, params, job_id)
        elif job_type == "summary":
            artifact_data = generate_summary(chunks, params)
        else:
            raise ValueError(f"Unknown job type: {job_type}")

        total_input = artifact_data.get("total_input_tokens", 0)
        total_output = artifact_data.get("total_output_tokens", 0)
        duration = time.monotonic() - start_time

        # Persist token usage on the job record for auditability
        jobs_table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #s = :s, artifactId = :a, inputTokens = :it, outputTokens = :ot REMOVE errorMessage",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":s": "COMPLETED",
                ":a": artifact_data["artifactId"],
                ":it": total_input,
                ":ot": total_output,
            },
        )

        artifacts_table.put_item(Item={
            "artifactId": artifact_data["artifactId"],
            "jobId": job_id,
            "notebookId": notebook_id,
            "type": job_type,
            "params": params,
            "s3Key": artifact_data["s3Key"],
            "coverageScore": artifact_data.get("coverageScore", 100),
            "coverageWarning": artifact_data.get("coverageWarning", False),
            "createdAt": artifact_data["createdAt"],
        })

        # Accumulate daily token usage for this user (resets by date key)
        _record_token_usage(user_id, total_input + total_output)

        emit_job_metrics(
            user_id=user_id,
            job_type=job_type,
            depth=depth,
            input_tokens=total_input,
            output_tokens=total_output,
            duration_seconds=duration,
            validation_retries=artifact_data.get("validation_retries", 0),
            coverage_score=artifact_data.get("coverageScore", 100),
            success=True,
        )

        _decrement_job_count(user_id)
        try:
            _notify_user(user_id, {
                "type": "job_complete",
                "jobId": job_id,
                "artifactId": artifact_data["artifactId"],
            })
        except Exception:
            log.warning("Failed to notify user %s of job completion", user_id)
        log.info("Job %s completed in %.1fs, tokens: %d in / %d out",
                 job_id, duration, total_input, total_output)

    except Exception as e:
        duration = time.monotonic() - start_time
        log.exception("Job %s failed: %s", job_id, e)
        jobs_table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #s = :s, errorMessage = :e",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "FAILED", ":e": str(e)[:2000]},
        )
        emit_job_metrics(
            user_id=user_id,
            job_type=job_type,
            depth=params.get("depth", "important_points"),
            input_tokens=0,
            output_tokens=0,
            duration_seconds=duration,
            validation_retries=0,
            coverage_score=0,
            success=False,
        )
        _decrement_job_count(user_id)
        try:
            _notify_user(user_id, {"type": "job_failed", "jobId": job_id, "error": str(e)})
        except Exception:
            log.warning("Failed to notify user %s of job failure", user_id)
        raise


def _run_with_validation(generator_fn, chunks: list[dict], params: dict, job_id: str) -> dict:
    depth = params.get("depth", "important_points")
    missing: list[str] = []
    total_input = 0
    total_output = 0

    for attempt in range(MAX_RETRIES + 1):
        result = generator_fn(chunks, params, missing_points=missing)
        total_input += result.get("input_tokens", 0)
        total_output += result.get("output_tokens", 0)

        validation = validate_artifact(result["script_text"], chunks, depth)
        total_input += validation.get("input_tokens", 0)
        total_output += validation.get("output_tokens", 0)

        result["coverageScore"] = validation["coverage_score"]
        result["coverageWarning"] = False
        result["total_input_tokens"] = total_input
        result["total_output_tokens"] = total_output
        result["validation_retries"] = attempt

        if validation["passed"]:
            return result

        missing = validation["missing"]
        log.info("Validation failed on attempt %d, missing: %s", attempt + 1, missing)

        if attempt == MAX_RETRIES:
            log.warning("Max retries reached for job %s — delivering with coverage warning", job_id)
            result["coverageWarning"] = True
            return result

    return result


def _query_hint(job_type: str, params: dict) -> str:
    if job_type == "podcast":
        return f"Generate a {params.get('genre', 'educational')} podcast about the main topics"
    if job_type == "mindmap":
        return "Key concepts, themes, and relationships in the content"
    if job_type == "quiz":
        return "Important facts, definitions, and concepts that can be tested"
    if job_type == "summary":
        return "Main topics, key facts, and important highlights in the content"
    return "Main topics and key information"


def _update_job_status(job_id: str, status: str):
    jobs_table.update_item(
        Key={"jobId": job_id},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": status},
    )


def _record_token_usage(user_id: str, tokens: int):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        # If the stored date differs from today, reset the counter for the new day.
        # Two-step: try to increment assuming date matches, fall back to reset.
        user_job_counts_table.update_item(
            Key={"userId": user_id},
            UpdateExpression=(
                "SET dailyTokens = if_not_exists(dailyTokens, :zero) + :t, "
                "dailyTokensDate = :d"
            ),
            ConditionExpression=(
                Attr("dailyTokensDate").eq(today) | Attr("dailyTokensDate").not_exists()
            ),
            ExpressionAttributeValues={":t": tokens, ":zero": 0, ":d": today},
        )
    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        # Date rolled over — reset counter for new day
        user_job_counts_table.update_item(
            Key={"userId": user_id},
            UpdateExpression="SET dailyTokens = :t, dailyTokensDate = :d",
            ExpressionAttributeValues={":t": tokens, ":d": today},
        )
    except Exception as e:
        log.warning("Failed to record token usage for %s: %s", user_id, e)


def _decrement_job_count(user_id: str):
    try:
        user_job_counts_table.update_item(
            Key={"userId": user_id},
            UpdateExpression="SET runningJobs = runningJobs - :one",
            ConditionExpression=boto3.dynamodb.conditions.Attr("runningJobs").gt(0),
            ExpressionAttributeValues={":one": 1},
        )
    except Exception:
        pass  # non-critical — counter is already 0 or missing


def _notify_user(user_id: str, payload: dict):
    if not WS_ENDPOINT:
        return
    connections = ws_connections_table.scan(
        FilterExpression=boto3.dynamodb.conditions.Attr("userId").eq(user_id)
    ).get("Items", [])

    if not connections:
        return

    apigw = boto3.client("apigatewaymanagementapi", endpoint_url=WS_ENDPOINT)
    for conn in connections:
        try:
            apigw.post_to_connection(
                ConnectionId=conn["connectionId"],
                Data=json.dumps(payload).encode("utf-8"),
            )
        except Exception:
            pass


if __name__ == "__main__":
    main()
