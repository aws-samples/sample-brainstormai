"""
Embed text chunks using Amazon Bedrock Titan Text Embeddings v2.

Titan v2 produces 1024-dimensional vectors and supports up to 8192 tokens.
We embed in batches of 20 to avoid request throttling.
"""

import json
import logging
import os
import time

import boto3

log = logging.getLogger(__name__)
bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))

MODEL_ID = "amazon.titan-embed-text-v2:0"
EMBEDDING_DIM = 1024
BATCH_SIZE = 20
RETRY_DELAY = 2


def embed_chunks(chunks: list[str]) -> list[dict]:
    """Return list of {text, embedding, token_count} dicts."""
    results = []
    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i : i + BATCH_SIZE]
        for chunk in batch:
            embedding, token_count = _embed_one(chunk)
            results.append({"text": chunk, "embedding": embedding, "token_count": token_count})
        if i + BATCH_SIZE < len(chunks):
            time.sleep(0.1)  # brief pause to respect Bedrock TPS limits
    return results


def _embed_one(text: str, retries: int = 3) -> tuple[list[float], int]:
    for attempt in range(retries):
        try:
            response = bedrock.invoke_model(
                modelId=MODEL_ID,
                body=json.dumps({"inputText": text}),
                contentType="application/json",
                accept="application/json",
            )
            body = json.loads(response["body"].read())
            return body["embedding"], body.get("inputTextTokenCount", 0)
        except Exception as e:
            if attempt == retries - 1:
                raise
            log.warning("Embedding attempt %d failed: %s — retrying", attempt + 1, e)
            time.sleep(RETRY_DELAY * (attempt + 1))
