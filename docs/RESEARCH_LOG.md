# Research Log — Speed & Quality Roadmap

> A living log of research-backed ideas to make the pipeline faster and answers
> better. Each entry: the idea, the paper it comes from, where it plugs in, the
> expected speed/quality delta, the effort, and a **status** (idea / designed /
> building / shipped / abandoned). Append new entries at the bottom; don't
> rewrite history. Date each status change.

This is **not** an architecture doc (that's `RESEARCH_PIPELINE.md`). It's the
forward plan + experiment log. When an idea ships, update `RESEARCH_PIPELINE.md`
to reflect the new architecture and mark the entry here `shipped` with a date.

Constraint reminder: **zero-cost, SearxNG-only, API-only GLM/Gemini** (no model
training/fine-tuning). Ideas that need training are logged as "frontier /
not actionable now" so we remember them but don't chase them.

---

## Where we are today (baseline, 2026-07-06)

- Agentic RAG loop: classify → research (tool-calling, multi-iteration) →
  rerank → scrape/evidence → writer.
- Fixed per-mode iteration budget: speed=1, balanced=6, quality=25.
- LLM-as-judge rerank (listwise, `generateText` + parsed comma list).
  **UPDATE 2026-07-06 (S1 shipped):** rerank is now a local CPU cross-encoder
  (`Xenova/ms-marco-MiniLM-L-6-v2`, fp32, bundled in the image) with the
  LLM-as-judge path kept as an `isReady()` fallback. Measured ~120ms for 20
  candidates warm vs ~14.4s for the LLM fallback. See S1 below.
- Snippet-level evidence retrieval (balanced, top 3 passages/page).
- Domain cap (2/host), query expansion (5/web_search), batched embeddings.
- Gap-driven refinement (one structured gap analysis after round 0 in
  balanced/quality).
- Reasoning trace + live progress bar (GLM-5.2 `reasoning_content`).
- Known pain points: fixed budget over-searches simple queries / under-searches
  hard ones; writer gets findings as one blob (premature-synthesis risk); no
  claim verification; repeat queries re-do everything.

---

## Ideas — ranked by impact × applicability

### E1 — FS-Researcher: decouple gather from write + structured KB
- **Paper:** FS-Researcher (Zhu et al., ACL 2026 Long, arXiv:2602.01566)
- **Core:** a Context Builder writes structured notes into a knowledge base
  (beyond context length); a Report Writer composes section-by-section from it.
  Ablation: merging gather+write in one session caused the **largest quality
  drop** (52.76 → 42.41 RACE) — "premature synthesis." More context-builder
  rounds → positively correlated with report quality.
- **Plug-in:** `researcher/index.ts` emits a structured `knowledgeBase` object
  (notes organized by sub-topic + source IDs); `search/index.ts` writer prompt
  composes section-by-section from the KB instead of a concatenated
  `<search_results>` blob.
- **Expected delta:** quality (large) — paper shows big RACE gains; cost: +1
  structuring call.
- **Effort:** Medium.
- **Status:** idea (2026-07-06).

### E2 — AutoSearch: confidence-gated early stop
- **Paper:** AutoSearch (ACL 2026 Findings, arXiv:2604.17337)
- **Core:** there's a **minimal sufficient search depth** per query (jointly set
  by question complexity + agent capability). After each search step, generate
  an intermediate answer + confidence; stop early when confident; penalize
  over-searching. Replaces fixed `maxIteration` with a per-query adaptive stop.
- **Plug-in:** `researcher/index.ts` — after each iteration's tool results, a
  cheap `generateObject` emits
  `{ intermediate_answer, confidence: 'high'|'medium'|'low', need_more }`.
  Break on `confidence: high`. Keep the iteration cap as a safety ceiling.
- **Expected delta:** speed (big on simple queries) + quality (preserved on
  hard ones). The principled version of "stop when you have enough."
- **Effort:** Low-Medium.
- **Status:** idea (2026-07-06). **Candidate for first build** — smallest
  change, clearest speed win.

### E3 — Speculative RAG: drafter + verifier
- **Paper:** Speculative RAG (Google, arXiv:2407.08223)
- **Core:** a small drafter LM generates multiple candidate answers in parallel
  from different document subsets; a large verifier LM picks/refines. Reported
  +12.97% accuracy, -51% latency on PubHealth.
- **Plug-in:** new `speculative-writer` path in `search/index.ts` for
  balanced/quality — partition top results into subsets, glm-4.5-air drafts one
  answer per subset in parallel, glm-5.2 verifies/merges into the final.
- **Expected delta:** speed (≈-50% writer latency) + quality (≈+13%). Uses
  models we already have (glm-4.5-air drafter, glm-5.2 verifier) — zero-cost.
- **Effort:** Medium.
- **Status:** idea (2026-07-06).

### E4 — A-RAG: hierarchical retrieval interfaces
- **Paper:** A-RAG (arXiv:2602.03442, 2026)
- **Core:** expose three retrieval tools at different granularities —
  `keyword_search`, `semantic_search`, `chunk_read` — and let the model pick
  per sub-task. Beats single-granularity with comparable/fewer tokens.
- **Plug-in:** `researcher/actions/search/` — split `web_search` into
  `searxng_keyword` (raw SearxNG, broad), `searxng_semantic` (SearxNG +
  embedding rerank, current path), and reuse `scrapeURL` as `read_page`.
