"""
RAG retrieval from pgvector.

Embeds the query hint using Bedrock Titan, then runs a cosine similarity
search against the notebook's chunks and returns the top-k results.
"""

import json
import logging
import os
import time

import boto3
import psycopg2
from psycopg2 import pool
from pgvector.psycopg2 import register_vector

log = logging.getLogger(__name__)
bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))
MODEL_ID = "amazon.titan-embed-text-v2:0"

# Resolved once at worker startup — one Secrets Manager call per task lifetime.
_db_pool: pool.ThreadedConnectionPool | None = None


def _get_pool() -> pool.ThreadedConnectionPool:
    global _db_pool
    if _db_pool is not None and not _db_pool.closed:
        return _db_pool

    sm = boto3.client("secretsmanager")
    secret = json.loads(sm.get_secret_value(SecretId=os.environ["DB_SECRET_ARN"])["SecretString"])
    _db_pool = pool.ThreadedConnectionPool(
        minconn=2,
        maxconn=8,  # 8 conns per task × 10 max tasks = 80 max, well under t3.medium limit
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", 5432)),
        dbname=os.environ.get("DB_NAME", "brainstormai"),
        user=secret["username"],
        password=secret["password"],
        sslmode="require",
    )
    return _db_pool


def retrieve_chunks(notebook_id: str, query: str, top_k: int) -> list[dict]:
    embedding = _embed_query(query)
    db_pool = _get_pool()
    conn = db_pool.getconn()
    try:
        register_vector(conn)
        with conn.cursor() as cur:
            # Get distinct source_ids for this notebook
            cur.execute(
                "SELECT DISTINCT source_id FROM chunks WHERE notebook_id = %s",
                (notebook_id,),
            )
            source_ids = [row[0] for row in cur.fetchall()]

        if not source_ids:
            return []

        # Distribute top_k evenly across sources so no single source dominates.
        # Each source gets at least floor(top_k / n_sources) chunks, remainder
        # goes to the first sources.
        n = len(source_ids)
        per_source = max(1, top_k // n)
        remainder = top_k - per_source * n

        all_rows = []
        with conn.cursor() as cur:
            for i, source_id in enumerate(source_ids):
                limit = per_source + (1 if i < remainder else 0)
                cur.execute(
                    """
                    SELECT chunk_id, text, chunk_index, token_count,
                           1 - (embedding <=> %s::vector) AS similarity
                    FROM chunks
                    WHERE notebook_id = %s AND source_id = %s
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                    """,
                    (embedding, notebook_id, source_id, embedding, limit),
                )
                all_rows.extend(cur.fetchall())
    finally:
        db_pool.putconn(conn)

    # Sort combined results by similarity descending so generators see best chunks first
    all_rows.sort(key=lambda r: r[4], reverse=True)

    return [
        {
            "chunk_id": str(row[0]),
            "text": row[1],
            "chunk_index": row[2],
            "token_count": row[3],
            "similarity": float(row[4]),
        }
        for row in all_rows
    ]


def _embed_query(text: str) -> list[float]:
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
            time.sleep(2 ** attempt)  # 1s, 2s, 4s backoff
