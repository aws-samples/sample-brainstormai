"""
Sources Lambda — manage sources within a notebook.

Routes:
  GET    /notebooks/{notebookId}/sources
  POST   /notebooks/{notebookId}/sources/upload-url   → presigned S3 PUT URL for PDF
  POST   /notebooks/{notebookId}/sources/url           → submit a URL source
  POST   /notebooks/{notebookId}/sources/text          → submit plain text
  DELETE /notebooks/{notebookId}/sources/{sourceId}
"""

import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")
s3_client = boto3.client("s3")
sqs_client = boto3.client("sqs")

notebooks_table = dynamodb.Table(os.environ["NOTEBOOKS_TABLE"])
sources_table = dynamodb.Table(os.environ["SOURCES_TABLE"])
S3_BUCKET = os.environ["S3_BUCKET"]
INGESTION_QUEUE_URL = os.environ["INGESTION_QUEUE_URL"]

MAX_SOURCES_PER_NOTEBOOK = 10
MAX_PDF_BYTES = 5 * 1024 * 1024  # 5 MB


def lambda_handler(event, context):
    method = event["httpMethod"]
    path = event["resource"]
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    notebook_id = event["pathParameters"]["notebookId"]

    _authorize_notebook(user_id, notebook_id)

    try:
        if path == "/notebooks/{notebookId}/sources":
            if method == "GET":
                return list_sources(notebook_id)

        if path == "/notebooks/{notebookId}/sources/upload-url":
            if method == "POST":
                return get_upload_url(user_id, notebook_id, json.loads(event["body"] or "{}"))

        if path == "/notebooks/{notebookId}/sources/url":
            if method == "POST":
                return add_url_source(user_id, notebook_id, json.loads(event["body"] or "{}"))

        if path == "/notebooks/{notebookId}/sources/text":
            if method == "POST":
                return add_text_source(user_id, notebook_id, json.loads(event["body"] or "{}"))

        if path == "/notebooks/{notebookId}/sources/{sourceId}/ingest":
            source_id = event["pathParameters"]["sourceId"]
            if method == "POST":
                return trigger_ingest(user_id, notebook_id, source_id)

        if path == "/notebooks/{notebookId}/sources/{sourceId}":
            source_id = event["pathParameters"]["sourceId"]
            if method == "DELETE":
                return delete_source(user_id, notebook_id, source_id)

        return resp(404, {"error": "Not found"})
    except ValueError as e:
        return resp(400, {"error": str(e)})
    except PermissionError as e:
        return resp(403, {"error": str(e)})


def list_sources(notebook_id: str):
    items = sources_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
    )["Items"]
    return resp(200, {"sources": items})