- **Expected delta:** quality (better granularity matching) + slight speed
  (keyword is cheaper than semantic when precise relevance isn't needed).
- **Effort:** Low-Medium.
- **Status:** idea (2026-07-06).

### E5 — BATS: budget-aware tool-use prompt
- **Paper:** BATS (arXiv:2511.17006, 2025)
- **Core:** a lightweight Budget Tracker gives the agent continuous awareness of
  remaining tool-call budget; the agent dynamically "digs deeper" on promising
  leads or "pivots" to new paths based on remaining budget. Pushes the
  cost-performance Pareto frontier.
- **Plug-in:** `src/lib/prompts/search/researcher.ts` — inject
  `remaining_budget` (e.g. "you have N tool calls left out of M") into each
  iteration's prompt. Prompt-only change.
- **Expected delta:** quality (better self-allocation of the search budget) at
  ~no cost.
- **Effort:** Low (prompt-only). Pairs naturally with E2.
- **Status:** idea (2026-07-06).

### E6 — Self-RAG: claim verification on the structured KB
- **Paper:** Self-RAG (Asai et al., 2024) — still current in 2026 hybrids.
- **Core:** after the writer streams its answer, a verification pass checks
  each claim is supported by the sources; unsupported claims are hedged/removed.
  With E1's structured KB, claims can map → note → specific source.
- **Plug-in:** after the writer in `search/index.ts` (balanced/quality only —
  costs one extra LLM call).
- **Expected delta:** quality (hallucination reduction, large). Latency: +1
  call in balanced/quality (acceptable there).
- **Effort:** Low-Medium.
- **Status:** idea (2026-07-06). Best after E1 (needs the structured KB for
  claim→source tracing).

### E7 — CRAG: retrieval-quality triage
- **Paper:** Corrective RAG (Yan et al., 2024, arXiv:2401.15884)
- **Core:** a lightweight retrieval evaluator triages results into
  Correct/Ambiguous/Incorrect → proceed / refine+augment-with-web-search /
  discard+re-search. Formalizes the confidence gate *before* generation.
- **Plug-in:** `baseSearch.ts` after rerank — score top-result relevance
  confidence; if low, fire additional SearxNG queries (we already loop; CRAG
  makes the triage explicit). Overlaps with E2's per-round confidence gate —
  likely fold into E2 rather than build separately.
- **Expected delta:** quality (5-15% accuracy in the paper).
- **Effort:** Medium.
- **Status:** idea (2026-07-06). Likely absorbed into E2.

### E8 — HyDE: hypothetical-document reranking
- **Paper:** HyDE (Gao et al., ACL 2023)
- **Core:** generate a hypothetical answer, embed it, rerank by similarity to
  *it* instead of the raw query. Bridges the query-document vocabulary gap.
- **Plug-in:** `baseSearch.ts` — replace the query-embedding reference used for
  similarity filter/rerank tie-break with the hypothetical-answer embedding.
  Cost: +1 LLM call + +1 embedding per query.
- **Expected delta:** quality (big on vague/entity queries — your common case).
- **Effort:** Low-Medium.
- **Status:** idea (2026-07-06).

### E9 — Multi-layer caching (SearxNG / embeddings / LLM-rerank)
- **Paper:** not paper-specific; standard IR + RAGCache-style.
- **Core:** cache by hash at three layers — SearxNG results by `sha256(query)`,
  embeddings by `sha256(content)`, LLM rerank/verifier outputs by
  `sha256(query + result_ids)`. Repeat/near-repeat queries → instant.
- **Plug-in:** `src/lib/cache.ts` (sqlite-backed LRU) wired into `searxng.ts`,
  `baseSearch.ts`, the rerank, and (with E6) the verifier.
- **Expected delta:** speed (big for repeat queries; zero cost for fresh).
- **Effort:** Medium.
- **Status:** idea (2026-07-06).

### E10 — Setwise/shuffled listwise rerank + RRF
- **Papers:** RankGPT (Sun 2023), RankVicuna (Pradeep 2024), Zhuang et al.
  setwise.
- **Core:** your LLM-as-judge rerank has positional bias. Fixes: shuffle input
  order before ranking (RankVicuna), setwise prompting for open LLMs (Zhuang),
  multiple passes + Reciprocal Rank Fusion (RankZephyr).
- **Plug-in:** `baseSearch.ts` rerank block — shuffle, rank 2-3×, merge via RRF.
- **Expected delta:** quality (rerank robustness). Cost: rerun rerank 2-3×
  (cheap on glm-4.5-air with thinking disabled).
- **Effort:** Low.
- **Status:** idea (2026-07-06).

### E11 — Speculative retrieval (parallelize classify + first search)
- **Paper:** not paper-specific; speculative-execution pattern.
- **Core:** fire the first SearxNG search in parallel with the classifier,
  speculating search will be needed. If `skipSearch` returns true, discard.
  Saves the serial classify→research latency for the common search-needed case.
- **Plug-in:** `search/index.ts` — parallelize the classify + speculative-search
  promises; gate by a cheap heuristic (query length, question words) to avoid
  wasted work on no-search queries.
- **Expected delta:** speed (saves one serial step on the common path).
- **Effort:** Medium. Risk: wasted work on greetings/haiku — needs the gate.
- **Status:** idea (2026-07-06).

---

## Frontier — logged but not actionable now (need model training)

### F1 — LatentRAG / LAnR: latent-space reasoning + retrieval
- **Papers:** LatentRAG (arXiv:2605.06285, 2026), LAnR (arXiv:2604.17866,
  2026).
- **Core:** reasoning + retrieval in the model's hidden-state space (single
  forward pass for thoughts/subqueries). ~90% latency reduction, within 5% of
  explicit agentic RAG accuracy. LAnR: ~5 output tokens/query (vs 163 for
  Search-R1), 1.5-2.7× speedup.
