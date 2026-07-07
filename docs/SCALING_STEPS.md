# Scaling Steps — Detailed Build Plan

The extremely detailed, step-by-step plan for scaling `/api/enrich` to
**1000 leads / 10 min with citations** and deploying it on Kubernetes. This is
the executable checklist companion to `docs/SCALE_AND_DEPLOYMENT.md` (the
architecture overview). Each step has: goal, exact files, commands, verification,
rollback, and done-criteria.

**Status legend:** `[x]` done · `[~]` in progress · `[ ]` not started · `[!]` blocked.

---

## Phase 0 — App-layer hardening (DONE)

### Step 0.1 — Switch speed mode to Gemini Flash Lite  `[x]`
- **Goal:** higher throughput/concurrency for the speed-mode writer.
- **Files:** `src/lib/models/modeModels.ts`.
- **Change:** `MODE_MODEL_MAP.speed` → `{ providerType: 'gemini', key: 'models/gemini-3.1-flash-lite' }`.
- **Verification:** solo `/api/enrich` returns a cited answer in ~5s.
- **Done:** shipped in Build 6.

### Step 0.2 — Gemini `thought_signature` round-trip  `[x]`
- **Goal:** Gemini's OpenAI-compat endpoint requires the `thought_signature`
  from the streaming tool-call delta to be sent back on the assistant
  message; without it the API returns `400: Function call is missing a
  thought_signature`.
- **Files:**
  - `src/lib/models/types.ts` — add `thoughtSignature?: string` to `ToolCall`.
  - `src/lib/models/providers/openai/openaiLLM.ts` — `streamText` captures
    `delta.tool_calls[].extra_content.google.thought_signature` (Gemini sends
    `index: null`, bucket by `recievedToolCalls.length`).
  - `src/lib/models/providers/gemini/geminiLLM.ts` — override
    `convertToOpenAIMessages` to re-attach `extra_content.google.thought_signature`.
  - `src/lib/agents/search/searchWriter.ts` + `enrichmentAgent.ts` — propagate
    `tc.thoughtSignature` into the assistant message.
- **Verification:** `/api/enrich` with a search-triggering query returns 200
  with sources (was 400 before).
- **Done:** shipped in Build 6.

### Step 0.3 — `requireSearch` prompt for enrichment  `[x]`
- **Goal:** force the enrichment writer to call `web_search` and refuse to
  fabricate from internal knowledge (training data is stale for
  funding/news/leadership). Exposed the "30-concurrent quality mirage" —
  the writer was answering from memory with 0 sources.
- **Files:** `src/lib/prompts/search/searchWriterPrompt.ts` (adds
  `opts.requireSearch`), `src/lib/agents/search/enrichmentAgent.ts` (passes
  `requireSearch: true`).
- **Verification:** when SearxNG returns nothing, the answer honestly says
  "search returned no results" instead of inventing facts.
- **Done:** shipped in Build 7.

### Step 0.4 — `retryStream` for fetch-failed resilience  `[x]`
- **Goal:** eliminate the `500: fetch failed` responses from Gemini RPM
  throttling under concurrency.
- **Files:** `src/lib/models/retryStream.ts` (new) — retries the underlying
  call only if it throws before yielding the first chunk (no double-emit
  risk). Wired into `enrichmentAgent.runSearchWriter`.
- **Verification:** 30-concurrent test → 30/30 succeeded (was 29/30).
- **Done:** shipped in Build 7.

### Step 0.5 — Load test + sizing  `[x]`
- **Result:** quality-sustaining per-pod throughput is ~0.87–1.55 req/s at
  10–16 concurrent. Past ~12 concurrent, Gemini free-tier degrades
  tool-calling and single-IP SearxNG gets banned. **Scale pods, not
  concurrency.**
- **Done:** documented in Build 7.

### Step 0.6 — Local embedder for the enrich hot path  `[x]`
- **Goal:** remove the 2 Gemini embedding API calls per search from the
  enrich path → one fewer rate-limited dependency, lower latency.
- **Files:** `src/lib/models/localEmbeddingModel.ts` (new singleton),
  `src/lib/models/modeModels.ts` (`LOCAL_EMBEDDING_MODEL`),
  `src/app/api/enrich/route.ts` (load local first, Gemini fallback),
  `src/instrumentation.ts` (prewarm), `Dockerfile` + `Dockerfile.slim`
  (bundle `Xenova/all-MiniLM-L6-v2` at `/home/vane/models/embedder/`).
- **Verification:** isolated in-container test → 384-dim, correct cosine
  ordering; instrumentation log `local-embedder: loaded`; solo enrich clean.
