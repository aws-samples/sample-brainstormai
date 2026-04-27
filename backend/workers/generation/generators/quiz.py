"""
Quiz generator.

Produces a JSON array of multiple-choice questions grounded in source chunks.

Schema per question:
  {
    "question": "...",
    "options": ["A", "B", "C", "D"],
    "correctIndex": 0-3,
    "explanation": "..."
  }

Depth controls question count:
  brief           → 5 questions
  important_points → 10 questions
  in_depth        → 20 questions
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

DEPTH_COUNTS = {"brief": 5, "important_points": 10, "in_depth": 20}

SYSTEM_PROMPT = """You are an expert quiz designer. You create rigorous, fair multiple-choice
questions based strictly on provided source material. You output ONLY valid JSON arrays."""


def generate_quiz(chunks: list[dict], params: dict, missing_points: list[str] = None) -> dict:
    depth = params.get("depth", "important_points")
    count = DEPTH_COUNTS.get(depth, 10)

    missing_section = ""
    if missing_points:
        missing_section = (
            "\n\nEnsure questions cover these topics:\n" +
            "\n".join(f"- {p}" for p in missing_points)
        )

    user_prompt = f"""Create exactly {count} multiple-choice questions from the source material below.

Output ONLY a JSON array in this exact schema:
[
  {{
    "question": "What is...?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctIndex": 0,
    "explanation": "Option A is correct because..."
  }}
]

Rules:
- Each question must have exactly 4 options
- correctIndex is 0-indexed (0 = first option)
- All questions must be answerable from the source material — no outside knowledge required
- Vary difficulty: mix recall, comprehension, and application questions
- Explanations must cite the relevant information from sources
- No markdown, no prose — pure JSON array only
{missing_section}

SOURCE MATERIAL:
{format_chunks(chunks)}"""

    raw, in_tok, out_tok = invoke(SYSTEM_PROMPT, user_prompt, max_tokens=6000)
    quiz_json = _parse_json(raw, count)

    artifact_id = str(uuid.uuid4())
    s3_key = f"artifacts/{artifact_id}/quiz.json"
    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=s3_key,
        Body=json.dumps(quiz_json).encode("utf-8"),
        ContentType="application/json",
    )

    script_text = json.dumps(quiz_json)
    return {
        "artifactId": artifact_id,
        "s3Key": s3_key,
        "script_text": script_text,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def _parse_json(raw: str, expected_count: int) -> list:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Quiz LLM returned invalid JSON: {e}\nRaw: {raw[:500]}")

    if not isinstance(data, list):
        raise ValueError("Expected a JSON array for quiz output")

    for i, q in enumerate(data):
        if not all(k in q for k in ("question", "options", "correctIndex", "explanation")):
            raise ValueError(f"Question {i} is missing required fields")
        if len(q["options"]) != 4:
            raise ValueError(f"Question {i} must have exactly 4 options")

    return data
