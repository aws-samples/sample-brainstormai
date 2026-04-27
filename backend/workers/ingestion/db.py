"""
PostgreSQL/pgvector connection and chunk storage.

Schema (created by migration, not by this worker):
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE TABLE chunks (
    chunk_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notebook_id UUID NOT NULL,
    source_id   UUID NOT NULL,
    chunk_index INT  NOT NULL,
    text        TEXT NOT NULL,
    embedding   vector(1024),
    token_count INT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  CREATE INDEX ON chunks (notebook_id);
"""

import json
import logging
import os

import boto3
import psycopg2
from pgvector.psycopg2 import register_vector

log = logging.getLogger(__name__)


def get_connection():
    secret_arn = os.environ["DB_SECRET_ARN"]
    sm = boto3.client("secretsmanager")
    secret = json.loads(sm.get_secret_value(SecretId=secret_arn)["SecretString"])

    conn = psycopg2.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", 5432)),
        dbname=os.environ.get("DB_NAME", "brainstormai"),
        user=secret["username"],
        password=secret["password"],
        connect_timeout=10,
        sslmode="require",
    )
    register_vector(conn)
    return conn


def upsert_chunks(conn, notebook_id: str, source_id: str, embedded_chunks: list[dict]):
    # Delete existing chunks for this source before re-inserting (handles re-ingestion)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM chunks WHERE source_id = %s", (source_id,))

    with conn.cursor() as cur:
        for idx, chunk in enumerate(embedded_chunks):
            cur.execute(
                """
                INSERT INTO chunks (notebook_id, source_id, chunk_index, text, embedding, token_count)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    notebook_id,
                    source_id,
                    idx,
                    chunk["text"],
                    chunk["embedding"],
                    chunk["token_count"],
                ),
            )
    conn.commit()
    log.info("Stored %d chunks for source %s in pgvector", len(embedded_chunks), source_id)