- **Note:** chat/search routes keep Gemini embedding so uploads (persisted
  768-dim chunks) stay consistent.
- **Done:** shipped in Build 8.

---

## Phase 1 — Search infrastructure (the core scaling unlock)

> **This phase is the critical path.** Without it, sustained concurrency is
> impossible — the Build 7 load test proved all useful engines (Google/Brave/DDG)
> ban a single IP within ~30 concurrent requests.

### Step 1.1 — Sign up for a rotating residential proxy  `[ ]`
- **Goal:** every SearxNG engine request egresses through a fresh exit IP so
  upstream engines don't rate-limit/captcha the pool.
- **Action (you, external):** create an account at Bright Data / Smartproxy /
  Oxylabs. Get the rotating-residential endpoint URL
  (`http://user:pass@rotating.brightdata.com:22225` or similar).
- **Cost:** ~$5/GB; SearxNG text traffic is ~400MB / 1000 leads → ~$2/batch.
- **Done when:** you have a working proxy URL + credentials and can curl
  through it and see a rotating exit IP:
  ```bash
  curl -x http://user:pass@rotating.proxy:port https://api.ipify.org  # run twice, expect different IPs
  ```

### Step 1.2 — Wire the proxy into SearxNG `settings.yml`  `[ ]`
- **Goal:** SearxNG routes all engine requests through the rotating proxy.
- **Files:** `searxng/settings.yml`.
- **Change:** add an `outgoing.proxies` block (HTTP + HTTPS) pointing at the
  proxy URL, sourced from an env var so secrets stay out of the image:
  ```yaml
  outgoing:
    proxies:
      all://: ${SEARXNG_PROXY_URL}
  ```
  (SearxNG supports env interpolation in settings; verify against the
  SearxNG docs for the exact `outgoing.proxies` schema for your version.)
- **Verification (local):** restart the local SearxNG with `SEARXNG_PROXY_URL`
  set, run a query, confirm results return and the SearxNG log shows requests
  going through the proxy (no direct engine 403s/captchas).
- **Rollback:** remove the `outgoing.proxies` block.

### Step 1.3 — Widen the engine allowlist  `[ ]`
- **Goal:** more engine diversity = resilience when one engine throttles.
- **Files:** `searxng/settings.yml`.
- **Change:** re-enable `startpage`, `mojeek`, `qwant` (currently `disabled:
  true`). Keep `bing`/`startpage`/`qwant` image/video engines disabled (not
  useful for enrichment).
- **Verification:** a query returns results from ≥3 engines (check
  `result.engine` in the JSON).
- **Rollback:** re-disable the engines.

### Step 1.4 — Retry-across-instances in `searxng.ts`  `[ ]`
- **Goal:** if one SearxNG pod returns empty/captchas, retry against a
  different pod (different exit IP) before giving up.
- **Files:** `src/lib/searxng.ts`.
- **Change:** `searchSearxng` currently hits a single `searxngURL`. Make it
  accept a list of URLs (or read a comma-separated `SEARXNG_API_URLS` env),
  try them in round-robin order, return the first non-empty successful
  response. Keep the 25s timeout split across attempts.
- **Verification (local):** point `SEARXNG_API_URLS` at two SearxNG instances,
  stop one, confirm requests succeed via the other.
- **Rollback:** single-URL behavior (one env var).
- **Done when:** a search returns results even if the first SearxNG instance
  is down/empty.

### Step 1.5 — Re-run the load test with the proxy  `[ ]`
- **Goal:** find the true quality-sustaining throughput with IP rotation.
- **Action:** with the proxy configured locally, re-run
  `/tmp/loadtest_enrich2.sh 30` (and 50, 100) and measure sources/citations
  per request, not just throughput.
- **Done when:** at the target concurrency, ≥90% of requests return
  sourced+cited answers, and throughput ≥ 1.67 req/s sustained. This is the
  **validation gate** before K8s — do not proceed to Phase 3 until it passes.
- **If it doesn't pass:** the ceiling is Gemini RPM, not SearxNG → go to
  Phase 2 step 2.3 (paid Gemini) before re-testing.

---

## Phase 2 — App-layer concurrency control

### Step 2.1 — Add `p-limit` dependency  `[ ]`
- **Goal:** bounded in-flight concurrency per pod so a burst can't collapse
  the SearxNG pool or Gemini RPM.
- **Command:** `yarn add p-limit`.
- **Verification:** `p-limit` in `package.json` + `yarn.lock`.

