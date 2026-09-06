# GPT-5.6 Luna AI review layer

This layer is deliberately **read-only with respect to investment logic**.
It does not modify Ranking V2, Leader, RS20, combined timing, Scout, the
strategy registry, Simulation V1/V2, or either existing OOS ledger.

## Flow

1. The existing home page renders its normal 🔥 핵심 / ⭐ 강한 candidates.
2. `public/home-ai-review.js` observes the rendered order and sends the visible
   shortlist (up to 16 candidates) to `/api/ai-review`.
3. The server keeps each individual `gpt-5.6-luna` Structured Outputs call at
   five candidates maximum. A full 16-name shortlist is therefore reviewed as
   `5 + 5 + 5 + 1` parallel Luna sub-batches and recombined in the original
   dashboard order.
4. Results are cached as one review set by signal date + visible candidate-code
   order, so reloads do not create repeat API charges. `AI_REVIEW_MAX_DAILY_BATCHES`
   counts these review sets, not the internal Luna sub-calls.
5. The UI mirrors each available AI verdict into the existing candidate cell;
   clicking the verdict opens the Bull / Bear / Risk detail dialog.

## OOS isolation

AI results are stored only in:

- `ai-review-cache.json`
- `ai-review-history.jsonl`
- `ai-review-summary.json`

under `DASHBOARD_DATA_DIR`.

A history row is written only when the request describes today's confirmed
`EOD_FULL` snapshot after the KRX close. Missed days are never back-filled.
All reviewed candidates in that eligible shortlist are recorded individually.
`/api/ai-review/summary` joins those immutable AI decisions to the existing
`strategy-oos-history.jsonl` future outcomes for 3D/5D/10D reporting. It never
writes to the strategy OOS file.

## Required environment

```text
OPENAI_API_KEY=...
AI_REVIEW_ENABLED=1
AI_REVIEW_MODEL=gpt-5.6-luna
AI_REVIEW_REASONING_EFFORT=low
AI_REVIEW_MAX_TOTAL_CANDIDATES=16
AI_REVIEW_MAX_CANDIDATES=5
AI_REVIEW_MAX_DAILY_BATCHES=3
AI_REVIEW_TIMEOUT_MS=60000
```

`AI_REVIEW_MAX_TOTAL_CANDIDATES` is the visible shortlist limit. The existing
`AI_REVIEW_MAX_CANDIDATES=5` remains the safe per-Luna-call chunk size, so a
production environment that already has the old 5-candidate setting does not
need to change that value.

The production service already loads `/etc/portfolio-dashboard.env`, so the key
belongs there and must not be committed to GitHub.

## Bootstrap wrappers

To keep the existing large files byte-identical, the original blobs are retained
as `server-core.mjs` and `public/index-entry-review-core.js`. The original paths
are thin wrappers that preload the AI extension and then import the preserved
core implementation. This makes rollback trivial and prevents accidental edits
to Ranking/OOS logic as part of the AI integration.
