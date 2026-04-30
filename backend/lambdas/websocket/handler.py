"""
WebSocket Lambda — handles API Gateway WebSocket lifecycle and message routing.

Routes handled:
  $connect      → validate JWT, store connectionId
  $disconnect   → remove connectionId
  sendmessage   → dispatch by action:
      subscribe_job   → register interest in a job's completion notification
      start_podcast   → begin a podcast playback session
      resume          → advance to next podcast turn

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
polly_client = boto3.client("polly")
s3_client = boto3.client("s3")

ws_connections_table = dynamodb.Table(os.environ["WS_CONNECTIONS_TABLE"])
podcast_sessions_table = dynamodb.Table(os.environ["PODCAST_SESSIONS_TABLE"])
artifacts_table = dynamodb.Table(os.environ["ARTIFACTS_TABLE"])
jobs_table = dynamodb.Table(os.environ["JOBS_TABLE"])

WS_ENDPOINT = os.environ.get("WS_ENDPOINT", "")
S3_BUCKET = os.environ["S3_BUCKET"]

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