### Step 2.2 — Gate `/api/enrich` with a semaphore  `[ ]`
- **Goal:** cap in-flight enrich requests per pod at ~10–12 (the
  quality-sustaining regime from the Build 7 test).
- **Files:** `src/app/api/enrich/route.ts`.
- **Change:** create a module-level `const limiter = p-limit(12)`; wrap the
  per-request work in `await limiter(async () => { ... })`. If over capacity,
  requests queue (or return 429 if you prefer backpressure — start with
  queueing). Make the limit env-configurable: `ENRICH_CONCURRENCY_LIMIT`
  (default 12).
- **Verification:** fire 30 concurrent requests at one pod; observe ≤12
  in-flight (log active count), no 500s, throughput stable.
- **Rollback:** set the env var high (or remove the wrapper).
- **Done when:** a single pod under burst load stays in the reliable regime.

### Step 2.3 — Paid Gemini tier  `[ ]`
- **Goal:** RPM headroom so Gemini doesn't throttle tool-calling under
  concurrency.
- **Action (you, external):** enable billing on the Gemini project / upgrade
  the API key. The model id stays `models/gemini-3.1-flash-lite`; only the
  key's tier changes.
- **Files:** just the k8s Secret (Phase 3) / local env — no code change.
- **Verification:** re-run the 30-concurrent load test; expect sourced
  answers on ≥90% of requests (vs the free-tier degradation at 30).
- **Done when:** 30-concurrent test shows ≥90% sourced answers.

---

## Phase 3 — Kubernetes deployment

### Step 3.1 — Author the `k8s/` manifests  `[ ]`
- **Goal:** runnable k8s skeleton.
- **Files (new):** `k8s/` directory:
  - `namespace.yaml` — `vane` namespace.
  - `secret.llm-keys.yaml` — `GEMINI_API_KEY`, `GLM_API_KEY` (base64).
  - `secret.searxng-proxy.yaml` — `SEARXNG_PROXY_URL`.
  - `configmap.searxng.yaml` — `settings.yml` (engines + `outgoing.proxies`).
  - `configmap.vane-env.yaml` — `SEARXNG_API_URL=http://searxng:8080`,
    `DATA_DIR=/home/vane/data`, `ENRICH_CONCURRENCY_LIMIT=12`.
  - `deployment.vane-app.yaml` — image `vane-glm:latest` (built from
    `Dockerfile.slim`), port 3000, envFrom secrets + configmap, PVC mount
    `/home/vane/data`, readiness probe on `/`.
  - `hpa.vane-app.yaml` — min 3 max 10, CPU 70% (or custom queue-depth).
  - `service.vane-app.yaml` — ClusterIP.
  - `deployment.searxng.yaml` — `searxng/searxng:latest`, 8–10 replicas,
    port 8080, settings ConfigMap + proxy Secret.
  - `service.searxng.yaml` — ClusterIP (round-robin).
  - `pvc.vane-data.yaml` — persistent.
  - `ingress.yaml` — TLS, `/` → `vane-app`.
- **Verification:** `kubectl apply -f k8s/ --dry-run=client` passes.
- **Done when:** `kubectl apply -f k8s/` brings up a healthy cluster
  (`kubectl get pods` all Running, `/api/enrich` responds through the
  ingress).

### Step 3.2 — Build + push the slim image to a registry  `[ ]`
- **Goal:** the cluster pulls a production image, doesn't build locally.
- **Commands:**
  ```bash
  docker build -f Dockerfile.slim -t <registry>/vane:<tag> .
  docker push <registry>/vane:<tag>
  ```
- **Update** `k8s/deployment.vane-app.yaml` to reference the pushed image.
- **Done when:** `kubectl describe pod` shows the image pulled + running.

### Step 3.3 — Deploy SearxNG pool first  `[ ]`
- **Goal:** search backend live before the app depends on it.
- **Action:** `kubectl apply -f k8s/configmap.searxng.yaml -f k8s/secret.searxng-proxy.yaml -f k8s/deployment.searxng.yaml -f k8s/service.searxng.yaml`.
- **Verification:** `kubectl exec` into a vane-app pod and curl
  `http://searxng:8080/search?format=json&q=test` → results (proxy rotating).
- **Done when:** 8–10 SearxNG pods Running + a probe query returns results
  through the proxy.

### Step 3.4 — Deploy the app + ingress  `[ ]`
- **Action:** apply the app Deployment, HPA, Service, Secret, ConfigMap,
  Ingress, PVC.
- **Verification:** `curl https://<host>/api/enrich ...` returns a cited
  answer. `kubectl get hpa` shows scaling working.
- **Done when:** a solo enrich through the ingress succeeds with sources.

