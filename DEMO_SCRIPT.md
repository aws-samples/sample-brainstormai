# BrainstormAI — Demo Script

End-to-end walkthrough with simultaneous AWS Console view.  
**Estimated time: 20–25 minutes**

---

## Before you start

Have these open in separate browser tabs:

| Tab | URL / Location |
|---|---|
| App | Your deployed frontend URL |
| CloudWatch Logs | `/ecs/generation-worker` log group |
| CloudWatch Metrics | BrainstormAI/Generation custom namespace |
| SQS | brainstormai-podcast queue |
| DynamoDB | brainstormai-jobs table |
| S3 | brainstormai-assets-\<account\> bucket |
| ECS | brainstormai cluster → GenerationService |

---

## Act 1 — Upload sources (2 min)

### On the app
1. Create a new notebook: "Machine Learning Fundamentals"
2. Upload two PDFs — different topics (e.g. one on neural networks, one on transformers)
3. Watch the Sources tab — sources show status **INGESTING**, then **READY**

### Simultaneously on console

**SQS → brainstormai-ingestion queue**
- Show the message count tick up to 2 as each source is uploaded
- Refresh — messages disappear within seconds as the ingestion worker picks them up

**CloudWatch Logs → /ecs/ingestion-worker**
- Live tail the log group
- Show lines: `Extracting text`, `Chunking`, `Embedding`, `Storing vectors` per source
- Point out: each source produces ~50 chunks; each chunk is embedded with Titan Embeddings and stored in S3 Vectors

**S3 → brainstormai-assets bucket → chunks/**
- Show a `.json` file appearing (one per source) containing all chunk texts
- Explain: S3 Vectors stores the vector (1024 floats) per chunk; the sidecar JSON in S3 stores the actual text — this is how we stay under the 2KB metadata limit

**What to say:**
> "The ingestion pipeline is fully async. The user uploads a file, gets an immediate response, and the ECS worker processes it in the background. Each source is chunked into ~500-token segments, embedded with Amazon Titan Embeddings v2 into a 1024-dimensional vector, and indexed into an S3 Vectors bucket — one index per notebook. The app polls until both sources are READY before enabling generation."

---

## Act 2 — Generate a podcast (5 min)

### On the app
1. Go to the **Generate** tab
2. Select: Podcast · Important Points · Educational · English
3. Click **Generate podcast**
4. Watch the Jobs table — status shows **QUEUED**, then **RUNNING**

### Simultaneously on console — do this in order

**Step 1 — SQS (first 5 seconds)**
- Open **brainstormai-podcast** queue
- Click "Send and receive messages" → "Poll for messages"
- Show the message arriving with `jobId`, `userId`, `notebookId`, `params`
- Message disappears within seconds (ECS worker picks it up, deletes after processing)

**What to say:**
> "The API Lambda validates the request, checks the daily token budget, atomically increments the running job counter in DynamoDB, writes a QUEUED job record, and drops a message to SQS. The ECS generation worker is long-polling SQS with a 20-second wait time — it picks this up almost instantly."

**Step 2 — DynamoDB (10 seconds in)**
- Open **brainstormai-jobs** table → Explore items
- Find the job by scanning — show `status: RUNNING`, `userId`, `notebookId`, `params`

**What to say:**
> "The worker marks the job RUNNING in DynamoDB immediately. This is what the frontend polls to update the status indicator. It also enforces the concurrency guard — each user can have at most 3 running jobs at once via an atomic counter on a separate DynamoDB table."

**Step 3 — CloudWatch Logs (during generation, ~30–60 seconds)**
- Live tail **/ecs/generation-worker**
- Walk through the key log lines as they appear:

| Log line you'll see | What to say |
|---|---|
| `[job_id] Starting job type=podcast depth=important_points` | "Worker receives the SQS message and begins processing" |
| `[job_id] Querying S3 Vectors top_k=40` | "RAG retrieval — we query the S3 Vectors index with a Titan-embedded query hint. We always fetch 100 vectors (the S3 Vectors max) and filter client-side so no source gets starved" |
| `[job_id] Retrieved 40 chunks from 2 sources` | "Both PDFs contributed chunks — that's the multi-source fix. Each source gets a proportional budget based on how many are in the notebook" |
| `[job_id] Generating podcast script attempt=1` | "Haiku 4.5 receives the 20–40 most relevant chunks and writes the ALEX/SAM script" |
| `[job_id] Validation passed coverage_score=82` | "A second Haiku call acts as a validation agent — it checks how much of the source material made it into the script. Threshold is 70% for important_points. If it fails, we retry with the missing topics injected back into the prompt" |
| `[job_id] Synthesizing TTS for N turns` | "Polly Neural synthesizes each speaker turn separately — Matthew for ALEX, Joanna for SAM — then we concatenate the MP3 chunks and upload to S3" |
| `[job_id] Job completed artifact_id=...` | "Done. Worker writes the artifact to DynamoDB, decrements the running job counter, and sends a WebSocket push to the frontend" |

**Step 4 — S3 (after completion)**
- Go to **brainstormai-assets** bucket → `artifacts/` folder
- Show two files: `<artifactId>.json` (the script) and `<artifactId>.mp3` (the audio)
- Click the .json — show the ALEX/SAM script structure, coverage score, params

**Step 5 — DynamoDB (after completion)**
- Refresh brainstormai-jobs — show `status: COMPLETED`, `artifactId`, `inputTokens`, `outputTokens`
- Open **brainstormai-artifacts** — show the full artifact record with `coverageScore`, `notebookUpdatedAt` (the cache key)

---

## Act 3 — Play the podcast (2 min)

