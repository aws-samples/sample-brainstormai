# BrainstormAI — Security Scan Summary
Date: 2026-05-13

## Semgrep — Python
**0 actionable findings** (2 false positives)

| Severity | Rule | File | Disposition |
|---|---|---|---|
| WARNING | `dynamic-urllib-use-detected` | `backend/lambdas/ws_authorizer/handler.py:25` | False positive — urllib fetches Cognito JWKS endpoint for JWT validation, URL is a static computed string from env var |
| WARNING | `python-logger-credential-disclosure` | `backend/workers/generation/main.py:303` | False positive — logs an exception message only, no credentials |

## Semgrep — JavaScript
**0 findings.** Clean.

## npm audit — infra/
**1 HIGH** (accepted risk), 0 CRITICAL

| Severity | Package | Issue | Disposition |
|---|---|---|---|
| HIGH | `fast-uri` (inside `aws-cdk-lib`) | Path traversal via percent-encoded dot segments | Accepted risk — `fast-uri` is pinned inside `aws-cdk-lib`'s own dependency tree; not directly patchable from outside. `aws-cdk-lib` was upgraded from 2.160.0 → 2.253.1 to minimize exposure. This is a build-time tool only, never executed in production. |

## npm audit — frontend/
**0 HIGH, 0 CRITICAL.** 2 moderate (transitive, no fix available).

## Trivy — Container images (ingestion + generation)
**0 CRITICAL, 7 HIGH per image** (accepted risk)

All 7 HIGH CVEs are in OS-level Debian packages with **no fix available** in Debian repos as of scan date:

| CVE | Package | Fixed version |
|---|---|---|
| CVE-2026-4878 | libcap2 | No fix |
| CVE-2025-69720 | libncursesw6, libtinfo6, ncurses-base, ncurses-bin | No fix |
| CVE-2026-29111 | libsystemd0, libudev1 | No fix |

Mitigation: `apt-get upgrade -y` is run in both Dockerfiles at build time — these packages will be patched automatically once Debian releases fixes.

## cdk-nag (AWS Solutions checks)
**0 ERRORS, 0 AwsSolutions WARNINGS** after remediation.

All findings were either fixed or suppressed with documented justifications in the CDK stack files.

Fixes applied:
- Cognito password policy now requires symbols
- S3 assets bucket: SSL enforced + server access logging enabled
- All SQS queues: SSL enforced
- Both ECS Dockerfiles: non-root USER added
- aws-cdk-lib upgraded to 2.253.1

## Holmes / Slingshot (Checkov + cfn-guard + Semgrep OSS + ACAT)
**181 total findings across 5 CFN templates. 1 fixed, 180 accepted risk / false positives. 0 unaddressed vulnerabilities.**

Templates re-generated after all remediation. Full findings and dispositions:

### Fixed
| Rule | Finding | Fix applied |
|---|---|---|
| `CLOUDWATCH_LOG_GROUP_RETENTION_PERIOD_CHECK` | Lambda + ECS log groups had no retention policy | Explicit `LogGroup` constructs with `RetentionDays.THREE_MONTHS` added to all Lambda functions and ECS task definitions |

### Suppressed — accepted risk for sample application
| Rule | Resource(s) | Disposition |
|---|---|---|
| `CKV_AWS_119` / `DYNAMODB_TABLE_ENCRYPTED_KMS` | All 7 DynamoDB tables | DynamoDB uses AWS-owned CMK by default (encryption at rest is on). KMS CMK adds ~$1/key/month overhead not warranted for a sample app. Checkov skip metadata added to each table. |
| `CKV_AWS_28` / `DDB3` | All 7 DynamoDB tables | PITR disabled to reduce cost. Production deployments should enable it. Already suppressed in cdk-nag; Checkov skip metadata added. |
| `CKV_AWS_27` / `SQS_QUEUE_KMS_MASTER_KEY_ID_RULE` | All 10 SQS queues | SSE-SQS (AWS-managed) is enabled by default since 2022. `enforceSSL: true` protects data in transit. KMS CMK not required for sample app. Checkov skip metadata added. |
| `LAMBDA_INSIDE_VPC` | 6 API Lambda functions | API Lambdas are sync REST handlers; placing them in a VPC adds NAT Gateway cost and latency with no security benefit when they only call DynamoDB/SQS/S3 (all reachable via VPC endpoints or public AWS endpoints over TLS). ECS workers that handle long-running jobs are already in a private VPC subnet. |
| `LAMBDA_DLQ_CHECK` | 6 API Lambda functions | API Lambdas are synchronously invoked by API Gateway — failures are returned directly to the caller, not dropped silently. DLQs are only meaningful for async/event-source invocations. |
| `LAMBDA_CONCURRENCY_CHECK` | 6 API Lambda functions + WS authorizer | No reserved concurrency set; Lambda scales freely up to account limits. For a sample app this is acceptable. Production deployments should set per-function concurrency limits. |
| `CKV_AWS_116` | 6 API Lambda functions | Same as LAMBDA_DLQ_CHECK above — synchronous invocations do not need DLQs. |
| `AwsSolutions-CFR3` / `AwsSolutions-CFR4` | CloudFront distribution | Access logging and custom SSL cert omitted for sample app. Noted in cdk-nag suppressions. |
| `RDS_MASTER_USER_PASSWORD` | RDS PostgreSQL instance | False positive — CDK uses `{{resolve:secretsmanager:brainstormai/db:SecretString:password}}` dynamic reference. cfn-guard does not recognise this pattern as Secrets Manager-managed and flags it incorrectly. Password is never in plaintext in the template. |
| `generic-api-key` (Semgrep OSS) | S3 asset zip hashes in CFN | False positive — the detected strings are SHA-256 hashes of CDK-bundled Lambda zip files, not API keys or credentials. |
| `SUBNET_AUTO_ASSIGN_PUBLIC_IP` | VPC public subnets | Public subnets have `MapPublicIpOnLaunch: true` by CDK default. NAT Gateway and ECS services run in private subnets only (`assignPublicIp: false`). This is intentional standard VPC design. |
| `NO_UNRESTRICTED_ROUTE_TO_IGW` | VPC route table | Standard 0.0.0.0/0 → IGW route on public subnets — required for NAT Gateway to reach the internet. Private/isolated subnets have no IGW route. |
| `AwsSolutions-RDS3` / `AwsSolutions-SMG4` | RDS + Secrets Manager | Multi-AZ and secret rotation omitted for sample app. Noted in cdk-nag suppressions. |

## CFN Templates for Holmes
Generated CloudFormation templates are in `cdk-synth/`:
- `BrainstormAI-CognitoStack.template.json`
- `BrainstormAI-StorageStack.template.json`
- `BrainstormAI-ComputeStack.template.json`
- `BrainstormAI-ApiStack.template.json`
- `BrainstormAI-FrontendStack.template.json`

## Files to attach to PCSR ticket
| Scanner | File |
|---|---|
| Semgrep (Python) | `semgrep_python.json` |
| Semgrep (JavaScript) | `semgrep_js.json` |
| npm audit (infra) | `npm_audit_infra.json` |
| npm audit (frontend) | `npm_audit_frontend.json` |
| Trivy (ingestion container) | `trivy_ingestion.json` |
| Trivy (generation container) | `trivy_generation.json` |
| CDK Nag / CloudFormation | `cdk-synth/*.template.json` |
