"""
Notebooks Lambda — CRUD for user notebooks.

Routes (method + path suffix dispatched by event['routeKey']):
  GET    /notebooks
  POST   /notebooks
  GET    /notebooks/{notebookId}
  PATCH  /notebooks/{notebookId}
  DELETE /notebooks/{notebookId}

Each request carries a Cognito JWT; the user sub is extracted from
requestContext.authorizer.claims.sub and used to scope all queries.
"""

import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb")
notebooks_table = dynamodb.Table(os.environ["NOTEBOOKS_TABLE"])
sources_table = dynamodb.Table(os.environ["SOURCES_TABLE"])
jobs_table = dynamodb.Table(os.environ["JOBS_TABLE"])
artifacts_table = dynamodb.Table(os.environ["ARTIFACTS_TABLE"])


def lambda_handler(event, context):
    method = event["httpMethod"]
    path = event["resource"]
    user_id = event["requestContext"]["authorizer"]["claims"]["sub"]

    try:
        if path == "/notebooks":
            if method == "GET":
                return list_notebooks(user_id)
            if method == "POST":
                return create_notebook(user_id, json.loads(event["body"] or "{}"))

        if path == "/notebooks/{notebookId}":
            notebook_id = event["pathParameters"]["notebookId"]
            if method == "GET":
                return get_notebook(user_id, notebook_id)
            if method == "PATCH":
                return update_notebook(user_id, notebook_id, json.loads(event["body"] or "{}"))
            if method == "DELETE":
                return delete_notebook(user_id, notebook_id)

        return resp(404, {"error": "Not found"})
    except PermissionError as e:
        return resp(403, {"error": str(e)})
    except ValueError as e:
        return resp(400, {"error": str(e)})


def list_notebooks(user_id: str):
    result = notebooks_table.query(
        IndexName="userId-index",
        KeyConditionExpression=Key("userId").eq(user_id),
        ScanIndexForward=False,
    )
    return resp(200, {"notebooks": result["Items"]})


def create_notebook(user_id: str, body: dict):
    title = (body.get("title") or "").strip()
    if not title:
        raise ValueError("title is required")
    if len(title) > 200:
        raise ValueError("title must be 200 characters or fewer")

    now = datetime.now(timezone.utc).isoformat()
    notebook = {
        "notebookId": str(uuid.uuid4()),
        "userId": user_id,
        "title": title,
        "status": "READY",
        "sourceCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }
    notebooks_table.put_item(Item=notebook)
    return resp(201, notebook)


def get_notebook(user_id: str, notebook_id: str):
    item = _get_and_authorize(user_id, notebook_id)
    return resp(200, item)


def update_notebook(user_id: str, notebook_id: str, body: dict):
    _get_and_authorize(user_id, notebook_id)
    title = (body.get("title") or "").strip()
    if not title:
        raise ValueError("title is required")

    now = datetime.now(timezone.utc).isoformat()
    notebooks_table.update_item(
        Key={"notebookId": notebook_id},
        UpdateExpression="SET title = :t, updatedAt = :u",
        ExpressionAttributeValues={":t": title, ":u": now},
    )
    return resp(200, {"notebookId": notebook_id, "title": title, "updatedAt": now})


def delete_notebook(user_id: str, notebook_id: str):
    _get_and_authorize(user_id, notebook_id)

    # Delete all sources for this notebook
    sources = sources_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
    )["Items"]
    for s in sources:
        sources_table.delete_item(Key={"sourceId": s["sourceId"]})

    # Delete all jobs for this notebook
    jobs = jobs_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
    )["Items"]
    for j in jobs:
        jobs_table.delete_item(Key={"jobId": j["jobId"]})

    # Delete all artifacts for this notebook
    artifacts = artifacts_table.query(
        IndexName="notebookId-index",
        KeyConditionExpression=Key("notebookId").eq(notebook_id),
    )["Items"]
    for a in artifacts:
        artifacts_table.delete_item(Key={"artifactId": a["artifactId"]})

    notebooks_table.delete_item(Key={"notebookId": notebook_id})
    return resp(204, {})


def _get_and_authorize(user_id: str, notebook_id: str) -> dict:
    item = notebooks_table.get_item(Key={"notebookId": notebook_id}).get("Item")
    if not item:
        raise ValueError(f"Notebook {notebook_id} not found")
    if item["userId"] != user_id:
        raise PermissionError("Access denied")
    return item


def resp(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": json.dumps(body, default=str),
    }