### On the app
1. Click the **Artifacts** tab — show the completed artifact with coverage score badge
2. Click **Play**
3. Podcast starts playing — ALEX and SAM voices alternate

### Simultaneously on console

**WebSocket — CloudWatch Logs → brainstormai-websocket Lambda**
- Show the `start_podcast` action being received
- Show `podcast_turn` events being pushed: `turnIndex: 1`, then `turnIndex: 2`, etc.

**DynamoDB → brainstormai-podcast-sessions**
- Show the session record: `currentTurn`, `totalTurns`, `audioUrls[]`

**What to say:**
> "Playback is also event-driven. The frontend opens a WebSocket connection authenticated by the Cognito JWT. It sends `start_podcast`, and the Lambda pushes the first turn — speaker, text, and a pre-signed S3 URL for the audio. When the audio finishes playing, the frontend sends `resume` and gets the next turn. This is why the audio feels instant — we're streaming turns, not loading the whole thing first."

---

## Act 4 — Demonstrate caching (2 min)

### On the app
1. Go back to Generate tab
2. Select the exact same options: Podcast · Important Points · Educational · English
3. Click Generate again

### Simultaneously on console

**DynamoDB → brainstormai-jobs**
- Show the new job record — `status: COMPLETED`, `cached: true` — appears instantly

**SQS → brainstormai-podcast**
- Show zero messages — nothing was sent to the queue

**What to say:**
> "The cache key is: notebook ID + job type + params + the notebook's `updatedAt` timestamp. If all four match an existing artifact, the API returns COMPLETED immediately — no worker involved, no LLM call, no Polly charge. The artifact tab updates in real time. This is also why we store `notebookUpdatedAt` on every artifact — the moment a user adds a new source, the timestamp changes, the cache is invalidated, and the next generation produces fresh content."

---

## Act 5 — CloudWatch Metrics (2 min)

### On console only

**CloudWatch → Metrics → Custom namespaces → BrainstormAI/Generation**

Show these metrics and narrate:

| Metric | What it shows |
|---|---|
| `JobSuccess` / `JobFailure` (by JobType) | Success rate per artifact type |
| `CoverageScore` (by Depth) | Average content coverage — did the script cover the source material? |
| `ValidationRetries` (by Depth) | How often the first attempt failed the coverage check |
| `JobDurationSeconds` (by JobType) | End-to-end latency per type |
| `TokensInput` / `TokensOutput` (by UserId) | Per-user token spend for cost attribution |

**What to say:**
> "Every job publishes custom metrics to CloudWatch in the BrainstormAI/Generation namespace. We track coverage score per depth level — if in_depth jobs are consistently below threshold, it tells us our chunk retrieval isn't finding enough diverse content. ValidationRetries tells us model quality — a high retry rate means the first generation attempt is missing topics. These are the signals we'd wire into CloudWatch Alarms for production."

---

## Act 6 — Multi-language / genre (1 min)

### On the app
1. Generate a second podcast: Podcast · Brief · Debate · Hindi
2. Show the job queued

**What to say:**
> "The language and genre parameters change the system prompt sent to Haiku 4.5 — debate style uses adversarial framing, sporty uses high-energy language. For Hindi, Polly switches to Kajal, the only Neural Hindi voice available. The ALEX/SAM label rule is enforced in English regardless of language — the parser relies on it."

---

## Questions you'll likely get — brief answers

**Q: Why ECS and not Step Functions?**
> Lambda has a 15-minute timeout. An in-depth podcast with TTS takes 18–20 minutes. Step Functions orchestrates at the infra level — every new artifact type needs a new state machine, new Lambdas, new IAM roles. Our ECS worker uses a code-level dispatch pattern — adding PPT generation is one Python file and three lines of config.

**Q: Why RAG and not just send the whole document?**
> RAG sends 9K tokens per job. Full-document pass-through sends 33K–100K tokens depending on how many PDFs are in the notebook. At 15K jobs/month, RAG is $220/month cheaper than direct LLM — the RAG infrastructure pays for itself. Also, "lost in the middle" — models deprioritize content in the middle of very long contexts.

**Q: Did you test other models?**
> Yes — benchmark results are in `benchmark/benchmark_summary.md`. Haiku 4.5 produced 29 speaker turns vs 9–14 for Nova Pro and Llama 4 Maverick. All four working models passed format validation, but turn count is the strongest proxy for script richness and audio length. Nova Lite costs $9/month at this scale but produces shallow 5-minute scripts — not the product we want to deliver.

**Q: How do you prevent prompt injection from user-uploaded PDFs?**
> Two layers: the chunks are wrapped in `<untrusted_source_chunk>` XML tags with an instruction to treat the content as factual material only, not instructions. And we have a Bedrock Guardrail (`lalac10679yh`) configured with PROMPT_ATTACK at HIGH sensitivity — if a chunk contains adversarial instructions, Bedrock blocks the call entirely and the worker throws a descriptive error.

**Q: What happens if a job gets stuck?**
> SQS visibility timeout is 900 seconds. If the worker crashes mid-job, the message reappears after 15 minutes and a new worker picks it up. After 3 failed attempts, SQS moves the message to the dead-letter queue (`brainstormai-podcast-dlq`). The DynamoDB job record stays in RUNNING — that's a known gap, a stuck-RUNNING cleanup Lambda would be the next reliability improvement.

**Q: How does auto-scaling work?**
> CloudWatch math expressions sum the visible message counts across all 4 generation queues. When the total exceeds a threshold, ECS adds tasks; when it drains to zero, it scales back down. The ingestion worker scales independently off its own queue depth.
