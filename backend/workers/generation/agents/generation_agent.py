"""
Shared LLM call wrapper for all generation agents.
Handles Bedrock invocation, retries, and prompt construction helpers.
"""

import json
import logging
import os
import time

import boto3
from botocore.config import Config

log = logging.getLogger(__name__)
bedrock = boto3.client(
    "bedrock-runtime",
    region_name=os.environ.get("AWS_REGION", "us-east-1"),
    config=Config(read_timeout=600, connect_timeout=10, retries={"max_attempts": 0}),
)
MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"


def invoke(
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 8000,
    retries: int = 3,
) -> tuple[str, int, int]:
    """Return (text, input_tokens, output_tokens)."""
    for attempt in range(retries):
        try:
            response = bedrock.invoke_model(
                modelId=MODEL_ID,
                body=json.dumps({
                    "anthropic_version": "bedrock-2023-05-31",
                    "max_tokens": max_tokens,
                    "system": system_prompt,
                    "messages": [{"role": "user", "content": user_prompt}],
                }),
                contentType="application/json",
                accept="application/json",
            )
            body = json.loads(response["body"].read())
            usage = body.get("usage", {})
            return (
                body["content"][0]["text"].strip(),
                usage.get("input_tokens", 0),
                usage.get("output_tokens", 0),
            )
        except Exception as e:
            if attempt == retries - 1:
                raise
            log.warning("LLM call attempt %d failed: %s — retrying", attempt + 1, e)
            time.sleep(2 ** attempt)


def format_chunks(chunks: list[dict]) -> str:
    return "\n\n---\n\n".join(
        f"[Source chunk {i+1}]\n{c['text']}" for i, c in enumerate(chunks)
    )
