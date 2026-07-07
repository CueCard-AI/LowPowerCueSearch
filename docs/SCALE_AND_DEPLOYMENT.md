# Scale & Deployment

Production architecture for `LowPowerCueSearch` — getting `/api/enrich` to **1000 leads / 10 min** with citations, plus the chat UI. Grounded in the current repo (`Dockerfile.slim`, `src/lib/config/index.ts`, `src/lib/models/modeModels.ts`, `searxng/settings.yml`, `src/lib/searxng.ts`) and the Build 7 load-test findings in `docs/BUILD_TRACKER.md`.

## 1. Target

- **Throughput:** 1.67 req/s sustained with citations (= 1000 leads / 10 min).
- **Quality:** every enrichment answer sourced & cited; honest "search failed" instead of fabrication (`requireSearch` prompt, Build 7).
- **Resilience:** no single-IP SearxNG ban, no Gemini-RPM 500s, survives pod churn.
- **Cost:** ~$5–7 per 1000-lead batch (LLM-dominated).

## 2. System architecture

```
                            ┌─────────────────────────────────────────────────────────────┐
                            │                     INTERNET                                │
                            │   users (UI)  •  lead-enrichment client  •  upstream search  │
                            └───────────┬───────────────────────────────────┬─────────────┘
                                        │                                   │
                            ┌───────────▼──────────────┐    ┌───────────────▼──────────────┐
                            │  Load Balancer / Ingress  │    │  Rotating residential proxy  │
                            │  (nginx-ingress or ALB)   │    │  (Bright Data / Smartproxy)  │
                            │  TLS terminates here      │    │  exit IP rotates per request │
                            └───────────┬──────────────┘    └───────────────┬──────────────┘
                                        │                                   │
                            ┌───────────▼───────────────────────────────────▼──────────────┐
                            │                  Kubernetes cluster                          │
                            │                                                            │
                            │   ┌───────────────────────────────────────────────────────┐ │
                            │   │ Namespace: vane                                        │ │
                            │   │                                                       │ │
                            │   │   vane-app  Deployment + HPA  (Dockerfile.slim, ~2GB)│ │
                            │   │   ┌─────────┐  ┌─────────┐  ┌─────────┐               │ │
                            │   │   │ pod 1   │  │ pod 2   │  │ pod N   │  (target 3+) │ │
                            │   │   │ Next.js │  │ Next.js │  │ Next.js │  port 3000   │ │
                            │   │   │ +local  │  │ +local  │  │ +local  │               │ │
                            │   │   │  embed  │  │  embed  │  │  embed  │               │ │
                            │   │   │ +x-enc  │  │ +x-enc  │  │ +x-enc  │               │ │
                            │   │   │  rerank │  │  rerank │  │  rerank │               │ │
                            │   │   │ p-limit │  │ p-limit │  │ p-limit │  (~10-12/pod) │ │
                            │   │   └────┬────┘  └────┬────┘  └────┬────┘               │ │
                            │   │        │            │            │                     │ │
                            │   │        └────────────┼────────────┘                     │ │
                            │   │                     │                                  │ │
                            │   │      Service: vane-app (ClusterIP, round-robin)        │ │
                            │   │                     │                                  │ │
                            │   │   ┌─────────────────▼──────────────────────────┐      │ │
                            │   │   │ /api/enrich  •  /api/chat  •  /api/search  │      │ │
                            │   │   │  (modeModels.ts → Gemini Flash Lite speed, │      │ │
                            │   │   │   GLM-4.6 balanced, GLM-5.2 quality)        │      │ │
                            │   │   └─────────────────┬──────────────────────────┘      │ │
                            │   └─────────────────────┼─────────────────────────────────┘ │
                            │                         │                                   │
                            │   ┌─────────────────────▼─────────────────────────────────┐ │
                            │   │ External LLM (egress)                                 │ │
                            │   │  • Gemini Flash Lite (paid) — speed writer, KB, embed │ │
                            │   │    fallback (if local embedder off)                    │ │
                            │   │  • GLM-4.6 / GLM-5.2 (z.ai) — balanced/quality         │ │
                            │   └──────────────────────────────────────────────────────┘ │
                            │                         │                                   │
                            │   ┌─────────────────────▼─────────────────────────────────┐ │
                            │   │ Service: searxng (ClusterIP, round-robin)              │ │
                            │   │   ┌──────────┐ ┌──────────┐ ┌──────────┐  (target 8-10)│ │
                            │   │   │ searx 1  │ │ searx 2  │ │ searx N  │  port 8080   │ │
                            │   │   │ settings │ │ settings │ │ settings │              │ │
                            │   │   │ .yml     │ │ .yml     │ │ .yml     │              │ │
                            │   │   │ proxy→   │ │ proxy→   │ │ proxy→   │              │ │
                            │   │   └─────┬────┘ └─────┬────┘ └─────┬────┘              │ │
                            │   └─────────┼────────────┼────────────┼───────────────────┘ │
                            └─────────────┼────────────┼────────────┼─────────────────────┘
                                          │            │            │
                            ┌─────────────▼────────────▼────────────▼─────────────────────┐
                            │  Upstream search engines (via rotating proxy)               │
                            │   Google  •  Brave  •  DuckDuckGo  •  Startpage  •  Mojeek  │
                            │   Qwant  •  Wikipedia  •  WolframAlpha                      │
                            └─────────────────────────────────────────────────────────────┘

  Persistent / shared:
    ┌──────────────────────┐   ┌──────────────────────────┐
    │ PVC: vane-data        │   │ Redis (optional, batch)   │
    │ /home/vane/data       │   │  • job queue (BullMQ)     │
    │  • config.json        │   │  • result cache           │
    │  • sqlite (chats)     │   │  • dedup cache            │
    │  • uploads            │   └──────────────────────────┘
    └──────────────────────┘
```

