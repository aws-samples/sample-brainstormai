"""
RAG retrieval from S3 Vectors.

Embeds the query hint using Bedrock Titan Text Embeddings v2, then queries
the notebook's S3 Vectors index for the most similar chunks.

Each notebook has a dedicated index (index_name == notebook_id).  Vector keys
are formatted as "{source_id}#{chunk_index}" and text is stored in vector
metadata.

The same per-source spread logic as the previous pgvector retriever is
preserved so no single source dominates the retrieved context.

Environment variables required:
    S3_VECTORS_BUCKET  — name of the S3 Vectors bucket (e.g. "brainstormai-vectors")
    AWS_REGION         — AWS region (default: "us-east-1")
"""

import json
import logging
import os
import time

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger(__name__)

bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))
MODEL_ID = "amazon.titan-embed-text-v2:0"

S3V_BUCKET = os.environ["S3_VECTORS_BUCKET"]

client = boto3.client("s3vectors", region_name=os.environ.get("AWS_REGION", "us-east-1"))

# S3 Vectors returns at most 100 results per QueryVectors call.
MAX_QUERY_TOP_K = 100


def retrieve_chunks(notebook_id: str, query: str, top_k: int) -> list[dict]:
    """Return up to *top_k* chunks most relevant to *query* from *notebook_id*.

    Implements the same per-source spread as the original pgvector retriever:
    chunks are distributed evenly across sources so no single source can
    monopolise the retrieved context window.

    Returns an empty list if the notebook index does not exist yet.

    Each returned dict contains:
        chunk_id    — the S3 Vectors key (source_id#chunk_index)
        text        — chunk text (from metadata)
        chunk_index — integer position within the source
        token_count — token count (from metadata)
        similarity  — cosine similarity score (1 - cosine_distance)
    """
    embedding = _embed_query(query)

    # --- Discover distinct source_ids in this notebook index ---
    source_ids = _list_source_ids(notebook_id)
    if not source_ids:
        return []

    # --- Distribute top_k budget evenly across sources ---
    # Each source gets at least floor(top_k / n_sources) slots; the remainder
    # is distributed one extra slot to the first sources (same as original).
    n = len(source_ids)
    per_source = max(1, top_k // n)
    remainder = top_k - per_source * n

    all_results: list[dict] = []

    for i, source_id in enumerate(source_ids):
        limit = per_source + (1 if i < remainder else 0)
        # S3 Vectors caps top_k at MAX_QUERY_TOP_K.
        capped_limit = min(limit, MAX_QUERY_TOP_K)

        chunks = _query_source(notebook_id, embedding, source_id, capped_limit)
        all_results.extend(chunks)

    # Sort combined results by similarity descending so generators see best chunks first.
    all_results.sort(key=lambda r: r["similarity"], reverse=True)

    return all_results[:top_k]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _list_source_ids(notebook_id: str) -> list[str]:
    """Return the distinct source_ids present in the notebook's S3 Vectors index.

    Pages through ListVectors to collect all keys, then extracts the source_id
    portion (everything before the first "#" in the key).  Returns an empty
    list if the index does not exist.
    """
    source_ids: set[str] = set()
    next_token: str | None = None

    while True:
        kwargs: dict = {
            "vectorBucketName": S3V_BUCKET,
            "indexName": notebook_id,
        }
        if next_token:
            kwargs["nextToken"] = next_token

        try:
            response = client.list_vectors(**kwargs)
        except ClientError as exc:
            error_code = exc.response["Error"]["Code"]
            if error_code in ("NoSuchIndex", "ResourceNotFoundException"):
                # No index yet — notebook has no ingested sources.
                return []
            raise

        for vector in response.get("vectors", []):
            key: str = vector["key"]
            source_id = key.split("#", 1)[0]
            source_ids.add(source_id)

        next_token = response.get("nextToken")
        if not next_token:
            break

    return list(source_ids)


def _query_source(
    notebook_id: str,
    embedding: list[float],
    source_id: str,
    top_k: int,
) -> list[dict]:
    """Query the notebook index for *top_k* chunks closest to *embedding*.

    Filters results client-side to those belonging to *source_id* (identified
    by the key prefix).  S3 Vectors does not support key-prefix filters on
    QueryVectors, so we over-fetch (up to MAX_QUERY_TOP_K) and filter after.

    Returns a list of dicts matching the retrieve_chunks output format.
    """
    # Over-fetch to compensate for filtering: request the full quota so that
    # after filtering by source_id we still have enough candidates.
    fetch_k = min(MAX_QUERY_TOP_K, top_k * max(1, 4))  # generous over-fetch

    try:
        response = client.query_vectors(
            vectorBucketName=S3V_BUCKET,
            indexName=notebook_id,
            queryVector={"float32": embedding},
            topK=fetch_k,
            returnMetadata=True,
            returnDistance=True,
        )
    except ClientError as exc:
        error_code = exc.response["Error"]["Code"]
        if error_code in ("NoSuchIndex", "ResourceNotFoundException"):
            return []
        raise

    results: list[dict] = []
    prefix = f"{source_id}#"

    for item in response.get("vectors", []):
        key: str = item["key"]
        if not key.startswith(prefix):
            # Belongs to a different source — skip.
            continue

        metadata: dict = item.get("metadata") or {}
        # Cosine distance → cosine similarity: similarity = 1 - distance
        distance: float = item.get("distance", 0.0)
        similarity: float = 1.0 - distance

        results.append({
            "chunk_id": key,
            "text": metadata.get("text", ""),
            "chunk_index": metadata.get("chunk_index", 0),
            "token_count": metadata.get("token_count", 0),
            "similarity": similarity,
        })

        if len(results) >= top_k:
            break

    return results


def _embed_query(text: str) -> list[float]:
    """Embed *text* using Bedrock Titan Text Embeddings v2 with exponential back-off."""
    for attempt in range(4):
        try:
            response = bedrock.invoke_model(
                modelId=MODEL_ID,
                body=json.dumps({"inputText": text}),
                contentType="application/json",
                accept="application/json",
            )
            return json.loads(response["body"].read())["embedding"]
        except bedrock.exceptions.ThrottlingException:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)  # 1s, 2s, 4s back-off
