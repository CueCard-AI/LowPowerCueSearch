/**
 * Shared local embedding model — a transformers.js `feature-extraction` pipeline
 * loaded from bundled ONNX weights, cached on globalThis so it's loaded once and
 * reused across all module contexts (instrumentation, route handlers, the
 * researcher loop). Mirrors the reranker's offline-load pattern
 * (`src/lib/reranker/index.ts`).
 *
 * Why local: removes the Gemini `gemini-embedding-001` API calls from the enrich
 * hot path (2 calls/search) — one fewer rate-limited dependency, lower latency,
 * no RPM pressure under concurrency. Used by `/api/enrich`. The chat/search
 * routes keep using `EMBEDDING_MODEL` (Gemini) so the uploads feature (which
 * persists 768-dim chunk embeddings) stays consistent — see
 * docs/SCALE_AND_DEPLOYMENT.md.
 *
 * Model: `Xenova/all-MiniLM-L6-v2` (~22MB fp32, 384-dim). Bundled into the image
 * at `/home/vane/models/embedder/` (see Dockerfile / Dockerfile.slim).
 *
 * Returns `null` if the model fails to load (missing bundle, OOM, etc.) so
 * callers can fall back to the Gemini embedding model. The failure is cached so
 * we don't retry the (slow) load on every request.
 */

import TransformerEmbedding from './providers/transformers/transformerEmbedding';

const MODEL_PATH =
  process.env.LOCAL_EMBEDDER_PATH || '/home/vane/models/embedder';

type Cached =
  | { state: 'ready'; embedder: TransformerEmbedding }
  | { state: 'failed' }
  | null;

const globalForLocalEmbed = globalThis as unknown as {
  __localEmbedder?: Cached;
};

export const getLocalEmbeddingModel =
  async (): Promise<TransformerEmbedding | null> => {
    const cached = globalForLocalEmbed.__localEmbedder;
    if (cached?.state === 'ready') return cached.embedder;
    if (cached?.state === 'failed') return null;

    try {
      const { env } = await import('@huggingface/transformers');
      // Offline by design — load only from the bundled path, never the network.
      env.allowRemoteModels = false;

      const embedder = new TransformerEmbedding({ model: MODEL_PATH });

      // Warmup so the first real query doesn't pay model-load + JIT/WASM-init
      // cost. This is where a load failure surfaces (throws).
      await embedder.embedText(['warmup']);
      console.log(`local-embedder: loaded from ${MODEL_PATH}`);

      globalForLocalEmbed.__localEmbedder = { state: 'ready', embedder };
      return embedder;
    } catch (err: any) {
      console.log(
        `local-embedder: load failed (path=${MODEL_PATH}) — ${err?.message || err}`,
      );
      globalForLocalEmbed.__localEmbedder = { state: 'failed' };
      return null;
    }
  };

/** Whether the local embedder has been instantiated (not necessarily warmed). */
export const hasLocalEmbedder = (): boolean =>
  globalForLocalEmbed.__localEmbedder?.state === 'ready';
