# LowPowerCueSearch (Vane fork) 🔍

A **zero-cost, Perplexity-style AI search engine** that runs entirely on your own
hardware. This fork is tuned for **speed + answer quality** using free-tier
services only: **GLM via z.ai** for chat/research/writer, **Gemini** for
embeddings, and **self-hosted SearxNG** for web search. No paid APIs.

It combines internet search with an agentic research loop, a **local CPU
cross-encoder** for result reranking (S1), **cross-encoder snippet compression**
for speed mode (S9), a **Gemini-powered structured knowledge base** for
balanced/quality (E1), gap-driven refinement, multi-hop evidence chaining, and
a live reasoning trace — delivering cited answers while keeping your searches
private.

---

## How it works (one query)

```
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
         speed:    cross-encoder snippet compression (S9: top 2 sentences × top 10)
         balanced: scrape top3 → evidence retrieval (top3 passages)
         quality:  scrape + per-chunk fact extraction
       │
       ├─ balanced/quality: Gemini 3.1 Flash Lite → structured KB (E1)
       │  (topic-organized notes + source IDs; writer composes section-by-section)
       ▼
writer (streamText) ──► cited answer  (+ reasoning_content → UI trace)
```

For the full pipeline, algorithm catalog, and tuning knobs, see
[docs/RESEARCH_PIPELINE.md](docs/RESEARCH_PIPELINE.md).

---

## Modes (speed vs quality)

