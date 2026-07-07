# Local Models — Cross-Encoder Reranker & Local Embedder

> **Scope qualifier (read this first):** the two models in this doc serve
> different blast radii.
>
> - **Cross-encoder reranker** — runs in **every search mode** (speed /
>   balanced / quality). It's pipeline-wide: `baseSearch.ts` calls
>   `reranker.rerank()` after dedup and `reranker.compress()` (S9) in speed
>   mode. Both the chat UI (`/api/chat`) and `/api/enrich` benefit.
> - **Local embedder** — **enrich-path only.** It's wired into `/api/enrich`
>   and **nothing else**. The chat + search routes keep using Gemini
>   `gemini-embedding-001` so the uploads feature (which persists 768-dim
>   chunk embeddings to `data/uploads/*.content.json`) stays dimensionally
>   consistent. See §4.3 for why this split is mandatory.
>
> So "local models" here does **not** mean "the whole app runs on local
> models." It means: one local reranker for the pipeline, plus one local
> embedder scoped specifically to the enrichment endpoint to remove Gemini
> embedding API calls from that hot path.

Deep reference for the two local CPU models that ship bundled in the Docker image: the **cross-encoder reranker** (S1/S9) and the **local embedder** (Build 8). Both load offline from bundled ONNX weights via `@huggingface/transformers` (`^3.8.1`), are cached as `globalThis` singletons, and are prewarmed at server startup. **Prewarming is the single most operationally important detail in this doc** — a cold model adds 5–15s to the first request and forces a fallback that costs either an LLM call (reranker) or a Gemini API call (embedder), which under the enrichment batch workload means blown latency budgets and RPM pressure on the very first leads of a run. §5 and §11 cover prewarm in depth.

---

## 0. Why local models

| Concern | Local model | API alternative | Why local wins here |
|---|---|---|---|
| Reranking search results | Cross-encoder `ms-marco-MiniLM-L-6-v2` | LLM-as-judge (`generateText`) | 5–10× faster (~50–180ms vs ~2–5s), cross-encoder-grade relevance, no API quota, deterministic, offline. |
| Embedding queries/results (enrich only) | `all-MiniLM-L6-v2` (384-dim) | Gemini `gemini-embedding-001` | No RPM pressure under concurrency, lower latency, no network hop, free. |
| Failure mode | Falls back to the API path | n/a | Local model is a *progressive enhancement* — pipeline degrades, never breaks. |

Both are **zero-cost** (free tier independent, no API key) and **offline** (`env.allowRemoteModels = false` — the image bundles the weights, no runtime download).

### 0.1 What "local" buys you, concretely

Three things, all of which matter most under the enrichment batch workload (1000 leads / 10 min, ~10–12 concurrent):

1. **No rate limit.** Every enrich request does ~1 search → ~2 embedding calls + 1 rerank pass + 1 compress pass. With Gemini embeddings that's ~20–24 Gemini calls/sustained-second at target concurrency — comfortably inside free-tier RPM only on paper; in practice the throttling we measured (Build 7) degrades tool-calling. Local models have no RPM ceiling.
2. **No network hop.** A Gemini embedding round-trip is ~150–400ms over the internet (TLS + API queue + model inference + response). Local embed is ~10–20ms in-process. At 2 calls/search × 1000 leads that's ~300–800s of network time removed from the batch.
3. **Deterministic + offline.** No "fetch failed," no captcha, no 429, no dependency on the Gemini control plane being up. The only failure mode is the bundle being missing or OOM — both caught and fallen back from.

The cost is **RAM** (~0.5GB/pod for both models resident) and **cold-start time** (~5–15s once per process — see §5). For a long-running enrich deployment the RAM is cheap and the cold start is amortized to ~zero; for a tiny ephemeral CLI it would be a bad trade. This is why the local embedder is enrich-path-only, not global.

---

## 1. The two models

| | Cross-encoder reranker | Local embedder |
|---|---|---|
| **HF repo** | `Xenova/ms-marco-MiniLM-L-6-v2` | `Xenova/all-MiniLM-L6-v2` |
| **Architecture** | MS MARCO MiniLM-L6 cross-encoder | MiniLM-L6 sentence embedder (bi-encoder) |
| **Transformers.js task** | `text-classification` | `feature-extraction` |
| **Output** | `{ label, score }` per (query, doc) pair | 384-dim mean-pooled, L2-normalized vector |
| **Params / size** | ~22M params, ~87MB fp32 ONNX | ~22M params, ~87MB fp32 ONNX |
| **dtype** | `fp32` | `fp32` |
| **Bundled path** | `/home/vane/models/reranker/` | `/home/vane/models/embedder/` |
| **Env override** | `RERANKER_MODEL_PATH` | `LOCAL_EMBEDDER_PATH` |
| **Singleton key** | `globalThis.__reranker` | `globalThis.__localEmbedder` |
| **Used by** | `src/lib/reranker/index.ts` → `baseSearch.ts` (rerank + compress) — **all modes** | `src/lib/models/localEmbeddingModel.ts` → **`/api/enrich` only** |
| **Fallback on failure** | LLM-as-judge rerank (`llmRerankFallback`) | Gemini `gemini-embedding-001` |
| **Input cap** | 512 token pairs | 256 token sequences |

> **Note on size:** the fp32 ONNX files are ~87MB each, not the ~22MB "quantized" figure sometimes quoted. 22MB would be the int8-quantized variant; we ship fp32 for correctness. Quantized is a future optimization once the `dtype` mapping is verified (see `Dockerfile:68-72` comment).

### 1.1 Bundled files (each model)

Both models bundle the same set of files via `curl` in the Dockerfile (mirroring `Dockerfile:73-88`):

```
/home/vane/models/<reranker|embedder>/
  config.json                 # model config (hidden size, layers, vocab)
  tokenizer.json              # the fast tokenizer (tokenizers lib, WASM)
  tokenizer_config.json       # tokenizer options (special tokens, truncation)
  special_tokens_map.json     # optional (|| true) — [CLS], [SEP], [PAD], etc.
  onnx/model.onnx             # the fp32 weights — the big file (~87MB)
```

`Dockerfile.slim` (the production image) bundles **both** too — and also installs `curl` in its second stage (it was missing before Build 8). If a required file is missing, `pipeline(...)` throws at load time, which each singleton catches (§3.2, §4.1) and falls back from.

### 1.2 Why these specific models