## 3. Components

| Component | Image / source | Replicas | Purpose | Key config |
|---|---|---|---|---|
| Ingress | nginx-ingress or cloud ALB | 1+ (HA) | TLS, routing, rate-limit | host → `vane-app` Service |
| vane-app | `Dockerfile.slim` (~2GB, no SearxNG) | 3+ (HPA on CPU/queue) | Next.js API + UI; local embedder + cross-encoder reranker; bounded concurrency | env: `SEARXNG_API_URL`, `GEMINI_API_KEY`, `GLM_API_KEY`, `DATA_DIR` |
| searxng | `searxng/searxng` (official) | 8–10 | Meta-search, fans out to engines | `settings.yml` ConfigMap + proxy Secret |
| Proxy | external managed (Bright Data/Smartproxy/Oxylabs) | n/a | Rotating residential exit IPs | `outgoing.proxies` in `settings.yml` |
| Redis | `redis:7` | 1 (HA optional) | Job queue + cache for batch path | BullMQ |
| PVC | — | 1 | Persistent app state | `/home/vane/data` |

## 4. Request lifecycle (`/api/enrich`, speed mode)

```
client POST /api/enrich
  → Ingress → vane-app Service → a pod (round-robin)
     pod:
       1. p-limit gate (≤ ~10-12 in-flight per pod)
       2. load Gemini Flash Lite + local embedder (cached singletons)
       3. Search-o1 writer:
            round 0: streamText(web_search tool) → model calls web_search
                     ↳ web_search → Searxng Service → a searxng pod
                         → engines via rotating proxy → results
                       ↳ local embedder embeds queries+results (batched)
                       ↳ local cross-encoder reranks (S1) + compresses (S9)
            round 1: streamText(no tools, search results) → cited answer
       4. retryStream wraps both streamText calls (retries on fetch-failed)
       5. parseCitations([N] → source map)
       6. return { answer, sources, reasoning, citations }
```

Balanced/quality mode bypasses the Search-o1 writer and runs the full pipeline (classify → researcher/BATS → Gemini KB → drafter/verifier), still using the same Searxng pool and local embedder.

## 5. Kubernetes topology (manifests to author)

```
k8s/
  namespace.yaml                 # vane
  secret.searxng-proxy.yaml      # PROXY_URL (residential rotating endpoint)
  secret.llm-keys.yaml           # GEMINI_API_KEY, GLM_API_KEY (z.ai)
  configmap.searxng.yaml         # settings.yml (engines + outgoing.proxies)
  configmap.vane-env.yaml        # SEARXNG_API_URL=http://searxng:8080, DATA_DIR
  deployment.vane-app.yaml       # Dockerfile.slim, port 3000, PVC mount /home/vane/data
  hpa.vane-app.yaml              # CPU 70% / custom queue-depth, min 3 max 10
  service.vane-app.yaml          # ClusterIP
  deployment.searxng.yaml        # 8-10 replicas, port 8080, proxy env
  service.searxng.yaml           # ClusterIP (round-robin)
  deployment.redis.yaml          # batch queue
  service.redis.yaml
  ingress.yaml                   # TLS, /api/* + /
  pvc.vane-data.yaml             # persistent config + sqlite + uploads
```

## 6. Configuration & secrets

App config is **env-driven** (`src/lib/config/index.ts:175` `initializeFromEnv`): provider keys (`GEMINI_API_KEY`, `GLM_API_KEY`) and `SEARXNG_API_URL` come from env; `config.json` is persisted at `${DATA_DIR}/data/config.json` (`src/lib/config/index.ts:8`). In k8s:

- **Secrets → env** on the vane-app Deployment: `GEMINI_API_KEY`, `GLM_API_KEY`, `SEARXNG_API_URL`, `DATA_DIR=/home/vane/data`.
- **SearxNG proxy** → Secret mounted into the searxng pod as env, referenced by `outgoing.proxies` in `settings.yml`.
- **PVC** at `/home/vane/data` so `config.json` + sqlite survive pod restarts. For >1 app replica, either keep sqlite on a single "writer" pod + read replicas, or move chats to Postgres — sqlite + RWX is fragile. The enrich-only batch path barely touches the DB, so a single PVC with RWX or a dedicated writer pod is fine to start.

