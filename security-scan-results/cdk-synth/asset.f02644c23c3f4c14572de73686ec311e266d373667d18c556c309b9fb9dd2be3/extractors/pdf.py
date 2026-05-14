"""
PDF text extraction.

Primary: PyMuPDF (fast, free, handles text-based PDFs perfectly).
Fallback: Amazon Textract (handles scanned/image PDFs, costs per page).

We try PyMuPDF first. If it extracts fewer than 100 characters per page on
average, the PDF is likely image-based and we escalate to Textract.
"""

import io
import logging
import os
import re
import time

import boto3
import fitz  # PyMuPDF

log = logging.getLogger(__name__)
s3_client = boto3.client("s3")
textract_client = boto3.client("textract")
S3_BUCKET = os.environ["S3_BUCKET"]

MIN_CHARS_PER_PAGE = 100


def extract_pdf(s3_key: str) -> str:
    pdf_bytes = _download_pdf(s3_key)
    text = _extract_with_pymupdf(pdf_bytes)

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    num_pages = doc.page_count
    doc.close()

    if num_pages > 0 and len(text) / num_pages < MIN_CHARS_PER_PAGE:
        log.info("PyMuPDF yield too low (%d chars / %d pages), falling back to Textract",
                 len(text), num_pages)
        text = _extract_with_textract(s3_key)

    return _clean_text(text)


def _download_pdf(s3_key: str) -> bytes:
    obj = s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key)
    return obj["Body"].read()


def _extract_with_pymupdf(pdf_bytes: bytes) -> str:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    for page in doc:
        pages.append(page.get_text("text"))
    doc.close()
    return "\n".join(pages)


def _extract_with_textract(s3_key: str) -> str:
    # Textract async for multi-page documents
    response = textract_client.start_document_text_detection(
        DocumentLocation={"S3Object": {"Bucket": S3_BUCKET, "Name": s3_key}}
    )
    job_id = response["JobId"]

    # Poll until complete (max 5 minutes)
    for _ in range(60):
        time.sleep(5)
        result = textract_client.get_document_text_detection(JobId=job_id)
        status = result["JobStatus"]
        if status == "SUCCEEDED":
            return _collect_textract_pages(job_id)
        if status == "FAILED":
            raise RuntimeError(f"Textract job {job_id} failed")

    raise TimeoutError(f"Textract job {job_id} timed out")


def _collect_textract_pages(job_id: str) -> str:
    lines = []
    next_token = None
    while True:
        kwargs = {"JobId": job_id}
        if next_token:
            kwargs["NextToken"] = next_token
        result = textract_client.get_document_text_detection(**kwargs)
        for block in result["Blocks"]:
            if block["BlockType"] == "LINE":
                lines.append(block["Text"])
        next_token = result.get("NextToken")
        if not next_token:
            break
    return "\n".join(lines)


def _clean_text(text: str) -> str:
    # Collapse runs of whitespace/newlines while preserving paragraph breaks
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    # Remove page-number-only lines (common in PDFs)
    text = re.sub(r"^\s*\d+\s*$", "", text, flags=re.MULTILINE)
    return text.strip()
