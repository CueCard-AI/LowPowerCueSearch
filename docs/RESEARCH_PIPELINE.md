# Research Pipeline

This document describes how Vane (this fork, "LowPowerCueSearch") turns a user query into a cited answer — the full pipeline, the per-mode model mapping, the search/result algorithms, and the reasoning-trace surfacing in the UI.

It is intended as a reference for anyone modifying the search/answer code under `src/lib/agents/search/`, `src/lib/models/`, or the SearxNG + scraper integration.

## Diagrams

### UI flow — what the user sees for one query

```
┌─────────────────────────────────────────────────────────────┐
│ User types: "who is Maanav Iyengar?"                        │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────┐
│ Brainstorming...   ( ○ )    │   ← classifier (thinking off)
└─────────────────────────────┘
            │  clears ~2s
            ▼
┌──────────────────────────────────────┐
│ Research Progress          [▮▮▮░ 60%]│   ← live progress bar
│  ● Thinking...                       │   ← reasoning_content stream
│  ● Searching 5 queries               │
│  ● Found 23 results                  │
│  ● Reading 3 sources                 │   ← scrape + evidence retrieval
└──────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────┐
│ Sources                              │
│  [linkedin] [wpi] [thenewwarehouse]  │
└──────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│ Answer (streamed, [1][2][3] citations)                      │
│  "Maanav Iyengar is the CEO of Retina Robotics..."          │
└─────────────────────────────────────────────────────────────┘
```

### Backend flow — data/control through the pipeline

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
  │   (parallel)                                 │  → drafter → verifier
  └─ researcher loop ──────► searchFindings      ┘
       plan → web_search(5) → reflect → ...
         per query: SearxNG → batched embed → sim>0.5 filter
         merge → dedup>0.75 → domain cap 2/host → rerank (cross-encoder ∥ LLM-fallback)
         speed:    cross-encoder snippet compression (S9: top 2 sentences × top 10)
         balanced: scrape top3 → evidence retrieval (top3 passages)
         quality:  scrape + per-chunk fact extraction
       │
       ├─ balanced/quality: Gemini 3.1 Flash Lite → structured KB (E1)
       │
       ├─ E3: drafter (glm-4.5-air, thinking disabled) → quick draft from KB
       ▼