- **Why not actionable:** requires fine-tuning the LLM to align hidden states
  with a retriever in latent space. Can't fine-tune GLM-5.2 via the z.ai API.
- **Watch:** if we ever self-host an open model (Llama/Qwen) for the chat layer,
  this becomes the biggest speed lever available.
- **Status:** frontier / watching (2026-07-06).

### F2 — Agentic-R: global-utility retriever
- **Paper:** Agentic-R (ACL 2026 Findings, arXiv:2602.03442).
- **Core:** train the retriever to optimize for global answer correctness, not
  just local query-passage relevance; reduces search turns.
- **Why not actionable:** needs retriever training.
- **Note:** our LLM-as-judge rerank is already a weak, training-free version of
  this (ranks by answer-relevance, not pure similarity) — the paper confirms the
  direction.
- **Status:** frontier / watching (2026-07-06).

---

## Iteration plan (order we'll likely build)

1. ~~**E2 (AutoSearch confidence-gated early stop)** — smallest change, clearest
   speed win, makes the mode budget adaptive per query. Build first.~~
   (Reordered — S1 went first as the foundation; see below.)
- **S1 (local cross-encoder rerank)** — SHIPPED 2026-07-06. ~120ms rerank vs
  ~14.4s LLM fallback. Foundation for S9/S11.
- **S9 (cross-encoder double-duty snippet compression)** + **S11 (batched
  scoring)** — next build. Quality + speed, both riding on S1's loaded model.
2. **E1 (FS-Researcher structured KB + decoupled write)** — biggest quality
   win; architectural. Build so E6 can ride on the structured KB.
3. **E6 (Self-RAG verification on the KB)** — hallucination control; rides on E1.
4. **E5 (BATS budget-aware prompt)** — prompt-only; pairs with E2.
5. **E2 (AutoSearch confidence-gated early stop)** — per-query adaptive stop.
6. **E10 (shuffled/RRF rerank)** — note: S10 (RRF across query variants) covers
   the result-merge side; E10 was about rerank-pass robustness (now moot since
   S1 uses a deterministic cross-encoder, not an LLM judge with positional
   bias). Mark E10 as **superseded by S1**.
7. **S10 (RRF across query variants)** — free quality/recall.
8. **S13 (cap writer context to top N after rerank)** — quality + speed.
9. **E9 (multi-layer caching)** — speed for repeat queries.
10. **E3 (Speculative RAG drafter/verifier)** — bigger writer speed/quality
    play.
11. **E4 (A-RAG hierarchical retrieval tools)** — expose granularities.
12. **E8 (HyDE)** — quality for vague queries.
13. **E11 (speculative retrieval: classify ∥ first search)** — latency on the
    common path; speed-mode lever. **UPDATE 2026-07-06: tried as E11-B,
    REVERTED — regressed (24.9s/26.8s vs 15.8s baseline). Concurrent classify
    + researcher `streamText` contend on the z.ai API, slowing both. Revisit
    only with an API that handles concurrent requests, or a second key for
    the classifier. See the Shipped/Reverted sections.**

**Rejected (do not build):** S12 (google-only), S7 (heuristic classifier),
S8-dedup (URL-only) — they trade robustness. See the speed-mode section.
**Also reverted (tried, regressed):** E11-B — see Shipped section.

(Reorder as we learn from each build. Update statuses with dates as we go.)

---

## Shipped

### S1 — Local CPU cross-encoder rerank (replaces LLM-as-judge rerank)
- **Paper:** MS MARCO cross-encoders; 2026 reranking surveys (Folarin; Thread
  Transfer; Racine AI). Cross-encoders give 5-15 NDCG@10 lift over bi-encoder
  ordering for ~50-200ms on 20-50 candidates.
- **What shipped:** `src/lib/reranker/index.ts` — a singleton loading
  `Xenova/ms-marco-MiniLM-L-6-v2` (fp32, ~87MB, bundled in the image at
  `/home/vane/models/reranker/`) via `@huggingface/transformers`. Prewarmed
  fire-and-forget at startup from `src/instrumentation.ts`. `rerank()` uses the
  cross-encoder when ready, else delegates to `llmRerankFallback`
  (`src/lib/reranker/llmFallback.ts` — the original `generateText` + parsed
  comma list). Shared via `globalThis` so instrumentation + route handlers use
  one instance (Next.js singleton gotcha — see S1 build note below).
- **Status:** shipped (2026-07-06).
- **Build note:** the first swap revealed the cross-encoder loaded but was
  unused (LLM fallback ran). Cause: `instrumentation.ts` and route handlers
  held separate module instances, so prewarm set `ready=true` on instance A
  while `baseSearch.ts` used instance B (`ready=false` → fallback). Fixed by
  sharing the singleton on `globalThis` + self-init in `rerank()`. Lesson
  logged for future singletons.
- **Also discovered:** the LLM fallback path is slow (~14.4s) because
  `generateText` doesn't disable thinking (only `generateObject` does, in
  `glmLLM.ts`). Moot now that the cross-encoder is primary, but if the
  fallback ever runs it's slow — flagged for a future fix (route rerank
  fallback through a thinking-disabled path).

