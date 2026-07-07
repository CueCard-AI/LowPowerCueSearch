# Build Tracker

Tracking the 4-build speed+quality batch. Update checkboxes as we go.
Each build: implement → rebuild → swap → verify → document. Verify on a
stable base before starting the next.

See `docs/RESEARCH_LOG.md` for the full idea entries, papers, and rationale.

---

## Build 1 — S9 + E11-B (speed mode) — DONE (S9 shipped, E11-B reverted)

**Goal:** speed-mode snippet quality (S9) + hide classifier latency (E11-B).

**Result:** S9 shipped (compression 20-29ms, no latency cost, sharper writer
context). E11-B reverted — regressed to 24.9-26.8s (z.ai contends concurrent
requests). See `docs/RESEARCH_LOG.md` experiment log.

### S9 — cross-encoder double-duty snippet compression
- [x] Add `compress(query, items, topK)` to `src/lib/reranker/index.ts` —
      reuse the loaded cross-encoder to score each sentence per snippet
      against the query; keep top 2-3 sentences per result.
- [x] Call `compress` from `baseSearch.ts` speed path before returning to
      the writer.
- [x] Verify: speed-mode query — `compress` log line present, compression
      20-29ms, end-to-end 15.2-17.5s (within noise of baseline). Sharper
      writer context confirmed.
- [x] Document: S9 shipped in `RESEARCH_LOG.md` (card format w/ bar chart) +
      `RESEARCH_PIPELINE.md` (diagram + 5.4 bullet).

### E11-B — classify ∥ researcher (speculative parallelism) — REVERTED
- [x] Implemented: start `researcher.research()` in parallel with `classify()`
      using an optimistic classification.
- [x] Measured: **regressed** — 24.9s and 26.8s vs the 15.8s S1 baseline.
      Likely cause: concurrent classify + researcher `streamText` hit z.ai
      simultaneously and the API contends/throttles concurrent requests from
      the same key, slowing both. The "hide classify latency" win assumes the
      LLM API handles concurrency without slowdown; z.ai does not.
- [x] **Reverted.** E11-B is not viable with the current z.ai API behavior.
      Logged as `reverted` in `docs/RESEARCH_LOG.md`. Revisit only if we move
      to an API/endpoint that handles concurrent requests well, or add a
      second API key for the classifier.
- [x] Document: E11-B reverted + rationale in `RESEARCH_LOG.md` (card format
      w/ regression+recovery bar chart).

### Build 1 closeout
- [x] Rebuild image, swap container.
- [x] Speed-mode query end-to-end measurement (vs S1 baseline 15.8s) —
      15.2s/17.5s (S9-only, E11-B reverted).
- [x] Lint clean on all edited files.

---

## Build 2 — E1 (FS-Researcher structured KB + decoupled write) — DONE

**Goal:** biggest quality win — researcher builds a structured knowledge
base; writer composes section-by-section from it (no "premature synthesis").

**Result:** E1 shipped. KB construction uses **Gemini 3.1 Flash Lite** (100%
reliable structured outputs vs ~50% with GLM). 1.1-2.0s per KB, 3-4 notes.
Both test queries (factual + exploratory) produced structured KBs. Writer
composes from structured notes. Also fixed the no-search poem refusal (writer
prompt now says "answer from knowledge without citations" for no-search
queries). Speed mode unaffected (14.2s). See `docs/RESEARCH_LOG.md` E1 card.

---

## Build 3 — E2 (AutoSearch confidence-gated early stop) — PENDING

**Goal:** per-query adaptive stop — intermediate answer + confidence after
each research round; stop when confident.

- [ ] After each research round (balanced/quality), a cheap `generateObject`
      emits `{intermediate_answer, confidence, need_more}`; break on
      `confidence: high`. Keep `maxIteration` as a safety ceiling.
- [ ] Verify: a simple query stops at round 1; a hard one keeps going.
- [ ] Document: E2 shipped + diagram update.

---

## Build 3.5 — Search-o1-style single-stream writer (SPEED MODE ONLY) — DONE

**Goal:** cut speed mode from 3 LLM calls (classify + researcher + writer) to 1-2
(writer with tool-call breaks for SearxNG/widgets). Target: 11-14s. **Achieved.**
**Zero quality degradation** — every current speed-mode feature preserved via tools.