verifier (mode's chat model, streamText) → refines draft + KB → cited answer
```

---

## 1. High-level flow

A chat request enters at `src/app/api/chat/route.ts` (`POST /api/chat`). The flow is:

1. **Resolve models from the optimization mode** (hardcoded mapping — see §2).
2. **Classifier** (`src/lib/agents/search/classifier.ts`) — one structured `generateObject` call that decides:
   - `skipSearch` — whether to skip the Researcher entirely (general-knowledge / writing / widget queries).
   - Source flags (`personalSearch`, `academicSearch`, `discussionSearch`) — which search tools the Researcher may call.
   - Widget flags (`showWeatherWidget`, `showStockWidget`, `showCalculationWidget`).
   - `standaloneFollowUp` — a context-independent reformulation of the follow-up question.
3. **Widgets + Researcher run in parallel** (`src/lib/agents/search/index.ts`):
   - `WidgetExecutor.executeAll` runs any widgets the classifier flagged.
   - If `!skipSearch`, `Researcher.research()` runs an agentic tool-calling loop (see §3).
4. **Writer** — `input.config.llm.streamText(...)` with `getWriterPrompt(...)` synthesizes the final cited answer from the research findings + widget context. Reasoning content is surfaced live (see §6).

The search API route (`src/app/api/search/route.ts`) mirrors this for the programmatic `/api/search` endpoint using `APISearchAgent` (`src/lib/agents/search/api.ts`).

---

## 2. Mode → model mapping (hardcoded)

Model selection is **hardcoded by optimization mode** and ignores the client-supplied `chatModel`/`embeddingModel` fields. The mapping lives in `src/lib/models/modeModels.ts`:

| Mode | Chat model | Reasoning trace? | Embeddings |
|---|---|---|---|
| `speed` | `gemini-3.1-flash-lite` (lightweight, high-throughput) | No | Gemini `gemini-embedding-001` |
| `balanced` | `glm-4.6` (smart non-reasoning) | No | Gemini `gemini-embedding-001` |
| `quality` | `glm-5.2` (reasoning flagship) | Yes | Gemini `gemini-embedding-001` |

The chat + search routes resolve the model via `ModelRegistry.loadChatModelByType(providerType, key)` / `loadEmbeddingModelByType(...)` (`src/lib/models/registry.ts`), which find the configured provider of a given `type` and load the model. The Gemini provider connection (with its API key) is stored in `config.json` inside the `vane-data` volume — **not** in source code.

The writer uses the same mode-appropriate `llm`, so speed mode gets a fast non-reasoning writer, and quality mode gets a reasoning writer that emits a visible reasoning trace.

### GLM-specific tweaks

- `src/lib/models/providers/glm/glmLLM.ts` overrides `generateObject` to inject `thinking: { type: 'disabled' }` into the request. This keeps the **classifier**, **widgets**, and the **LLM-as-judge reranker** (all `generateObject` callers) fast on the reasoning model — they don't need to reason, just produce small JSON.
- The override uses `chat.completions.create` (not `.parse`) and runs `repairJson({ extractJson: true })` on the content, because GLM wraps JSON in ```` ```json ```` fences and the OpenAI SDK's strict `.parse()` would reject that.
- `streamText` (inherited from `OpenAILLM`) captures `delta.reasoning_content` and yields it as `reasoningChunk` — see §6.

### Why GLM embeddings aren't used

z.ai's API only serves chat models (glm-4.5 … glm-5.2); `embedding-3`/`embedding-2` return `1211 Unknown Model`. So embeddings go through Gemini's free-tier OpenAI-compatible endpoint (`gemini-embedding-001`, 3072 dims). The previous default (local Transformers `all-MiniLM-L6-v2` on CPU) still exists as a fallback provider but is no longer selected.

---

## 3. The Researcher loop

`src/lib/agents/search/researcher/index.ts` — an agentic tool-calling loop:

```
for i in 0..maxIteration:
  streamText(researcherPrompt, history, tools)   // GLM reasons, then emits tool calls
  collect tool calls (incl. __reasoning_preamble plan)
  if no tool calls or last is `done`: break
  execute tools (web_search / academic_search / social_search / scrapeURL / uploads_search)
  append assistant + tool results to agentMessageHistory
  [balanced/quality, after round 0] run gap analysis, inject as guidance   // §4
```

`maxIteration` per mode: `speed=1`, `balanced=6`, `quality=25`.

The `__reasoning_preamble` tool (`src/lib/agents/search/researcher/actions/plan.ts`) is the model's "plan" step — it must be called before other tools in balanced/quality. Its output is rendered as a `reasoning` subStep in the UI.

### Multi-hop chaining (prompt-level)

The balanced and quality researcher prompts include a `<multi_hop_chaining>` section instructing the model: when a search returns a candidate entity central to the answer (a name, company, term), search that entity directly next to confirm and enrich, rather than answering from a single half-mention. Example in prompt: "Who is the CEO of Retina Robotics?" → search "Retina Robotics CEO" → results mention "Maanav Iyengar" → search "Maanav Iyengar Retina Robotics" → done.

---

## 4. Gap-driven refinement

After the first research round in balanced/quality modes, the loop runs a structured `generateObject` gap analysis (`src/lib/agents/search/researcher/index.ts`, inside the loop, `i === 0` branch):

Schema: `{ covered: string[], missing: string[], next_queries: string[] }`

The result is injected into `agentMessageHistory` as a `<gap_analysis>` user message, guiding the remaining iterations to target what's still **missing** rather than re-searching covered ground. Runs once per query (not per iteration) to keep the LLM-call budget bounded. Failures are caught and logged — the loop continues without it.

---

## 5. Search + result-selection algorithm

`src/lib/agents/search/researcher/actions/search/baseSearch.ts` — `executeSearch(...)` is the core. Per `web_search` tool call (up to 5 queries now), the flow is:

### 5.1 Per query
1. `searchSearxng(q)` — calls SearxNG with a **25s timeout** (`src/lib/searxng.ts`).
2. Cap results to top **20** (`res.results.slice(0, 20)`).
3. **Batched embeddings**: one `embedText([q])` + one `embedText(all 20 contents)` call (was 21 separate calls). Gemini OpenAI-compatible endpoint.
4. Similarity filter: keep results with `cosine(query, content) > 0.5`.
5. Emit a `searching` subStep + a `search_results` subStep to the UI.

### 5.2 Across all queries (merge + dedup)
6. Sort all results by similarity descending.
7. Dedup by embedding similarity `> 0.75` (near-duplicates).
8. **Domain diversity cap**: max **2 results per hostname** so one site can't dominate.
9. Slice to top 20.

### 5.3 Reranking — local CPU cross-encoder (S1) with LLM-as-judge fallback
10. If >3 results remain, the **Reranker singleton** (`src/lib/reranker/index.ts`) reranks them. **Primary path:** a local CPU cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`, fp32, ~87MB, bundled in the image at `/home/vane/models/reranker/`) loaded via `@huggingface/transformers`, prewarmed fire-and-forget at startup from `src/instrumentation.ts`. Scores each `(query, candidate)` pair and sorts by relevance — ~120ms for 20 candidates warm. **Fallback path:** if the cross-encoder isn't ready (still loading / failed to load / OOM), delegates to `llmRerankFallback` (`src/lib/reranker/llmFallback.ts`) — the original `generateText` + parsed-comma-list LLM-as-judge rerank. The singleton is shared via `globalThis` so the instrumentation prewarm and the route handlers use one instance. This replaces the weak cosine-similarity ordering with cross-encoder-grade relevance (trained on MS MARCO) at a fraction of the latency — the single biggest result-quality + speed lever.

### 5.4 Mode-specific content enrichment
- **Speed**: snippet content as-is (`r.content || r.title`), then **S9 — cross-encoder snippet compression**: the Reranker's `compress()` reuses the loaded cross-encoder to score each sentence per snippet against the query and keep the top 2 sentences for the top 10 results (~20-29ms). Drops nav/metadata/ad noise so the writer gets high-signal spans. No LLM call, no latency cost.
- **Balanced**: scrapes the **top 3** reranked results in parallel via `Scraper.scrape` (Playwright + `@mozilla/readability`), then runs **snippet-level evidence retrieval**: each page is split into ~500-char passages, batched-embedded, and the **top 3 passages** by similarity to the query are kept as `r.content`. Emits a `reading` subStep. Gives the writer precise evidence instead of a raw 4000-char dump.
- **Quality**: separate path that scrapes, picks results via an LLM picker, and runs per-chunk fact extraction (`generateObject` per chunk) — see `baseSearch.ts` quality branch.

### 5.5 Query expansion
The `web_search` tool accepts **up to 5 queries** per call (`src/lib/agents/search/researcher/actions/search/webSearch.ts`, `.slice(0, 5)`). The mode prompts instruct the model to use all 5 slots and split queries across facets of the question. SearxNG handles them concurrently, and the batched embeddings keep the per-query cost low.

### 5.6 Structured knowledge base (E1 — balanced/quality)
After research, a **Gemini 3.1 Flash Lite** model constructs a structured knowledge base (`buildKnowledgeBase` in `src/lib/agents/search/index.ts`) — topic-organized notes with source IDs. The writer then composes section-by-section from the KB instead of a concatenated `<search_results>` blob, avoiding the "premature synthesis" the FS-Researcher paper showed is the largest quality drop in agentic research. **Gemini is used (not GLM)** because Google's API enforces `response_format: json_schema` strictly (100% reliable), while z.ai doesn't (~50% with GLM). The Gemini model is cached via `globalThis` (loaded once, reused). Falls back to the raw blob if Gemini is unavailable. Speed mode skips the KB (keeps the S9 fast path).

---

## 6. Reasoning trace in the UI

GLM-5.2 streams `delta.reasoning_content` alongside `delta.content`. `OpenAILLM.streamText` (`src/lib/models/providers/openai/openaiLLM.ts`) yields `reasoningChunk` on each chunk. Two consumers surface it:

- **Researcher loop** (`researcher/index.ts`): accumulates `reasoningChunk` into a `reasoning` subStep on the active research block (alongside the `__reasoning_preamble` plan subStep).
- **Writer** (`src/lib/agents/search/index.ts`): emits a separate research block with a `reasoning` subStep for the answer-phase thinking.

`src/components/AssistantSteps.tsx` renders `type: 'reasoning'` subSteps as "Thinking" rows with the streamed text. It also renders a **live progress bar** under the "Research Progress" header showing the current step's status (e.g., "Searching 3 queries", "Reading 3 sources", "Thinking…") and a filling percentage based on subStep count — visible even when the panel is collapsed, so long quality-mode runs feel active instead of an open-ended spinner.

For non-reasoning models (speed/balanced), `reasoning_content` is empty, so no reasoning subSteps appear — the progress bar still tracks searching/reading steps.

---

## 7. SearxNG configuration

`searxng/settings.yml` (baked into the Docker image, also live-editable at `/etc/searxng/settings.yml` in the container):

- Engines enabled: `google`, `brave`, `wikipedia`, `duckduckgo`, `wolframalpha`.
- Engines disabled (captcha-prone / garbage from residential IP): `bing`, `bing news`, `bing images`, `bing videos`, `startpage`, `qwant`, `mojeek`.
- `search.max_request_timeout: 6.0` — caps how long SearxNG waits for slow engines. Google + brave respond fast; slow failing engines get cut off sooner.

SearxNG runs inside the container on port 8080 (internal); Vane calls it via `getSearxngURL()` from `config.json` (`search.searxngURL`).

### Residential-IP reality

From a residential IP, most SearxNG engines get captcha'd or rate-limited. `google` + `brave` are the reliable ones. If search reliability is insufficient, the zero-cost options are: (a) tune engines further in `settings.yml`, (b) host SearxNG on a free-cloud VM (Oracle Cloud Free Tier / Fly.io free) with a datacenter IP that's less captcha-prone, and point `search.searxngURL` at it. Paid search APIs (Tavily/Exa) are intentionally **not** used — this fork targets a zero-cost Perplexity-style experience.

---

## 8. Cost model (zero paid services)

- **Chat/research/writer LLM**: GLM via z.ai (Coding Plan key, free tier credits).
- **Embeddings**: Gemini `gemini-embedding-001` (free tier).
- **Web search**: SearxNG (self-hosted in-container, free).
- **Scraping**: Playwright + `@mozilla/readability` (in-process, free).
- No Tavily/Exa/Cohere/OpenAI-API calls.

---

## 9. Key files

| File | Role |
|---|---|
| `src/lib/models/modeModels.ts` | Hardcoded mode→model + embedding mapping |
| `src/lib/models/registry.ts` | `loadChatModelByType` / `loadEmbeddingModelByType` |
| `src/lib/models/providers/glm/glmLLM.ts` | `generateObject` with `thinking: disabled` + fence-tolerant JSON parsing |
| `src/lib/models/providers/glm/index.ts` | GLM provider, default chat models synced to z.ai's list |
| `src/lib/models/providers/openai/openaiLLM.ts` | `streamText` captures `reasoning_content` |
| `src/app/api/chat/route.ts` | Chat entry; resolves models from mode |
| `src/app/api/search/route.ts` | Search API entry; resolves models from mode |
| `src/lib/agents/search/index.ts` | SearchAgent: classify → (widgets ∥ research) → writer |
| `src/lib/agents/search/classifier.ts` | Structured classification |
| `src/lib/agents/search/researcher/index.ts` | Agentic loop + gap-driven refinement + reasoning surfacing |
| `src/lib/agents/search/researcher/actions/search/baseSearch.ts` | SearxNG → batched embeddings → dedup → domain cap → cross-encoder rerank → scrape/evidence |
| `src/lib/reranker/index.ts` | Local CPU cross-encoder reranker singleton + LLM-as-judge fallback + prewarm |
| `src/lib/reranker/llmFallback.ts` | LLM-as-judge rerank fallback (`generateText` + parsed comma list) |
| `src/instrumentation.ts` | Next.js instrumentation hook — prewarms the reranker at startup |
| `src/lib/agents/search/index.ts` | SearchAgent: speed → Search-o1 writer; balanced/quality → classify → research → Gemini KB → writer |
| `src/lib/agents/search/searchWriter.ts` | Search-o1-style single-stream writer for speed mode (1-2 LLM calls, tool-based) |
| `src/lib/agents/search/tools/searchWriterTools.ts` | Tool definitions for the Search-o1 writer (web_search + widget tools) |
| `src/lib/agents/search/tools/searchWriterExecutor.ts` | Tool executors wrapping SearxNG + cross-encoder + compression + widgets (S13: top 8 cap) |
| `src/lib/prompts/search/searchWriterPrompt.ts` | Unified prompt for the Search-o1 writer (answer-writing + query-gen + tool-use + budget awareness) |
| `src/lib/prompts/search/writer.ts` | Final answer prompt for balanced/quality (includes no-search "answer from knowledge" clause) |
| `src/lib/prompts/search/drafterVerifierPrompt.ts` | E3 drafter + verifier prompts (two-pass writer for balanced/quality) |
| `src/lib/agents/search/researcher/actions/search/webSearch.ts` | `web_search` tool (5-query cap, mode prompts) |
| `src/lib/agents/search/researcher/actions/plan.ts` | `__reasoning_preamble` plan tool |
| `src/lib/prompts/search/researcher.ts` | Mode prompts (multi-hop chaining, gap-aware) |
| `src/lib/prompts/search/writer.ts` | Final answer prompt |
| `src/lib/searxng.ts` | SearxNG client (25s timeout) |
| `src/lib/scraper.ts` | Playwright + Readability scraper |
| `src/components/AssistantSteps.tsx` | Research Progress panel + live progress bar |
| `searxng/settings.yml` | Engine selection + `max_request_timeout` |

---

## 10. Tuning knobs

- **Speed vs quality**: switch the optimization mode in the search bar (speed / balanced / quality). Mode determines the chat model, iteration count, and enrichment depth.
- **Result cap**: `res.results.slice(0, 20)` in `baseSearch.ts` (per query) and the final `.slice(0, 20)` (per web_search call).
- **Domain cap**: `hostCount[host] <= 2` in `baseSearch.ts`.
- **Similarity thresholds**: `> 0.5` (keep) and `> 0.75` (dedup) in `baseSearch.ts`.
- **Evidence passages**: `.slice(0, 3)` top passages per scraped page in the balanced path.
- **Scrape depth**: `topToScrape = uniqueSearchResults.slice(0, 3)` in the balanced path.
- **SearxNG timeout**: `setTimeout(..., 25000)` in `src/lib/searxng.ts`.
- **SearxNG engine timeout**: `search.max_request_timeout` in `searxng/settings.yml`.
- **Iteration counts**: `researcher/index.ts` `maxIteration` per mode.
- **Model mapping**: `src/lib/models/modeModels.ts`.