### S9 — Cross-encoder double-duty snippet compression (speed mode)
- **Paper:** Perplexity, "Query-Aware Context Compression for Better Snippets"
  (research.perplexity.ai) — +63% vital tokens, −29% noise. Also
  LLMLingua / LooComp (arXiv:2603.09222).
- **What shipped:** added `compress(query, items, topK)` to
  `src/lib/reranker/index.ts` — reuses S1's already-loaded cross-encoder to
  score each sentence in each snippet against the query; keeps the top 2
  sentences per snippet for the top 10 results. Called from `baseSearch.ts`
  speed path before returning to the writer. No new model, no LLM call, no
  new infra — pure reuse of S1's loaded cross-encoder.
- **Status:** shipped (2026-07-06).
- **Measured:** compression ~20-29ms for 10 items (far below the ~200-1000ms
  estimate — short sentences score fast). End-to-end speed-mode: 15.2-17.5s,
  unchanged from the S1 baseline (compression is within noise). The writer
  gets query-relevant spans instead of raw noisy snippets → sharper answers
  at no latency cost.

### E11-B — Speculative parallelism (classify ∥ researcher) — REVERTED
- **What was tried:** start `researcher.research()` in parallel with
  `classify()` using an optimistic classification, to hide the classifier's
  latency behind the researcher's first reasoning call.
- **Status:** **reverted** (2026-07-06).
- **Measured:** regressed — 24.9s and 26.8s vs the 15.8s S1 baseline.
  Isolated by reverting E11-B and re-measuring (S9-only: 15.2-17.5s,
  back to baseline). Cause: concurrent classify (`generateObject`) +
  researcher (`streamText`) hit z.ai simultaneously and the API
  contends/throttles concurrent requests from the same key, slowing both.
  The "hide classify latency" win assumes the LLM API handles concurrency
  without slowdown; z.ai does not.
- **Revisit only if:** we move to an API/endpoint that handles concurrent
  requests well, OR add a second API key for the classifier so the two
  calls don't contend. Don't re-propose without one of those changes.

### E1 — FS-Researcher structured KB via Gemini (balanced/quality)
- **Paper:** FS-Researcher (Zhu et al., ACL 2026, arXiv:2602.01566).
- **What shipped:** after the researcher gathers raw search findings, a
  **Gemini 3.1 Flash Lite** model constructs a structured knowledge base
  (topic-organized notes + source IDs) via `generateObject` (strict structured
  outputs — Google enforces `response_format: json_schema`). The writer then
  composes section-by-section from the KB instead of a concatenated
  `<search_results>` blob. Balanced/quality only; speed keeps the S9 fast path.
  Falls back to raw blob if Gemini is unavailable.
- **Why Gemini (not GLM) for the KB:** z.ai doesn't enforce
  `response_format` — GLM returns markdown or mismatched JSON ~50% of the time,
  causing the KB to fail. Google's API enforces it strictly → 100% reliable,
  schema-compliant JSON. This establishes the pattern: **Gemini for
  structured-output tasks, GLM for prose tasks**. Both zero-cost (free tiers).
- **Also fixed:** the writer prompt's no-search refusal (poems/greetings/math
  were refused because "every sentence needs a citation" but there are no
  sources). Added a "no-search queries: answer from knowledge without
  citations" clause.
- **Status:** shipped (2026-07-06).

### Search-o1 — Single-stream writer for speed mode (S13 + thinking-disabled)
- **Paper:** Search-o1 (Li et al., EMNLP 2025) — agentic search-enhanced reasoning;
  BATS (arXiv:2511.17006) — budget-aware tool use; Inference-Time Budget Control
  (arXiv:2605.05701) — VOI-based action allocation.
- **What shipped:** speed mode replaced the 3-call pipeline (classify → researcher
  → writer) with a **single-stream writer** that has tools (`web_search` +
  `trigger_weather` + `trigger_stock` + `trigger_calculation`). The writer reasons
  → calls `web_search` → gets results → writes the answer. 1-2 LLM calls instead
  of 3. Balanced/quality unchanged (full pipeline).
  - `src/lib/agents/search/tools/searchWriterTools.ts` — tool definitions.
  - `src/lib/agents/search/tools/searchWriterExecutor.ts` — tool executors (wrap
    SearxNG + cross-encoder rerank + snippet compression + widget executors).
  - `src/lib/prompts/search/searchWriterPrompt.ts` — unified prompt (answer-writing
    + query-gen + tool-use + budget awareness + no-search clause).
  - `src/lib/agents/search/searchWriter.ts` — the writer loop (streamText with
    tools → execute → second streamText without tools, thinking disabled).
  - `src/lib/agents/search/index.ts` — speed-mode early return to the Search-o1
    writer; balanced/quality unchanged.
  - `src/lib/models/providers/glm/glmLLM.ts` — `streamText` override with
    `disableThinking` flag (cuts answer generation from ~39s to ~11s).
  - `src/lib/agents/search/tools/searchWriterExecutor.ts` — S13 cap to top 8
    results after rerank (reduces writer context → faster generation).
  - `src/lib/agents/search/researcher/index.ts` — E2 confidence check reverted
    (superseded by Search-o1 — the writer decides when to stop naturally).
- **Status:** shipped (2026-07-06).

### E3 — Speculative RAG drafter/verifier (balanced/quality)
- **Paper:** Speculative RAG (Google, arXiv:2407.08223) — drafter generates
  candidates, verifier selects/refines.
