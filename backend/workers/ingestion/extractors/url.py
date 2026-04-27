"""
URL text extraction using Trafilatura.

Trafilatura is purpose-built for extracting article content from web pages.
It handles noise removal (nav, ads, footers) better than BeautifulSoup.

Extracted text is also stored in S3 so it can be re-processed without re-fetching.
"""

import logging
import os

import boto3
import trafilatura

log = logging.getLogger(__name__)
s3_client = boto3.client("s3")
S3_BUCKET = os.environ["S3_BUCKET"]


def extract_url(url: str, s3_key: str) -> str:
    log.info("Fetching URL: %s", url)
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        raise ValueError(f"Could not fetch content from URL: {url}")

    text = trafilatura.extract(
        downloaded,
        include_comments=False,
        include_tables=True,
        no_fallback=False,
        favor_recall=True,
    )

    if not text or len(text.strip()) < 100:
        raise ValueError(f"URL yielded insufficient content (< 100 chars): {url}")

    # Cache extracted text in S3
    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=s3_key,
        Body=text.encode("utf-8"),
        ContentType="text/plain",
    )

    log.info("Extracted %d chars from URL %s", len(text), url)
    return text
