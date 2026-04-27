# BrainstormAI

An AWS-native platform that turns your documents into podcasts, mind maps, quizzes, and summaries using generative AI.

Built by Hima Varshini Parasa (hvparasa@)

---

## What it does

Upload PDFs, URLs, or plain text into a **notebook**. BrainstormAI ingests and embeds your sources, then lets you generate:

- **Podcast** — a two-speaker conversational audio episode (TTS via Amazon Polly Neural), with genre (educational / debate / sporty), language, and depth controls
- **Mind Map** — an interactive, expandable node graph you can explore branch by branch
- **Quiz** — a scored multiple-choice quiz with explanations
- **Summary** — a concise written overview of the source material

Each artifact goes through a RAG pipeline (pgvector similarity search) and a validation agent that checks coverage and retries generation if key points are missing.

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
    ├── S3  ──── source files, audio segments, artifact JSON
    ├── DynamoDB ── notebooks, sources, jobs, artifacts, WS connections
    └── SQS queues (podcast / mindmap / quiz / summary)
              │
              ▼
         ECS Fargate workers
              │
              ├── Ingestion worker
              │     PDF/URL/text extract → chunk → Titan embed → pgvector (RDS)
              │
              └── Generation worker
                    RAG retrieve → Claude generation agent
                    → Claude validation agent (retry up to 2×)
                    → post-process (Polly TTS / JSON schema)
                    → S3 + DynamoDB → WebSocket notify
```

**AWS services used:** Cognito, API Gateway (REST + WebSocket), Lambda, S3, DynamoDB, SQS, ECS Fargate, ECR, RDS (PostgreSQL + pgvector), Bedrock (Claude Sonnet, Titan Embeddings), Polly Neural TTS, CloudFront, CloudWatch

---

## Project structure

```
brainstormAI/
├── frontend/          React + Cloudscape UI (Vite)
├── backend/
│   ├── lambdas/       API handlers (notebooks, sources, jobs, artifacts, websocket)
│   └── workers/
│       ├── ingestion/ PDF/URL/text extract, chunk, embed
│       └── generation/ RAG, generation agents, TTS, metrics
└── infra/             AWS CDK stacks (TypeScript)
```

---

## Infrastructure (CDK)

| Stack | What it provisions |
|---|---|
| `CognitoStack` | User Pool + App Client |
| `StorageStack` | S3 bucket, DynamoDB tables, RDS + pgvector, VPC |
| `ApiStack` | REST API Gateway + Lambda handlers, WebSocket API |
| `ComputeStack` | ECS Fargate cluster, ingestion + generation services, SQS queues |
| `FrontendStack` | S3 static hosting + CloudFront distribution |

---

## Generation pipeline

1. **Retrieve** — embed the job's query hint with Titan, cosine-similarity search top-K chunks from pgvector
2. **Generate** — Claude produces the artifact grounded in retrieved chunks
3. **Validate** — Claude checks coverage against source chunks; if score < threshold, retry with missing points (up to 2 retries)
4. **Post-process** — Polly TTS for podcasts; JSON schema validation for mind maps and quizzes
5. **Store** — artifact written to S3 + DynamoDB; user notified via WebSocket

---

## Depth settings

| Depth | Podcast | Mind Map / Quiz |
|---|---|---|
| Brief | ~5 min | Concise |
| Important Points | ~10 min | Key points |
| In-Depth | ~20 min | Comprehensive |

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

## Token usage tracking

Every completed job stores `inputTokens` and `outputTokens` on its DynamoDB record, keyed by `jobId` (UUID). The `/usage` API endpoint aggregates these by date and artifact type. Pass `?notebookId=<id>` to scope results to a single notebook.

Daily limit: 3,000,000 tokens per user (checked at job creation time and enforced by the generation worker).
