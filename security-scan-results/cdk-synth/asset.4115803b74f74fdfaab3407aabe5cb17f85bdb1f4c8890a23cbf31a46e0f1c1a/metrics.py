"""
CloudWatch custom metrics emitter for the generation worker.

Namespace: BrainstormAI/Generation

Metrics published per job:
  - TokensInput        (Count)  — LLM input tokens consumed
  - TokensOutput       (Count)  — LLM output tokens produced
  - JobDurationSeconds (Seconds) — wall-clock job time
  - ValidationRetries  (Count)  — number of validation retries needed (0, 1, or 2)
  - CoverageScore      (None)   — 0-100 coverage score from validation agent
  - JobSuccess         (Count)  — 1 on success
  - JobFailure         (Count)  — 1 on failure

All metrics carry dimensions: JobType, Depth.
TokensInput / TokensOutput also carry a UserId dimension so per-user spend is queryable.
"""

import logging
import os

import boto3

log = logging.getLogger(__name__)
cw = boto3.client("cloudwatch", region_name=os.environ.get("AWS_REGION", "us-east-1"))

NAMESPACE = "BrainstormAI/Generation"


def emit_job_metrics(
    *,
    user_id: str,
    job_type: str,
    depth: str,
    input_tokens: int,
    output_tokens: int,
    duration_seconds: float,
    validation_retries: int,
    coverage_score: int,
    success: bool,
):
    base_dims = [
        {"Name": "JobType", "Value": job_type},
        {"Name": "Depth", "Value": depth},
    ]
    user_dims = base_dims + [{"Name": "UserId", "Value": user_id}]

    metric_data = [
        # Token usage — also per-user for cost attribution
        {
            "MetricName": "TokensInput",
            "Dimensions": user_dims,
            "Value": input_tokens,
            "Unit": "Count",
        },
        {
            "MetricName": "TokensOutput",
            "Dimensions": user_dims,
            "Value": output_tokens,
            "Unit": "Count",
        },
        # Job performance
        {
            "MetricName": "JobDurationSeconds",
            "Dimensions": base_dims,
            "Value": duration_seconds,
            "Unit": "Seconds",
        },
        {
            "MetricName": "ValidationRetries",
            "Dimensions": base_dims,
            "Value": validation_retries,
            "Unit": "Count",
        },
        {
            "MetricName": "CoverageScore",
            "Dimensions": base_dims,
            "Value": coverage_score,
            "Unit": "None",
        },
        # Success / failure counters — used for CloudWatch alarms
        {
            "MetricName": "JobSuccess" if success else "JobFailure",
            "Dimensions": base_dims,
            "Value": 1,
            "Unit": "Count",
        },
    ]

    try:
        cw.put_metric_data(Namespace=NAMESPACE, MetricData=metric_data)
    except Exception as e:
        # Metrics are non-critical — log and continue
        log.warning("Failed to emit CloudWatch metrics: %s", e)
