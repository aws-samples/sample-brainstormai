# Model Benchmark Results

**Run date:** 2026-05-04  
**Source material:** PagedAttention ML paper (20 chunks, same as production)  
**Script:** `run_benchmark.py` — pulls real S3 chunks, scores format validity, turn count, latency, cost

## Results

| Model | Format Valid | Turns | Latency | Cost/job | Monthly (15K jobs) |
|---|---|---|---|---|---|
| Amazon Nova Lite | YES | 13 | 4.2s | $0.00062 | $9.30 |
| Llama 4 Maverick 17B | YES | 14 | 2.7s | $0.00212 | $31.80 |
| Amazon Nova Pro | YES | 9 | 3.4s | $0.00761 | $114.15 |
| **Claude Haiku 4.5 (current)** | **YES** | **29** | 12.6s | $0.01161 | $174.15 |

> Haiku 3.5 and 3 are blocked — AWS marks them legacy and requires explicit activation after 30 days idle.

## Why Claude Haiku 4.5

- **Highest turn count (29)** — most natural, conversational scripts; translates to 15–18 min audio
- **Cheaper alternatives produce shallower scripts** — Nova Lite (13 turns) and Llama 4 (14 turns) yield ~5–8 min audio
- **All 4 working models pass format validation** — ALEX/SAM structure holds across providers
- **Cost delta is justified** — $174/month vs $9/month at 15K jobs; quality gap is significant
- **Instruction following** — Haiku 4.5 consistently respects the no-preamble, no-title, ALEX/SAM-only rules

## Scoring Criteria

- `format_valid` — ≥95% of non-empty lines match `ALEX:` or `SAM:` pattern
- `turn_count` — number of distinct speaker turns parsed
- `latency_s` — wall-clock seconds to full streamed response
- `cost_usd` — calculated from reported input/output token counts at published Bedrock pricing
