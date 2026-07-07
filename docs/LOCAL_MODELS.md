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

Deep reference for the two local CPU models that ship bundled in the Docker image: the **cross-encoder reranker** (S1/S9) and the **local embedder** (Build 8). Both load offline from bundled ONNX weights via `@huggingface/transformers` (`^3.8.1`), are cached as `globalThis` singletons, and are prewarmed at server startup.

## 0. Why local models

| Concern | Local model | API alternative | Why local wins here |
|---|---|---|---|
| Reranking search results | Cross-encoder `ms-marco-MiniLM-L-6-v2` | LLM-as-judge (`generateText`) | 5–10× faster (~50–180ms vs ~2–5s), cross-encoder-grade relevance, no API quota, deterministic, offline. |
| Embedding queries/results (enrich only) | `all-MiniLM-L6-v2` (384-dim) | Gemini `gemini-embedding-001` | No RPM pressure under concurrency, lower latency, no network hop, free. |
| Failure mode | Falls back to the API path | n/a | Local model is a *progressive enhancement* — pipeline degrades, never breaks. |

Both are **zero-cost** (free tier independent, no API key) and **offline** (`env.allowRemoteModels = false` — the image bundles the weights, no runtime download).

---

## 1. The two models

| | Cross-encoder reranker | Local embedder |
|---|---|---|
| **HF repo** | `Xenova/ms-marco-MiniLM-L-6-v2` | `Xenova/all-MiniLM-L6-v2` |
| **Architecture** | MS MARCO MiniLM-L6 cross-encoder | MiniLM-L6 sentence embedder |
| **Transformers.js task** | `text-classification` | `feature-extraction` |
| **Output** | `{ label, score }` per (query, doc) pair | 384-dim mean-pooled, L2-normalized vector |
| **Params / size** | ~22M params, ~87MB fp32 ONNX | ~22M params, ~87MB fp32 ONNX |
| **dtype** | `fp32` | `fp32` |
| **Bundled path** | `/home/vane/models/reranker/` | `/home/vane/models/embedder/` |
| **Env override** | `RERANKER_MODEL_PATH` | `LOCAL_EMBEDDER_PATH` |
| **Singleton key** | `globalThis.__reranker` | `globalThis.__localEmbedder` |
| **Used by** | `src/lib/reranker/index.ts` → `baseSearch.ts` (rerank + compress) — **all modes** | `src/lib/models/localEmbeddingModel.ts` → **`/api/enrich` only** |
| **Fallback on failure** | LLM-as-judge rerank (`llmRerankFallback`) | Gemini `gemini-embedding-001` |

> **Note on size:** the fp32 ONNX files are ~87MB each, not the ~22MB "quantized" figure sometimes quoted. 22MB would be the int8-quantized variant; we ship fp32 for correctness. Quantized is a future optimization once the `dtype` mapping is verified (see `Dockerfile:68-72` comment).

### 1.1 Bundled files (each model)

Both models bundle the same set of files via `curl` in the Dockerfile (mirroring `Dockerfile:73-88`):

```
/home/vane/models/<reranker|embedder>/
  config.json
  tokenizer.json
  tokenizer_config.json
  special_tokens_map.json     # optional (|| true)
  onnx/model.onnx             # the fp32 weights
```

`Dockerfile.slim` (the production image) bundles **both** too — and also installs `curl` in its second stage (it was missing before Build 8).

---

## 2. transformers.js runtime

- **Library:** `@huggingface/transformers@^3.8.1` (the successor to `@xenova/transformers`).
- **Offline mode:** `env.allowRemoteModels = false` is set inside each singleton's load — the pipeline loads **only** from the local `MODEL_PATH`, never the network. This is critical: without it, a cold container with no HF cache would try to download at first request and fail/hang.
- **dtype:** `fp32` — passed to `pipeline(...)`. The ONNX file is the fp32 conversion (`onnx/model.onnx`).
- **Loading:** `pipeline('text-classification' | 'feature-extraction', MODEL_PATH, { dtype: 'fp32' })`. `MODEL_PATH` is a local directory path, which transformers.js treats as a pre-downloaded model repo.

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

- **Idempotent:** `initStarted` guards re-entry; safe to call from instrumentation AND defensively from `rerank()`.
- **Warmup inference:** the first real query doesn't pay WASM-init/JIT cost — the warmup `(query, document)` pair pays it at startup.
- **Failure → null:** on any load error, logs `reranker: load failed, using LLM fallback` and returns `null`; `this.ready` stays `false`. The pipeline degrades to LLM-as-judge, never breaks.

