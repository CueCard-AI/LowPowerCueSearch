# Docs Index

One page linking every doc, skill, and rule with a one-line description.
Anything is one click away.

## Top-level

| Path | What it is |
|---|---|
| [README.md](../README.md) | Project overview, modes, quick start, algorithm highlights |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute: structure, conventions, before-you-ship checklist |

## docs/

| Doc | What it covers |
|---|---|
| [ONBOARDING.md](ONBOARDING.md) | Read-this-first for any new agent: mental model, mode mapping, algorithm catalog, invariants, pitfalls |
| [RUNBOOK.md](RUNBOOK.md) | Operational runbook: build/swap/verify, log decoding, SearxNG testing, config.json volume edits, incident playbook, recovery |
| [RESEARCH_PIPELINE.md](RESEARCH_PIPELINE.md) | Full pipeline reference: stages, mode→model map, algorithm catalog, reasoning trace, tuning knobs, key-file map |
| [RESEARCH_LOG.md](RESEARCH_LOG.md) | Living research log + speed/quality roadmap (papers, ideas, statuses, iteration plan, experiment log) |
| [SCALE_AND_DEPLOYMENT.md](SCALE_AND_DEPLOYMENT.md) | Production architecture, K8s topology, SearxNG proxy pool, sizing, cost — scaling `/api/enrich` to 1000 leads/10 min |
| [SCALING_STEPS.md](SCALING_STEPS.md) | Extremely detailed step-by-step build plan (phases 0–4, per-step files/commands/verification/done-criteria) for the scaling effort |
| [LOCAL_MODELS.md](LOCAL_MODELS.md) | Cross-encoder reranker (all modes) + local embedder (`/api/enrich` only) — bundling, singletons, prewarm, fallbacks, perf |
| [architecture/README.md](architecture/README.md) | Upstream Vane architecture overview (key components) |
| [architecture/WORKING.md](architecture/WORKING.md) | Upstream high-level flow |
| [API/SEARCH.md](API/SEARCH.md) | Programmatic search API (`POST /api/search`) |
| [API/ENRICH.md](API/ENRICH.md) | Lead enrichment API (`POST /api/enrich`) — request/response, streaming, citations map, UI transpose |
| [installation/UPDATING.md](installation/UPDATING.md) | Updating the app |

## .cursor/skills/ (auto-load in Cursor)

| Skill | Loads when | Purpose |
|---|---|---|
| [ml-search-pipeline](../.cursor/skills/ml-search-pipeline/SKILL.md) | editing `src/lib/agents/search/**` or discussing the pipeline (auto) | Deep orientation on the pipeline, speed/quality modes, algorithm catalog, tuning knobs |
| [quality-coding](../.cursor/skills/quality-coding/SKILL.md) | editing source (auto) | Project-specific anti-patterns, design rules, doc standards, before-you-ship checklist |
| [documentation](../.cursor/skills/documentation/SKILL.md) | editing `.md` docs / file headers / mentioning docs or diagrams (auto) | Detailed-description structure + ASCII UI/UX + pipeline diagram conventions |
| [experiment-logging](../.cursor/skills/experiment-logging/SKILL.md) | editing `docs/RESEARCH_LOG.md` / `docs/BUILD_TRACKER.md` / mentioning experiments (auto) | Scannable experiment cards: status badge + TL;DR + before/after diagram + ASCII measurement bar charts |
| [vane-ops](../.cursor/skills/vane-ops/SKILL.md) | named explicitly | Docker build/swap/verify loop, log decoding, SearxNG testing, config.json volume edits |

## .cursor/rules/ (always-on or file-scoped)

| Rule | Scope | Enforces |
|---|---|---|
| [zero-cost-constraint.mdc](../.cursor/rules/zero-cost-constraint.mdc) | always | No paid APIs — SearxNG + Gemini free tier + GLM via z.ai only |
| [quality-coding.mdc](../.cursor/rules/quality-coding.mdc) | always | No keys in source, fallbacks on external calls, no N+1 calls, no speed-mode LLM round-trips, ship pipeline changes with docs update |
| [documentation.mdc](../.cursor/rules/documentation.mdc) | always | Flow/pipeline changes ship with a docs + ASCII-diagram update, not just prose |
| [experiment-logging.mdc](../.cursor/rules/experiment-logging.mdc) | always | Every shipped/reverted experiment in `docs/RESEARCH_LOG.md` ships with a measurement bar chart + status badge + TL;DR |
| [research-pipeline.mdc](../.cursor/rules/research-pipeline.mdc) | `src/lib/agents/search/**` | Pipeline invariants: mode→model hardcoded, Gemini embeddings, fence-tolerant `generateObject`, writer uses mode llm |
| [glm-provider.mdc](../.cursor/rules/glm-provider.mdc) | `src/lib/models/providers/glm/**` | GLM specifics: thinking-disabled, `repairJson` for fences, model list sync, coding endpoint, no GLM embeddings |
| [searxng.mdc](../.cursor/rules/searxng.mdc) | `searxng/**` | Engine allowlist, `max_request_timeout`, residential-IP reality, JSON format required |
| [docker-ops.mdc](../.cursor/rules/docker-ops.mdc) | `Dockerfile*`, `docker-compose*`, `entrypoint.sh` | Slow build, swap pattern, config.json in volume, verify after swap |

## Where to start (by task)

| If you want to… | Start here |
|---|---|
| Understand the codebase | [ONBOARDING.md](ONBOARDING.md) → [RESEARCH_PIPELINE.md](RESEARCH_PIPELINE.md) |
| Run / rebuild / debug | [RUNBOOK.md](RUNBOOK.md) |
| Deploy / scale / size the cluster | [SCALE_AND_DEPLOYMENT.md](SCALE_AND_DEPLOYMENT.md) |
| Modify the search pipeline | [RESEARCH_PIPELINE.md](RESEARCH_PIPELINE.md) + the `ml-search-pipeline` skill |
| Plan the next speed/quality improvement | [RESEARCH_LOG.md](RESEARCH_LOG.md) (ideas, papers, statuses, iteration plan) |
| Add a model provider | `src/lib/models/providers/` + the `glm-provider` rule |
| Understand local models (reranker + embedder) | [LOCAL_MODELS.md](LOCAL_MODELS.md) |
| Use the API (search vs enrich vs chat) | [API/ENRICH.md](API/ENRICH.md) §0 + [API/SEARCH.md](API/SEARCH.md) |
| Tune SearxNG | [searxng/settings.yml](../searxng/settings.yml) + the `searxng` rule |
| Write/fix docs | the `documentation` skill + the `documentation` rule |
| Ship a change | [CONTRIBUTING.md](../CONTRIBUTING.md) before-you-ship checklist |
