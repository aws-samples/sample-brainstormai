"""
WebSocket Lambda — handles API Gateway WebSocket lifecycle and message routing.

Routes handled:
  $connect      → validate JWT, store connectionId
  $disconnect   → remove connectionId
  sendmessage   → dispatch by action:
      subscribe_job   → register interest in a job's completion notification
      start_podcast   → begin a podcast playback session
      resume          → advance to next podcast turn
      interrupt       → pause podcast, answer a user question via Bedrock + Polly,
                        push podcast_answer message with presigned audio URL

Pushes back to client via ApiGatewayManagementApi using the WS_ENDPOINT env var.
"""

import base64
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone

import boto3

dynamodb = boto3.resource("dynamodb")
bedrock_client = boto3.client("bedrock-runtime")
polly_client = boto3.client("polly")
s3_client = boto3.client("s3")

ws_connections_table = dynamodb.Table(os.environ["WS_CONNECTIONS_TABLE"])
podcast_sessions_table = dynamodb.Table(os.environ["PODCAST_SESSIONS_TABLE"])
artifacts_table = dynamodb.Table(os.environ["ARTIFACTS_TABLE"])
jobs_table = dynamodb.Table(os.environ["JOBS_TABLE"])

WS_ENDPOINT = os.environ.get("WS_ENDPOINT", "")
S3_BUCKET = os.environ["S3_BUCKET"]
BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
POLLY_MAX_CHARS = 2900

POLLY_VOICES = {
    "english": ("Matthew", "Joanna"),
    "hindi": ("Kajal", "Aditi"),
    "mandarin": ("Zhiyu", "Zhiyu"),
    "spanish": ("Miguel", "Lupe"),
    "french": ("Lea", "Remi"),
}


def lambda_handler(event, context):
    route = event["requestContext"]["routeKey"]
    connection_id = event["requestContext"]["connectionId"]
    print(f"[WS] route={route} conn={connection_id}")

    if route == "$connect":
        return on_connect(event, connection_id)
    if route == "$disconnect":
        return on_disconnect(connection_id)
    if route in ("sendmessage", "$default"):
        return on_message(event, connection_id)
    return {"statusCode": 200}


# ── Connection lifecycle ──────────────────────────────────────────────────────

def _decode_user_id(event: dict) -> str:
    """Extract sub from the JWT token passed as ?token= query param."""
    token = (event.get("queryStringParameters") or {}).get("token", "")
    if not token:
        raise ValueError("Missing token")
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid token format")
    # Decode payload (add padding if needed)
    payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
    payload = json.loads(base64.b64decode(payload_b64))
    sub = payload.get("sub")
    if not sub:
        raise ValueError("No sub in token")
    return sub


def on_connect(event, connection_id: str):
    try:
        user_id = _decode_user_id(event)
    except Exception:
        return {"statusCode": 401}
    ws_connections_table.put_item(Item={
        "connectionId": connection_id,
        "userId": user_id,
        "sessionType": "notify",
        "ttl": int(time.time()) + 7200,  # 2h auto-expire
        "connectedAt": datetime.now(timezone.utc).isoformat(),
    })
    return {"statusCode": 200}


def on_disconnect(connection_id: str):
    ws_connections_table.delete_item(Key={"connectionId": connection_id})
    return {"statusCode": 200}


# ── Inbound message routing ───────────────────────────────────────────────────

def on_message(event, connection_id: str):
    body = json.loads(event.get("body") or "{}")
    action = body.get("action")
    print(f"[WS] on_message action={action} conn={connection_id}")

    conn = ws_connections_table.get_item(Key={"connectionId": connection_id}).get("Item")
    if not conn:
        print(f"[WS] connection not found: {connection_id}")
        return {"statusCode": 401}
    user_id = conn["userId"]

    if action == "subscribe_job":
        return subscribe_job(connection_id, user_id, body)
    if action == "start_podcast":
        return start_podcast(connection_id, user_id, body)
    if action == "resume":
        return handle_resume(connection_id, user_id, body)
    if action == "interrupt":
        return handle_interrupt(connection_id, user_id, body)

    return {"statusCode": 400}


