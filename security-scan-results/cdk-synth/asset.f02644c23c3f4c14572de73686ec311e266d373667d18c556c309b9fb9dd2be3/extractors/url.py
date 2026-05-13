"""
URL text extraction using Trafilatura.

Trafilatura is purpose-built for extracting article content from web pages.
It handles noise removal (nav, ads, footers) better than BeautifulSoup.

Extracted text is also stored in S3 so it can be re-processed without re-fetching.

Safeguards:
  - 15-second connect/read timeout — prevents hanging on slow servers
  - 5 MB response size cap — prevents infinite/huge page downloads
  - Only HTTPS is accepted (enforced at the Lambda layer before this is called)
"""

import logging
import os

import boto3
import requests
import trafilatura

log = logging.getLogger(__name__)
s3_client = boto3.client("s3")
S3_BUCKET = os.environ["S3_BUCKET"]

FETCH_TIMEOUT = 15          # seconds for connect + read
MAX_CONTENT_BYTES = 5 * 1024 * 1024  # 5 MB


def extract_url(url: str, s3_key: str) -> str:
    log.info("Fetching URL: %s", url)
    raw_html = _fetch(url)

    text = trafilatura.extract(
        raw_html,
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


def _fetch(url: str) -> str:
    """Fetch URL with timeout and size cap. Returns raw HTML as a string."""
    try:
        resp = requests.get(
            url,
            timeout=FETCH_TIMEOUT,
            stream=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; BrainstormAI/1.0)"},
        )
        resp.raise_for_status()
    except requests.exceptions.Timeout:
        raise ValueError(f"URL fetch timed out after {FETCH_TIMEOUT}s: {url}")
    except requests.exceptions.RequestException as e:
        raise ValueError(f"Could not fetch content from URL: {url} — {e}")

    # Read up to MAX_CONTENT_BYTES; discard the rest
    chunks = []
    total = 0
    for chunk in resp.iter_content(chunk_size=65536, decode_unicode=False):
        total += len(chunk)
        chunks.append(chunk)
        if total >= MAX_CONTENT_BYTES:
            log.warning("URL %s exceeded %d byte cap — truncating", url, MAX_CONTENT_BYTES)
            break
    resp.close()

    raw = b"".join(chunks)
    encoding = resp.encoding or "utf-8"
    try:
        return raw.decode(encoding, errors="replace")
    except (LookupError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace")
