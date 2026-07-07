---
name: ml-search-pipeline
description: >-
  Orient on and modify the ML research/search pipeline in this Vane
  (LowPowerCueSearch) fork — the multi-stage pipeline that turns a query into a
  cited answer. Use when working on files under src/lib/agents/search/**, the
  researcher loop, search/result algorithms (reranking, gap analysis, multi-hop,
  evidence retrieval, domain cap, query expansion, embeddings), the classifier,
  the writer, the mode→model mapping, or when discussing search speed/quality
  tradeoffs. Also use when the user mentions the research pipeline, search
  quality, speed vs quality modes, SearxNG results, scraping, or answer
  grounding.
---

# ML Search Pipeline

This is a zero-cost Perplexity-style AI search engine. The pipeline is
ML-research-heavy: a query flows through classification, an agentic
research loop, result selection/reranking, optional scraping + evidence
retrieval, and a final cited answer. Two axes matter for every change:
**speed** and **quality**, controlled by the optimization mode.

## The pipeline (one query)

`src/app/api/chat/route.ts` → `SearchAgent.searchAsync`
(`src/lib/agents/search/index.ts`):

1. **Classify** (`src/lib/agents/search/classifier.ts`) — one
   `generateObject` call → `skipSearch`, source flags, widget flags,
   `standaloneFollowUp`.
2. **Widgets ∥ Researcher** run in parallel.
   - Researcher = agentic tool-calling loop
    (`src/lib/agents/search/researcher/index.ts`): plan → web_search →
    reflect → search again → done.
3. **Writer** — `streamText` with `getWriterPrompt` synthesizes the cited
   answer from findings + widget context. Reasoning is surfaced live (see
   §Reasoning trace).

The `/api/search` route mirrors this via `APISearchAgent`
(`src/lib/agents/search/api.ts`).

## Mode → model mapping (hardcoded)

`src/lib/models/modeModels.ts`. The mode picked in the UI determines the
chat model; the client's model selection is **ignored**.

| Mode | Chat model | Reason trace | Iterations | Result enrichment |
|---|---|---|---|---|
| speed | `gemini-3.1-flash-lite` | no | 1 | snippets only |
| balanced | `glm-4.6` | no | 6 | scrape top 3 + evidence retrieval |
| quality | `glm-5.2` | yes | 25 | scrape + per-chunk fact extraction |

Embeddings are always Gemini `gemini-embedding-001`
(`src/lib/models/registry.ts` `loadEmbeddingModelByType`). z.ai does NOT
serve GLM embeddings — never try to use them.

## Algorithm catalog (what already exists — check before adding)

All in `src/lib/agents/search/researcher/actions/search/baseSearch.ts`
unless noted:

- **Batched embeddings** — per query: `embedText([q])` + one
  `embedText(allContents)` (not 21 separate calls).
- **Similarity filter** — keep `cosine(query, content) > 0.5`.
- **Dedup** — drop results with pairwise `cosine > 0.75`.
- **Domain cap** — max 2 results per hostname.
- **LLM-as-judge reranking** — one `generateObject` ranks all deduped
  results by semantic relevance; falls back to similarity order on
  failure. Biggest result-quality lever.
- **Snippet-level evidence retrieval** (balanced) — scraped pages split
  into ~500-char passages, batched-embedded, top 3 passages by query
  similarity kept (not a raw 4000-char dump).
- **Result cap** — top 20 per query, top 20 per web_search call.
- **Query expansion** — `web_search` accepts up to 5 queries
  (`src/lib/agents/search/researcher/actions/search/webSearch.ts`,
  `.slice(0, 5)`); prompts say "up to 5".
- **Gap-driven refinement** (`researcher/index.ts`) — after round 0 in
  balanced/quality, a structured `{covered, missing, next_queries}` call
  is injected as guidance for later iterations. Runs once per query.
- **Multi-hop chaining** (`src/lib/prompts/search/researcher.ts`) —
  balanced/quality prompts instruct: when a search returns a candidate
  entity central to the answer, search that entity directly next.
- **`__reasoning_preamble` plan tool**
  (`researcher/actions/plan.ts`) — model must call it before other tools
  in balanced/quality; rendered as a reasoning subStep.

## Reasoning trace + progress bar

GLM-5.2 streams `delta.reasoning_content`. `OpenAILLM.streamText`
(`src/lib/models/providers/openai/openaiLLM.ts`) yields it as
`reasoningChunk`. The Researcher loop and the writer each accumulate it
into `reasoning` subSteps. `src/components/AssistantSteps.tsx` renders
"Thinking" rows + a live progress bar (current step status + filling %).

## Tuning knobs

| Knob | Where |
|---|---|
| Result cap per query | `baseSearch.ts` `res.results.slice(0, 20)` |
| Final cap per web_search | `baseSearch.ts` `.slice(0, 20)` |
| Domain cap | `baseSearch.ts` `hostCount[host] <= 2` |
| Keep / dedup thresholds | `baseSearch.ts` `> 0.5` / `> 0.75` |
| Evidence passages per page | `baseSearch.ts` `.slice(0, 3)` |
| Scrape depth (balanced) | `baseSearch.ts` `topToScrape = ...slice(0, 3)` |
| SearxNG timeout | `src/lib/searxng.ts` `25000` ms |
| SearxNG engine timeout | `searxng/settings.yml` `max_request_timeout` |
| Iterations per mode | `researcher/index.ts` `maxIteration` |
| Mode → model | `src/lib/models/modeModels.ts` |

## How to think about a change

Before modifying any stage, answer:
1. **Which mode(s) does this affect?** Speed must stay fast (no scraping,
   no extra LLM calls). Balanced is the quality/speed sweet spot. Quality
   can afford deep work.
2. **Does it preserve the invariants?** Mode→model hardcoded; embeddings
   via Gemini; `generateObject` on GLM disables thinking + uses
   `repairJson`; writer uses the mode-appropriate llm.
3. **Does it add an LLM round-trip?** Count them. Speed mode budget is
   ~3 calls total (classify + 1 research + writer). Every extra call in
   speed mode is a regression.
4. **Does it respect the zero-cost constraint?** No paid APIs. SearxNG +
   Gemini free tier + GLM via z.ai only.

## Deep reference

For the full architecture, per-stage detail, cost model, and key-file
map, read [../../docs/RESEARCH_PIPELINE.md](../../docs/RESEARCH_PIPELINE.md).
