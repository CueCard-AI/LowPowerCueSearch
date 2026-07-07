# New-Agent Onboarding

> Read this first. It orients you on what this codebase is, the mental model,
> the invariants you must not break, and the operational loop. It is written for
> an AI agent (or human) about to make changes to LowPowerCueSearch.

## What this is

A **zero-cost, Perplexity-style AI search engine**. A user query flows through
classification, an agentic research loop, result selection/reranking, optional
scraping + evidence retrieval, and a final cited answer. Two axes matter for
every change: **speed** and **quality**, controlled by the optimization mode.

Stack: **GLM via z.ai** (chat/research/writer) + **Gemini** (embeddings,
free tier) + **self-hosted SearxNG** (web search). No paid APIs.

## The mental model (pipeline)

Speed mode and balanced/quality use **different architectures**:

```
SPEED MODE (Search-o1-style, 1-2 LLM calls):
  writer streamText with tools:
    ├─ web_search(queries) → SearxNG + cross-encoder rerank + S9 compression (S13: top 8)
    ├─ trigger_weather(location) → weather widget
    ├─ trigger_stock(symbol) → stock widget
    └─ trigger_calculation(expr) → calc widget
  → 2nd streamText (no tools, thinking disabled) → cited answer OR widget answer

BALANCED/QUALITY (3+ LLM calls):
query
  │
  ▼
classify ──► { skipSearch, sources, widgets, standaloneFollowUp }
  │
  ├─ widgets ───────────────► widgetContext      ┐
  │   (parallel)                                 │  → writer
  └─ researcher loop ──────► searchFindings      ┘
       plan → web_search(5) → reflect → ...
         per query: SearxNG → batched embed → sim>0.5 filter
         merge → dedup>0.75 → domain cap 2/host → rerank (cross-encoder ∥ LLM-fallback)
         balanced: scrape top3 → evidence retrieval (top3 passages)
         quality:  scrape + per-chunk fact extraction
       │
       ├─ balanced/quality: Gemini 3.1 Flash Lite → structured KB (E1)
       ▼
writer (streamText) ──► cited answer  (+ reasoning_content → UI trace)
```

Entry point: `src/app/api/chat/route.ts` → `SearchAgent.searchAsync`
(`src/lib/agents/search/index.ts`). The deep reference is
[RESEARCH_PIPELINE.md](RESEARCH_PIPELINE.md). For production scaling
(K8s, SearxNG proxy pool, sizing, cost), see
[SCALE_AND_DEPLOYMENT.md](SCALE_AND_DEPLOYMENT.md).

## Mode → model mapping (hardcoded — do not bypass)

`src/lib/models/modeModels.ts`. The mode picked in the UI determines the chat
model; the client's model selection is **ignored**.

| Mode | Chat model | Reason trace | Iterations | Enrichment |
|---|---|---|---|---|
| speed | `gemini-3.1-flash-lite` | no | 1-2 (Search-o1) | web_search tool + S9 + S13 top-8 |
| balanced | `glm-4.6` | no | 3 (BATS) | scrape top3 + evidence retrieval + Gemini KB + drafter/verifier |
| quality | `glm-5.2` | yes | 10 (BATS) | scrape + per-chunk extraction + Gemini KB + drafter/verifier |

Embeddings are always Gemini `gemini-embedding-001`. z.ai serves **no** GLM
embeddings — never substitute one.

## Algorithm catalog (what already exists — check before adding)

All in `src/lib/agents/search/researcher/actions/search/baseSearch.ts` unless
noted:

- **Search-o1-style single-stream writer (speed mode)** — `src/lib/agents/search/searchWriter.ts`.
  The speed-mode writer has tools (`web_search` + widget tools). It reasons →
  calls `web_search` → gets results → writes the answer. 1-2 LLM calls instead
  of 3. The `web_search` tool wraps SearxNG + cross-encoder rerank (S1) +
  snippet compression (S9) + top-8 cap (S13). Widget tools wrap the existing
  widget executors. Thinking is disabled on the answer-generation call (cuts
  ~39s → ~11s). Factual: 9.2s, broad: 21.4s, no-search: 4.0s.
- **Local CPU cross-encoder reranking (S1)** — `src/lib/reranker/index.ts`.
  Bundled `ms-marco-MiniLM-L-6-v2` cross-encoder, prewarmed at startup via
  `src/instrumentation.ts`, shared via `globalThis`. ~120ms for 20 candidates.
  LLM-as-judge fallback (`llmFallback.ts`) if the model isn't ready.