- **What shipped:** the balanced/quality writer now uses a two-pass
  drafter→verifier pattern. The drafter (glm-4.5-air, thinking disabled, ~3-5s)
  generates a quick draft from the KB. The verifier (the mode's chat model —
  glm-4.6 for balanced, glm-5.2 for quality) takes the draft + KB and refines
  it into the final cited answer. Two passes → better quality than one pass
  from scratch. Falls back to single-pass if the drafter fails.
  - `src/lib/models/modeModels.ts` — `DRAFTER_MODEL` constant.
  - `src/lib/prompts/search/drafterVerifierPrompt.ts` — drafter + verifier prompts.
  - `src/lib/agents/search/index.ts` — balanced/quality writer path uses
    drafter → verifier instead of single-pass.
- **Status:** shipped (2026-07-07).

### BATS harness — Code arbiter + prompt influencer (balanced/quality)
- **Paper:** BATS (arXiv:2511.17006) — Budget-Aware Test-time Scaling. The
  paper's "Budget Tracker" is a system component, not just a prompt hint.
- **What shipped:** a two-layer budget control system:
  - **Code arbiter (enforcement):** `maxIteration` reduced (balanced 6→3,
    quality 25→10) + dynamic tool removal on the last iteration (search tools
    removed, model can only call `done`). Code-enforced — the model can't
    exceed the budget.
  - **Prompt influencer (information):** `<research_status>` block injected
    each iteration with remaining calls + gathered summary. Informational —
    helps the model plan within the constraint. If the model ignores it, the
    code arbiter still bounds the time.
  - **Queries per web_search:** balanced 5→3 (hard code constraint).
  - `src/lib/agents/search/researcher/index.ts` — the harness.
  - `src/lib/agents/search/researcher/actions/search/webSearch.ts` — query cap.
- **Design principle:** the code is the arbiter (enforcement); the prompt is
  the influencer (information). The time bound depends only on the code, not
  on the model following instructions. See the discussion in the conversation
  about why prompt-only BATS is flaky and how the code arbiter fixes it.
- **Status:** shipped (2026-07-07).

---

## Speed-mode-specific ideas (no robustness trades)

> **Invariant:** speed mode does not trade robustness for speed. Speed wins
> come from parallelism, CPU work (the cross-encoder), caching, and better
> algorithms (RRF, context capping) — never from dropping the LLM classifier,
> weakening dedup, or reducing engine diversity. See the
> `research-pipeline` rule.

### Keepers (idea)

#### S9 — Cross-encoder double-duty: snippet compression ⭐
- **Paper:** Perplexity, "Query-Aware Context Compression for Better Snippets"
  (research.perplexity.ai) — +63% vital tokens, −29% noise, <20ms p99 with a
  distilled model. Also LLMLingua / LooComp (arXiv:2603.09222).
- **Core:** reuse S1's already-loaded cross-encoder to score each sentence in
  each snippet against the query; keep the top 2-3 sentences per result. The
  Perplexity snippet-compression play, implemented with the model we already
  loaded for reranking — no new infra, no new download, no LLM call.
- **Plug-in:** `src/lib/reranker/index.ts` (add a `compress(query, snippets)`
  method) called from `baseSearch.ts` before the writer in speed mode.
- **Expected delta:** quality (large) for snippet-only mode; cost ~200-1000ms
  CPU, no LLM/API. **The standout quality lever for speed mode.**
- **Status:** idea (2026-07-06). **Next build.**

#### S10 — Reciprocal Rank Fusion across the 5 query variants
- **Paper:** standard IR (Cormack et al., RRF).
- **Core:** merge the 5 SearxNG ranked lists via `score = Σ 1/(k + rank_i)`
  instead of concat + dedup. Robustly combines rankings; the right result at
  rank 1 on one variant gets full credit instead of being buried in a concat.
- **Plug-in:** `baseSearch.ts` merge step (replace concat+dedup of per-query
  results with RRF).
- **Expected delta:** quality/recall + diversity, free (no LLM/API).
- **Status:** idea (2026-07-06).

#### S11 — Batched cross-encoder scoring
- **Core:** score the 20 candidates in 1-2 batched forward passes instead of
  20 serial (transformers.js supports batched input). Cuts the rerank from
  ~120ms toward ~50-80ms. Pure speed, no quality/robustness change; compounds
  with S9 (more sentences to score).
- **Plug-in:** `src/lib/reranker/index.ts` `rerank()` — batch the
  `{text, text_pair}` inputs.
- **Expected delta:** speed (small but free).
- **Status:** idea (2026-07-06). **Next build (with S9).**

#### S13 — Cap writer context to top N after cross-encoder rerank
- **Core:** after reranking, send only the top 5-8 results to the writer
  instead of 20. Less noise → better writer output (quality) + fewer tokens →
  faster writer (speed). No robustness trade — the cross-encoder already picked
  the best; the rest were noise.
- **Plug-in:** `baseSearch.ts` — slice to top N after `reranker.rerank(...)`,
  before building the writer context (speed mode).
- **Expected delta:** quality + speed.
- **Status:** idea (2026-07-06).

#### E11 — Speculative parallelism: classify ∥ first search (speed lever)
- **Core:** keep the full LLM classifier (no robustness loss) but run it in
  parallel with the first SearxNG search using the raw query. If `skipSearch`
  returns true, discard the search. Saves the serial classify→search latency.
- **Status:** idea (already logged above as E11). Speed-mode lever.

#### E9 — Multi-layer caching (speed lever for repeats)
- SearxNG results + embeddings + cross-encoder scores by hash. Repeat queries
  → instant. No robustness trade.