- **`ms-marco-MiniLM-L-6-v2`** — a cross-encoder fine-tuned on MS MARCO (Microsoft's query→passage dataset). Cross-encoders score `(query, document)` **jointly** through the full transformer (late interaction), so they're far more accurate than bi-encoder cosine similarity for relevance ranking — at the cost of needing one forward pass per pair (which is why we cap at 20 candidates). MiniLM-L6 is the largest variant that stays <~600ms on CPU for 20 pairs. The L12 variant is more accurate but ~2× slower; the `bge-reranker-v2-m3` (~568M params) is ~4–10s on CPU and is **not** used.
- **`all-MiniLM-L6-v2`** — a bi-encoder sentence embedder (384-dim) trained via contrastive learning on 1B+ sentence pairs. Independent of query, so you embed query and documents separately and compare with cosine/dot. 384-dim is a deliberate size/speed/quality trade — `bge-base-en-v1.5` (768-dim) is higher quality but ~2× the RAM and ~1.5× the latency. 384-dim is fine for the enrich path because the cross-encoder does the *final* relevance ordering; the embedder only does dedup + snippet similarity filtering.

---

## 2. transformers.js runtime

- **Library:** `@huggingface/transformers@^3.8.1` (the successor to `@xenova/transformers`; the import path and `pipeline` API are the same, the package name moved).
- **Backend:** ONNX Runtime (`onnxruntime-web` / `onnxruntime-node` under the hood) executing the ONNX graph. In Node it uses the native ORT bindings (not the WASM web backend) — so inference is native CPU code, not WASM-interpreted. (The warmup cost is still real: ORT session creation + tokenizer load + V8 JIT on the JS glue.)
- **Offline mode:** `env.allowRemoteModels = false` is set inside each singleton's load — the pipeline loads **only** from the local `MODEL_PATH`, never the network. This is critical: without it, a cold container with no HF cache would try to download at first request and fail/hang. With it, the model comes from the image layer — instant filesystem reads, no network.
- **dtype:** `fp32` — passed to `pipeline(...)`. The ONNX file is the fp32 conversion (`onnx/model.onnx`). Other dtype options in transformers.js v3: `'q8'` (int8 quantized, ~4× smaller/faster, small accuracy drop), `'fp16'` (not supported on CPU), `'int8'`, `'uint8'`. We use fp32 for correctness; q8 is a future swap (§10) once we verify the q8 ONNX files exist in the Xenova repo.
- **Loading:** `pipeline('text-classification' | 'feature-extraction', MODEL_PATH, { dtype: 'fp32' })`. `MODEL_PATH` is a local directory path, which transformers.js treats as a pre-downloaded model repo (it reads `config.json` + `tokenizer.json` + `onnx/model.onnx` from there).
- **Concurrency:** a loaded pipeline is **not thread-safe for parallel inference** in the same way an HTTP endpoint is — transformers.js serializes inference through the ORT session. Under the enrich batch's ~10–12 concurrent requests, each request's `embedText`/`pipe(...)` calls queue through the single session per model. This is fine because each call is ~10–180ms; the queue depth stays shallow. It also means **a single model instance serves all concurrent requests** — there's no per-request model load (which would be catastrophic). The singleton isn't just a memory optimization; it's a correctness/perf invariant.
- **Threading:** ORT in Node can use multi-threaded CPU inference via the `numThreads` session option (defaults to using available cores). We don't set it explicitly; for ~22M-param models the per-call work is small enough that single-thread is fine and avoids core contention with the Next.js event loop and other pods.

---

## 3. The Reranker singleton — `src/lib/reranker/index.ts`

### 3.1 Shape

A single `Reranker` class exported as a `globalThis` singleton:

```ts
// src/lib/reranker/index.ts:223-230
const globalForReranker = globalThis as unknown as { __reranker?: Reranker };
if (!globalForReranker.__reranker) {
  globalForReranker.__reranker = new Reranker();
}
const reranker = globalForReranker.__reranker;
export default reranker;
```

The class holds: `pipelinePromise` (the loading promise), `ready` (bool — set true only after warmup succeeds), `initStarted` (idempotency guard).

### 3.2 `init()` — fire-and-forget load + warmup

```ts
// src/lib/reranker/index.ts:55-84 (summarized)
init(): Promise<Pipeline | null> {
  if (this.initStarted) return this.pipelinePromise!;
  this.initStarted = true;
  this.pipelinePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    const pipe = await pipeline('text-classification', MODEL_PATH, { dtype: 'fp32' });
    await pipe({ text: 'warmup query', text_pair: 'warmup document' }); // JIT/WASM warmup
    this.ready = true;
    console.log(`reranker: model loaded from ${MODEL_PATH}`);
    return pipe;
  })().catch(() => null);
  return this.pipelinePromise;
}
```

What each line actually does, and why:

1. **`if (this.initStarted) return this.pipelinePromise!`** — idempotency. Multiple callers (instrumentation, the first `rerank()` call, a defensive self-init) all share the same in-flight load promise. Without this, two callers would double-load the model (~250MB wasted, race on `ready`).
2. **`await import('@huggingface/transformers')`** — dynamic import so the (large) transformers.js library only loads when the reranker actually initializes, not when the module is imported. Keeps cold server startup fast.
3. **`env.allowRemoteModels = false`** — offline lockdown. Belt to the Dockerfile's "bundle the weights" suspenders.
4. **`await pipeline('text-classification', MODEL_PATH, { dtype: 'fp32' })`** — the expensive step (§5 breaks down the cost): reads `config.json` + `tokenizer.json` + `onnx/model.onnx` from disk, constructs the ORT session, instantiates the tokenizer. ~3–8s cold.
5. **`await pipe({ text: 'warmup query', text_pair: 'warmup document' })`** — the warmup inference. This is **not** about validating the model; it's about paying the one-time costs that the *first real* call would otherwise pay: V8 JIT-compiling the JS glue, ORT's internal kernel selection/cache, tokenizer WASM init. Without warmup, the first real query takes ~2–4s instead of ~150ms. With warmup, that cost moves to startup (where it overlaps SearxNG init) and the first real query is already fast.
6. **`this.ready = true`** — set **only after warmup succeeds**. This is the gate `rerank()` checks; until it's true, `rerank()` falls back to LLM-as-judge. So "ready" specifically means "warmed and fast," not just "loaded."
7. **`.catch(() => null)`** — any failure (missing bundle, corrupt ONNX, OOM) → `pipelinePromise` resolves null, `ready` stays false, the pipeline degrades to LLM-as-judge forever for this process. Logged separately.

### 3.3 `rerank(query, candidates, llm)`

`src/lib/reranker/index.ts:98-154`:

1. If `candidates.length <= 3` → return as-is (not worth scoring — the LLM fallback has the same guard).
2. Self-init if not started (the globalThis-cross-module safety net, §5.1).
3. If `ready` and pipe loaded:
   - Score the first `MAX_CANDIDATES = 20` pairs: `pipe({ text: query, text_pair: snippet.slice(0, 512) })` → `{ label, score }`. The `slice(0, 512)` is the token-cap guard (the model's max_seq_len is 512; longer snippets would truncate inside the tokenizer anyway, but pre-slicing avoids sending huge strings through the tokenizer).
   - Sort by `score` desc; append the un-scored tail (`candidates.slice(20)`) in original order.
   - Log: `rerank: cross-encoder (Xms, N candidates)`.
   - On any runtime error → fall through to LLM fallback.
4. Else: `llmRerankFallback(query, candidates, llm)` — the original `generateText` + parsed-comma-list path (`src/lib/reranker/llmFallback.ts`). Logs `rerank: llm-fallback (Xms)`.

> **Why the LLM fallback uses `generateText` not `generateObject`:** GLM ignores JSON schemas and returns a bare list like `0, 1, 3, 2`, which `repairJson` can't coerce into `{ ranking: [...] }`. So the fallback parses integers out of the raw text (robust to stray prose/fences). See `llmFallback.ts:5-17`.

> **Score semantics:** the cross-encoder's `score` is a sigmoid'd relevance logit (MS MARCO training signal: 1 = passage answers the query, 0 = it doesn't). The *absolute* value is uncalibrated to "relevance %," but the *ordering* by score is what we use — and that ordering is cross-encoder-grade, meaningfully better than the bi-encoder cosine similarity that ranked candidates before this step.

### 3.4 `compress(query, items, topK=2)` — S9 snippet compression

`src/lib/reranker/index.ts:166-213` — reuses the **already-loaded** cross-encoder for a second job (zero extra load cost; the model is already warm):

1. For each snippet, split into sentences (`/[^.!?]+[.!?]+/g`, length ≥ 20).
2. If ≤ `topK` sentences → keep the snippet whole.
3. Else score each sentence with `pipe({ text: query, text_pair: sentence })`, keep the top `topK`.
4. Return the joined top sentences per snippet. Logs `compress: cross-encoder (Xms, N items, top K sentences)`.
5. On any error → return the raw snippets unchanged.

This is the Perplexity query-aware-context-compression technique — drops nav/metadata/ad noise so the writer gets high-signal spans. **Speed-mode only** (balanced already scrapes+extracts evidence). Called from `baseSearch.ts:271-283` on the top 10 results with `topK=2`. The cost is one forward pass per sentence per snippet — bounded by `topToCompress.length (10) × avg_sentences_per_snippet`. The 16–178ms measurements reflect that variance.

---

## 4. The local embedder singleton — `src/lib/models/localEmbeddingModel.ts`

### 4.1 Shape

```ts
// src/lib/models/localEmbeddingModel.ts (summarized)
export const getLocalEmbeddingModel = async (): Promise<TransformerEmbedding | null> => {
  const cached = globalForLocalEmbed.__localEmbedder;
  if (cached?.state === 'ready') return cached.embedder;
  if (cached?.state === 'failed') return null;   // don't retry the slow load every request
  try {
    const { env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    const embedder = new TransformerEmbedding({ model: MODEL_PATH });
    await embedder.embedText(['warmup']);        // surfaces load failures here
    globalForLocalEmbed.__localEmbedder = { state: 'ready', embedder };
    return embedder;
  } catch {
    globalForLocalEmbed.__localEmbedder = { state: 'failed' }; // cache the failure
    return null;
  }
};
```

Three-state cache (`ready` / `failed` / null) so a failed load isn't retried on every request (the load + warmup is the slow part — retrying per request would re-pay 5–15s each time and probably OOM under concurrency). The `failed` state is sticky for the life of the process; the enrich route will use the Gemini fallback for the whole run. Restart the pod to retry.

### 4.2 The underlying embedder — `src/lib/models/providers/transformers/transformerEmbedding.ts`

```ts
private async embed(texts: string[]) {
  if (!this.pipelinePromise) {
    this.pipelinePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('feature-extraction', this.config.model, { dtype: 'fp32' });
    })();
  }
  const pipe = await this.pipelinePromise;
  const output = await pipe(texts, { pooling: 'mean', normalize: true });
  return output.tolist() as number[][];
}
```

- **Lazy pipeline promise:** the pipeline loads on first `embedText`, cached on the instance. `getLocalEmbeddingModel()` triggers this via the warmup `embedText(['warmup'])` call.
- **Pooling:** `mean` + `normalize: true` → L2-normalized mean-pooled embeddings. Mean pooling averages the token-level hidden states from the last layer into one sequence vector; L2 normalization scales it to unit length. **Why both:** with L2-normalized vectors, cosine similarity = dot product, so `computeSimilarity` reduces to a cheap dot product. Without normalization, dot product would be magnitude-contaminated and you'd need an explicit cosine formula (divide by both norms).
- **Output:** `number[][]` — one 384-dim vector per input text. The batched call (one `pipe(texts)` for many texts) is much faster than per-text calls because ORT batches them through one forward pass — this is the S11 optimization (Build 7): the search path batches query + ~20 result contents into 2 Gemini calls instead of 21. With the local embedder the same batching applies — one call for the query, one for all contents.

### 4.3 Why only `/api/enrich` (the scope qualifier, in detail)

Speed mode + `/api/enrich` never run uploads search (no `fileIds`), so a 384-dim embedder is safe there. The chat/search routes keep using `EMBEDDING_MODEL` (Gemini `gemini-embedding-001`, 768-dim) because the **uploads feature persists 768-dim chunk embeddings** to `data/uploads/*.content.json`, and `computeSimilarity` (`src/lib/utils/computeSimilarity.ts`) **throws on dimension mismatch**:

```ts
// src/lib/utils/computeSimilarity.ts:1-3
const computeSimilarity = (x: number[], y: number[]): number => {
  if (x.length !== y.length)
    throw new Error('Vectors must be of the same length');
```

Switching the global `EMBEDDING_MODEL` to a 384-dim local model would make `uploads_search` crash on every existing uploaded file (768-dim stored vs 384-dim query). So the split is mandatory:

- `/api/enrich` (no uploads, the scaling target) → local 384-dim embedder.
- `/api/chat` + `/api/search` (can carry uploads) → Gemini 768-dim embedder.

See `docs/BUILD_TRACKER.md` Build 8 + the embedding-persistence audit. If you ever want to unify on local embeddings, the migration is: (a) re-embed all `data/uploads/*.content.json` files with the new model, or (b) add a dimension tag to stored embeddings and lazy-re-embed on mismatch, or (c) move uploads to a per-upload model selection persisted alongside the chunks. None of these are done today.

### 4.4 Fallback

`/api/enrich` (`src/app/api/enrich/route.ts:93-100`): if `getLocalEmbeddingModel()` returns `null`, load Gemini `gemini-embedding-001` instead. So a missing bundle or OOM doesn't break enrichment — it just costs the Gemini API calls for that run (and re-introduces the RPM pressure the local embedder was meant to remove). That's the progressive-enhancement contract: local is a perf/dependency optimization, not a correctness requirement.

> **Subtle:** the fallback is per-pod and sticky. If the local embedder fails to load on a pod, that pod uses Gemini for the rest of its life. Under the batch workload this means one bad pod can quietly consume Gemini quota while healthy pods use local. The startup log (`local-embedder: loaded` vs `local-embedder: load failed`) is the tell — monitor it (§11.6).

---

## 5. Prewarm — `src/instrumentation.ts` (the critical part)

> Read this section if you read nothing else. Prewarm is what makes the
> difference between a deployment that hits its latency target on the first
> lead of a batch and one that doesn't.

### 5.1 The cold-start problem, in detail

A transformers.js model is not "loaded" the way a JS module is loaded. The first call after process start pays a stack of one-time costs that are **much** larger than steady-state inference:

| Cold-start cost | What it is | Approx. time |
|---|---|---|
| **Dynamic import** of `@huggingface/transformers` | V8 parses + compiles the library's JS (~MBs of source). Cached after first import. | ~200–800ms |
| **Tokenizer construction** | Loads `tokenizer.json`, instantiates the WASM-backed fast tokenizer. | ~100–400ms |
| **ORT session creation** | Reads `onnx/model.onnx` (~87MB) from disk, deserializes the graph, allocates weight tensors, sets up CPU execution providers. | ~2–6s (disk + deserialize) |
| **First-inference JIT** | V8 JIT-compiles the JS glue around ORT; ORT picks + caches optimal kernels for the input shapes. Subsequent calls reuse the compiled paths. | ~1–4s |
| **WASM init** (tokenizer) | The tokenizer's WASM module initializes its memory/tables. | ~100–300ms |
| **Total cold → warm** | Sum of the above, serialized. | **~5–15s** |

After warmup, the same model does inference in **~10–180ms**. So the cold→warm ratio is roughly **50–100×**. The first lead of a batch, on a cold pod, without prewarm, would take ~5–15s **just for the first embed/rerank call** — and worse, for the reranker, that ~5–15s exceeds the time the LLM-as-judge fallback would take (~2–5s), so a cold reranker is *slower than the fallback it's supposed to replace* and provides no quality benefit on that request.

Prewarm moves all of that cost from "first real request" to "server startup, in the background, overlapping with SearxNG init and the Next.js route compilation." By the time a real request arrives, `ready=true` and inference is fast.

### 5.2 The prewarm hook

`src/instrumentation.ts` — Next.js calls `register()` once on server startup (after the route bundle is loaded, before the server accepts traffic on most configurations):

```ts
// src/instrumentation.ts
export async function register() {
  try {
    const { default: reranker } = await import('@/lib/reranker');
    reranker.init();                                  // fire-and-forget
  } catch (err) { console.log('reranker: instrumentation prewarm skipped —', err); }

  try {
    const { getLocalEmbeddingModel } = await import('@/lib/models/localEmbeddingModel');
    getLocalEmbeddingModel();                          // fire-and-forget
  } catch (err) { console.log('local-embedder: instrumentation prewarm skipped —', err); }
}
```

Both `init()` and `getLocalEmbeddingModel()` return promises that are **not awaited**. The hook returns immediately; the models load in the background while the server starts accepting traffic.

### 5.3 The race condition: request arrives before prewarm completes

This is the design's central tradeoff and you must understand it to operate the deployment. Fire-and-forget means a request can arrive before `ready=true`. Here's exactly what happens in each case:

**Reranker not ready, `rerank()` called:**
1. `rerank()` checks `this.ready` → false.
2. Falls through to `llmRerankFallback(query, candidates, llm)` — an LLM `generateText` call (~2–5s, costs GLM/Gemini quota).
3. The request completes with a correctly-ordered result, just slower and with an API call.
4. Meanwhile `init()` finishes in the background; `ready` flips true; **the next request** uses the cross-encoder (~150ms).

**Embedder not ready, `/api/enrich` called:**
1. `getLocalEmbeddingModel()` returns `null` (load not finished → cache state is `null`, not `ready`).

   > Wait — check the code. `getLocalEmbeddingModel` only sets the cache after warmup completes. If called *during* load, the cache is still `null`, so it falls into the `try` block and **starts a second load** (the function isn't idempotent across concurrent callers the way `init()` is). This is a known minor flaw: two concurrent first-requests would both attempt to load. In practice the instrumentation prewarm almost always wins the race, and the `TransformerEmbedding`'s own `pipelinePromise` is instance-local so a second `TransformerEmbedding` would double-load. **The fix if this matters: add an `initStarted`-style guard to `getLocalEmbeddingModel` mirroring `Reranker.init()`.** For now, the prewarm + the ~5–15s load window being shorter than the time between deploy and first traffic makes this a non-issue in production.
2. The enrich route's `if (!embeddings)` fallback loads Gemini `gemini-embedding-001` instead.
3. The request completes with Gemini embeddings (~150–400ms × 2, costs Gemini quota).
4. The local embedder finishes loading in the background; **the next request** uses local (~10–20ms).

So the prewarm design is **correct under the assumption that the first real request arrives after ~5–15s of server uptime** — which is true for a normal deploy-to-traffic gap and for k8s readiness probes that wait for the prewarm logs (§11.3). It is **not correct** if you `kubectl apply` and immediately route traffic to a fresh pod with no readiness gate — the first few requests will use fallbacks. That's still *safe* (no errors, just slower + API calls), but it wastes quota and blows the latency budget for those first leads.

### 5.4 Why `globalThis` singletons are mandatory

Next.js can hold **separate module instances** for the instrumentation hook vs route handlers — instrumentation runs in the server's startup context, route handlers in the request-handling context, and Next.js's module loader can give them separate copies of `src/lib/reranker/index.ts`. If each copy created its own `Reranker`, the instrumentation prewarm (which sets `ready=true` on *its* instance) would not reach the route handler's instance (which would stay `ready=false` forever and fall back to LLM on every request).

`globalThis` is shared across all module contexts in the same Node process, so:

```ts
const globalForReranker = globalThis as unknown as { __reranker?: Reranker };
if (!globalForReranker.__reranker) {
  globalForReranker.__reranker = new Reranker();  // one instance, shared
}
export default globalForReranker.__reranker;
```

…guarantees one `Reranker` with one loaded cross-encoder, visible to both instrumentation and routes. **This was a real bug before the singleton:** the cross-encoder loaded at startup (the log appeared) but `rerank()` still fell back to LLM on every request because the route handler's `Reranker` was a different instance with `ready=false`. The `local-embedder: loaded` log appearing while the route still uses Gemini is the same failure mode — which is why the embedder singleton uses the same `globalThis` pattern.

### 5.5 The defensive self-init belt-and-suspenders

Even with the singleton, `rerank()` calls `if (!this.initStarted) this.init();` (`src/lib/reranker/index.ts:109`) — a cheap safety net in case the instrumentation prewarm ran on a different module instance (pre-singleton behavior) or the singleton was somehow not yet populated when the route loaded. With the singleton it's usually a no-op. The embedder doesn't have this guard (a minor asymmetry — see §5.3 note about adding one if concurrent first-requests become a real scenario).

### 5.6 Why fire-and-forget (not awaited) — the full reasoning

Awaiting the prewarm in `register()` would block server startup on ~5–15s of model load + warmup. That sounds small, but it cascades badly:

- **Next.js standalone `server.js` won't accept traffic until `register()` resolves.** A 15s block means 15s of zero capacity during deploy.
- **k8s liveness/readiness probes start ticking from pod start, not from `register()` completion.** A 15s block can trip a liveness probe (`defaultFailureThreshold` × `periodSeconds` is often 30s, so you'd survive, but barely) and trigger a restart loop — which would *never* converge because each restart re-pays the 15s.
- **HPA scale-up** would be useless: a new pod takes 15s+ to accept traffic, by which time the burst is over.

Fire-and-forget lets the server start accepting traffic immediately, with the models warming in the background. The cost is the §5.3 race — which is bounded (only the first few requests on a fresh pod) and gracefully degraded (fallbacks, not errors). The mitigation is a readiness probe that gates on the prewarm logs (§11.3), which gives you "fire-and-forget inside the pod, but don't route traffic until warm" — the best of both.

### 5.7 Concurrent prewarm of both models

`register()` calls `reranker.init()` and `getLocalEmbeddingModel()` back-to-back, both fire-and-forget. They load **in parallel**, contending for:
- **Disk I/O:** two ~87MB ONNX reads. On most storage this is fine (sequential disk read at ~100s of MB/s), but on slow network-attached volumes (EBS gp3, Azure standard disk) the parallelism adds latency. Pre-pull the image onto the node (§11.5) to keep reads local.
- **CPU:** two ORT session creations + two warmup inferences. On a 1-vCPU pod this briefly pegs the core; on 2+ vCPU it's comfortable. The warmup inferences themselves are tiny (one pair / one short text) so the spike is short (~1–3s).
- **RAM:** peak ~0.5GB resident for both. This is the *peak* — the request-rate memory is the same ~0.5GB since the models stay loaded. Size the pod memory request at ~1GB to leave headroom for Next.js + the request payload + the ORT inference buffers.

There's no ordering dependency between the two — they're independent models used by different code paths. Loading them in parallel is correct.

### 5.8 Prewarm failure handling

Both prewarms are wrapped in try/catch in `register()`, and the underlying singletons catch their own load errors (§3.2, §4.1). The failure modes:

- **Reranker load fails** → `ready=false` forever for this process → every `rerank()` uses LLM fallback. Log: `reranker: load failed, using LLM fallback — <err>`.
- **Embedder load fails** → cache state `failed` → every `/api/enrich` uses Gemini embedding. Log: `local-embedder: load failed (path=...) — <err>`.
- **The dynamic `import()` itself throws** (e.g. `@huggingface/transformers` not installed) → caught in `register()`, logged `...: instrumentation prewarm skipped — <err>`. The route then hits the same missing-import when it tries to use the model, which the singleton catches → fallback.

In all cases the server stays up and serves requests via fallback. **Restart the pod to retry** — the failure states are sticky for the life of the process.

---

## 6. Call sites (where the models actually run)

### 6.1 Reranker — **all search modes** (chat + enrich)

| Site | File:line | What | Modes |
|---|---|---|---|
| Rerank | `src/lib/agents/search/researcher/actions/search/baseSearch.ts:198` | After dedup, top 20 → `reranker.rerank(queries, results, llm)` | speed + balanced + quality |
| Compress (S9) | `baseSearch.ts:273` | Speed mode only, top 10 → `reranker.compress(query, items, 2)` | speed only |

### 6.2 Local embedder — **`/api/enrich` only**

| Site | File:line | What |
|---|---|---|
| Enrich query vector | `baseSearch.ts:54` (via `input.config.embedding`) | `embedText([q])` for snippet similarity filter |
| Enrich result vectors | `baseSearch.ts:58` | `embedText(contents)` for similarity + in-request dedup |

> The local embedder is reached **only** via `/api/enrich`'s `input.config.embedding`. The chat/search routes load `EMBEDDING_MODEL` (Gemini), so their `baseSearch.ts` embedText calls hit Gemini, not the local model. This is the intended split (§4.3).

### 6.3 Gemini embedder — chat/search routes (for contrast)

| Site | File:line | What |
|---|---|---|
| Evidence query | `baseSearch.ts:229` | `embedText([queries.join(' ')])` for passage ranking — balanced mode, Gemini |
| Passage vectors | `baseSearch.ts:245` | `embedText(passages)` for top-3 evidence retrieval — balanced, Gemini |
| Uploads write | `src/lib/uploads/manager.ts:95,126,152` | `embedText(splittedText)` → persisted to `.content.json` — **always Gemini** |
| Uploads search | `src/lib/uploads/store.ts:54` | `embedText(queries)` vs persisted chunks — **always Gemini** |

### 6.4 Pipeline ordering (where prewarm matters in the request timeline)

A speed-mode `/api/enrich` request hits the local models in this order:

```
1. Searxng search            (~1–3s, network — the long pole)
2. embedText([query])         (~10ms, local embedder)   ← prewarm-critical
3. embedText([contents])      (~15ms, local embedder)   ← prewarm-critical
4. dedup via computeSimilarity (~1ms)
5. reranker.rerank(...)       (~50–180ms, cross-encoder) ← prewarm-critical
6. reranker.compress(...)     (~16–178ms, cross-encoder) ← prewarm-critical
7. Gemini writer streamText   (~3–8s, network — the other long pole)
```

Steps 2–6 are the local-model window. If any of them cold-starts (no prewarm), that step jumps from ~tens-of-ms to ~5–15s — easily dominating the request. **All four local-model calls are on the critical path of every enrich request**, which is why prewarm isn't optional for this workload.

---

## 7. Performance characteristics (measured)

From the load-test logs (`docs/BUILD_TRACKER.md` Build 7):

| Op | Cold (no prewarm) | Warm (prewarmed) | Notes |
|---|---|---|---|
| `rerank` (10–20 candidates) | ~5–10s (load) + ~2–4s (first inference) | **48–178ms** | linear in candidate count; cap 20 keeps it bounded |
| `compress` (10 items, top 2) | n/a (reuses loaded reranker) | **16–178ms** | linear in total sentences scored |
| `embedText` (batch of ~20) | ~3–6s (load) + ~1s (first inference) | ~10–20ms | batched; one call for query + one for contents (S11) |
| Model load + warmup (cold) | — | ~5–15s | once per process, at startup (prewarm) |

All CPU. No GPU needed. The MiniLM-L6 variants are the largest models that stay fast on CPU; the larger `bge-reranker-v2-m3` (~568M params) is ~4–10s on CPU and is **not** used (see `src/lib/reranker/index.ts:21-23`).

**Concurrency note:** under the enrich batch's ~10–12 concurrent requests, the single shared model instance serializes inference. Empirically (Build 7) rerank stayed 48–178ms even at 30 concurrent — the per-call work is small enough that the queue stays shallow. You will not see 30× latency inflation from model contention; the throttling we measured was upstream (SearxNG + Gemini), not local models.

---

## 8. Failure modes & fallbacks

| Failure | Detection | Fallback | Effect |
|---|---|---|---|
| Reranker weights missing / load error | `init()` catches → `ready=false`, `pipe=null` | `rerank()` → `llmRerankFallback` (LLM-as-judge) | Slower rerank (~2–5s), same output quality band, costs 1 LLM call/search |
| Reranker runtime error mid-scoring | `rerank()` try/catch | `llmRerankFallback` | Same as above |
| Embedder weights missing / load error | `getLocalEmbeddingModel()` catches → returns `null` (sticky `failed`) | `/api/enrich` loads Gemini `gemini-embedding-001` | Enrich works, costs 2 Gemini calls/search + re-introduces RPM pressure |
| Embedder runtime error mid-request | `embedText` throws | **No fallback** — bubbles to `baseSearch` try/catch → keeps similarity order | Enrich may return 0 sources on that request (requireSearch prompt reports it) |
| Module-context split (instrumentation vs routes) | n/a | `globalThis` singleton + defensive self-init | Both see the same loaded model |
| Container cold start | first request before prewarm done | fire-and-forget → first few requests use fallbacks | No errors, slight latency + quota cost on first few requests |
| OOM during load | `init()`/`getLocalEmbeddingModel()` catch | Same as load-error fallbacks | Pod serves via fallback until restarted |
| Concurrent first-requests (embedder) | two `getLocalEmbeddingModel()` calls both load | `TransformerEmbedder`'s `pipelinePromise` is instance-local → potential double-load | Wasted ~250MB + load time; bounded to the first ~15s window. Fix: add `initStarted` guard (§5.3) |

---

## 9. Operations

### 9.1 Logs to expect at startup

```
reranker: model loaded from /home/vane/models/reranker
local-embedder: loaded from /home/vane/models/embedder
```
(Both fire-and-forget — they may appear a few seconds after `Ready`.)

Failure logs:
```
reranker: load failed, using LLM fallback — <err>
local-embedder: load failed (path=/home/vane/models/embedder) — <err>
```

### 9.2 Logs during requests

```
rerank: cross-encoder (124ms, 20 candidates)
compress: cross-encoder (64ms, 10 items, top 2 sentences)
```
If you see `rerank: llm-fallback (...)` instead, the cross-encoder isn't ready/loaded — check the startup log for a load failure. If you see it persistently past the first few requests, the singleton/prewarm is broken on that pod.

### 9.3 Verifying the bundle in an image

```bash
docker run --rm vane-glm sh -c "ls -la /home/vane/models/reranker/onnx/model.onnx /home/vane/models/embedder/onnx/model.onnx"
```
Both should be ~87M. If either is missing or 0 bytes, the `curl --fail` in the Dockerfile would have failed the build — so a successful build implies the bundle is present.

### 9.4 Isolated embedder smoke test (no SearxNG needed)

```bash
docker exec vane node -e '
(async () => {
  const t0 = Date.now();
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  const pipe = await pipeline("feature-extraction", "/home/vane/models/embedder", { dtype: "fp32" });
  console.log("load ms:", Date.now()-t0);
  const a = await pipe(["ceo of anthropic"], { pooling: "mean", normalize: true });
  const b = await pipe(["anthropic chief executive"], { pooling: "mean", normalize: true });
  const c = await pipe(["the weather in paris"], { pooling: "mean", normalize: true });
  const va = a.tolist()[0], vb = b.tolist()[0], vc = c.tolist()[0];
  const cos = (x,y) => x.reduce((s,xi,i) => s+xi*y[i], 0);
  console.log("dim", va.length, "cos(a,b)", cos(va,vb).toFixed(3), "cos(a,c)", cos(va,vc).toFixed(3));
  // expect: dim 384, cos(a,b) > 0.5, cos(a,c) < 0.2
})();
'
```
This also reports the cold-load time — useful for sizing the prewarm window on your hardware.

### 9.5 Measuring prewarm end-to-end

To verify prewarm actually completes before traffic, time from container start to the "loaded" logs:

```bash
docker run -d -p 4567:3000 -v vane-data:/home/vane/data --name vane vane-glm
START=$(date +%s)
# wait for both loaded logs
docker logs -f vane 2>&1 | \
  awk '/reranker: model loaded/ {r=1} /local-embedder: loaded/ {e=1} r&&e {print "prewarm done at", systime()-'"$START"' "s"; exit}'
```
On a warm node this is typically ~6–10s; on a cold node pulling the image it's longer (the image pull dominates — §11.5).

### 9.6 Memory

Each loaded model resident ~150–250MB (weights + ONNX runtime + inference buffers). Two models ≈ ~0.5GB RSS overhead per pod, **plus** ~0.5GB during the parallel load window (duplicate buffers, JIT cache building). Peak RSS during prewarm can briefly hit ~1.2–1.5GB on a 1GB pod — size the pod memory limit at ~1.5GB to avoid an OOM-kill during prewarm (which would look like a crash loop). Steady-state is ~0.5GB for the models + Next.js baseline.

---

## 10. Tuning / swapping models

| Goal | Swap | Files |
|---|---|---|
| Better rerank quality (slower) | `Xenova/ms-marco-MiniLM-L-12-v2` | `Dockerfile` curl URL + `RERANKER_MODEL_PATH` |
| Quantized rerank (smaller, faster, slight quality drop) | int8 ONNX + `dtype: 'q8'` | `Dockerfile` + `src/lib/reranker/index.ts:66` — verify dtype mapping first |
| Better embedder (768-dim, matches Gemini) | `Xenova/bge-base-en-v1.5` (~110MB) | `Dockerfile` curl URL + `localEmbeddingModel.ts` MODEL_PATH — safe for enrich (no persistence); **do not** swap the global `EMBEDDING_MODEL` (uploads) |
| Faster embedder (smaller) | `Xenova/all-MiniLM-L-4-v2` (~14MB) | same |
| Multi-threaded inference | set `numThreads` in the pipeline options | `src/lib/reranker/index.ts:65`, `transformerEmbedding.ts:28` — benchmark first; on small models the overhead can exceed the gain |

> Swapping the embedder to a different dimension is safe **only** for `/api/enrich` (no persistence). Never change `EMBEDDING_MODEL` (Gemini) without re-embedding uploads — see §4.3.

---

## 11. Prewarm + deployment patterns (critical for enrichment at scale)

This section ties prewarm to the actual deployment. Read it before sizing the k8s fleet (`docs/SCALE_AND_DEPLOYMENT.md`, `docs/SCALING_STEPS.md`).

### 11.1 Why prewarm is critical for the enrichment batch specifically

The enrichment batch workload is the worst case for a cold model:

- **It's bursty.** A 1000-lead batch is a step function: zero traffic, then 10–12 concurrent requests all at once. There is no "warm-up traffic" — the first wave hits a pod that has been idle since startup.
- **Every request uses the local models 4×** (2 embed + 1 rerank + 1 compress, §6.4). A cold model adds ~5–15s **per call**, and these calls are on the critical path before the writer can run. A cold pod would take ~30–60s for the first request instead of ~5s — 6–12× the latency budget, per request, for the entire first wave.
- **The first leads of the batch matter disproportionately.** Operators watch the first few leads to confirm the run is healthy. If the first 10 leads take 60s each, the operator abort the run before the pods warm up — even though steady-state would be fine. Prewarm makes the first lead look like the 1000th.
- **Fallbacks cost quota.** A cold reranker uses the LLM-as-judge fallback (1 extra LLM call/search). A cold embedder uses Gemini (2 extra Gemini calls/search). At 10–12 concurrent × the first ~10 requests on a fresh pod, that's ~100–150 extra API calls per cold pod — enough to nudge the Gemini free tier into throttling, which then degrades the *rest* of the run via the tool-calling degradation we measured in Build 7.

So prewarm isn't a nicety for the enrichment batch — it's the difference between "first lead is fast and correct" and "first 10 leads are slow, expensive, and possibly throttled."

### 11.2 Why prewarm is critical for deployment (HPA scale-up)

When HPA scales the app fleet from 3 → 10 pods to absorb a batch:

- Each new pod starts cold — no prewarm yet.
- If the readiness probe doesn't gate on prewarm (§11.3), the load balancer routes traffic to the new pod immediately, and the first ~5–15s of requests on that pod use fallbacks.
- Under a burst, HPA may add multiple pods at once — all cold, all serving traffic, all using fallbacks simultaneously. This is the **cold-start storm**: a chunk of your batch's first requests hit fallbacks, spike Gemini RPM, and (per Build 7) trigger the tool-calling degradation that produces 0-source answers.
- The degradation is self-reinforcing: 0-source answers take ~5s (no search) and look "fast" to HPA's CPU metric, so HPA doesn't add more pods, but the batch is producing garbage.

The mitigations are §11.3 (readiness gate) and §11.5 (pre-pull + overprovision) so that scale-up pods are warm before they take traffic.

### 11.3 Readiness probe: gate traffic on prewarm completion

The cleanest fix to §11.2 is a readiness probe that returns success only after both models are warm. Two options:

**Option A — log-based readiness (no code change).** Use a k8s `exec` readiness probe that greps the pod logs for both "loaded" lines:

```yaml
readinessProbe:
  exec:
    command:
      - sh
      - -c
      - "docker logs $(hostname) 2>&1 | grep -q 'reranker: model loaded' && docker logs $(hostname) 2>&1 | grep -q 'local-embedder: loaded'"
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 60   # allow up to 5 min for slow nodes / image pulls
```
(This is illustrative — `docker logs` from inside a pod doesn't work; in practice use `kubectl logs` from a sidecar, or write a readiness flag file. See §11.4 for the flag-file approach.)

**Option B — flag-file readiness (recommended, tiny code change).** Have each singleton write `/tmp/<model>.ready` when it warms, and the readiness probe checks for both files:

```ts
// in Reranker.init() after this.ready = true
fs.writeFileSync('/tmp/reranker.ready', String(Date.now()));
// in getLocalEmbeddingModel after state='ready'
fs.writeFileSync('/tmp/embedder.ready', String(Date.now()));
```
```yaml
readinessProbe:
  exec:
    command: ["sh", "-c", "test -f /tmp/reranker.ready -a -f /tmp/embedder.ready"]
  initialDelaySeconds: 3
  periodSeconds: 3
  failureThreshold: 100
```

**Tradeoff:** gating readiness on prewarm means a fresh pod takes ~5–15s before it accepts traffic. That's the *point* — you're trading 5–15s of scale-up delay for "every request from this pod is fast and on-local-models." For the enrichment batch this is the right trade. For the chat UI (low, steady traffic) you might prefer no readiness gate so the UI is responsive immediately, accepting fallbacks for the first few requests. **Use a separate Deployment per workload** if you want different policies (§11.7).

> **Liveness probe must NOT gate on prewarm.** A liveness probe that fails during prewarm will restart the pod before prewarm completes → infinite restart loop (pod never converges). Liveness should only check "is the Next.js server up" (`/` 200), not "are the models warm."

### 11.4 The flag-file pattern (concrete)

If we adopt Option B, the code change is ~4 lines per singleton. Sketch:

```ts
// src/lib/reranker/index.ts — inside init(), after this.ready = true
this.ready = true;
try { fs.writeFileSync('/tmp/reranker.ready', String(Date.now())); } catch {}
console.log(`reranker: model loaded from ${MODEL_PATH}`);

// src/lib/models/localEmbeddingModel.ts — after setting state='ready'
globalForLocalEmbed.__localEmbedder = { state: 'ready', embedder };
try { fs.writeFileSync('/tmp/embedder.ready', String(Date.now())); } catch {}
console.log(`local-embedder: loaded from ${MODEL_PATH}`);
```

The flag files double as a debug aid: `kubectl exec <pod> -- ls /tmp/*.ready` shows which models are warm without parsing logs.

### 11.5 Pre-pull images + overprovision (avoid image-pull cold starts)

The prewarm window assumes the image is already on the node. On a fresh node, `imagePullPolicy: Always` + a 2GB image = ~30–60s of pull before prewarm even starts. Mitigations:

- **`imagePullPolicy: IfNotPresent`** for tagged releases (not `:latest`) — k8t pulls once, caches on the node.
- **A node-level pre-pull DaemonSet** that `docker pull`s the image onto every node ahead of scale events.
- **Overprovisioning** — run 1–2 "pause" pods with the same image so the image is cached and a node is warm; HPA can scale them away. Cheaper than it sounds for a 2GB image.
- **Cluster autoscaler `--balance-similar-node-groups`** + `topologySpreadConstraints` to avoid scheduling all scale-up pods on one cold node.

For the enrichment batch specifically: **pre-scale the fleet before submitting the batch.** Scale to N pods, wait for all to be `Ready` (readiness gate ensures warm), then submit. Don't rely on HPA to react to the batch — by the time HPA sees the CPU spike and scales, the first wave has already hit cold pods.

### 11.6 Monitoring prewarm health

Alert on (per pod):
- `reranker: load failed` or `local-embedder: load failed` in logs → the pod is permanently on fallbacks; restart it.
- `rerank: llm-fallback` rate > the first few requests → the cross-encoder isn't reaching ready; check the singleton wiring / OOM.
- `/tmp/reranker.ready` or `/tmp/embedder.ready` missing after `initialDelaySeconds + periodSeconds × failureThreshold` → readiness probe is failing; pod never joins the LB.
- Pod RSS approaching the memory limit during prewarm → bump the memory limit (§9.6) or you'll get OOMKilled during prewarm.

A simple Prometheus-style metric if you want one: `local_models_ready{model="reranker|embedder", pod="..."} 0|1`, set by the flag-file presence.

### 11.7 Per-workload Deployments (chat vs enrich)

The chat UI and `/api/enrich` have opposite prewarm policies:

| Workload | Traffic shape | Prewarm policy | Why |
|---|---|---|---|
| Chat UI (`/api/chat`) | Low, steady, human-paced | No readiness gate — accept fallbacks for first requests | UI responsiveness > first-request quota; fallbacks are invisible to users |
| Enrich batch (`/api/enrich`) | Bursty, high-concurrency, cost-sensitive | Readiness gate on prewarm — never serve cold | First-lead latency + Gemini RPM budget are critical (§11.1) |

If you run both workloads, split them into two Deployments sharing the same image but with different readiness probes (and different HPA rules). The enrich Deployment gates on `/tmp/*.ready`; the chat Deployment doesn't. This is the `vane-app` vs `vane-enrich` split foreshadowed in `docs/SCALE_AND_DEPLOYMENT.md`.

---

## 12. Anti-patterns (do not do these)

- **Don't await prewarm in `register()`.** Blocks startup, trips liveness probes, breaks HPA scale-up (§5.6).
- **Don't load models per-request.** Would pay 5–15s × 4 calls × every request. The singleton + prewarm exist precisely to prevent this.
- **Don't prewarm in route handlers.** Routes load on first request, not at startup — prewarming there means the first request pays the load anyway. Prewarm belongs in `instrumentation.ts`.
- **Don't skip the `globalThis` singleton.** Next.js module-context split means instrumentation and routes get separate instances without it (§5.4). The model "loads" but routes never see `ready=true`.
- **Don't gate liveness on prewarm.** Liveness must only check "is the server up," not "are models warm" — otherwise cold-start → restart → cold-start forever (§11.3).
- **Don't set `env.allowRemoteModels = true`.** A cold container with no HF cache would hang on a network download at first request. The bundle + offline lockdown is the whole point.
- **Don't ship `:latest` for production with `imagePullPolicy: Always`.** Adds 30–60s of pull to every scale-up; use tagged releases + `IfNotPresent` (§11.5).
- **Don't size pod memory at exactly the steady-state RSS.** Peak RSS during prewarm is ~1.5× steady-state; you'll OOMKill during prewarm (§9.6).
- **Don't swap the global `EMBEDDING_MODEL` to a different dimension without re-embedding uploads.** `computeSimilarity` throws on mismatch (§4.3).
- **Don't use the `bge-reranker-v2-m3` on CPU.** ~4–10s per call; the MiniLM-L6 is the largest that stays fast on CPU (§7).

---

## See also

- `src/lib/reranker/index.ts` — the Reranker singleton (source of truth).
- `src/lib/reranker/llmFallback.ts` — LLM-as-judge fallback.
- `src/lib/models/localEmbeddingModel.ts` — the embedder singleton.
- `src/lib/models/providers/transformers/transformerEmbedding.ts` — the underlying embed pipeline.
- `src/instrumentation.ts` — prewarm hook.
- `docs/BUILD_TRACKER.md` — Build 8 (local embedder), Build 7 (load-test latency measurements), S1/S9 (reranker/compress experiments).
- `docs/RESEARCH_LOG.md` — S1 (reranker rationale + paper), S9 (compression), S11 (batched embeddings).
- `docs/API/ENRICH.md` — the only endpoint that uses the local embedder.
- `docs/SCALE_AND_DEPLOYMENT.md` — K8s topology, pod sizing, the readiness-gate recommendation.
- `docs/SCALING_STEPS.md` — step 3.1 (K8s manifests, readiness probes) + step 3.4 (deploy + verify prewarm).
