# Contributing to LowPowerCueSearch (Vane fork)

Thanks for contributing! This is a zero-cost, Perplexity-style AI search engine
(GLM via z.ai + Gemini embeddings + self-hosted SearxNG). Before changing code,
read [docs/ONBOARDING.md](docs/ONBOARDING.md) — it's the fastest orientation.

## Project structure

- **UI & routes** (`src/app`, `src/components`) — Next.js app directory + API
  routes (`/api/chat`, `/api/search`, `/api/providers`).
- **Search pipeline** (`src/lib/agents/search`) — classify → research → rerank →
  scrape → write. The deep reference is
  [docs/RESEARCH_PIPELINE.md](docs/RESEARCH_PIPELINE.md).
  - `classifier.ts` decides whether research is needed and what runs.
  - `researcher/` is the agentic tool-calling loop.
  - `researcher/actions/search/baseSearch.ts` is the search/result algorithm
    (rerank, domain cap, evidence retrieval, embeddings batching).
  - `widgets/` runs structured widgets (weather, stock, calculation) in
    parallel with research.
- **Models** (`src/lib/models`) — providers + `modeModels.ts` (the hardcoded
  mode→model map) + `registry.ts` (loaders).
- **Prompts** (`src/lib/prompts/search`) — classifier, researcher (per-mode),
  writer.
- **SearxNG** (`src/lib/searxng.ts`) + **scraper** (`src/lib/scraper.ts`).
- **DB** (`src/lib/db`) — sqlite via better-sqlite3 + drizzle.
- **Uploads** (`src/lib/uploads`) — file ingest + embedding for personal search.

### Where to make changes

- **Search behavior / reasoning** → `src/lib/agents/search`.
- **A search tool / capability** → `src/lib/agents/search/researcher/actions`
  (registered in `actions/index.ts`).
- **A widget** → `src/lib/agents/search/widgets`.
- **A model provider** → `src/lib/models/providers` + wire into
  `src/lib/models/providers/index.ts`.
- **Mode → model mapping** → `src/lib/models/modeModels.ts`.
- **SearxNG engines / timeouts** → `searxng/settings.yml`.
- **Prompts** → `src/lib/prompts/search`.

## Fork-specific conventions

These are non-negotiable. The `.cursor/rules/` enforce most of them; the
`quality-coding` skill has the full rationale.

1. **Zero-cost.** No paid APIs — SearxNG + Gemini free tier + GLM via z.ai only.
   If a feature needs a paid service, flag it and propose a free alternative;
   don't silently add the dependency.
2. **No keys in source.** API keys live in `config.json` in the `vane-data`
   volume. Never in `.ts`, `.env`, or the Dockerfile. See
   [docs/RUNBOOK.md](docs/RUNBOOK.md) for the volume-edit workflow.
3. **Mode-gate new features.** Speed budget is ~3 LLM calls total (classify +
   1 research iter + writer). Any new LLM call in speed mode is a regression —
   gate to balanced/quality.
4. **Fence-tolerant `generateObject` on GLM.** GLM wraps JSON in ```json
   fences; `.parse()` rejects them. The override in
   `src/lib/models/providers/glm/glmLLM.ts` uses `.create()` +
   `repairJson({ extractJson: true })` + `thinking: { type: 'disabled' }`. Keep
   it. (For free-form outputs like the rerank list, use `generateText` + manual
   parse instead.)
5. **Fallbacks on every external call.** SearxNG / scrape / LLM / embeddings
   all `try/catch` and degrade. The pipeline never hard-crashes on one stage.
6. **No N+1 external calls.** Batch embeddings/API calls. Don't
   `await Promise.all(arr.map(async x => await fetch(...)))` over a known set.
7. **Reasoning trace stays.** `streamText` yields `reasoningChunk` (from
   `delta.reasoning_content`). Don't strip it. Throttle `session.updateBlock`
   in per-chunk loops (≥64 chars between emits) to avoid flooding the client.

## Cursor skills & rules

The repo ships agent guidance in `.cursor/`:

- **Skills** (`.cursor/skills/`): `ml-search-pipeline` (auto, pipeline
  orientation), `quality-coding` (auto, anti-patterns + doc standards),
  `documentation` (auto, ASCII diagram conventions), `vane-ops` (explicit,
  Docker runbook).
- **Rules** (`.cursor/rules/`): `zero-cost-constraint` (always),
  `quality-coding` (always), `documentation` (always), plus file-scoped rules
  for the research pipeline, GLM provider, SearxNG, and Docker ops.

If you introduce a new invariant, add a rule. If you add a new operational
workflow, add a skill. See [docs/INDEX.md](docs/INDEX.md) for the full list.

## Before you ship (checklist)

- [ ] `ReadLints` clean on edited files.
- [ ] No new paid dependency.
- [ ] Speed mode didn't gain an LLM round-trip.
- [ ] Every new external call has a `try/catch` fallback.
- [ ] No N+1 external calls — batched or parallelized.
- [ ] **Pipeline/UI-flow change → update `docs/RESEARCH_PIPELINE.md` with an
      ASCII diagram** of the new flow (not just prose).
- [ ] Key/config change → in the volume, not source.
- [ ] New model/provider → `modeModels.ts` or the provider's default list is in
      sync with what the API actually serves (curl-verify, don't guess).
- [ ] File-level header + JSDoc on new pipeline-public exports.
- [ ] Run `npm run format:write` before committing.

## Documentation requirement

Any change that alters a **user-visible flow** (UI states, progress steps) or a
**pipeline stage** must ship with a `docs/` update that includes an **ASCII
diagram** of the new flow — not just prose. Diagrams use box-drawing chars,
labeled arrows, code-fence wrapped, ≤ ~60 cols. See the `documentation` skill
for conventions.

## Setting up your environment

```bash
npm install
npm run dev        # development (hot reload) on :3000
# or
npm run build && npm run start
```

For Docker (recommended — bundles SearxNG):

```bash
docker build -t vane-glm .
docker run -d -p 4567:3000 -v vane-data:/home/vane/data --name vane-glm vane-glm
```

See the [README](README.md) for full setup and [docs/RUNBOOK.md](docs/RUNBOOK.md)
for the operational loop. Database migrations run automatically on startup.

## Coding practices

1. Verify your change works (run a query in the affected mode(s)).
2. Run `npm run format:write` before committing.
3. Follow the `quality-coding` skill's anti-pattern catalog — don't reintroduce
   bugs we already fixed (N+1 calls, `.parse()` on fences, reasoning-update
   flood, bare-list rerank, residential-IP SearxNG assumptions).

Thanks for helping keep this a fast, high-quality, zero-cost search engine.