### Step 3.5 — Production load test  `[ ]`
- **Goal:** validate the 1000-leads/10-min target end-to-end on the cluster.
- **Action:** run the 30-concurrent test (then 50, 100) against the ingress;
  watch `kubectl get hpa` scale pods.
- **Done when:** 1000 leads in ≤10 min with ≥90% sourced+cited. This is the
  final acceptance gate.
- **If it doesn't pass:** check which layer is the new ceiling — SearxNG pool
  size (add pods), Gemini RPM (paid tier / more keys), or app pods (HPA max).

---

## Phase 4 — Batch job queue (optional, after the synchronous path is proven)

### Step 4.1 — Add Redis + BullMQ  `[ ]`
- **Goal:** submit a 1000-lead batch as a job; workers drain it with bounded
  concurrency, survive pod churn, expose progress.
- **Files (new):** `src/lib/queue/` — BullMQ queue + worker;
  `src/app/api/enrich/batch/route.ts` — `POST` submits a batch, `GET` reads
  progress; `k8s/deployment.redis.yaml` + `service.redis.yaml`.
- **Change:** the worker calls the same `EnrichmentAgent.enrich` with a
  per-worker `p-limit` (~10).
- **Done when:** `POST /api/enrich/batch` with 1000 leads returns a job id;
  `GET /api/enrich/batch/:id` shows progress; the job completes in ≤10 min.

### Step 4.2 — Result cache + dedup  `[ ]`
- **Goal:** don't re-search a company that's already been enriched this batch.
- **Files:** `src/lib/queue/` — Redis-backed cache keyed by
  `hash(prompt + companyUrl)`.
- **Done when:** a repeated company in the same batch returns the cached
  result with 0 search calls.

---

## Cross-cutting — Documentation

### Step D.1 — Keep docs in sync  `[~]`
- `docs/SCALE_AND_DEPLOYMENT.md` — architecture overview (done).
- `docs/SCALING_STEPS.md` — this file (done).
- `docs/BUILD_TRACKER.md` — Build 6 (Gemini speed), 7 (resilience + load
  test), 8 (local embedder) all documented.
- Update each step's `[ ]` → `[x]` here as it ships, and add a Build entry to
  `BUILD_TRACKER.md` for each phase.

### Step D.2 — Update the `searxng` and `docker-ops` rules  `[ ]`
- When Phase 1 ships, update `.cursor/rules/searxng.mdc` with the proxy
  pattern + `SEARXNG_API_URLS` multi-instance env.
- When Phase 3 ships, update `.cursor/rules/docker-ops.mdc` with the slim
  image + registry push flow.

---

## Quick reference — what's done vs. pending

| Phase | Step | Status |
|---|---|---|
| 0 | 0.1 Gemini Flash Lite speed | `[x]` |
| 0 | 0.2 thought_signature round-trip | `[x]` |
| 0 | 0.3 requireSearch prompt | `[x]` |
| 0 | 0.4 retryStream | `[x]` |
| 0 | 0.5 Load test + sizing | `[x]` |
| 0 | 0.6 Local embedder | `[x]` |
| 1 | 1.1 Proxy account | `[ ]` (you) |
| 1 | 1.2 SearxNG proxy config | `[ ]` |
| 1 | 1.3 Wider engine allowlist | `[ ]` |
| 1 | 1.4 Retry-across-instances | `[ ]` |
| 1 | 1.5 Proxy load test (validation gate) | `[ ]` |
| 2 | 2.1 `p-limit` dep | `[ ]` |
| 2 | 2.2 `/api/enrich` semaphore | `[ ]` |
| 2 | 2.3 Paid Gemini tier | `[ ]` (you) |
| 3 | 3.1 K8s manifests | `[ ]` |
| 3 | 3.2 Build + push slim image | `[ ]` |
| 3 | 3.3 Deploy SearxNG pool | `[ ]` |
| 3 | 3.4 Deploy app + ingress | `[ ]` |
| 3 | 3.5 Production load test (acceptance gate) | `[ ]` |
| 4 | 4.1 Redis + BullMQ batch queue | `[ ]` (optional) |
| 4 | 4.2 Result cache + dedup | `[ ]` (optional) |

---

## See also

- `docs/SCALE_AND_DEPLOYMENT.md` — architecture diagram, component table,
  sizing, cost.
- `docs/BUILD_TRACKER.md` — Builds 6–8 (shipped work + measurements).
- `docs/RESEARCH_PIPELINE.md` — pipeline reference.
- `.cursor/rules/research-pipeline.mdc` — Gemini thought_signature invariant,
  E1 pattern.
