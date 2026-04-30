# BrainstormAI

An AWS-native platform that turns your documents into podcasts, mind maps, quizzes, and summaries using generative AI.

Built by Hima Varshini Parasa (hvparasa@)

---

## What it does

Upload PDFs, URLs, or plain text into a **notebook**. BrainstormAI ingests and embeds your sources, then lets you generate:

- **Podcast** — a two-speaker conversational audio episode (TTS via Amazon Polly Neural), with genre (educational / debate / sporty), language, and depth controls
- **Mind Map** — an interactive, expandable node graph with uncapped depth — the tree grows as deep as the content warrants
- **Quiz** — a scored multiple-choice quiz with explanations
- **Summary** — a concise written overview of the source material

Each artifact goes through a RAG pipeline (S3 Vectors similarity search) and a validation agent that checks coverage and retries generation if key points are missing.

Identical jobs are cached: if you generate the same artifact type with the same parameters for a notebook whose sources have not changed, the existing artifact is returned instantly with no LLM call.

---

## Architecture

```
Browser (React + Cloudscape)
    │
    ▼
API Gateway (REST + WebSocket)
    │
    ├── Lambda handlers
    │     notebooks / sources / jobs / artifacts / websocket
    │
    ├── S3  ──── source files, chunk text sidecars, audio segments, artifact JSON
    ├── DynamoDB ── notebooks, sources, jobs, artifacts, WS connections
    ├── S3 Vectors ── per-notebook vector indexes (one index per notebook)
    └── SQS queues (podcast / mindmap / quiz / summary)
              │
              ▼
         ECS Fargate workers
              │
              ├── Ingestion worker
              │     PDF/URL/text extract → chunk → Titan embed
              │     → S3 Vectors (vectors) + S3 (chunk texts)
              │
              └── Generation worker
                    RAG retrieve → Claude generation agent
                    → Claude validation agent (retry up to 2×)
                    → post-process (Polly TTS / JSON schema)
                    → S3 + DynamoDB → WebSocket notify
```

**AWS services used:** Cognito, API Gateway (REST + WebSocket), Lambda, S3, S3 Vectors, DynamoDB, SQS, ECS Fargate, ECR, Bedrock (Claude Haiku 4.5, Titan Embeddings v2, Guardrails), Polly Neural TTS, CloudFront, CloudWatch

---

## Project structure

```
brainstormAI/
├── frontend/          React + Cloudscape UI (Vite)
├── backend/
│   ├── lambdas/       API handlers (notebooks, sources, jobs, artifacts, websocket)
│   └── workers/
│       ├── ingestion/ PDF/URL/text extract, chunk, embed, S3 Vectors storage
│       └── generation/ RAG retrieval, generation agents, TTS, metrics
└── infra/             AWS CDK stacks (TypeScript)
```

---

## Infrastructure (CDK)

| Stack | What it provisions |
|---|---|
| `CognitoStack` | User Pool + App Client |
| `StorageStack` | S3 bucket, DynamoDB tables, S3 Vectors bucket, VPC |
| `ApiStack` | REST API Gateway + Lambda handlers, WebSocket API |
| `ComputeStack` | ECS Fargate cluster, ingestion + generation services, SQS queues |
| `FrontendStack` | S3 static hosting + CloudFront distribution |

---

## Vector storage

Each notebook gets its own S3 Vectors index (`index_name == notebook_id`). Vector keys are formatted as `{source_id}#{chunk_index}`. Only small scalar metadata (source_id, chunk_index, token_count) is stored in the vector index; full chunk texts are stored in S3 as `chunks/{source_id}.json` sidecars and fetched at retrieval time (S3 Vectors enforces a 2048-byte metadata limit per vector).

---

## Generation pipeline

1. **Retrieve** — embed the job's query hint with Titan Embeddings v2, cosine-similarity search top-K chunks from S3 Vectors, distributed evenly across sources
2. **Generate** — Claude Haiku 4.5 produces the artifact grounded in retrieved chunks
3. **Validate** — Claude checks coverage against source chunks; if score < threshold, retry with missing points (up to 2 retries)
4. **Post-process** — Polly Neural TTS for podcasts; JSON schema validation for mind maps and quizzes
5. **Cache** — artifact stored with `notebookUpdatedAt` as cache key; identical future requests return the cached artifact instantly
6. **Store** — artifact written to S3 + DynamoDB; user notified via WebSocket

---

## Artifact caching

Cache key: `notebookId + jobType + params + notebookUpdatedAt`

- Cache **hit**: job is immediately marked COMPLETED pointing at the existing artifact — no LLM call, no queue
- Cache **miss**: normal generation flow runs and stamps `notebookUpdatedAt` on the new artifact
- Cache **invalidation**: adding or deleting any source bumps `notebook.updatedAt`, automatically invalidating all cached artifacts for that notebook

---

## Depth settings

| Depth | Podcast | Mind Map / Quiz |
|---|---|---|
| Brief | ~5 min | Concise (2 levels) |
| Important Points | ~10 min | Key points (3 levels) |
| In-Depth | ~20 min | Uncapped — as deep as content warrants |

---

## Supported languages (podcast)

English, Hindi, Mandarin, Spanish, French

---

## UI navigation

The app uses a persistent sidebar with two top-level sections:

- **My Notebooks** — list, create, and open notebooks
- **Usage** — global token usage dashboard with day-wise pie charts across all notebooks

Inside each notebook there are five tabs: Sources, Generate, Artifacts, Summary, and Usage. The notebook Usage tab shows the same day-wise breakdown scoped to jobs in that notebook only.

---

## Security

**Prompt injection protection** — source content (from PDFs, URLs, and text) is treated as untrusted data throughout the pipeline:

- All chunks are wrapped in `<untrusted_source_chunk>` XML tags with an explicit instruction to the model to treat the content as data, not instructions
- Every LLM call passes through a Bedrock Guardrail (`lalac10679yh`) with `PROMPT_ATTACK` detection at HIGH sensitivity — if an injection attempt is detected, the job fails with a clear error rather than producing compromised output

**URL validation** — only HTTPS URLs are accepted; private/internal IP ranges and the EC2 metadata endpoint are blocked before any fetch is attempted.

---

## Token usage tracking

Every completed job stores `inputTokens` and `outputTokens` on its DynamoDB record, keyed by `jobId` (UUID). The `/usage` API endpoint aggregates these by date and artifact type. Pass `?notebookId=<id>` to scope results to a single notebook.

Daily limit: 3,000,000 tokens per user (checked at job creation time and enforced by the generation worker).