# ── Subscribe to job notification ─────────────────────────────────────────────

def subscribe_job(connection_id: str, user_id: str, body: dict):
    job_id = body.get("jobId")
    # Store subscription so generation worker can push completion
    ws_connections_table.update_item(
        Key={"connectionId": connection_id},
        UpdateExpression="SET subscribedJobId = :j",
        ExpressionAttributeValues={":j": job_id},
    )
    return {"statusCode": 200}


# ── Podcast session ───────────────────────────────────────────────────────────

def start_podcast(connection_id: str, user_id: str, body: dict):
    artifact_id = body.get("artifactId")
    print(f"[WS] start_podcast artifact_id={artifact_id}")
    artifact = artifacts_table.get_item(Key={"artifactId": artifact_id}).get("Item")
    if not artifact or artifact["type"] != "podcast":
        print(f"[WS] artifact not found or wrong type: {artifact}")
        _push(connection_id, {"type": "error", "message": "Artifact not found"})
        return {"statusCode": 404}

    try:
        manifest_key = artifact["s3Key"]
        print(f"[WS] loading manifest from s3Key={manifest_key}")
        manifest = json.loads(s3_client.get_object(Bucket=S3_BUCKET, Key=manifest_key)["Body"].read())

        session_id = str(uuid.uuid4())
        language = manifest.get("language", "english")
        print(f"[WS] session_id={session_id} turns={len(manifest['turns'])} language={language}")

        podcast_sessions_table.put_item(Item={
            "sessionId": session_id,
            "artifactId": artifact_id,
            "userId": user_id,
            "connectionId": connection_id,
            "turnIndex": 0,
            "script": manifest["turns"],
            "language": language,
            "ttl": int(time.time()) + 7200,
        })

        ws_connections_table.update_item(
            Key={"connectionId": connection_id},
            UpdateExpression="SET sessionType = :pt, podcastSessionId = :sid",
            ExpressionAttributeValues={":pt": "podcast", ":sid": session_id},
        )

        # Push first turn immediately
        _push_next_turn(connection_id, session_id, manifest["turns"], 0, language)
        print(f"[WS] first turn pushed")
        return {"statusCode": 200}
    except Exception as e:
        print(f"[WS] start_podcast error: {e}")
        import traceback; traceback.print_exc()
        return {"statusCode": 500}


def handle_resume(connection_id: str, user_id: str, body: dict):
    session_id = body.get("sessionId")
    session = podcast_sessions_table.get_item(Key={"sessionId": session_id}).get("Item")
    if not session or session["userId"] != user_id:
        return {"statusCode": 403}

    turn_index = int(session["turnIndex"])
    script = session["script"]
    language = session.get("language", "english")

    if turn_index >= len(script):
        _push(connection_id, {"type": "podcast_done", "sessionId": session_id})
    else:
        _push_next_turn(connection_id, session_id, script, turn_index, language)

    return {"statusCode": 200}


# ── Podcast interrupt / Q&A ───────────────────────────────────────────────────

def handle_interrupt(connection_id: str, user_id: str, body: dict):
    session_id = body.get("sessionId")
    question = (body.get("question") or "").strip()
    print(f"[WS] interrupt session_id={session_id!r} question_len={len(question)} user={user_id}")
    if not session_id or not question:
        print(f"[WS] interrupt rejected: missing session_id={not session_id} missing_question={not question}")
        _push(connection_id, {"type": "error", "message": "sessionId and question are required"})
        return {"statusCode": 400}

    session = podcast_sessions_table.get_item(Key={"sessionId": session_id}).get("Item")
    if not session or session["userId"] != user_id:
        return {"statusCode": 403}

    try:
        script = session["script"]
        language = session.get("language", "english")

        # Build context: last few turns the user has heard so far
        heard_index = max(0, int(session["turnIndex"]) - 1)
        context_turns = script[max(0, heard_index - 6): heard_index + 1]
        context_text = "\n".join(
            f"{t['speaker']}: {t['text']}" for t in context_turns
        )

        answer_text = _generate_answer(question, context_text)
        audio_url = _synthesize_answer(answer_text, language, session_id)

        _push(connection_id, {
            "type": "podcast_answer",
            "sessionId": session_id,
            "question": question,
            "answer": answer_text,
            "audioUrl": audio_url,
        })
        return {"statusCode": 200}
    except Exception as e:
        print(f"[WS] interrupt error: {e}")
        import traceback; traceback.print_exc()
        _push(connection_id, {"type": "error", "message": "Failed to generate answer"})
        return {"statusCode": 500}