### 3.3 `rerank(query, candidates, llm)`

`src/lib/reranker/index.ts:98-154`:

1. If `candidates.length <= 3` → return as-is (not worth scoring).
2. Self-init if not started (the globalThis-cross-module safety net).
3. If `ready` and pipe loaded:
   - Score the first `MAX_CANDIDATES = 20` pairs: `pipe({ text: query, text_pair: snippet.slice(0, 512) })` → `{ label, score }`.
   - Sort by `score` desc; append the un-scored tail (`candidates.slice(20)`) in original order.
   - Log: `rerank: cross-encoder (Xms, N candidates)`.
   - On any runtime error → fall through to LLM fallback.
4. Else: `llmRerankFallback(query, candidates, llm)` — the original `generateText` + parsed-comma-list path (`src/lib/reranker/llmFallback.ts`). Logs `rerank: llm-fallback (Xms)`.

> **Why the LLM fallback uses `generateText` not `generateObject`:** GLM ignores JSON schemas and returns a bare list like `0, 1, 3, 2`, which `repairJson` can't coerce into `{ ranking: [...] }`. So the fallback parses integers out of the raw text (robust to stray prose/fences). See `llmFallback.ts:5-17`.

### 3.4 `compress(query, items, topK=2)` — S9 snippet compression

`src/lib/reranker/index.ts:166-213` — reuses the **already-loaded** cross-encoder for a second job:

1. For each snippet, split into sentences (`/[^.!?]+[.!?]+/g`, length ≥ 20).
2. If ≤ `topK` sentences → keep the snippet whole.
3. Else score each sentence with `pipe({ text: query, text_pair: sentence })`, keep the top `topK`.
4. Return the joined top sentences per snippet. Logs `compress: cross-encoder (Xms, N items, top K sentences)`.
5. On any error → return the raw snippets unchanged.

This is the Perplexity query-aware-context-compression technique — drops nav/metadata/ad noise so the writer gets high-signal spans. **Speed-mode only** (balanced already scrapes+extracts evidence). Called from `baseSearch.ts:271-283` on the top 10 results with `topK=2`.

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

Three-state cache (`ready` / `failed` / null) so a failed load isn't retried on every request (the load + warmup is the slow part).

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

- **Lazy pipeline promise:** the pipeline loads on first `embedText`, cached on the instance.
- **Pooling:** `mean` + `normalize: true` → L2-normalized mean-pooled embeddings (required for cosine similarity via dot product).
- **Output:** `number[][]` — one 384-dim vector per input text.

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

See `docs/BUILD_TRACKER.md` Build 8 + the embedding-persistence audit.

### 4.4 Fallback

`/api/enrich` (`src/app/api/enrich/route.ts:93-100`): if `getLocalEmbeddingModel()` returns `null`, load Gemini `gemini-embedding-001` instead. So a missing bundle or OOM doesn't break enrichment — it just costs the Gemini API calls for that run.

---

## 5. Prewarm — `src/instrumentation.ts`

Next.js instrumentation hook — runs once on server startup, **fire-and-forget** (the models warm in the background, overlapping with SearxNG init, not blocking startup):

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

### 5.1 Why `globalThis` singletons are mandatory

Next.js can hold **separate module instances** for the instrumentation hook vs route handlers. If each created its own `Reranker`, the instrumentation prewarm (which sets `ready=true`) would not reach the route handler's instance (which would stay `ready=false` and fall back to LLM rerank). `globalThis` is shared across all module contexts in the same Node process, so the singleton guarantees one instance with one loaded model. This was a real bug before the singleton — the cross-encoder loaded but rerank still fell back to LLM because of separate instances. See `src/lib/reranker/index.ts:216-222`.

### 5.2 The defensive self-init belt-and-suspenders

Even with the singleton, `rerank()` calls `if (!this.initStarted) this.init();` (`src/lib/reranker/index.ts:109`) — a cheap safety net in case the instrumentation prewarm ran on a different module instance (pre-singleton behavior). With the singleton it's usually a no-op.

### 5.3 Why fire-and-forget (not awaited)

Awaiting would block server startup on ~5–15s of model load + warmup. Fire-and-forget lets the server start immediately and serve requests; if a request arrives before the model is ready, `rerank()` falls back to LLM and `getLocalEmbeddingModel()` falls back to Gemini. The model becomes ready mid-flight and subsequent requests use it.

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

---

## 7. Performance characteristics (measured)

From the load-test logs (`docs/BUILD_TRACKER.md` Build 7):