- **Cross-encoder snippet compression (S9)** — `reranker.compress()` reuses S1's
  loaded cross-encoder to keep top 2 query-relevant sentences per snippet (speed
  mode, ~20-29ms). No LLM call, no latency cost.
- **Structured knowledge base via Gemini (E1)** — `buildKnowledgeBase()` in
  `src/lib/agents/search/index.ts` uses **Gemini 3.1 Flash Lite** (not GLM) for
  the `generateObject` call. Google enforces `response_format: json_schema` →
  100% reliable. The writer composes section-by-section from the KB. Balanced/
  quality only. Falls back to raw blob if Gemini is unavailable.
- **Batched embeddings** — `embedText([q])` + one `embedText(allContents)`.
- **Similarity filter** `> 0.5`, **dedup** `> 0.75`.
- **Domain cap** — max 2 results per hostname.
- **Snippet-level evidence retrieval** (balanced) — top 3 passages per scraped
  page by query similarity.
- **Result cap** — top 20 per query, top 20 per `web_search` call.
- **Query expansion** — up to 5 queries per `web_search`
  (`researcher/actions/search/webSearch.ts`).
- **Gap-driven refinement** (`researcher/index.ts`) — after round 0 in
  balanced/quality, `{covered, missing, next_queries}` is injected as guidance.
- **Multi-hop chaining** (`src/lib/prompts/search/researcher.ts`) — prompts
  instruct: pursue candidate entities found in results.
- **`__reasoning_preamble` plan tool** (`researcher/actions/plan.ts`).
- **BATS harness: code arbiter + prompt influencer** — `maxIteration` reduced
  (balanced 3, quality 10). On the last iteration, search tools are removed
  (code-enforced — the model can only call `done`). A `<research_status>` block
  is injected into the prompt each iteration (remaining calls + gathered summary)
  — informational, helps the model plan. Queries per web_search: balanced 3.
  Design: code = arbiter (reliable), prompt = influencer (informational).

## Invariants you must not break

1. **Zero-cost.** No paid APIs. SearxNG + Gemini free tier + GLM via z.ai.
2. **No keys in source.** API keys live in `config.json` in the `vane-data`
   volume. Never in `.ts`, `.env`, or the Dockerfile.