def _generate_answer(question: str, context: str) -> str:
    prompt = (
        "You are a helpful podcast assistant. The user is listening to a podcast and paused "
        "to ask a question. Answer concisely (2-4 sentences) based on the podcast context below.\n\n"
        f"<podcast_context>\n{context}\n</podcast_context>\n\n"
        f"User question: {question}"
    )
    resp = bedrock_client.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 512,
            "messages": [{"role": "user", "content": prompt}],
        }),
        contentType="application/json",
        accept="application/json",
    )
    result = json.loads(resp["body"].read())
    return result["content"][0]["text"].strip()


def _synthesize_answer(text: str, language: str, session_id: str) -> str:
    voices = POLLY_VOICES.get(language, POLLY_VOICES["english"])
    voice_id = voices[1]  # use the second speaker (SAM) as the answer voice

    chunks = _split_for_polly(text)
    audio_parts = []
    for chunk in chunks:
        resp = polly_client.synthesize_speech(
            Text=chunk,
            OutputFormat="mp3",
            VoiceId=voice_id,
            Engine="neural",
        )
        audio_parts.append(resp["AudioStream"].read())

    audio_data = b"".join(audio_parts)
    key = f"audio/qa/{session_id}/{uuid.uuid4()}.mp3"
    s3_client.put_object(Bucket=S3_BUCKET, Key=key, Body=audio_data, ContentType="audio/mpeg")

    return s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": key},
        ExpiresIn=3600,
    )


def _split_for_polly(text: str) -> list[str]:
    if len(text) <= POLLY_MAX_CHARS:
        return [text]
    chunks, current = [], ""
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if len(current) + len(sentence) + 1 > POLLY_MAX_CHARS:
            if current:
                chunks.append(current.strip())
            current = sentence
        else:
            current = (current + " " + sentence).strip()
    if current:
        chunks.append(current.strip())
    return chunks or [text[:POLLY_MAX_CHARS]]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _push_next_turn(connection_id: str, session_id: str, script: list, turn_index: int, language: str):
    if turn_index >= len(script):
        _push(connection_id, {"type": "podcast_done", "sessionId": session_id})
        return

    turn = script[turn_index]
    # Pre-generated audio key is stored in the manifest turn
    audio_key = turn["s3Key"]
    presigned_url = s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": audio_key},
        ExpiresIn=3600,
    )

    # Advance turn counter in session
    podcast_sessions_table.update_item(
        Key={"sessionId": session_id},
        UpdateExpression="SET turnIndex = :t",
        ExpressionAttributeValues={":t": turn_index + 1},
    )

    _push(connection_id, {
        "type": "podcast_turn",
        "sessionId": session_id,
        "turnIndex": turn_index,
        "speaker": turn["speaker"],
        "text": turn["text"],
        "audioUrl": presigned_url,
        "totalTurns": len(script),
    })


def _push(connection_id: str, payload: dict):
    apigw = boto3.client(
        "apigatewaymanagementapi",
        endpoint_url=WS_ENDPOINT,
    )
    try:
        apigw.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps(payload).encode("utf-8"),
        )
    except apigw.exceptions.GoneException:
        # Client disconnected — clean up silently
        ws_connections_table.delete_item(Key={"connectionId": connection_id})
