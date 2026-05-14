"""
Artifacts Lambda — retrieve completed artifacts and generate presigned URLs.

Routes:
  GET  /notebooks/{notebookId}/artifacts
  GET  /notebooks/{notebookId}/artifacts/{artifactId}

For podcast artifacts the response includes a 'playlist' array of
presigned S3 URLs for each audio segment, valid for 1 hour.

For mindmap and quiz artifacts the response includes a presigned
URL for the raw JSON file stored in S3.
"""

import json
import os

import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")
s3_client = boto3.client("s3")

notebooks_table = dynamodb.Table(os.environ["NOTEBOOKS_TABLE"])
artifacts_table = dynamodb.Table(os.environ["ARTIFACTS_TABLE"])
S3_BUCKET = os.environ["S3_BUCKET"]

PRESIGN_TTL = 3600  # 1 hour


def lambda_handler(event, context):
    method = event["httpMethod"]
    path = event["resource"]
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]
    notebook_id = event["pathParameters"]["notebookId"]

    _authorize_notebook(user_id, notebook_id)

    try:
        if path == "/notebooks/{notebookId}/artifacts":
            if method == "GET":
                return list_artifacts(notebook_id)

        if path == "/notebooks/{notebookId}/artifacts/{artifactId}":
            artifact_id = event["pathParameters"]["artifactId"]
            if method == "GET":
                return get_artifact(notebook_id, artifact_id)

        return resp(404, {"error": "Not found"})
    except ValueError as e:
        return resp(400, {"error": str(e)})
    except PermissionError as e:
        return resp(403, {"error": str(e)})


def list_artifacts(notebook_id: str):
    items = artifacts_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
        ScanIndexForward=False,
    )["Items"]
    # Strip raw s3Keys from list view — clients get presigned URLs on detail view
    for item in items:
        item.pop("s3Key", None)
    return resp(200, {"artifacts": items})


def get_artifact(notebook_id: str, artifact_id: str):
    item = artifacts_table.get_item(Key={"artifactId": artifact_id}).get("Item")
    if not item or item["notebookId"] != notebook_id:
        raise ValueError("Artifact not found")

    artifact_type = item["type"]

    if artifact_type == "podcast":
        manifest_key = item["s3Key"]  # points to manifest.json
        manifest_obj = s3_client.get_object(Bucket=S3_BUCKET, Key=manifest_key)
        manifest = json.loads(manifest_obj["Body"].read())

        playlist = []
        for turn in manifest["turns"]:
            presigned_url = s3_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": S3_BUCKET, "Key": turn["s3Key"]},
                ExpiresIn=PRESIGN_TTL,
            )
            playlist.append({
                "turnIndex": turn["turnIndex"],
                "speaker": turn["speaker"],
                "text": turn["text"],
                "audioUrl": presigned_url,
            })

        item["playlist"] = playlist
        item.pop("s3Key", None)

    elif artifact_type == "summary":
        summary_obj = s3_client.get_object(Bucket=S3_BUCKET, Key=item["s3Key"])
        item["summary"] = json.loads(summary_obj["Body"].read())
        item.pop("s3Key", None)

    else:
        # mindmap or quiz — return presigned URL to the JSON artifact
        presigned_url = s3_client.generate_presigned_url(
            "get_object",
            Params={"Bucket": S3_BUCKET, "Key": item["s3Key"]},
            ExpiresIn=PRESIGN_TTL,
        )
        item["artifactUrl"] = presigned_url
        item.pop("s3Key", None)

    return resp(200, item)


def _authorize_notebook(user_id: str, notebook_id: str):
    item = notebooks_table.get_item(Key={"notebookId": notebook_id}).get("Item")
    if not item:
        raise ValueError("Notebook not found")
    if item["userId"] != user_id:
        raise PermissionError("Access denied")


def resp(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(body, default=str),
    }
