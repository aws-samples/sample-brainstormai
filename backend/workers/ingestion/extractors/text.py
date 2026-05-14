"""Plain text extraction — reads pre-stored text directly from S3."""

import logging
import os

import boto3

log = logging.getLogger(__name__)
s3_client = boto3.client("s3")
S3_BUCKET = os.environ["S3_BUCKET"]


def extract_text(s3_key: str) -> str:
    obj = s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key)
    text = obj["Body"].read().decode("utf-8")
    log.info("Read %d chars from s3://%s/%s", len(text), S3_BUCKET, s3_key)
    return text