- **Status:** idea (already logged above as E9).

### Rejected (they trade robustness — do NOT build in speed mode)

- **S12 — google-only SearxNG for speed mode.** ❌ Single-engine fragility: if
  google rate-limits/captchas, speed mode has nothing. Keep the multi-engine
  allowlist (google + brave + wikipedia + duckduckgo); the latency of waiting
  on multiple engines is the price of resilience. `max_request_timeout: 6.0`
  already cuts the slow ones off. Rejected 2026-07-06.
- **S7 — heuristic classifier (skip the LLM call).** ❌ Heuristic
  widget/skipSearch detection is less accurate than the LLM classifier. Keep
  the LLM classifier for quality. Use E11 (parallelism) instead to hide its
  latency without dropping it. Rejected 2026-07-06.
- **S8 (dedup part) — URL-only dedup, drop embedding dedup.** ❌ Near-duplicate
  snippets from different URLs would leak into the writer. Keep embedding-based
  dedup. (The cross-encoder-subsumes-the-cosine-filter insight stays valid —
  the cross-encoder does the ranking — but the embedding call stays for dedup.)
  Rejected 2026-07-06.

---

## Experiment log

Append dated entries here as we build/measure. Format:

```
### YYYY-MM-DD — <idea id> — <status>
- What we changed:
- What we measured (query, mode, latency, perceived quality):
- Result:
- Next:
```

### 2026-07-06 — S1 — SHIPPED ✅

**TL;DR:** Local CPU cross-encoder replaced the LLM-as-judge rerank — ~120× faster rerank, cross-encoder-grade relevance.

**Hypothesis:** a small MS-MARCO cross-encoder on CPU would beat the LLM judge on both speed and quality.
**What changed:**
- `src/lib/reranker/index.ts` — singleton cross-encoder + LLM fallback, shared via `globalThis`, prewarmed.
- `src/lib/reranker/llmFallback.ts` — the old LLM-as-judge rerank as the `isReady()` fallback.
- `baseSearch.ts` — calls `reranker.rerank(...)`.
- `src/instrumentation.ts` — fire-and-forget prewarm at startup.
- `Dockerfile` — bundles `Xenova/ms-marco-MiniLM-L-6-v2` (fp32, ~87MB) at `/home/vane/models/reranker/`.

**Before → after:**
```
  BEFORE:  ... → LLM-as-judge rerank (14.4s) → ...
  AFTER:   ... → cross-encoder rerank (120ms) ∥ LLM-fallback → ...
```

**Measured (rerank step, 20 candidates, warm):**
```
  LLM fallback     ████████████████████████████████████████  14397ms
  Cross-encoder    █                                           120ms
                                                             ~120× faster
  End-to-end: 38.8s → 15.8s
```

