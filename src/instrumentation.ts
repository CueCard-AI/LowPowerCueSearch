/**
 * Next.js instrumentation hook — runs once on server startup.
 * Used here to prewarm local CPU models so the first real query doesn't pay
 * the model-load + JIT cost. Fire-and-forget: they warm in the background,
 * overlapping with SearxNG init, and do not block startup.
 *
 * - Cross-encoder reranker: on failure, silently falls back to LLM-as-judge
 *   rerank — see src/lib/reranker/index.ts.
 * - Local embedder (enrich hot path): on failure, /api/enrich falls back to
 *   the Gemini embedding model — see src/lib/models/localEmbeddingModel.ts.
 */
export async function register() {
  try {
    const { default: reranker } = await import('@/lib/reranker');
    reranker.init();
  } catch (err) {
    console.log('reranker: instrumentation prewarm skipped —', err);
  }

  try {
    const { getLocalEmbeddingModel } = await import(
      '@/lib/models/localEmbeddingModel'
    );
    getLocalEmbeddingModel();
  } catch (err) {
    console.log('local-embedder: instrumentation prewarm skipped —', err);
  }
}
