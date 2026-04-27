"""
WebSocket Lambda — handles API Gateway WebSocket lifecycle and message routing.

Routes handled:
  $connect      → validate JWT, store connectionId
  $disconnect   → remove connectionId
  sendmessage   → dispatch by action:
      subscribe_job   → register interest in a job's completion notification
      start_podcast   → begin a podcast playback session
      interrupt       → user asks a question mid-podcast
      resume          → user resumes playback after Q&A

Pushes back to client via ApiGatewayManagementApi using the WS_ENDPOINT env var.

Note: JWT validation at $connect uses Cognito public keys. For MVP we rely on
the Cognito authorizer configured on the $connect route in API Gateway, so the
Lambda itself trusts the already-validated claims in requestContext.
"""

import base64
import json
import os
import time
import uuid
from datetime import datetime, timezone

import boto3

dynamodb = boto3.resource("dynamodb")
bedrock_client = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))
polly_client = boto3.client("polly")
s3_client = boto3.client("s3")

ws_connections_table = dynamodb.Table(os.environ["WS_CONNECTIONS_TABLE"])
podcast_sessions_table = dynamodb.Table(os.environ["PODCAST_SESSIONS_TABLE"])
artifacts_table = dynamodb.Table(os.environ["ARTIFACTS_TABLE"])
jobs_table = dynamodb.Table(os.environ["JOBS_TABLE"])

WS_ENDPOINT = os.environ.get("WS_ENDPOINT", "")
S3_BUCKET = os.environ["S3_BUCKET"]
BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"  # cross-region inference profile

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
    if action == "interrupt":
        return handle_interrupt(connection_id, user_id, body)
    if action == "resume":
        return handle_resume(connection_id, user_id, body)

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
            "history": [],
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


def handle_interrupt(connection_id: str, user_id: str, body: dict):
    session_id = body.get("sessionId")
    question = (body.get("text") or "").strip()
    if not question:
        return {"statusCode": 400}

    session = podcast_sessions_table.get_item(Key={"sessionId": session_id}).get("Item")
    if not session or session["userId"] != user_id:
        return {"statusCode": 403}

    language = session.get("language", "english")
    history = session.get("history", [])

    # Client sends turnIndex indicating where in the audio the listener paused
    turn_index = int(body.get("turnIndex", session.get("turnIndex", 0)))

    # Build context: script up to current turn + history
    script_context = "\n".join(
        f"{t['speaker']}: {t['text']}" for t in session["script"][:turn_index]
    )
    history_context = "\n".join(
        f"Q: {h['question']}\nA: {h['answer']}" for h in history[-5:]  # last 5 exchanges
    )

    # Derive the two speaker names from the script
    speakers = list(dict.fromkeys(t["speaker"] for t in session["script"]))
    host_a = speakers[0] if speakers else "ALEX"
    host_b = speakers[1] if len(speakers) > 1 else "SAM"

    answer = _generate_answer(question, script_context, history_context, language, host_a, host_b)

    # TTS using host A's voice (same speaker who drives the conversation)
    voices = POLLY_VOICES.get(language, POLLY_VOICES["english"])
    audio_key = f"audio/{session['artifactId']}/qa_{uuid.uuid4()}.mp3"
    _synthesize_and_store(answer, voices[0], audio_key)

    presigned_url = s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": audio_key},
        ExpiresIn=3600,
    )

    # Persist Q&A in session history
    history.append({"question": question, "answer": answer})
    podcast_sessions_table.update_item(
        Key={"sessionId": session_id},
        UpdateExpression="SET history = :h",
        ExpressionAttributeValues={":h": history},
    )

    _push(connection_id, {
        "type": "podcast_answer",
        "sessionId": session_id,
        "text": answer,
        "audioUrl": presigned_url,
    })
    return {"statusCode": 200}


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


def _generate_answer(question: str, script_context: str, history_context: str, language: str,
                     host_a: str, host_b: str) -> str:
    lang_instruction = f"Respond entirely in {language}." if language != "english" else ""
    prior_qa = f"\nPrevious listener questions already addressed:\n{history_context}" if history_context.strip() else ""
    prompt = f"""You are {host_a}, one of the two hosts of this podcast. Your co-host is {host_b}.
A listener has just paused the podcast to ask a question. You need to address it naturally — as if it were said out loud mid-episode — before the podcast resumes.

Podcast conversation so far:
{script_context}
{prior_qa}

Listener's question: {question}

Write ONLY {host_a}'s spoken response. Rules:
- Start by warmly acknowledging the question, referencing {host_b} by name (e.g. "Oh great question — and {host_b}, this ties right into what we were just saying about...")
- Speak as {host_a} in first person. Do NOT write "{host_a}:" — just write the words they say.
- Stay tightly grounded in what was just discussed. Do not introduce new topics.
- Keep it to 3-5 natural spoken sentences. No bullet points, no headers.
- End in a way that naturally hands back to the podcast flow (e.g. "...so let's keep going" or "...which is exactly what we're about to get into").
{lang_instruction}"""

    response = bedrock_client.invoke_model(
        modelId=BEDROCK_MODEL,
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 400,
            "messages": [{"role": "user", "content": prompt}],
        }),
        contentType="application/json",
        accept="application/json",
    )
    result = json.loads(response["body"].read())
    return result["content"][0]["text"].strip()


def _synthesize_and_store(text: str, voice_id: str, s3_key: str):
    response = polly_client.synthesize_speech(
        Text=text,
        OutputFormat="mp3",
        VoiceId=voice_id,
        Engine="neural",
    )
    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=s3_key,
        Body=response["AudioStream"].read(),
        ContentType="audio/mpeg",
    )


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
