---
name: quality-coding
description: >-
  Enforce a high quality bar when writing or refactoring code in this Vane
  (LowPowerCueSearch) codebase — prevent project-specific bad design patterns,
  favor the right ones, and require good in-code documentation. Use when
  editing, writing, or refactoring TypeScript/TSX source under src/**, adding
  new modules, touching the research pipeline, or when the user asks for a code
  review, refactor, or to "do this well"/"write good code". Also use when
  adding documentation to code.
---

# Quality Coding (LowPowerCueSearch)

The agent already writes clean code generally. This skill adds
**project-specific** anti-patterns, design rules, and documentation
standards it would not infer without context.

## Anti-patterns to never reintroduce

These already bit this codebase. Don't reintroduce them.

- **N+1 API/embedding calls inside `.map()`** — batch them. We fixed
  21 per-result `embedText` calls → 2 in
  `src/lib/agents/search/researcher/actions/search/baseSearch.ts`. Any
  `await Promise.all(arr.map(async x => await fetch(...)))` over a known
  set is a smell — use one batched call where the API supports arrays.
- **`chat.completions.parse()` on non-OpenAI OpenAI-compatible endpoints**
  — GLM wraps JSON in ```json fences and `.parse()` strict-parses
  internally before any repair runs. Use `.create()` +
  `repairJson({ extractJson: true })`. See
  `src/lib/models/providers/glm/glmLLM.ts`.
- **Per-request user model selection for the pipeline** — mode→model is
  hardcoded in `src/lib/models/modeModels.ts`. The routes use
  `loadChatModelByType` / `loadEmbeddingModelByType`. Don't reintroduce
  client `chatModel`/`embeddingModel` selection for the pipeline.
- **Dropping `delta.reasoning_content`** — the UI reasoning trace depends
  on it. `streamText` must yield `reasoningChunk`. See
  `src/lib/models/providers/openai/openaiLLM.ts`.
- **Hardcoding API keys in source** — keys live in `config.json` in the
  `vane-data` volume. Never in source, env files, or the Dockerfile.
- **`use_default_settings: true` SearxNG with all engines** — captcha-prone
  from a residential IP. Use the allowlist in `searxng/settings.yml`.
- **Adding an LLM round-trip to speed mode** — speed budget is ~3 calls
  total (classify + 1 research iter + writer). Any new LLM call in speed
  mode is a regression. Gate new features to balanced/quality.
- **z.ai embedding models** — z.ai serves no embeddings
  (`embedding-3` → `1211 Unknown Model`). Embeddings go through Gemini.

## Design patterns to favor

- **One responsibility per pipeline stage** — classify / research / rerank
  / scrape / write are separate modules. Don't fuse stages.
- **Graceful fallbacks on every external call** — SearxNG timeout, scrape
  failure, LLM-judge failure, embedding failure all `try/catch` and
  degrade (fall back to similarity order, snippets, skip the step). The
  pipeline never hard-crashes on one stage. See `baseSearch.ts` for the
  pattern.
- **Gate features by `mode`** (`speed` / `balanced` / `quality`) — don't
  add cost to speed mode. Branch on `input.mode` / `input.config.mode`.
- **Progressive disclosure in prompts** — mode-specific prompt functions
  (`src/lib/prompts/search/researcher.ts`) rather than one mega-prompt
  with conditionals.
- **Batch external calls** — embeddings, scrapes, etc. in parallel or
  batched, never serial N+1.

## Documentation standards (enforced in-code)

- **File-level header comment** for any module with non-obvious
  architecture — one block at the top stating what it does and its place
  in the pipeline. Required for files like `baseSearch.ts`,
  `researcher/index.ts`, `modeModels.ts`, `glmLLM.ts`.
- **JSDoc** on exported functions that are part of the pipeline's public
  surface (e.g. `executeSearch`, `classify`, `getResearcherPrompt`,
  `loadChatModelByType`). Document params, return type, and any
  non-obvious behavior (fallbacks, mode-gating).
- **Inline comments only for non-obvious intent/tradeoffs** — e.g.
  `// thinking disabled: classifier only emits small JSON, no reasoning
  needed`. Never `// increment i` or restating the code.
- **When you add or change a pipeline stage, update
  `docs/RESEARCH_PIPELINE.md`** in the same change — the algorithm
  catalog, the flow, and the tuning-knobs table.
- **Keep skills/rules in sync** — if you introduce a new invariant, add a
  rule in `.cursor/rules/` for it. If you add a new operational workflow,
  add or update a skill in `.cursor/skills/`.

## Before-you-ship checklist (run this before declaring done)

- [ ] `ReadLints` clean on edited files.
- [ ] No new paid dependency (see `zero-cost-constraint` rule).
- [ ] Speed mode didn't gain an LLM round-trip.
- [ ] Every new external call has a `try/catch` fallback.
- [ ] No N+1 external calls — batched or parallelized.
- [ ] Pipeline touches → `docs/RESEARCH_PIPELINE.md` updated.
- [ ] Key/config touches → in the volume, not source.
- [ ] If you added/changed a provider or model, `modeModels.ts` or the
      provider's default model list is in sync with what the API actually
      serves (verify with a curl, don't guess).
- [ ] File-level header + JSDoc on new pipeline-public exports.
- [ ] If you introduced a new invariant, a `.cursor/rules/*.mdc` exists
      for it.

## What NOT to do

- Don't add generic "clean code" advice to files — the agent knows that.
- Don't write comments that restate the code.
- Don't add a paid service as a "quick fix" — flag it and propose a free
  alternative instead.
- Don't ship a pipeline change without updating
  `docs/RESEARCH_PIPELINE.md`.
