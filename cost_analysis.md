# BrainstormAI - Cost Analysis

**Assumed usage:** 100 DAU · 15,000 jobs/month · mix: 50% podcast, 25% mindmap, 25% quiz  
**Region:** us-east-1

---

## 1. Our System (RAG + LLM + TTS)

### Per-job cost breakdown (podcast, important_points depth)

| Component | What it does | Tokens / Units | Rate | Cost |
|---|---|---|---|---|
| Titan Embeddings (query) | Embed the user query for RAG retrieval | ~50 tokens | $0.02/1M tokens | $0.000001 |
| S3 Vectors (QueryVectors) | Retrieve top-100 chunks | 1 API call | $0.004/1K queries | $0.000004 |
| Claude Haiku 4.5 (generation) | Write script from 20 chunks | ~9K in / ~1.1K out | $0.80+$4.00/1M | $0.01161 |
| Claude Haiku 4.5 (validation) | Coverage check + scoring | ~10K in / ~0.5K out | $0.80+$4.00/1M | $0.01000 |
| Amazon Polly Neural (TTS) | Convert script to audio | ~8,000 chars | $16/1M chars | $0.00013 |
| ECS Fargate (worker time) | ~60s at 1 vCPU / 4 GB | - | $0.04048/vCPU-hr | $0.00067 |
| **Total per podcast job** | | | | **~$0.022** |

> Mindmap/quiz/summary jobs skip Polly TTS - cost is ~$0.021/job (LLM + validation only).

---

### Monthly cost at 15,000 jobs

| Service | Calculation | Monthly Cost |
|---|---|---|
| **Claude Haiku 4.5 - generation** | 15K jobs × $0.01161 | $174 |
| **Claude Haiku 4.5 - validation** | 15K jobs × $0.01000 | $150 |
| **Amazon Polly TTS (neural)** | 7,500 podcast jobs × 8K chars avg = 60M chars | $960 |
| **ECS Fargate - generation worker** | 15K jobs × 60s × 1vCPU/4GB | $22 |
| **ECS Fargate - ingestion worker** | 300 sources/mo × 30s × 0.5vCPU/2GB | $1 |
| **Titan Embeddings** | 15K queries + 300 ingestions × 50 chunks × 500 tokens | <$1 |
| **S3 Vectors** | 15K queries + ~15K vectors stored | <$1 |
| **S3 Storage** | ~80GB audio + PDFs + chunks | $2 |
| **DynamoDB (on-demand)** | Jobs, notebooks, artifacts, sources | $5 |
| **API Gateway** | 100 DAU × 20 calls/day × 30 days = 60K calls | <$1 |
| **Cognito** | 100 MAU (free tier: first 50K MAU) | $0 |
| **SQS** | 4 queues × 15K messages (free tier: first 1M) | $0 |
| **CloudWatch Logs** | Worker logs, Lambda logs | $2 |
| **Total** | | **~$1,317/month** |

**Per-job average: ~$0.088**  
**Per-user per month: ~$13.17** (at 150 jobs/user/month)

---

## 2. Comparative Scenarios

### Scenario A - Direct LLM + TTS (same output, no RAG)

Same as our system but replace S3 Vectors + embeddings with full-document pass-through.

| Item | Our RAG System | Direct LLM + TTS |
|---|---|---|
| LLM generation | $174 (9K tokens in) | $396 (33K tokens in) |
| Validation agent | $150 | $150 |
| Polly TTS | $960 | $960 |
| ECS Fargate | $22 | $22 |
| RAG infrastructure | ~$2 | $0 |
| Other infra | ~$10 | ~$10 |
| **Total** | **$1,318** | **$1,538** |

**RAG is $220/month cheaper than direct LLM for the same audio output quality.**  
The savings come from reducing input tokens 73% (33K → 9K) per job.

---

### Scenario B - Step Functions instead of ECS

Replace SQS + ECS with Step Functions orchestrating Lambda functions.

| Item | SQS + ECS (current) | Step Functions + Lambda |
|---|---|---|
| Orchestration | SQS ~$0 | $0.025/1K transitions × 5 steps × 15K jobs = $1.875 |
| Compute | ECS $22/month | Lambda: 15K × 120s × 1GB = $37/month (>15-min jobs fail) |
| Long jobs (in_depth) | Handled (no timeout) | ❌ Lambda 15-min limit kills 18-min in_depth jobs |
| Retry logic | Worker-level, content-aware | Infra-level only - can't inject missing_points feedback |
| **Total compute** | **$22** | **$37–$50** |

Step Functions adds orchestration cost (+$2/month) and removes the ability to run jobs longer than 15 minutes, while being more expensive per invocation. Marginal orchestration cost is 0.15% of total system cost - not worth the architectural trade-off.

---