| Op | Typical latency | Notes |
|---|---|---|
| `rerank` (10–20 candidates) | **48–178ms** | linear in candidate count; cap 20 keeps it bounded |
| `compress` (10 items, top 2) | **16–178ms** | linear in total sentences scored |
| `embedText` (batch of ~20) | ~10–20ms | batched; one call for query + one for contents (S11) |
| Model load + warmup (cold) | ~5–15s | once per process, at startup (prewarm) |

All CPU. No GPU needed. The MiniLM-L6 variants are the largest models that stay fast on CPU; the larger `bge-reranker-v2-m3` (~568M params) is ~4–10s on CPU and is **not** used (see `src/lib/reranker/index.ts:21-23`).

---

## 8. Failure modes & fallbacks

| Failure | Detection | Fallback | Effect |
|---|---|---|---|
| Reranker weights missing / load error | `init()` catches → `ready=false`, `pipe=null` | `rerank()` → `llmRerankFallback` (LLM-as-judge) | Slower rerank, same output quality band |
| Reranker runtime error mid-scoring | `rerank()` try/catch | `llmRerankFallback` | Same as above |
| Embedder weights missing / load error | `getLocalEmbeddingModel()` catches → returns `null` | `/api/enrich` loads Gemini `gemini-embedding-001` | Enrich works, costs Gemini API calls |
| Embedder runtime error mid-request | `embedText` throws | **No fallback** — bubbles to `baseSearch` try/catch → keeps similarity order | Enrich may return 0 sources on that request |
| Module-context split (instrumentation vs routes) | n/a | `globalThis` singleton + defensive self-init | Both see the same loaded model |
| Container cold start | first request before prewarm done | fire-and-forget → first few requests use fallbacks | No errors, slight latency |

---

## 9. Operations

### 9.1 Logs to expect at startup

```
reranker: model loaded from /home/vane/models/reranker
local-embedder: loaded from /home/vane/models/embedder
```
(Both fire-and-forget — they may appear a few seconds after `Ready`.)

### 9.2 Logs during requests

```
rerank: cross-encoder (124ms, 20 candidates)
compress: cross-encoder (64ms, 10 items, top 2 sentences)
```
If you see `rerank: llm-fallback (...)` instead, the cross-encoder isn't ready/loaded — check the startup log for a load failure.

### 9.3 Verifying the bundle in an image

```bash
docker run --rm vane-glm sh -c "ls /home/vane/models/reranker/onnx/model.onnx /home/vane/models/embedder/onnx/model.onnx"
```
Both should be ~87M.

### 9.4 Isolated embedder smoke test (no SearxNG needed)

```bash
docker exec vane node -e '
(async () => {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  const pipe = await pipeline("feature-extraction", "/home/vane/models/embedder", { dtype: "fp32" });
  const a = await pipe(["ceo of anthropic"], { pooling: "mean", normalize: true });
  const b = await pipe(["anthropic chief executive"], { pooling: "mean", normalize: true });
  const va = a.tolist()[0], vb = b.tolist()[0];
  const cos = (x,y) => x.reduce((s,xi,i) => s+xi*y[i], 0);
  console.log("dim", va.length, "cos", cos(va,vb).toFixed(3));  // expect dim 384, cos > 0.5
})();
'
```

### 9.5 Memory

Each loaded model resident ~150–250MB (weights + ONNX runtime + WASM buffers). Two models ≈ ~0.5GB RSS overhead per pod. Size pod memory requests accordingly (the HPA pods in `docs/SCALE_AND_DEPLOYMENT.md` should request ~1GB).

---

## 10. Tuning / swapping models

| Goal | Swap | Files |
|---|---|---|
| Better rerank quality (slower) | `Xenova/ms-marco-MiniLM-L-12-v2` | `Dockerfile` curl URL + `RERANKER_MODEL_PATH` |
| Quantized rerank (smaller, faster, slight quality drop) | int8 ONNX + `dtype: 'q8'` | `Dockerfile` + `src/lib/reranker/index.ts:66` — verify dtype mapping first |
| Better embedder (768-dim, matches Gemini) | `Xenova/bge-base-en-v1.5` (~110MB) | `Dockerfile` curl URL + `localEmbeddingModel.ts` MODEL_PATH — safe for enrich (no persistence); **do not** swap the global `EMBEDDING_MODEL` (uploads) |
| Faster embedder (smaller) | `Xenova/all-MiniLM-L-4-v2` (~14MB) | same |

> Swapping the embedder to a different dimension is safe **only** for `/api/enrich` (no persistence). Never change `EMBEDDING_MODEL` (Gemini) without re-embedding uploads — see §4.3.

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