**Result:** Search-o1 shipped. Speed mode: factual 9.2s, broad 21.4s, no-search 4.0s.
Citations preserved. Widgets via tools. Balanced/quality unchanged.
See `docs/RESEARCH_LOG.md` Search-o1 card.

### Architecture

```
SPEED MODE (Search-o1-style, 1-2 LLM calls):
  writer streamText with tools:
    ├─ web_search(queries)           → SearxNG + cross-encoder rerank + S9 compression
    ├─ trigger_weather(location)     → weather widget executor (free API)
    ├─ trigger_stock(symbol)         → stock widget executor (yahoo-finance)
    └─ trigger_calculation(expr)     → calculation widget (mathjs)
  → cited answer OR widget-powered answer

BALANCED/QUALITY (UNCHANGED — full 3+ call pipeline):
  classify → researcher loop → Gemini KB → writer
```

### Quality preservation (how each current feature is kept)

| Current feature | How it's preserved in Search-o1 speed mode |
|---|---|
| Classifier `skipSearch` | Writer decides naturally — if it knows the answer, it writes without searching (0 tool calls). |
| Classifier widget flags | Writer calls `trigger_weather/stock/calculation` tools — same widget executors, triggered by the writer's reasoning instead of the classifier. |
| Classifier `standaloneFollowUp` | Writer reads full chat history + reformulates the search query based on context (prompt instruction). |
| Researcher query generation | Writer's prompt includes SEO-friendly query-generation instructions (copied from the researcher prompt). |
| Researcher 1-iteration search | Writer calls `web_search` once (or 0, or 2+ times — MORE adaptive than fixed 1). |
| S1 cross-encoder rerank | Inside the `web_search` tool — `reranker.rerank()` is called before returning results to the writer. |
| S9 snippet compression | Inside the `web_search` tool — `reranker.compress()` is called on the results. |
| Citations [1][2] | `web_search` returns numbered results; writer cites them. Same format as current. |
| No-search writer fix | Writer's prompt has "answer from knowledge without citations" clause (already shipped). |
| Reasoning trace + progress bar | Writer's `reasoningChunk` streams to UI (same throttled emission as current writer). |

### File-by-file implementation plan

#### 1. `src/lib/agents/search/tools/searchWriterTools.ts` (NEW)
Tool definitions for the Search-o1-style writer. Each tool wraps existing infra.

```typescript
// web_search tool — wraps executeSearch + reranker.rerank + reranker.compress
export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web for information. Provide up to 5 targeted, SEO-friendly queries...',
  schema: z.object({
    queries: z.array(z.string()).describe('Search queries (keywords, not sentences)'),
  }),
};

// trigger_weather tool — wraps the weather widget executor
export const triggerWeatherTool: Tool = {
  name: 'trigger_weather',
  description: 'Get current weather for a location. Use for weather queries.',
  schema: z.object({
    location: z.string().describe('City/region name, e.g. "San Francisco, CA"'),
  }),
};

// trigger_stock tool — wraps the stock widget executor
export const triggerStockTool: Tool = {
  name: 'trigger_stock',
  description: 'Get current stock price for a symbol. Use for stock price queries.',
  schema: z.object({
    symbol: z.string().describe('Stock ticker, e.g. "AAPL"'),
  }),
};

// trigger_calculation tool — wraps the calculation widget
export const triggerCalculationTool: Tool = {
  name: 'trigger_calculation',
  description: 'Evaluate a mathematical expression. Use for math queries.',
  schema: z.object({
    expression: z.string().describe('Math expression, e.g. "25% of 80"'),
  }),
};
```

#### 2. `src/lib/agents/search/tools/searchWriterExecutor.ts` (NEW)
Executes tool calls from the writer. Each function wraps existing infra:

- `executeWebSearch(queries, llm, embedding, session)`:
  - Calls `executeSearch()` from `baseSearch.ts` (SearxNG + batched embeddings + dedup + domain cap).
  - Calls `reranker.rerank()` (S1 cross-encoder, ~120ms).
  - Calls `reranker.compress()` (S9 snippet compression, ~20-29ms).
  - Returns numbered results as `<result index=N title=T>content</result>` for the writer to cite.
  - Emits `searching` + `search_results` subSteps to the session (for the progress bar UI).