`modeModels.ts` is hardcoded (speed=`gemini-3.1-flash-lite`, balanced=`glm-4.6`, quality=`glm-5.2`); no runtime model selection needed.

## 7. Sizing (from Build 7 load test)

| Layer | Per-unit | Units for 1.67 req/s (with citations) |
|---|---|---|
| vane-app | ~0.87–1.55 req/s per pod at 10–12 concurrent | 3 pods (HA + headroom) |
| searxng | ~0.8 req/s per pod (5 concurrent × 6s) | 8–10 pods |
| Gemini Flash Lite (paid) | high RPM on paid tier | 1 key |
| Proxy | bandwidth-based | 1 rotating endpoint |
| Local embedder + reranker | CPU, ~10–180ms per call | per app-pod |

**Do not** raise per-pod concurrency past ~12 to chase throughput — that's the regime where Gemini free-tier degrades tool-calling and SearxNG gets banned. Scale pods, not concurrency.

## 8. External dependencies

| Dependency | Mode | Notes |
|---|---|---|
| Gemini API | paid | speed writer, KB construction (`generateObject`), embedding fallback. Paid tier for RPM headroom. |
| z.ai (GLM) | free or paid | balanced (`glm-4.6`) + quality (`glm-5.2`) chat; drafter (`glm-4.5-air`). Only used outside speed mode. |
| Rotating residential proxy | paid | ~$5/GB; SearxNG text traffic is tiny (~400MB / 1000 leads → ~$2/batch). |
| Upstream search engines | free (rate-limited per IP) | proxy rotation dodges per-IP limits. |
| HuggingFace | build-time only | local embedder + cross-encoder ONNX weights bundled in the image. |

## 9. Resilience & failure modes

| Failure | Mitigation |
|---|---|
| Gemini "fetch failed" (RPM) | `retryStream` (Build 7) retries before first chunk; paid tier for headroom. |
| Gemini skips tool-call under load | `requireSearch` prompt (Build 7) → honest "search failed" answer; caller retries the lead. Bounded per-pod concurrency keeps the model in the reliable regime. |
| Single-IP SearxNG banned (Google/Brave/DDG throttle) | Rotating residential proxy pool + multi-pod SearxNG; wider engine allowlist (startpage/mojeek/qwant). **This is the core scaling unlock — without it, sustained concurrency is impossible** (Build 7 confirmed all engines ban within ~30 concurrent requests). |
| SearxNG pod slow/down | `retryStream` + retry-across-instances in `src/lib/searxng.ts` (TODO); Service round-robin skips unhealthy pods. |
| Pod churn mid-batch | Optional Redis + BullMQ job queue — submitted batch drains with bounded workers, survives pod restarts. |
| Cross-encoder cold start | `src/instrumentation.ts` prewarms reranker (and should prewarm local embedder) on pod boot. |

## 10. Deployment sequence

1. **Local embedder** (transformers.js) — remove Gemini embedding from hot path; bundle ONNX in `Dockerfile.slim`; prewarm in `instrumentation.ts`. Testable locally.
2. **SearxNG proxy + engine diversity** — `outgoing.proxies` in `settings.yml`; re-enable startpage/mojeek/qwant; retry-across-instances in `searxng.ts`.
3. **Bounded concurrency** — `p-limit` ~10–12 per pod in `/api/enrich`.
4. **K8s manifests** — author `k8s/` (above); deploy Searxng pool first, point `SEARXNG_API_URL` at the Service.
5. **Paid Gemini tier** — swap the key in the Secret; verify RPM headroom with a 30-concurrent re-test (expect quality-sustaining 2+ req/s across 3 pods).
6. **Optional Redis + BullMQ** — batch submit endpoint + worker drain + progress.

## 11. Cost estimate (one 1000-lead batch)

- Gemini Flash Lite (paid): ~2000 calls × ~3.5k tokens → ~$3–4.
- Proxy bandwidth: ~400MB @ ~$5/GB → ~$2.
- K8s infra (8–10 tiny SearxNG + 3 app pods, 10 min): ~$0.50–1.
- **Total: ~$5–7 / 1000 leads**, dominated by LLM.

## 12. Local dev ↔ prod parity

| | Local (current) | Prod |
|---|---|---|
| App image | `Dockerfile` (bundled SearxNG, ~12GB) | `Dockerfile.slim` (~2GB, no SearxNG) |
| SearxNG | in-container, single instance, single IP | external pool, 8–10 pods, rotating proxy |
| Embeddings | Gemini API | local transformers.js (+ Gemini fallback) |
| LLM tier | Gemini free | Gemini paid |
| Concurrency | unbounded | `p-limit` ~10–12/pod |
| Config | `config.json` on local volume | Secrets → env + PVC |

---

## See also

- `docs/BUILD_TRACKER.md` — Build 7 (enrich resilience + load test findings).
- `docs/RESEARCH_PIPELINE.md` — pipeline architecture, modes, algorithm catalog.
- `docs/ONBOARDING.md` — mode table, invariants, common pitfalls.
- `.cursor/rules/research-pipeline.mdc` — Gemini `thought_signature` invariant, E1 pattern.
