"""
Summary generator.

Produces a structured summary (TLDR + key points + highlights) from source chunks.
No TTS, no validation agent — runs fast as a lightweight artifact type.

Stores the result JSON directly in S3 and returns the artifact metadata.
"""

import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone

import boto3

from agents.generation_agent import format_chunks, invoke

log = logging.getLogger(__name__)
s3_client = boto3.client("s3")
S3_BUCKET = os.environ["S3_BUCKET"]

DEPTH_INSTRUCTIONS = {
    "brief":            "Limit to 3 key points and 2 highlights. Be concise.",
    "important_points": "Include 5-7 key points and 3-4 highlights.",
    "in_depth":         "Include 8-12 key points and 5-6 detailed highlights.",
}

SYSTEM_PROMPT = (
    "You are a research assistant that produces clear, structured summaries. "
    "You always respond with valid JSON only — no preamble, no markdown code fences."
)


def generate_summary(chunks: list[dict], params: dict, **_) -> dict:
    depth = params.get("depth", "important_points")
    detail_instruction = DEPTH_INSTRUCTIONS.get(depth, DEPTH_INSTRUCTIONS["important_points"])

    user_prompt = f"""Summarize the following source material. {detail_instruction}

SOURCE MATERIAL:
{format_chunks(chunks)}

Respond with exactly this JSON structure (no extra keys):
{{
  "tldr": "2-3 sentence plain-English overview of the entire material",
  "key_points": ["concise point 1", "concise point 2"],
  "highlights": [
    {{"title": "short descriptive label", "detail": "1-2 sentence explanation"}},
    ...
  ]
}}"""

    text, in_tok, out_tok = invoke(SYSTEM_PROMPT, user_prompt, max_tokens=8000)

    summary_json = _parse_json(text)

    artifact_id = str(uuid.uuid4())
    s3_key = f"summaries/{artifact_id}.json"
    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=s3_key,
        Body=json.dumps(summary_json).encode("utf-8"),
        ContentType="application/json",
    )

    return {
        "artifactId": artifact_id,
        "s3Key": s3_key,
        "script_text": json.dumps(summary_json),
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "total_input_tokens": in_tok,
        "total_output_tokens": out_tok,
        "coverageScore": 100,
        "coverageWarning": False,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def _parse_json(text: str) -> dict:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise ValueError(f"Summary LLM returned non-JSON output: {text[:300]}")
