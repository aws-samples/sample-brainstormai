"""
Mind map generator.

Produces a JSON tree structure from source chunks.
Schema: { title, children: [{ label, children: [...] }] }

Depth controls tree complexity:
  brief           → 2 levels (root + immediate children)
  important_points → 3 levels
  in_depth        → 4+ levels with detail nodes
"""

import json
import logging
import os
import uuid
from datetime import datetime, timezone

import boto3

from agents.generation_agent import format_chunks, invoke

log = logging.getLogger(__name__)
s3_client = boto3.client("s3")
S3_BUCKET = os.environ["S3_BUCKET"]

DEPTH_LEVELS = {"brief": 2, "important_points": 3, "in_depth": 4}

SYSTEM_PROMPT = """You are a knowledge organization expert. You create structured mind maps
from document content. You output ONLY valid JSON — no prose, no markdown, no explanation.
The JSON must strictly follow the given schema."""


def generate_mindmap(chunks: list[dict], params: dict, missing_points: list[str] = None) -> dict:
    depth = params.get("depth", "important_points")
    levels = DEPTH_LEVELS.get(depth, 3)

    missing_section = ""
    if missing_points:
        missing_section = (
            "\n\nEnsure these topics are included as nodes:\n" +
            "\n".join(f"- {p}" for p in missing_points)
        )

    user_prompt = f"""Create a mind map with {levels} levels of depth from the following source material.

Output ONLY a JSON object in this exact schema:
{{
  "title": "Main topic",
  "children": [
    {{
      "label": "Subtopic",
      "children": [
        {{ "label": "Detail", "children": [] }}
      ]
    }}
  ]
}}

Rules:
- title should capture the overarching theme of all sources
- Each node label should be concise (3-8 words)
- No markdown, no prose — pure JSON only
- Every non-leaf at levels < {levels} must have children
{missing_section}

SOURCE MATERIAL:
{format_chunks(chunks)}"""

    raw, in_tok, out_tok = invoke(SYSTEM_PROMPT, user_prompt, max_tokens=4000)
    mindmap_json = _parse_json(raw)

    artifact_id = str(uuid.uuid4())
    s3_key = f"artifacts/{artifact_id}/mindmap.json"
    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=s3_key,
        Body=json.dumps(mindmap_json).encode("utf-8"),
        ContentType="application/json",
    )

    script_text = json.dumps(mindmap_json)
    return {
        "artifactId": artifact_id,
        "s3Key": s3_key,
        "script_text": script_text,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def _parse_json(raw: str) -> dict:
    # Strip markdown code fences if LLM wrapped output
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Mind map LLM returned invalid JSON: {e}\nRaw: {raw[:500]}")