3. **`generateObject` on GLM disables thinking + tolerates fences.** GLM wraps
   JSON in ```json fences; `.parse()` rejects them. The override in
   `src/lib/models/providers/glm/glmLLM.ts` uses `.create()` +
   `repairJson({ extractJson: true })` + `thinking: { type: 'disabled' }` +
   `safeParse` (with `lenient` flag for callers that can handle raw objects).
   The `streamText` override supports `disableThinking: true` for the Search-o1
   writer's answer-generation call (cuts ~39s → ~11s). Keep both overrides.
4. **Gemini for structured outputs, GLM for prose.** z.ai doesn't enforce
   `response_format: json_schema` (~50% reliable with GLM). Google does (100%).
   Use Gemini (e.g. `gemini-3.1-flash-lite`) for `generateObject` calls that
   need reliable JSON (KB construction, and potentially classifier/widgets).
   Use GLM for `streamText`/`generateText` (prose tasks). See E1 in
   `docs/RESEARCH_LOG.md`.
5. **Reasoning trace stays.** `streamText` yields `reasoningChunk` (from
   `delta.reasoning_content`). The UI trace depends on it. Don't strip it.
   Throttle `session.updateBlock` in per-chunk loops (≥64 chars between emits).
6. **Speed mode does not trade robustness for speed.** Speed wins come from
   parallelism, CPU work (cross-encoder), caching, and better algorithms —
   never from dropping the LLM classifier, weakening dedup, or reducing engine
   diversity. Rejected: S12 (google-only), S7 (heuristic classifier), S8-dedup
   (URL-only). See `docs/RESEARCH_LOG.md`.
7. **Every external call has a `try/catch` fallback.** SearxNG timeout → fall
   back to similarity order; scrape failure → keep snippet; cross-encoder
   failure → LLM rerank fallback; Gemini KB failure → raw blob. The pipeline
   degrades, never hard-crashes.
8. **No N+1 external calls.** Batch embeddings/API calls; don't
   `await Promise.all(arr.map(async x => await fetch(...)))` over a known set.
9. **Serial LLM calls on z.ai (not parallel).** z.ai contends concurrent
   requests from one key — E11-B (classify ∥ researcher) regressed to 24.9-26.8s
   vs 15.8s serial. Don't add concurrent LLM calls to the same key.

## The skills/rules system (auto-loads in Cursor)

- **Auto skills**: `ml-search-pipeline` (editing search code), `quality-coding`
  (editing source), `documentation` (editing docs), `experiment-logging`
  (editing experiment logs — cards + bar charts).
- **Explicit skill**: `vane-ops` (name it for Docker/ops work).
- **Always-on rules**: `zero-cost-constraint`, `quality-coding`,
  `documentation`, `experiment-logging`.
- **File-scoped rules**: `research-pipeline` (`src/lib/agents/search/**`),
  `glm-provider` (`src/lib/models/providers/glm/**`), `searxng`
  (`searxng/**`), `docker-ops` (`Dockerfile*` etc.).

If you introduce a new invariant, add a rule in `.cursor/rules/`. If you add a
new operational workflow, add a skill in `.cursor/skills/`.

## How to make a change (checklist)

- [ ] Lint clean (`ReadLints` on edited files).
- [ ] No new paid dependency.
- [ ] Speed mode didn't gain an LLM round-trip.
- [ ] Every new external call has a fallback.
- [ ] No N+1 external calls.
- [ ] Pipeline/UI-flow change → update `RESEARCH_PIPELINE.md` **with a diagram**.
- [ ] Key/config change → in the volume, not source.
- [ ] New model/provider → `modeModels.ts` or the provider's default list is in
      sync with what the API actually serves (curl-verify).
- [ ] File-level header + JSDoc on new pipeline-public exports.

## How to run / verify

```bash
docker build -t vane-glm .                       # slow (~10-30 min export)
docker stop vane-glm && docker rm vane-glm
docker run -d -p 4567:3000 -v vane-data:/home/vane/data --name vane-glm vane-glm
docker logs --tail 30 vane-glm
```

Hard-refresh http://localhost:4567 (Cmd+Shift+R). Run a speed-mode query to
confirm the pipeline before declaring done. Full ops reference:
[RUNBOOK.md](RUNBOOK.md).

## Common pitfalls (real bugs we hit)

- **N+1 embedding calls** — 21 per-result `embedText` calls. Batch them.
- **`chat.completions.parse()` on GLM** — strict-parses before fence-repair.
  Use `.create()` + `repairJson`.
- **GLM doesn't enforce `response_format: json_schema`** — returns markdown or
  mismatched JSON ~50% of the time. **Solution: use Gemini for structured
  outputs** (Google enforces the schema 100%). See E1 / the Gemini-for-
  structured-outputs pattern in the invariants above.
- **z.ai contends concurrent requests** — E11-B (classify ∥ researcher)
  regressed to 24.9-26.8s vs 15.8s serial. z.ai throttles concurrent calls from
  one key. **Serial LLM calls are faster than parallel** with a single key.
- **Reasoning-update flood → browser "Aw Snap"** — calling `session.updateBlock`
  on every `reasoningChunk` (thousands of tiny chunks) floods the client with
  full-array patches → renderer OOM. Throttle (≥64 chars between emits) + final
  flush.
- **GLM bare-list rerank** — GLM ignores `{ ranking: number[] }` and returns
  `"0, 1, 3, 2..."`. Use `generateText` + parse integers. (Now superseded by S1's
  cross-encoder which doesn't have this issue.)
- **No-search writer refusal** — the writer prompt required citations for every
  sentence, but poems/greetings/math have no sources. **Fixed**: added an "answer
  from knowledge without citations" clause for no-search queries.
- **Residential-IP SearxNG captcha** — most engines get captcha'd. `google` +
  `brave` are the reliable ones. Don't assume a failing engine is a config bug —
  test it directly (see RUNBOOK).
- **`1211 Unknown Model`** — a model id isn't on the endpoint you're using
  (e.g. `glm-5.2` needs the coding endpoint; `embedding-3` doesn't exist on
  z.ai at all; `glm-5.2[1m]` is a Claude-Code alias, not a raw API id).

## First tasks to orient yourself

1. Read [RESEARCH_PIPELINE.md](RESEARCH_PIPELINE.md) end to end.
2. Read the `ml-search-pipeline` skill (auto-loads when you open search files).
3. Trace one query: `route.ts` → `searchAsync` → `classify` → `research()` →
   `executeSearch` → `writer`.
4. Run a query in each mode and watch `docker logs -f vane-glm`.
