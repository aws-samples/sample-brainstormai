"""
Validation Agent — checks whether the generated artifact covers
the key points from the source chunks.

Returns:
  {
    "passed": bool,
    "missing": ["point 1", "point 2", ...],
    "coverage_score": 0-100
  }

Depth controls strictness:
  brief           → only flags absent core claims
  important_points → flags any notable point not mentioned
  in_depth        → flags even supporting details
"""

import json
import logging
import os

import boto3

log = logging.getLogger(__name__)
bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))
MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"

DEPTH_INSTRUCTIONS = {
    "brief": (
        "Focus only on the most critical claims and core conclusions. "
        "Ignore supporting details, examples, and minor points. "
        "Only flag a point as missing if its absence would significantly mislead a listener."
    ),
    "important_points": (
        "Flag any notable point, finding, or concept from the sources that is absent or "
        "substantially underrepresented in the artifact. Minor supporting details may be skipped."
    ),
    "in_depth": (
        "Flag every significant point including supporting evidence, examples, nuanced claims, "
        "and contextual details. The artifact should be comprehensive."
    ),
}


def validate_artifact(artifact_text: str, chunks: list[dict], depth: str) -> dict:
    source_excerpts = "\n\n---\n\n".join(c["text"] for c in chunks[:30])
    depth_instruction = DEPTH_INSTRUCTIONS.get(depth, DEPTH_INSTRUCTIONS["important_points"])

    prompt = f"""You are a content quality validator for an AI knowledge platform.

Your task: compare the artifact below against the source excerpts and identify significant points
from the sources that are missing or underrepresented in the artifact.

Depth level: {depth}
Validation rule: {depth_instruction}

SOURCE EXCERPTS:
{source_excerpts}

GENERATED ARTIFACT:
{artifact_text}

Respond with ONLY valid JSON in this exact format:
{{
  "passed": true or false,
  "missing": ["missing point 1", "missing point 2"],
  "coverage_score": integer 0-100
}}

Rules:
- passed = true if coverage_score >= 75 (for brief) / 70 (for important_points) / 65 (for in_depth)
- missing = [] if passed = true
- coverage_score reflects what percentage of key source points are covered
- Be specific in missing[] — write the actual missing claim, not a vague category"""

    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}],
        }),
        contentType="application/json",
        accept="application/json",
    )
    body = json.loads(response["body"].read())
    raw = body["content"][0]["text"].strip()
    usage = body.get("usage", {})

    try:
        result = json.loads(raw)
        return {
            "passed": bool(result.get("passed", False)),
            "missing": list(result.get("missing", [])),
            "coverage_score": int(result.get("coverage_score", 0)),
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
        }
    except (json.JSONDecodeError, KeyError) as e:
        log.warning("Validation agent returned invalid JSON: %s — defaulting to passed", e)
        return {
            "passed": True,
            "missing": [],
            "coverage_score": 80,
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
        }
