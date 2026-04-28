"""
Podcast generator.

Produces a two-speaker podcast script from source chunks, then:
  1. Splits script into speaker turns
  2. TTS each turn with Amazon Polly Neural
  3. Stores audio segments in S3
  4. Writes a manifest.json (ordered playlist metadata)

Returns dict with artifactId, s3Key (manifest), script_text (for validation).
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
polly_client = boto3.client("polly")
S3_BUCKET = os.environ["S3_BUCKET"]

POLLY_VOICES = {
    "english":  ("Matthew", "Joanna"),
    "hindi":    ("Kajal",   "Kajal"),   # Aditi is standard-only; Kajal is the only neural Hindi voice
    "mandarin": ("Zhiyu",   "Zhiyu"),
    "spanish":  ("Pedro",   "Lupe"),    # Miguel is standard-only
    "french":   ("Remi",    "Lea"),
}

DEPTH_DURATION = {
    "brief":            "at least 5 minutes",
    "important_points": "at least 10 minutes",
    "in_depth":         "at least 18 minutes",
}

SYSTEM_PROMPT = """You are a professional podcast script writer. You write engaging,
natural-sounding conversations between two hosts: ALEX and SAM.

CRITICAL FORMAT RULES — follow exactly:
- Output ONLY the raw script — no preamble, no title, no explanation, nothing before the first speaker line
- Every single line must start with "ALEX:" or "SAM:" — no stage directions, no narrator lines
- The speaker labels ALEX and SAM must always be in English regardless of the podcast language
- If the source material is in a different language, translate and discuss the concepts in the requested output language

CONTENT RULES:
- Speak in a natural, conversational tone — not lecture-style
- Ground every claim in the provided source material
- Never fabricate facts not present in the sources
- Transitions should feel organic, not mechanical
- End with a brief wrap-up by both hosts"""


def generate_podcast(chunks: list[dict], params: dict, missing_points: list[str] = None) -> dict:
    genre = params.get("genre", "educational")
    depth = params.get("depth", "important_points")
    language = params.get("language", "english")

    duration = DEPTH_DURATION.get(depth, "10-12 minutes")
    missing_section = ""
    if missing_points:
        missing_section = (
            "\n\nIMPORTANT — the previous draft was missing these points. "
            "Make sure to cover them:\n" +
            "\n".join(f"- {p}" for p in missing_points)
        )

    user_prompt = f"""Write a {genre} podcast script in {language} that covers ALL the provided source material thoroughly. The script should be {duration} long — but go longer if needed to cover everything. Do not cut content short to fit a time limit.

Genre guidelines:
- debate: ALEX and SAM take opposing viewpoints and challenge each other's reasoning
- educational: both hosts collaboratively explain and build on concepts
- sporty: energetic, casual, enthusiastic — like sports commentary applied to ideas

SOURCE MATERIAL:
{format_chunks(chunks)}
{missing_section}

Write the complete script now. Only output the script — no preamble, no stage directions."""

    script_text, in_tok, out_tok = invoke(SYSTEM_PROMPT, user_prompt, max_tokens=16000)
    turns = _parse_turns(script_text)

    if not turns:
        log.error("Script parser found no turns. Raw output (first 500 chars): %s", script_text[:500])
        raise ValueError("Script parser found no speaker turns in LLM output")

    artifact_id = str(uuid.uuid4())
    voices = POLLY_VOICES.get(language, POLLY_VOICES["english"])
    voice_map = {"ALEX": voices[0], "SAM": voices[1]}

    manifest_turns = []
    for idx, turn in enumerate(turns):
        speaker = turn["speaker"]
        text = turn["text"]
        voice_id = voice_map.get(speaker, voices[0])
        audio_key = f"audio/{artifact_id}/turn_{idx:04d}.mp3"

        _synthesize(text, voice_id, audio_key)

        manifest_turns.append({
            "turnIndex": idx,
            "speaker": speaker,
            "text": text,
            "s3Key": audio_key,
        })

    manifest = {
        "artifactId": artifact_id,
        "language": language,
        "genre": genre,
        "depth": depth,
        "turns": manifest_turns,
    }
    manifest_key = f"audio/{artifact_id}/manifest.json"
    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=manifest_key,
        Body=json.dumps(manifest).encode("utf-8"),
        ContentType="application/json",
    )

    return {
        "artifactId": artifact_id,
        "s3Key": manifest_key,
        "script_text": script_text,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


_SPEAKER_RE = re.compile(
    r"^\**\s*(ALEX|SAM)\s*\**\s*:",
    re.IGNORECASE,
)


def _parse_turns(script: str) -> list[dict]:
    turns = []
    current_speaker = None
    current_lines = []
    found_first = False

    for line in script.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _SPEAKER_RE.match(line)
        if m:
            found_first = True
            if current_speaker and current_lines:
                turns.append({"speaker": current_speaker, "text": " ".join(current_lines)})
            current_speaker = m.group(1).upper()
            rest = line[m.end():].strip()
            current_lines = [rest] if rest else []
        elif found_first and current_speaker:
            # continuation line of current speaker's turn
            current_lines.append(line)
        # lines before the first ALEX:/SAM: are preamble — silently skipped

    if current_speaker and current_lines:
        turns.append({"speaker": current_speaker, "text": " ".join(current_lines)})

    return turns


def _synthesize(text: str, voice_id: str, s3_key: str):
    # Polly has a 3000 char limit per request; split long turns
    chunks = _split_for_polly(text)
    audio_parts = []
    for chunk in chunks:
        response = polly_client.synthesize_speech(
            Text=chunk,
            OutputFormat="mp3",
            VoiceId=voice_id,
            Engine="neural",
        )
        audio_parts.append(response["AudioStream"].read())

    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=s3_key,
        Body=b"".join(audio_parts),
        ContentType="audio/mpeg",
    )


def _split_for_polly(text: str, max_chars: int = 2900) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    # Split on sentence boundaries
    parts = []
    current = ""
    for sentence in text.replace(". ", ".|").replace("! ", "!|").replace("? ", "?|").split("|"):
        if len(current) + len(sentence) < max_chars:
            current += sentence + " "
        else:
            if current:
                parts.append(current.strip())
            current = sentence + " "
    if current:
        parts.append(current.strip())
    return parts