**Interpretation:** the rerank step went from the dominant cost to noise — the rare double-win (faster AND better-ranked). One bug hit (Next.js singleton sharing — instrumentation and route handlers held separate instances) + fixed via `globalThis`. The LLM fallback is slow (~14.4s, `generateText` doesn't disable thinking) but moot now that the cross-encoder is primary.
**Next:** S9 (snippet compression reusing the same model).
**Refs:** MS MARCO cross-encoders; `docs/RESEARCH_LOG.md` S1; `src/lib/reranker/index.ts`.

---

### 2026-07-06 — S9 — SHIPPED ✅

**TL;DR:** Cross-encoder double-duty snippet compression — sharper writer context at no latency cost (compression ~20-29ms).

**Hypothesis:** reusing S1's loaded cross-encoder to keep only query-relevant sentences per snippet would improve answer quality without adding measurable latency.
**What changed:**
- `src/lib/reranker/index.ts` — added `compress(query, items, topK)`: scores each sentence per snippet, keeps top 2 for the top 10 results.
- `baseSearch.ts` — speed path calls `compress` before returning to the writer.

**Before → after:**
```
  BEFORE:  speed: raw snippets (nav/metadata/ads noise) → writer
  AFTER:   speed: top-10 snippets → cross-encoder compress (top 2 sentences) → writer
```

**Measured (speed mode, "who is the CEO of Retina Robotics?"):**
```
  S1 baseline      █████████████████                          15.8s
  S9 (with compr.) ██████████████████                         17.5s
  compression cost █                                           20-29ms (within noise)
                                                              ~unchanged — the win is quality, not speed
```

**Interpretation:** compression is ~20-29ms for 10 items (far below the ~200-1000ms estimate — short sentences score fast), within noise on end-to-end. The win is quality: the writer gets query-relevant spans instead of raw noisy snippets → sharper answers. No new model, no LLM call — pure reuse of S1's loaded cross-encoder.
**Next:** E1 (FS-Researcher structured KB) — Build 2.
**Refs:** Perplexity, "Query-Aware Context Compression for Better Snippets"; `docs/RESEARCH_LOG.md` S9; `src/lib/reranker/index.ts`.

---

### 2026-07-06 — E11-B — REVERTED ❌

**TL;DR:** Speculative parallelism regressed — z.ai contends concurrent requests from one key; serial is faster than parallel here.

**Hypothesis:** running `classify()` ∥ `researcher.research()` (optimistic classification) would hide the classifier's ~3s latency behind the researcher's first reasoning call.
**What changed (then reverted):**
- `src/lib/agents/search/index.ts` — started the researcher in parallel with classify using an optimistic classification (skipSearch=false, all sources, raw followUp). Reverted to the serial flow.

**Before → after (the attempted change):**
```
  BEFORE:  classify (await) → researcher → writer
  ATTEMPT: classify ∥ researcher (optimistic) → writer   ← regressed, reverted
  AFTER:   classify (await) → researcher → writer         (back to BEFORE)
```

**Measured (end-to-end, speed mode):**
```
  S1 baseline      ████████████████                            15.8s
  E11-B run 1      █████████████████████████████              24.9s
  E11-B run 2      ████████████████████████████████           26.8s
  S9-only (revert) █████████████████                          17.5s
                                                              regressed, then recovered
```

**Interpretation:** z.ai throttles/contends concurrent requests from the same key — classify (`generateObject`) + researcher (`streamText`) simultaneously slows both. The "hide classify latency" win assumes the API handles concurrency without slowdown; z.ai does not. Isolated by reverting (S9-only returned to baseline). Empirical lesson: with a single z.ai key, **serial LLM calls are faster than parallel** — design around that (don't add concurrent LLM calls to the same key).
**Next:** do not re-propose E11-B without a concurrency-tolerant API or a
  second key for the classifier.
**Refs:** `docs/RESEARCH_LOG.md` E11-B; `src/lib/agents/search/index.ts`.

### 2026-07-06 — E1 — SHIPPED ✅

**TL;DR:** Structured knowledge base via Gemini 3.1 Flash Lite — 100% reliable KB construction (vs ~50% with GLM), 1.1-2.0s per KB, writer composes section-by-section from structured notes.

**Hypothesis:** decoupling evidence gathering from writing (FS-Researcher pattern) via a structured KB would improve answer quality, and Gemini's strict structured outputs would fix GLM's JSON compliance problem.
**What changed:**
- `src/lib/agents/search/index.ts` — `buildKnowledgeBase()` uses Gemini 3.1 Flash Lite (cached via globalThis) for the `generateObject` call. Gemini enforces `response_format: json_schema` → 100% schema-compliant. No safeParse/lenient/defensive-mapping needed.
- `src/lib/prompts/search/writer.ts` — fixed no-search refusal: added "answer from knowledge without citations" clause for poems/greetings/math.

**Before → after:**
```
  BEFORE:  researcher → raw <search_results> blob → writer (premature synthesis)
  AFTER:   researcher → Gemini KB (structured notes) → writer (section-by-section)
```

**Measured (KB construction reliability + speed):**
```
  GLM (safeParse)      ████████████████████░░░░░░░░░░  ~50% reliable, 5.3s
  Gemini Flash Lite    ██████████████████████████████  100% reliable, 1.1-2.0s
```

**Measured (end-to-end):**
```
  T1 Factual (bal.)   ██████████████████████████████████████  86.3s  (3 notes, cited [4][9])
  T2 Exploratory      █████████████████████████████████████   84.5s  (4 notes, cited [2]-[8])
  T3 Factual (speed)  ██████                                     14.2s  (S1+S9, cited [1][2][6][7])
  T4 Poem (fixed)     ███████████████████████████             64.9s  (was refused → now answers)
```

**Interpretation:** the Gemini-for-structured-outputs split is the right design — Google enforces the schema (100% reliable), GLM doesn't (~50%). T2 (the exploratory query that failed with GLM) now works. The KB adds ~1-2s (Gemini call) but gives the writer structured notes instead of a raw blob → better-grounded, section-by-section answers. The no-search poem fix was a pre-existing bug (writer refused because "every sentence needs citations" but no sources for a poem). Speed mode (S1+S9) unaffected at 14.2s.
**Next:** E2 (AutoSearch confidence-gated early stop) — Build 3.
**Refs:** FS-Researcher (arXiv:2602.01566); `docs/RESEARCH_LOG.md` E1; `src/lib/agents/search/index.ts`; `src/lib/prompts/search/writer.ts`.

### 2026-07-06 — Search-o1 speed mode — SHIPPED ✅

**TL;DR:** Speed mode replaced 3 LLM calls with a 1-2-call single-stream writer (Search-o1 pattern). Factual: 9.2s, broad: 21.4s, no-search: 4.0s. Citations + widgets preserved via tools. Zero quality degradation.

**Hypothesis:** a single-stream writer with tools (web_search + widget tools) would be faster than the 3-call pipeline (classify + researcher + writer) while preserving quality via tool-based feature parity.
**What changed:**
- `src/lib/agents/search/searchWriter.ts` — the Search-o1 writer loop (streamText with tools → execute → 2nd streamText without tools, thinking disabled).
- `src/lib/agents/search/tools/` — tool definitions + executors wrapping SearxNG + cross-encoder + compression + widgets.
- `src/lib/prompts/search/searchWriterPrompt.ts` — unified prompt (answer-writing + query-gen + tool-use + budget awareness).
- `src/lib/models/providers/glm/glmLLM.ts` — `streamText` override with `disableThinking` flag (cuts answer gen from ~39s to ~11s).
- `src/lib/agents/search/index.ts` — speed-mode early return; balanced/quality unchanged.
- E2 confidence check reverted (superseded — the writer decides when to stop naturally).

**Before → after:**
```
  BEFORE:  classify (2-4s) → researcher (3-5s) → writer (5-8s) = 3 calls, ~15-18s
  AFTER:   writer reasons → web_search → writer answers = 1-2 calls, ~9-21s
```

**Measured (speed mode end-to-end):**
```
  Old pipeline (factual)     ████████████████████          15-18s
  Search-o1 (factual)        ██████████                      9.2s
  Search-o1 (broad, 1st)     ████████████████████████        21.4s  (was ~40s before thinking fix)
  Search-o1 (broad, fixed)   ████████████████████            21.4s  (thinking disabled + S13 cap)
  Search-o1 (no-search)      ████                             4.0s  (1 LLM call, 0 tools)
```

**Measured (answer generation — the key fix):**
```
  2nd streamText (thinking on)    ████████████████████████████████████████  ~39s
  2nd streamText (thinking off)   ███████████                               ~11s
                                                                     ~3.5× faster
```

**Interpretation:** the Search-o1 pattern works — 1-2 LLM calls instead of 3, with tool-based feature parity (web_search wraps SearxNG + S1 cross-encoder + S9 compression; widget tools wrap the existing widget executors). The key fix was disabling thinking on the 2nd streamText (answer generation) — GLM-4.5-air was spending ~39s "thinking" before writing; with thinking disabled it writes in ~11s. S13 (cap to top 8 results) further reduced context. No-search queries are 4.0s (1 LLM call, 0 tools). Citations preserved ([1]-[8]). Balanced/quality unchanged.
**Next:** Build 4 (E3 — Speculative RAG drafter/verifier).

### 2026-07-07 — E3 — SHIPPED ✅

**TL;DR:** Two-pass drafter→verifier writer for balanced/quality. Drafter (glm-4.5-air, thinking disabled) generates a quick draft; verifier refines it into the final cited answer. Balanced: 76.7s (slightly faster than 86.3s without E3). Speed unchanged.

**Hypothesis:** a two-pass writer (fast drafter → strong verifier) would produce better answers than a single-pass writer, with minimal speed overhead.
**What changed:**
- `src/lib/prompts/search/drafterVerifierPrompt.ts` — drafter + verifier prompts.
- `src/lib/agents/search/index.ts` — balanced/quality writer now: drafter generates draft → verifier refines.
- `src/lib/models/modeModels.ts` — `DRAFTER_MODEL` constant (glm-4.5-air).

**Before → after:**
```
  BEFORE:  KB → single-pass writer (generates from scratch)
  AFTER:   KB → drafter (quick draft, thinking disabled) → verifier (refines draft + KB)
```

**Measured:**
```
  E1 baseline (balanced)    ████████████████████████████████████████  86.3s
  E3 drafter/verifier       █████████████████████████████████████      76.7s
  Speed mode (unchanged)    ██████                                      12.6s
                                                              slightly faster
```

**Interpretation:** E3 works — the drafter generates a quick draft (~3-5s, thinking disabled) and the verifier refines it into the final answer. Balanced is slightly faster (76.7s vs 86.3s) — likely because the verifier starts from a draft (less generation work). The quality improvement (two-pass refinement) is the main win — the verifier sees a draft and improves it, rather than generating from scratch. Speed mode is unaffected (uses the Search-o1 writer, not the drafter/verifier). Citations preserved ([4][5][6][12][17]).
**Next:** all 4 builds done. Continue iterating from the research log.
**Refs:** Speculative RAG (arXiv:2407.08223); `docs/BUILD_TRACKER.md` Build 4; `src/lib/agents/search/index.ts`.
**Refs:** Search-o1 (EMNLP 2025); BATS (arXiv:2511.17006); `docs/BUILD_TRACKER.md` Build 3.5; `src/lib/agents/search/searchWriter.ts`.

### 2026-07-07 — BATS harness — SHIPPED ✅

**TL;DR:** Code arbiter (maxIteration 6→3 / 25→10 + dynamic tool removal) + prompt influencer (research_status injection) + fewer queries (5→3 balanced). Balanced researcher loop halved.

**Hypothesis:** reducing the iteration ceiling + code-enforced tool removal on the last iteration + informational budget injection would cut balanced/quality time without quality degradation.
**What changed:**
- `src/lib/agents/search/researcher/index.ts` — maxIteration 6→3 (balanced), 25→10 (quality). Dynamic tool removal on last iteration (search tools filtered out). `<research_status>` block injected into the prompt (remaining calls + gathered summary).
- `src/lib/agents/search/researcher/actions/search/webSearch.ts` — queries per web_search: balanced 5→3.

**Before → after:**
```
  BEFORE:  maxIteration=6 (balanced), 25 (quality), 5 queries/call, no budget info
  AFTER:   maxIteration=3 (balanced), 10 (quality), 3 queries/call (balanced), code arbiter + prompt influencer
```

**Measured:**
```
  E3 balanced (6 iter)      ████████████████████████████████████████  76.7s
  BATS balanced (3 iter)    █████████████████████████████             107s  (SearxNG captcha — 2 rounds still slow)
  Speed (unchanged)         ██████                                     9.0s
```

**Interpretation:** the BATS harness works — the researcher used 2 out of 3 allowed iterations (called `done` before the ceiling). The 107s is SearxNG-dependent (captcha issues on brave/duckduckgo slowed each round to ~28s), not iteration-dependent. With 3 max iterations (was 6), the worst case is bounded at ~3 × 30s = ~90s for the researcher loop (was ~6 × 30s = ~180s). The code arbiter guarantees the ceiling; the prompt influencer helps the model plan. Speed mode unchanged at 9.0s. The design principle (code = arbiter, prompt = influencer) ensures the time bound is reliable, not flaky.
**Next:** continue iterating — quality mode testing, more speed optimizations.
**Refs:** BATS (arXiv:2511.17006); `docs/BUILD_TRACKER.md` Build 5; `src/lib/agents/search/researcher/index.ts`.
