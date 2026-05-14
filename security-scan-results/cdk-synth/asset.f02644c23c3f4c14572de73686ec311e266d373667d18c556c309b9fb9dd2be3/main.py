"""
Ingestion worker — polls SQS ingestion queue and processes each source.

Pipeline per message:
  1. Extract text (PDF → PyMuPDF → fallback Textract; URL → Trafilatura; text → direct)
  2. Clean extracted text
  3. Semantic chunk (~500 tokens, 50-token overlap)
  4. Embed each chunk via Bedrock Titan Text Embeddings v2
  5. Store chunks + embeddings in S3 Vectors (one index per notebook)
  6. Update source status to READY in DynamoDB
  7. Re-check if all notebook sources are READY → update notebook status
"""

import json
import logging
import os
import signal
import time
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

from extractors.pdf import extract_pdf
from extractors.url import extract_url
from extractors.text import extract_text
from chunker import semantic_chunk
from embedder import embed_chunks
from s3vectors import upsert_chunks, delete_chunks, purge_orphan_chunks

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

sqs = boto3.client("sqs")
dynamodb = boto3.resource("dynamodb")
sources_table = dynamodb.Table(os.environ["SOURCES_TABLE"])
notebooks_table = dynamodb.Table(os.environ["NOTEBOOKS_TABLE"])
jobs_table = dynamodb.Table(os.environ["JOBS_TABLE"])

SUMMARY_QUEUE_URL = os.environ.get("SUMMARY_QUEUE_URL", "")

QUEUE_URL = os.environ["INGESTION_QUEUE_URL"]
POLL_WAIT = 20  # seconds (SQS long-poll)

_running = True


def main():
    signal.signal(signal.SIGTERM, lambda *_: globals().update(_running=False))
    log.info("Ingestion worker started, polling %s", QUEUE_URL)

    while _running:
        messages = sqs.receive_message(
            QueueUrl=QUEUE_URL,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=POLL_WAIT,
            VisibilityTimeout=900,
        ).get("Messages", [])

        for msg in messages:
            receipt = msg["ReceiptHandle"]
            try:
                payload = json.loads(msg["Body"])
                if payload.get("type") == "delete_chunks":
                    _delete_chunks_handler(payload["sourceId"], payload.get("notebookId"))
                elif payload.get("type") == "purge_orphan_chunks":
                    _purge_orphan_chunks_handler(
                        payload["valid_source_ids"], payload["notebookId"]
                    )
                else:
                    process_source(payload)
                sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=receipt)
            except Exception as e:
                log.exception("Failed to process message: %s", e)
                # Let visibility timeout expire → SQS retries up to maxReceiveCount → DLQ


def _delete_chunks_handler(source_id: str, notebook_id: str = None):
    """Handle a delete_chunks SQS message by removing vectors from S3 Vectors."""
    delete_chunks(source_id, notebook_id)
    if notebook_id:
        _maybe_mark_notebook_ready(notebook_id)


def _purge_orphan_chunks_handler(valid_source_ids: list[str], notebook_id: str):
    """Handle a purge_orphan_chunks SQS message by removing stale vectors from S3 Vectors."""
    purge_orphan_chunks(valid_source_ids, notebook_id)


def process_source(payload: dict):
    source_id = payload["sourceId"]
    source_type = payload["type"]

    log.info("Processing source %s type=%s", source_id, source_type)
    _update_source_status(source_id, "PROCESSING")

    try:
        source_item = sources_table.get_item(Key={"sourceId": source_id}).get("Item")
        if not source_item:
            raise ValueError(f"Source {source_id} not found in DynamoDB")

        notebook_id = source_item["notebookId"]

        # Step 1: Extract
        if source_type == "pdf":
            text = extract_pdf(payload["s3Key"])
        elif source_type == "url":
            text = extract_url(payload["url"], payload["s3Key"])
        elif source_type == "text":
            text = extract_text(payload["s3Key"])
        else:
            raise ValueError(f"Unknown source type: {source_type}")

        if not text or not text.strip():
            raise ValueError("Extraction produced empty text")

        # Step 2: Chunk
        chunks = semantic_chunk(text)
        log.info("Produced %d chunks for source %s", len(chunks), source_id)

        # Step 3: Embed
        embedded_chunks = embed_chunks(chunks)

        # Step 4: Store in S3 Vectors (index = notebook_id, key = source_id#chunk_index)
        upsert_chunks(notebook_id, source_id, embedded_chunks)

        # Step 5: Mark source READY
        sources_table.update_item(
            Key={"sourceId": source_id},
            UpdateExpression="SET #s = :ready, chunkCount = :cc",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":ready": "READY", ":cc": len(chunks)},
        )

        _maybe_mark_notebook_ready(notebook_id)
        log.info("Source %s ingested successfully (%d chunks)", source_id, len(chunks))

    except Exception as e:
        log.error("Source %s ingestion failed: %s", source_id, e)
        _update_source_status(source_id, "ERROR", str(e))
        raise


def _update_source_status(source_id: str, status: str, error: str = None):
    expr = "SET #s = :s"
    vals = {":s": status}
    if error:
        expr += ", errorMessage = :e"
        vals[":e"] = error[:2000]
    sources_table.update_item(
        Key={"sourceId": source_id},
        UpdateExpression=expr,
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues=vals,
    )


def _maybe_mark_notebook_ready(notebook_id: str):
    sources = sources_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
    )["Items"]

    all_ready = all(s["status"] == "READY" for s in sources)
    any_error = any(s["status"] == "ERROR" for s in sources)

    if all_ready:
        # Only transition to READY (and auto-summary) if not already READY.
        # ConditionalCheckFailedException means it was already READY — skip auto-summary.
        try:
            notebooks_table.update_item(
                Key={"notebookId": notebook_id},
                UpdateExpression="SET #s = :ready",
                ConditionExpression="#s <> :ready",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":ready": "READY"},
            )
            _enqueue_auto_summary(notebook_id, sources[0]["userId"])
        except notebooks_table.meta.client.exceptions.ConditionalCheckFailedException:
            log.info("Notebook %s already READY — skipping auto-summary", notebook_id)
    elif any_error:
        notebooks_table.update_item(
            Key={"notebookId": notebook_id},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "PARTIAL_ERROR"},
        )


def _enqueue_auto_summary(notebook_id: str, user_id: str):
    if not SUMMARY_QUEUE_URL:
        return
    try:
        job_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        params = {"depth": "important_points"}
        jobs_table.put_item(Item={
            "jobId": job_id,
            "userId": user_id,
            "notebookId": notebook_id,
            "type": "summary",
            "status": "QUEUED",
            "params": params,
            "createdAt": now,
            "updatedAt": now,
        })
        sqs.send_message(
            QueueUrl=SUMMARY_QUEUE_URL,
            MessageBody=json.dumps({
                "jobId": job_id,
                "userId": user_id,
                "notebookId": notebook_id,
                "type": "summary",
                "params": params,
            }),
        )
        log.info("Auto-summary job %s queued for notebook %s", job_id, notebook_id)
    except Exception as e:
        log.warning("Failed to enqueue auto-summary for notebook %s: %s", notebook_id, e)


if __name__ == "__main__":
    main()