def get_upload_url(user_id: str, notebook_id: str, body: dict):
    filename = (body.get("filename") or "").strip()
    size = int(body.get("size") or 0)

    if not filename.lower().endswith(".pdf"):
        raise ValueError("Only PDF files are accepted")
    if size > MAX_PDF_BYTES:
        raise ValueError(f"File size exceeds 5 MB limit")

    _check_source_limit(notebook_id)

    source_id = str(uuid.uuid4())
    s3_key = f"sources/{user_id}/{notebook_id}/{source_id}/raw.pdf"

    presigned_url = s3_client.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": S3_BUCKET,
            "Key": s3_key,
            "ContentType": "application/pdf",
        },
        ExpiresIn=900,  # 15 minutes
    )

    now = datetime.now(timezone.utc).isoformat()
    source = {
        "sourceId": source_id,
        "notebookId": notebook_id,
        "userId": user_id,
        "type": "pdf",
        "filename": filename,
        "s3Key": s3_key,
        "status": "PENDING",
        "chunkCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }
    sources_table.put_item(Item=source)
    _increment_source_count(notebook_id)

    # Do NOT enqueue here — the file doesn't exist in S3 yet.
    # The frontend calls POST /sources/{sourceId}/ingest after the S3 PUT completes.
    return resp(201, {"sourceId": source_id, "uploadUrl": presigned_url, "s3Key": s3_key})


def add_url_source(user_id: str, notebook_id: str, body: dict):
    url = (body.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        raise ValueError("Invalid URL")
    if "youtube.com" in url or "youtu.be" in url:
        raise ValueError("YouTube URLs are not supported in this version")

    _check_source_limit(notebook_id)

    source_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    source = {
        "sourceId": source_id,
        "notebookId": notebook_id,
        "userId": user_id,
        "type": "url",
        "url": url,
        "s3Key": f"sources/{user_id}/{notebook_id}/{source_id}/extracted.txt",
        "status": "PENDING",
        "chunkCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }
    sources_table.put_item(Item=source)
    _increment_source_count(notebook_id)

    sqs_client.send_message(
        QueueUrl=INGESTION_QUEUE_URL,
        MessageBody=json.dumps({"sourceId": source_id, "type": "url", "url": url,
                                "notebookId": notebook_id, "userId": user_id}),
    )
    return resp(201, {"sourceId": source_id})


def add_text_source(user_id: str, notebook_id: str, body: dict):
    content = (body.get("content") or "").strip()
    title = (body.get("title") or "Untitled note").strip()
    if not content:
        raise ValueError("content is required")
    if len(content) > 500_000:
        raise ValueError("Text exceeds 500,000 character limit")

    _check_source_limit(notebook_id)

    source_id = str(uuid.uuid4())
    s3_key = f"sources/{user_id}/{notebook_id}/{source_id}/extracted.txt"

    # Store raw text in S3
    s3_client.put_object(Bucket=S3_BUCKET, Key=s3_key, Body=content.encode("utf-8"),
                         ContentType="text/plain")

    now = datetime.now(timezone.utc).isoformat()
    source = {
        "sourceId": source_id,
        "notebookId": notebook_id,
        "userId": user_id,
        "type": "text",
        "title": title,
        "s3Key": s3_key,
        "status": "PENDING",
        "chunkCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }
    sources_table.put_item(Item=source)
    _increment_source_count(notebook_id)

    sqs_client.send_message(
        QueueUrl=INGESTION_QUEUE_URL,
        MessageBody=json.dumps({"sourceId": source_id, "type": "text", "s3Key": s3_key,
                                "notebookId": notebook_id, "userId": user_id}),
    )
    return resp(201, {"sourceId": source_id})


def trigger_ingest(user_id: str, notebook_id: str, source_id: str):
    item = sources_table.get_item(Key={"sourceId": source_id}).get("Item")
    if not item or item["notebookId"] != notebook_id:
        raise ValueError("Source not found")
    if item["userId"] != user_id:
        raise PermissionError("Access denied")
    if item["status"] != "PENDING":
        raise ValueError("Source is not in PENDING state")

    sqs_client.send_message(
        QueueUrl=INGESTION_QUEUE_URL,
        MessageBody=json.dumps({
            "sourceId": source_id,
            "type": item["type"],
            "s3Key": item["s3Key"],
            "url": item.get("url", ""),
            "notebookId": notebook_id,
            "userId": user_id,
        }),
    )
    return resp(200, {"sourceId": source_id, "status": "QUEUED"})


def delete_source(user_id: str, notebook_id: str, source_id: str):
    item = sources_table.get_item(Key={"sourceId": source_id}).get("Item")
    if not item or item["notebookId"] != notebook_id:
        raise ValueError("Source not found")
    if item["userId"] != user_id:
        raise PermissionError("Access denied")

    sources_table.delete_item(Key={"sourceId": source_id})
    notebooks_table.update_item(
        Key={"notebookId": notebook_id},
        UpdateExpression="SET sourceCount = sourceCount - :one, updatedAt = :u",
        ConditionExpression="sourceCount > :zero",
        ExpressionAttributeValues={":one": 1, ":zero": 0,
                                   ":u": datetime.now(timezone.utc).isoformat()},
    )
    return resp(204, {})


def _authorize_notebook(user_id: str, notebook_id: str):
    item = notebooks_table.get_item(Key={"notebookId": notebook_id}).get("Item")
    if not item:
        raise ValueError("Notebook not found")
    if item["userId"] != user_id:
        raise PermissionError("Access denied")


def _check_source_limit(notebook_id: str):
    count = sources_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
        Select="COUNT",
    )["Count"]
    if count >= MAX_SOURCES_PER_NOTEBOOK:
        raise ValueError(f"Maximum of {MAX_SOURCES_PER_NOTEBOOK} sources per notebook")


def _increment_source_count(notebook_id: str):
    notebooks_table.update_item(
        Key={"notebookId": notebook_id},
        UpdateExpression="SET sourceCount = sourceCount + :one, updatedAt = :u, #s = :ingesting",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":one": 1,
            ":u": datetime.now(timezone.utc).isoformat(),
            ":ingesting": "INGESTING",
        },
    )


def resp(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(body, default=str),
    }