The optimization mode selected in the search bar determines the chat model
(**hardcoded** — the client's model selection is ignored). Embeddings are always
Gemini `gemini-embedding-001`.

| Mode | Chat model | Reasoning trace | Research iterations | Result enrichment | ~Time |
|---|---|---|---|---|---|
| **Speed** | `gemini-3.1-flash-lite` | no | 1-2 (Search-o1) | web_search tool + S9 compression + S13 top-8 | ~1-6s |
| **Balanced** | `glm-4.6` | no | 3 (BATS) | scrape top 3 + evidence retrieval + Gemini KB + drafter/verifier | ~40-80s |
| **Quality** | `glm-5.2` | yes (visible) | 10 (BATS) | scrape + per-chunk fact extraction + Gemini KB + drafter/verifier | ~2-4 min |

The mapping lives in [`src/lib/models/modeModels.ts`](src/lib/models/modeModels.ts).

---

## Algorithm highlights

- **Search-o1-style single-stream writer (speed mode)** — the speed-mode writer
  has tools (`web_search` + widget tools). It reasons → calls `web_search` →
  gets results → writes the answer. 1-2 LLM calls instead of 3 (classify +
  researcher + writer). The `web_search` tool wraps SearxNG + cross-encoder
  rerank (S1) + snippet compression (S9) + top-8 cap (S13). Widget tools wrap
  the existing widget executors. Thinking is disabled on the answer-generation
  call (cuts ~39s → ~11s). Factual: 9.2s, broad: 21.4s, no-search: 4.0s.
- **Local CPU cross-encoder reranking (S1)** — a bundled `ms-marco-MiniLM-L-6-v2`
  cross-encoder reranks results in ~120ms (vs ~14.4s for the LLM-as-judge it
  replaced). Cross-encoder-grade relevance at a fraction of the latency. LLM
  fallback kept for resilience.
- **Cross-encoder snippet compression (S9)** — reuses S1's loaded cross-encoder
  to keep only the top 2 query-relevant sentences per snippet (speed mode,
  ~20-29ms). Drops nav/metadata/ad noise → sharper answers at no latency cost.
- **Structured knowledge base via Gemini (E1)** — after research, Gemini 3.1
  Flash Lite constructs a topic-organized KB (notes + source IDs) with 100%
  reliable structured outputs (Google enforces the schema). The writer composes
  section-by-section from the KB instead of a raw blob — no "premature
  synthesis." Balanced/quality only.
- **Gemini for structured outputs, GLM for prose** — the core pattern: Gemini
  for JSON/schema tasks (KB, and potentially classifier/widgets), GLM for prose
  tasks (writer, researcher reasoning). Both zero-cost (free tiers).
- **Gap-driven refinement** — after the first research round (balanced/quality),
  a structured `{covered, missing, next_queries}` analysis guides later
  iterations to target what's missing.
- **Multi-hop chaining** — when a search surfaces a candidate entity central to
  the answer, the researcher searches that entity directly next.
- **Snippet-level evidence retrieval** (balanced) — scraped pages are split into
  passages, embedded, and the top 3 passages per page are kept (not a raw dump).
- **Domain diversity cap** — max 2 results per hostname so one site can't
  dominate.
- **Query expansion** — up to 5 query variants per `web_search` call.
- **Batched embeddings** — 2 Gemini calls per query (was 21).
- **Reasoning trace + live progress bar** — GLM-5.2's `reasoning_content`
  streams into a "Thinking" row; a progress bar tracks the research.
- **No-search writer fix** — poems/greetings/math produce answers from knowledge
  without citations (was refusing because "every sentence needs a citation").

---

## Quick start (Docker, recommended)

```bash
docker run -d -p 4567:3000 -v vane-data:/home/vane/data --name vane-glm vane-glm
```

(Build the image first with `docker build -t vane-glm .` from the repo root.)
Then open http://localhost:4567, **hard-refresh** (Cmd+Shift+R), and configure:

1. **Add a GLM connection** (Settings → Models → Add Connection → GLM (Zhipu))
   - API key: your z.ai Coding Plan key (https://z.ai/model-api)
   - Base URL: `https://api.z.ai/api/coding/paas/v4` (needed for `glm-5.2`)
2. **Add a Gemini connection** (for embeddings) — paste a free Gemini key from
   https://aistudio.google.com/apikey. (Or skip and the app falls back to local
   CPU embeddings — slower.)
3. Run a query. Try **Speed** mode first (fast), then **Balanced** (richer),
  then **Quality** (reasoning trace).

> Keys live in `config.json` inside the `vane-data` volume — never in source.
> See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for the volume-edit workflow and
> [`docs/ONBOARDING.md`](docs/ONBOARDING.md) for the full setup walkthrough.

### Non-Docker

```bash
npm install
npm run build
npm run start   # or: npm run dev
```

You'll need to run your own SearxNG instance (JSON format enabled) and point
`search.searxngURL` at it in the setup screen.

---

## Zero-cost constraint

This fork targets a **$0** Perplexity-style experience:

- **Web search**: SearxNG (self-hosted, free) — only SearxNG.
- **Embeddings**: Gemini `gemini-embedding-001` (free tier).
- **Chat/research/writer LLM**: GLM via z.ai (Coding Plan free credits).
- **Structured outputs (KB construction)**: Gemini 3.1 Flash Lite (free tier) —
  Google enforces `response_format: json_schema` strictly (100% reliable), unlike
  z.ai (~50% with GLM). See the Gemini-for-structured-outputs pattern.
- **Reranking**: local CPU cross-encoder (`ms-marco-MiniLM-L-6-v2`, bundled).
- **Scraping**: Playwright + `@mozilla/readability` (in-process).

No Tavily/Exa/Cohere/OpenAI-API. If a feature needs a paid service, it's a
regression — see the `zero-cost-constraint` rule in
[`.cursor/rules/`](.cursor/rules/).

---

## Documentation

| Doc | What it covers |
|---|---|
| [docs/INDEX.md](docs/INDEX.md) | Table of contents for all docs, skills, rules |
| [docs/RESEARCH_PIPELINE.md](docs/RESEARCH_PIPELINE.md) | Full pipeline reference, algorithm catalog, tuning knobs |
| [docs/ONBOARDING.md](docs/ONBOARDING.md) | Read-this-first guide for any new agent on this codebase |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operational runbook: build/swap/verify, log decoding, incidents |
| [docs/SCALE_AND_DEPLOYMENT.md](docs/SCALE_AND_DEPLOYMENT.md) | Production architecture, K8s topology, sizing, cost — scaling `/api/enrich` to 1000 leads/10 min |
| [docs/SCALING_STEPS.md](docs/SCALING_STEPS.md) | Step-by-step build plan for the scaling effort (phases 0–4, per-step files/commands/verification) |
| [docs/API/ENRICH.md](docs/API/ENRICH.md) | Lead enrichment API (`POST /api/enrich`) — full request/response, streaming, citations map, UI transpose |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute: conventions, skills/rules, before-you-ship checklist |
| [docs/architecture/README.md](docs/architecture/README.md) | Upstream Vane architecture overview |
| [docs/API/SEARCH.md](docs/API/SEARCH.md) | Programmatic search API |

## Cursor skills & rules (`.cursor/`)

The repo ships agent guidance that auto-loads in Cursor:

- **Skills** (`.cursor/skills/`): `ml-search-pipeline` (auto, pipeline
  orientation), `quality-coding` (auto, anti-patterns + doc standards),
  `documentation` (auto, ASCII diagram conventions), `experiment-logging`
  (auto, experiment cards + bar charts), `vane-ops` (explicit, Docker runbook).
- **Rules** (`.cursor/rules/`): `zero-cost-constraint` (always), `quality-coding`
  (always), `documentation` (always), `experiment-logging` (always), plus
  file-scoped rules for the research pipeline, GLM provider, SearxNG, and Docker
  ops.

See [docs/INDEX.md](docs/INDEX.md) for the full list with descriptions.

---

## Project structure (quick map)

- `src/app/` — Next.js app + API routes (`/api/chat`, `/api/search`,
  `/api/providers`).
- `src/lib/agents/search/` — the research pipeline. **Speed mode:**
  Search-o1-style writer (`searchWriter.ts`) with tools. **Balanced/quality:**
  classify → research → rerank → scrape → Gemini KB → write.
- `src/lib/models/` — model providers (GLM, Gemini, OpenAI, Ollama, …) +
  `modeModels.ts` (the hardcoded mode→model map) + `registry.ts` +
  `geminiModel.ts` (shared Gemini model loader for structured outputs).
- `src/lib/reranker/` — local CPU cross-encoder reranker singleton (S1) +
  snippet compression (S9) + LLM-as-judge fallback.
- `src/lib/agents/search/tools/` — Search-o1 writer tool definitions +
  executors (wrap SearxNG + cross-encoder + compression + widgets).
- `src/lib/prompts/search/` — classifier, researcher, writer, and
  searchWriterPrompt (unified Search-o1 prompt) prompts.
- `src/lib/searxng.ts` — SearxNG client (25s timeout).
- `src/lib/scraper.ts` — Playwright + Readability scraper.
- `src/components/` — UI (chat, settings, `AssistantSteps` with the progress
  bar).
- `searxng/settings.yml` — SearxNG engine allowlist + timeouts.
- `Dockerfile` — bundles Next.js + SearxNG.

## License

MIT (upstream Vane, https://github.com/ItzCrazyKns/Vane).
