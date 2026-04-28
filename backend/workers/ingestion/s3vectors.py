"""
S3 Vectors storage for notebook chunk embeddings.

Replaces the pgvector/RDS backend. Each notebook gets its own S3 Vectors
index (index_name == notebook_id). Vector keys are formatted as:

    "{source_id}#{chunk_index}"

so that all chunks belonging to a source share a common key prefix, making
filtering and bulk-deletion straightforward.

Environment variables required:
    S3_VECTORS_BUCKET  — name of the S3 Vectors bucket (e.g. "brainstormai-vectors")
    AWS_REGION         — AWS region (default: "us-east-1")
"""

import logging
import os

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger(__name__)

S3V_BUCKET = os.environ["S3_VECTORS_BUCKET"]

# Titan Text Embeddings v2 produces 1024-dimensional vectors.
VECTOR_DIMENSION = 1024

# S3 Vectors API limits.
PUT_BATCH_SIZE = 500
DELETE_BATCH_SIZE = 500

client = boto3.client("s3vectors", region_name=os.environ.get("AWS_REGION", "us-east-1"))


# ---------------------------------------------------------------------------
# Index lifecycle helpers
# ---------------------------------------------------------------------------

def _create_index_if_not_exists(notebook_id: str) -> None:
    """Create the S3 Vectors index for *notebook_id* if it does not yet exist.

    Uses cosine distance to match the pgvector cosine similarity semantics.
    Swallows the "already exists" error so callers can use this as a
    create-or-ignore guard.
    """
    try:
        client.create_index(
            vectorBucketName=S3V_BUCKET,
            indexName=notebook_id,
            dataType="float32",
            dimension=VECTOR_DIMENSION,
            distanceMetric="cosine",
        )
        log.info("Created S3 Vectors index for notebook %s", notebook_id)
    except ClientError as exc:
        error_code = exc.response["Error"]["Code"]
        # Index already exists — nothing to do.
        if error_code in ("IndexAlreadyExistsException", "ConflictException"):
            log.debug("S3 Vectors index for notebook %s already exists", notebook_id)
        else:
            raise


# ---------------------------------------------------------------------------
# Public API (mirrors the old db.py surface)
# ---------------------------------------------------------------------------

def upsert_chunks(notebook_id: str, source_id: str, embedded_chunks: list[dict]) -> None:
    """Store *embedded_chunks* in the notebook's S3 Vectors index.

    Deletes any existing vectors for *source_id* first (re-ingestion support),
    then writes all chunks in batches of up to 500 (S3 Vectors limit).

    Args:
        notebook_id:     The notebook UUID — used as the index name.
        source_id:       The source UUID — used as key prefix.
        embedded_chunks: List of dicts with keys: "text", "embedding",
                         "token_count" (as produced by embedder.embed_chunks).
    """
    # Ensure the index exists before writing vectors.
    _create_index_if_not_exists(notebook_id)

    # Remove stale vectors for this source so re-ingestion is idempotent.
    delete_chunks(source_id, notebook_id)

    # Build the full vector list.
    vectors = []
    for i, chunk in enumerate(embedded_chunks):
        key = f"{source_id}#{i}"
        vectors.append({
            "key": key,
            "data": {"float32": chunk["embedding"]},
            "metadata": {
                "source_id": source_id,
                "chunk_index": i,
                "text": chunk["text"],
                "token_count": chunk.get("token_count", 0),
            },
        })

    # Write in batches of PUT_BATCH_SIZE.
    for batch_start in range(0, len(vectors), PUT_BATCH_SIZE):
        batch = vectors[batch_start : batch_start + PUT_BATCH_SIZE]
        client.put_vectors(
            vectorBucketName=S3V_BUCKET,
            indexName=notebook_id,
            vectors=batch,
        )
        log.debug(
            "PutVectors: wrote %d vectors (offset %d) for source %s",
            len(batch),
            batch_start,
            source_id,
        )

    log.info(
        "Stored %d chunks for source %s in S3 Vectors (notebook %s)",
        len(embedded_chunks),
        source_id,
        notebook_id,
    )


def delete_chunks(source_id: str, notebook_id: str) -> None:
    """Delete all vectors belonging to *source_id* from the notebook index.

    Lists all vectors in the index and removes those whose key starts with
    "{source_id}#".  Operates in batches of up to 500.

    If the index does not exist yet this is a no-op (nothing to delete).
    """
    prefix = f"{source_id}#"
    keys_to_delete = _list_keys_with_prefix(notebook_id, prefix)

    if not keys_to_delete:
        log.debug("No vectors to delete for source %s (notebook %s)", source_id, notebook_id)
        return

    _delete_keys_in_batches(notebook_id, keys_to_delete)
    log.info(
        "Deleted %d vectors for source %s (notebook %s)",
        len(keys_to_delete),
        source_id,
        notebook_id,
    )


def purge_orphan_chunks(valid_source_ids: list[str], notebook_id: str) -> None:
    """Delete all vectors whose source_id is not in *valid_source_ids*.

    Useful for cleaning up after sources are removed outside of the normal
    delete flow.  Operates on the notebook index identified by *notebook_id*.

    If the index does not exist this is a no-op.
    """
    valid_set = set(valid_source_ids)
    all_keys = _list_keys_with_prefix(notebook_id, prefix=None)

    orphan_keys = [
        key for key in all_keys
        if _source_id_from_key(key) not in valid_set
    ]

    if not orphan_keys:
        log.debug("No orphan vectors found in notebook %s", notebook_id)
        return

    _delete_keys_in_batches(notebook_id, orphan_keys)
    log.info(
        "Purged %d orphan vectors from notebook %s",
        len(orphan_keys),
        notebook_id,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _source_id_from_key(key: str) -> str:
    """Extract source_id from a vector key formatted as "{source_id}#{chunk_index}"."""
    return key.split("#", 1)[0]


def _list_keys_with_prefix(notebook_id: str, prefix: str | None) -> list[str]:
    """Return all vector keys in *notebook_id*'s index, optionally filtered by *prefix*.

    Pages through ListVectors results automatically.  Returns an empty list if
    the index does not exist.
    """
    keys: list[str] = []
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
                # Index doesn't exist — nothing to list.
                return []
            raise

        for vector in response.get("vectors", []):
            key = vector["key"]
            if prefix is None or key.startswith(prefix):
                keys.append(key)

        next_token = response.get("nextToken")
        if not next_token:
            break

    return keys


def _delete_keys_in_batches(notebook_id: str, keys: list[str]) -> None:
    """Delete *keys* from the notebook index in batches of DELETE_BATCH_SIZE."""
    for batch_start in range(0, len(keys), DELETE_BATCH_SIZE):
        batch = keys[batch_start : batch_start + DELETE_BATCH_SIZE]
        client.delete_vectors(
            vectorBucketName=S3V_BUCKET,
            indexName=notebook_id,
            keys=batch,
        )
        log.debug(
            "DeleteVectors: removed %d vectors (offset %d) from notebook %s",
            len(batch),
            batch_start,
            notebook_id,
        )