- `executeWeatherWidget(location, llm, chatHistory, followUp, session)`:
  - Calls the weather widget's `execute()` directly (the widget already handles location → coordinates → open-meteo API).
  - Emits a `widget` block to the session.
  - Returns `llmContext` string for the writer to incorporate.

- `executeStockWidget(symbol, llm, chatHistory, followUp, session)`:
  - Same pattern — calls the stock widget's `execute()`.
  - Emits a `widget` block.
  - Returns `llmContext`.

- `executeCalculationWidget(expression, llm, chatHistory, followUp, session)`:
  - Calls `mathEval(expression)` directly (mathjs, no LLM needed for the calc itself).
  - Emits a `widget` block.
  - Returns the result string.

#### 3. `src/lib/prompts/search/searchWriterPrompt.ts` (NEW)
The unified prompt for the Search-o1-style speed-mode writer. Combines:

- **Answer-writing instructions** (from the current `writer.ts`):
  - Informative, well-structured, engaging, cited, explanatory.
  - Markdown formatting, headings, no main title, conclusion.
  - Citation requirements ([number] notation).
  - No-search clause ("answer from knowledge without citations").

- **Query-generation instructions** (from the researcher's `webSearch.ts` speed prompt):
  - "Your queries should be keywords that are SEO friendly."
  - "E.g., for 'who is the CEO of Retina Robotics', search 'Retina Robotics CEO'."
  - "Reformulate based on conversation context (if the user says 'how do they work' and the context is about cars, search 'how do cars work')."
  - "Up to 5 queries per search call."

- **Tool-use instructions** (new):
  - "You have tools: web_search, trigger_weather, trigger_stock, trigger_calculation."
  - "If you know the answer, just write it — don't search unnecessarily."
  - "If you need more info, call web_search with targeted queries."
  - "For weather/stock/math queries, use the appropriate tool instead of web_search."
  - "After receiving search results, write your answer with citations."

- **Budget awareness** (BATS-style, E5):
  - "You are in speed mode — be efficient. Search at most twice. If the first
    search gave you enough, write the answer immediately."

#### 4. `src/lib/agents/search/searchWriter.ts` (NEW)
The Search-o1-style writer loop for speed mode. This is the core new code.

```
async function searchWriterStream(session, input):
  1. Build the unified prompt (searchWriterPrompt).
  2. Build the tool list (web_search + 3 widget tools).
  3. Start streamText with tools.
  4. Loop over the stream:
     - If chunk has reasoningChunk → emit to UI (throttled, same as current writer).
     - If chunk has contentChunk → emit to UI (text block, same as current writer).
     - If chunk has toolCallChunk → collect tool calls (same as researcher loop).
  5. After the stream ends (tool calls collected):
     - If no tool calls → the writer answered directly (no search needed). Done.
     - If tool calls present:
       a. Execute each tool call (web_search → executeWebSearch; widgets → executeWidget).
       b. Emit a research block with subSteps (searching, search_results) for the UI.
       c. Build the tool results as messages (role: 'tool', content: results).
       d. Start a SECOND streamText with:
          - The original messages + assistant tool_calls + tool results.
          - The same tools (writer can search again if needed).
          - No tools on the second call (force the writer to answer, not search forever).
       e. Loop over the second stream → emit content + reasoning to UI.
  6. Emit 'researchComplete' + 'end'.
```

Key design decisions:
- **Max 1 search round** in speed mode (the second streamText has no tools → the
  writer MUST write the answer). This bounds the LLM calls to 2 (first stream with
  tools → second stream without tools). If the writer doesn't search (knows the
  answer), it's 1 call.
- **Widget tools are available on both calls** (the writer can trigger a widget
  on the second call if it realizes it needs one). But web_search is only on the
  first call (bounds the search to 1 round).
- **The session emits the same block types** as the current pipeline (text,
  research with subSteps, widget) — the UI doesn't need to change.

#### 5. `src/lib/agents/search/index.ts` (MODIFY)
In `searchAsync`, add a speed-mode branch at the top:

```typescript
async searchAsync(session, input) {
  // ... DB setup (unchanged) ...

  if (input.config.mode === 'speed') {
    // Search-o1-style single-stream writer for speed mode.
    await searchWriterStream(session, input);
    return;
  }

  // ... existing balanced/quality pipeline (classify → researcher → KB → writer) ...
}
```

The balanced/quality pipeline is **completely unchanged**. Only speed mode
takes the new path.

#### 6. `src/lib/agents/search/researcher/index.ts` (MODIFY — revert E2)
Remove the E2 confidence-check block (the Gemini confidence check that was too
conservative). The Search-o1 approach supersedes E2 — the writer decides
naturally when to stop, no separate confidence check needed.

Also remove the E2 `getGeminiModel` import if no longer used (the gap analysis
still uses GLM's `generateObject`, not Gemini).

### Speed budget analysis

```
Current speed mode (3 LLM calls):
  classify (2-4s) + researcher streamText (3-5s) + writer streamText (5-8s)
  + SearxNG (3-5s) + rerank (0.12s) + compress (0.03s)
  = ~15-18s

Search-o1 speed mode (1-2 LLM calls):
  Case 1: writer knows the answer (0 tool calls)
    writer streamText only (5-8s) = ~5-8s
  Case 2: writer needs to search (1 web_search)
    writer streamText #1 with tools (3-5s reasoning + tool call emission)
    + SearxNG (3-5s) + rerank (0.12s) + compress (0.03s)
    + writer streamText #2 without tools (5-8s answer generation)
    = ~11-18s
  Case 3: writer triggers a widget (1 widget call)
    writer streamText #1 with tools (3-5s)
    + widget execution (~1-2s weather/stock, ~0ms calculation)
    + writer streamText #2 without tools (3-5s answer with widget data)
    = ~7-12s

  Target: 11-14s for the search case (Case 2). ✅
  Best case (no search): ~5-8s. Widget case: ~7-12s.
```

### Verification plan

| Test | Query | Expected behavior | Speed target |
|---|---|---|---|
| 1. Factual (search) | "who is the CEO of Retina Robotics?" | Writer reasons → web_search → results → cited answer | 11-14s |
| 2. No-search (knows it) | "what is 2+2?" | Writer answers directly, no tools | 5-8s |
| 3. Creative (no-search) | "write a poem about the ocean" | Writer writes poem, no tools, no citations | 5-8s |
| 4. Weather widget | "what's the weather in San Francisco?" | Writer calls trigger_weather → widget result → answer | 7-12s |
| 5. Stock widget | "how is AAPL doing today?" | Writer calls trigger_stock → widget result → answer | 7-12s |
| 6. Calculation widget | "what is 25% of 80?" | Writer calls trigger_calculation → result → answer | 7-12s |
| 7. Multi-turn context | history about cars → "how do they work?" | Writer reformulates → searches "how do cars work" → answer | 11-14s |
| 8. Quality check | "who is the CEO of Retina Robotics?" | Correct answer (Maanav Iyengar), citations [1][2] present | — |
| 9. Balanced (unchanged) | same factual query in balanced | Full pipeline still works (classify → researcher → KB → writer) | ~60-90s |

### Quality checks per test

For each test, verify:
- [ ] Correct answer (factual accuracy).
- [ ] Citations present and correct ([N] references matching sources).
- [ ] Widget data correct (weather/stock/calc values match the API).
- [ ] No-search queries produce answers (no refusal).
- [ ] Speed mode log shows `searchWriter` path (not the classify→researcher path).
- [ ] Balanced/quality mode still uses the full pipeline (no regression).

### Documentation plan

- [ ] RESEARCH_LOG.md: Search-o1 shipped card with bar chart (speed: 15-18s → 11-14s).
- [ ] RESEARCH_PIPELINE.md: new diagram for speed mode (Search-o1-style) + algorithm catalog entry.
- [ ] BUILD_TRACKER.md: Build 3.5 done.
- [ ] README.md: update speed-mode description + diagram.
- [ ] ONBOARDING.md: update algorithm catalog + pipeline diagram.
- [ ] Rules: update research-pipeline.mdc with Search-o1 speed-mode pattern.
- [ ] E2 logged as "superseded by Search-o1 speed mode" (the writer decides when to stop, no separate confidence check).

### Risks + mitigations

| Risk | Mitigation |
|---|---|
| Writer generates poor search queries | Prompt includes SEO-friendly query instructions from the researcher prompt. Tune if needed. |
| Writer doesn't call tools when it should | Prompt says "if you need more info, you MUST call web_search." Test + tune. |
| Writer calls web_search too many times | Second streamText has no web_search tool → writer MUST answer after 1 search. |
| Widget tool interface mismatch | Widget executors expect `WidgetInput` (classification, chatHistory, followUp, llm). The tool executor wraps this — constructs a synthetic `WidgetInput` from the tool call args. |
| Tool-call handling bugs in the streamText loop | Model the loop after the researcher's tool-call handling (which works). Test thoroughly. |
| Citation format mismatch | `web_search` returns numbered `<result index=N>` blocks — same format the current writer expects. |
| Session block emission differs | Use the same block types (text, research/subSteps, widget) as the current pipeline. UI doesn't change. |
| Balanced/quality regression | Speed mode takes a separate branch at the top of `searchAsync`. Balanced/quality code is untouched. |

---

## Build 5 — BATS harness + reduced iterations + fewer queries — DONE

**Goal:** balanced mode → ~40s, quality mode → max 4-5 min.

**Result:** Shipped. Three code-level changes + prompt influencer:
- `maxIteration`: balanced 6→3, quality 25→10 (hard code ceiling).
- Dynamic tool removal on last iteration (code arbiter — removes search tools,
  forces `done`).
- Prompt influencer: `<research_status>` block injected each iteration with
  remaining calls + gathered summary (informational, helps the model plan).
- Queries per web_search: balanced 5→3 (hard code constraint).
- Balanced: 107s (2 research rounds used — SearxNG was slow due to captcha).
  Speed: 9.0s (unchanged). The 107s is SearxNG-dependent, not iteration-dependent.
  With 3 max iterations (was 6), the ceiling is halved — worst case is bounded.

---

## Build 6 — Speed mode → Gemini 3.1 Flash Lite + thought_signature fix — DONE

**Goal:** Switch the speed-mode chat model from GLM-4.5-air to Gemini 3.1
Flash Lite for higher throughput/concurrency on the `/api/enrich` path
(target: 1000 leads in ~10 min). Required fixing Gemini's
`thought_signature` requirement for round-tripping tool calls.

**Result:** Shipped. Speed mode now uses `models/gemini-3.1-flash-lite`.

### Change — MODE_MODEL_MAP speed entry
- [x] `src/lib/models/modeModels.ts`: `speed` →
      `{ providerType: 'gemini', key: 'models/gemini-3.1-flash-lite' }`
      (was `glm-4.5-air`).

### Fix — Gemini thought_signature round-trip (tool calls)
Gemini's OpenAI-compatible endpoint requires that when an assistant
message containing `tool_calls` is sent back to the model, each tool_call
carries the `thought_signature` that was returned on the streaming delta.
Without it the API returns `400: Function call is missing a
thought_signature in functionCall parts`. GLM didn't need this.

- [x] `src/lib/models/types.ts`: add `thoughtSignature?: string` to `ToolCall`.
- [x] `src/lib/models/providers/openai/openaiLLM.ts` `streamText`: capture
      `delta.tool_calls[].extra_content.google.thought_signature` per
      tool-call (Gemini sends `index: null`, so fall back to
      `recievedToolCalls.length` as the bucket key) and attach it to the
      yielded `toolCallChunk`.
- [x] `src/lib/models/providers/gemini/geminiLLM.ts`: override
      `convertToOpenAIMessages` to re-attach
      `extra_content.google.thought_signature` on assistant tool_calls
      when `tc.thoughtSignature` is present.
- [x] `src/lib/agents/search/searchWriter.ts` + `enrichmentAgent.ts`:
      propagate `tc.thoughtSignature` into the `finalToolCalls` array
      that gets pushed back as the assistant message.

### Verification (speed mode, post-fix)
- [x] UI `/api/chat` (speed): factual 1s, funding-news 6s (w/ search),
      poem 1s. Answers + citations correct.
- [x] `/api/enrich` (speed): Anthropic 5s / 1762 chars / 8 sources / 6
      citations; OpenAI 5s / 1571 chars / 8 sources / 7 citations.
- [x] Lint clean on all edited files.

### Tradeoff (noted)
Gemini Flash Lite is a non-thinking model — it does **not** emit
`reasoning_content`. Speed mode therefore loses the streaming reasoning
trace it had under GLM-4.5-air (the UI "Thinking" step + the `reasoning`
array in `/api/enrich` will be empty for speed). This is acceptable for
the scale target (throughput > trace). Balanced/quality still emit
reasoning via the researcher loop.

---

## Build 7 — Enrich resilience + load test — DONE (fixes shipped; scaling infra pending)

**Goal:** Hardening for `/api/enrich` at scale (target: 1000 leads / 10 min). Two
app-layer fixes + a concurrency load test to size the pod fleet and surface
the real ceiling.

### Fix 1 — requireSearch prompt (quality win)
- [x] `src/lib/prompts/search/searchWriterPrompt.ts`: `getSearchWriterPrompt`
      now takes `opts.requireSearch`. When true (enrichment path), the prompt
      mandates a `web_search` call before answering and forbids answering
      from internal knowledge (training data is stale for funding/news/leadership).
- [x] `src/lib/agents/search/enrichmentAgent.ts`: passes `requireSearch: true`.
- **Effect:** when search returns nothing, the model now honestly says
  "search tool did not return current data" instead of fabricating a
  confident un-cited answer. Critical for enrichment trustworthiness.

### Fix 2 — retryStream (resilience)
- [x] New `src/lib/models/retryStream.ts`: wraps an async generator and
      retries the underlying call only if it throws **before** yielding the
      first chunk (covers network/RPM errors at connection setup — e.g.
      Gemini "fetch failed" under concurrency — without risking double-emit).
- [x] Wired into `enrichmentAgent.runSearchWriter` around both `streamText` rounds.
- **Effect:** eliminated the `500: fetch failed` responses (30/30 succeeded
  vs 29/30 before).

### Reverted — nudge retry (counterproductive)
- Initial attempt: if round 0 produced no tool calls, nudge with a system
  reminder and re-run. **Reverted** — under load the retried call also
  skipped tools (Gemini degraded), and the extra LLM call worsened RPM
  pressure + added 15–38s timeouts. Reliable tool-calling under load is an
  infrastructure problem (paid Gemini + bounded concurrency), not a prompt
  problem.

### Load test findings (single pod + single SearxNG, speed/Gemini Flash Lite)
| Concurrency | Throughput | Success | Avg sources | Notes |
|---|---|---|---|---|
| 10 (pre-fix) | 0.87 req/s | 100% | 8.0 | all cited |
| 16 (pre-fix) | 1.55 req/s | 100% | ~4 (mixed) | near target |
| 30 (pre-fix) | 2.14 req/s | 96.7% | **0.0** | writer fabricated from memory |
| 30 (post-fix) | 0.79 req/s | **100%** | 1.6 | honest "search failed" instead of fabricate |

**Key conclusions:**
1. **The 30-concurrent headline throughput was a quality mirage** — it was
   fast because the writer skipped search and answered from memory. The
   requireSearch prompt exposed this (honest failures > confident fabrications).
2. **Single-IP SearxNG is the binding constraint.** All three useful engines
   (Google CSE, Brave, DDG) get throttled within ~30 concurrent requests
   from one IP and take 3+ min to recover (Google captcha bans can last
   hours). **Confirms the rotating-residential-proxy pool is mandatory** for
   any sustained concurrency — this is the next infra build.
3. **Gemini free-tier RPM is the second ceiling** — causes "fetch failed"
   (now retried) and degraded tool-calling at ~30 concurrent. Paid tier +
   bounded per-pod concurrency (~10–12) is the fix.
4. **Quality-sustaining per-pod throughput is ~0.87–1.55 req/s** (10–16
   concurrent). To hit 1.67 req/s with citations, scale horizontally
   (2+ pods) at safe per-pod concurrency, not higher per-pod concurrency.

### Next (infrastructure phase)
- [ ] Local embeddings (transformers.js) — removes Gemini embedding API from hot path.
- [ ] SearxNG pool + rotating residential proxy (`outgoing.proxies` in settings.yml).
- [ ] Wider engine allowlist (re-enable startpage/mojeek/qwant) for diversity.
- [ ] Bounded concurrency at app layer (`p-limit` ~10–12 per pod).
- [ ] K8s manifests (app Deployment + HPA, SearxNG Deployment + Service, Secrets).
- [ ] Paid Gemini tier for RPM headroom.

> Note: the local SearxNG is currently IP-banned across all engines from
> aggressive load testing — needs a cooldown/restart or a proxy before
> further local concurrency tests are meaningful.

---

## Build 8 — Local embedder for the enrich hot path — DONE

**Goal:** Remove the Gemini `gemini-embedding-001` API calls from the
`/api/enrich` hot path (2 calls/search) so enrichment has one fewer
rate-limited dependency + lower latency under concurrency. Step 1 of the
`docs/SCALE_AND_DEPLOYMENT.md` deployment sequence.

**Result:** Shipped. `/api/enrich` now embeds queries/results with a local
transformers.js model (`Xenova/all-MiniLM-L6-v2`, 384-dim, ~87MB fp32)
loaded from bundled ONNX weights. Chat/search routes keep using Gemini
embedding so the uploads feature (persisted 768-dim chunk embeddings)
stays consistent.

### Changes
- [x] `src/lib/models/localEmbeddingModel.ts` (new): `getLocalEmbeddingModel()`
      — `globalThis`-cached singleton, offline load (`env.allowRemoteModels =
      false`), warmup, returns `null` on failure (failure cached so we don't
      retry the slow load every request). Mirrors the reranker pattern.
- [x] `src/lib/models/modeModels.ts`: added `LOCAL_EMBEDDING_MODEL` constant
      (documentary; the route uses the helper directly).
- [x] `src/app/api/enrich/route.ts`: loads the local embedder first; falls
      back to `EMBEDDING_MODEL` (Gemini) if it returns `null`.
- [x] `src/instrumentation.ts`: prewarms the local embedder alongside the
      reranker at server startup.
- [x] `Dockerfile` + `Dockerfile.slim`: bundle `Xenova/all-MiniLM-L6-v2`
      weights to `/home/vane/models/embedder/` (same `curl` pattern as the
      reranker). Slim image also got the reranker bundle it was missing +
      `curl` in its second stage.

### Why only the enrich route
Speed mode + `/api/enrich` never run uploads search (no `fileIds`), so
switching their embeddings to a 384-dim local model is safe. The uploads
**search** path uses `additionalConfig.embedding`, and uploads **write**
uses a UI-selected Gemini model — persisted chunk embeddings are 768-dim.
Switching the global `EMBEDDING_MODEL` would break `computeSimilarity`
(dimension mismatch). Keeping chat/search on Gemini preserves uploads.
See the embedding-persistence audit (subagent `66f24448`).

### Verification
- [x] Image bundles weights: `ls /home/vane/models/embedder/onnx/model.onnx`
      → 87M.
- [x] Instrumentation prewarm: `local-embedder: loaded from
      /home/vane/models/embedder` at startup.
- [x] Isolated embed test (in-container, no SearxNG): dim=384,
      cos(related)=0.6855 > cos(unrelated)=0.0669. PASS.
- [x] Solo `/api/enrich`: route loads local embedder, no fallback triggered,
      no errors (SearxNG still IP-banned → honest "search returned no
      results" answer; requireSearch prompt working).
- [x] Lint clean on all edited files.

### Tradeoff
MiniLM-L6-v2 (384-dim) is a smaller model than Gemini embedding-001
(768-dim) — slightly lower embedding quality for dedup/evidence retrieval.
Acceptable for the enrich hot path (the cross-encoder reranker, a separate
stronger model, does the final relevance ordering). If dedup quality
regresses, switch to `Xenova/bge-base-en-v1.5` (768-dim, ~110MB) — same
wiring, bigger bundle.

---

## Status legend

- `[ ]` not started
- `[~]` in progress
- `[x]` done
- `[!]` blocked / regressed — fix before next build
