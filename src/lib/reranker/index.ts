/**
 * Reranker — local CPU cross-encoder with an LLM-as-judge fallback.
 *
 * Primary path: a small cross-encoder (`ms-marco-MiniLM-L-6-v2`, ~22M params)
 * loaded from bundled weights in the Docker image via `@huggingface/transformers`.
 * On CPU (warm) it scores ~20 query/doc pairs in ~200-600ms — 5-10x faster than
 * the LLM-as-judge rerank it replaces, and cross-encoder-grade relevance (trained
 * on MS MARCO). Offline + deterministic: no API quota, no GLM bare-list fragility.
 *
 * Fallback path: if the cross-encoder isn't ready (still warming up, failed to
 * load, bundled weights missing/OOM), `rerank()` delegates to `llmRerankFallback`
 * — the original `generateText` + parsed-comma-list LLM rerank. This makes the
 * local model a progressive enhancement, not a hard dependency: the pipeline
 * degrades to the LLM rerank instead of breaking.
 *
 * Cold start is handled by `init()` being fire-and-forget at app startup
 * (see `src/instrumentation.ts`), overlapping with SearxNG init, plus a warmup
 * inference so the first real query doesn't pay JIT cost. With the weights
 * bundled in the image there's no runtime download.
 *
 * Trade-off note: only the small MiniLM is fast on CPU. The larger
 * `bge-reranker-v2-m3` (~568M params) is ~4-10s on CPU and is NOT used — it
 * needs a GPU. See docs/RESEARCH_LOG.md (S1) for the latency analysis.
 */

import { Chunk } from '@/lib/types';
import BaseLLM from '@/lib/models/base/llm';
import { llmRerankFallback } from './llmFallback';

const MODEL_PATH =
  process.env.RERANKER_MODEL_PATH || '/home/vane/models/reranker';
const MAX_CANDIDATES = 20;

type TextClassificationPipeline = {
  (input: { text: string; text_pair: string }): Promise<
    | { label: string; score: number }
    | { label: string; score: number }[]
  >;
};

class Reranker {
  private pipelinePromise: Promise<TextClassificationPipeline | null> | null =
    null;
  private ready = false;
  private initStarted = false;

  /**
   * Fire-and-forget load + warmup. Safe to call multiple times (idempotent).
   * Called at startup from `src/instrumentation.ts` AND defensively from
   * `rerank()` on first use, so the cross-encoder loads even if the
   * instrumentation hook ran in a different module context (a known Next.js
   * gotcha where instrumentation and route handlers can hold separate module
   * instances — see the globalThis singleton at the bottom of this file).
   */
  init(): Promise<TextClassificationPipeline | null> {
    if (this.initStarted) return this.pipelinePromise!;
    this.initStarted = true;

    this.pipelinePromise = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        // Offline by design — load only from the bundled path, never the network.
        env.allowRemoteModels = false;

        const pipe = (await pipeline('text-classification', MODEL_PATH, {
          dtype: 'fp32',
        })) as unknown as TextClassificationPipeline;

        // Warmup so the first real query doesn't pay JIT/WASM-init cost.
        await pipe({ text: 'warmup query', text_pair: 'warmup document' });

        this.ready = true;
        console.log(`reranker: model loaded from ${MODEL_PATH}`);
        return pipe;
      } catch (err: any) {
        console.log(
          `reranker: load failed, using LLM fallback — ${err?.message || err}`,
        );
        return null;
      }
    })();

    return this.pipelinePromise;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Rerank candidates by relevance to the query.
   *
   * - If the cross-encoder is ready: score each (query, candidate) pair and sort
   *   by score descending. Candidates beyond MAX_CANDIDATES keep their order.
   * - Otherwise: delegate to the LLM-as-judge fallback.
   * - On any cross-encoder runtime error: fall back to the LLM rerank.
   */
  async rerank(
    query: string,
    candidates: Chunk[],
    llm: BaseLLM<any>,
  ): Promise<Chunk[]> {
    if (candidates.length <= 3) return candidates;

    // Self-init in case the instrumentation prewarm ran on a different module
    // instance (Next.js can hold separate instances for instrumentation vs
    // route handlers). With the globalThis singleton below this is usually a
    // no-op, but it's a cheap safety net.
    if (!this.initStarted) this.init();

    if (this.ready && this.pipelinePromise) {
      try {
        const pipe = await this.pipelinePromise;
        if (pipe) {
          const t0 = Date.now();
          const toScore = candidates.slice(0, MAX_CANDIDATES);
          const rest = candidates.slice(MAX_CANDIDATES);

          const scored: { c: Chunk; score: number }[] = [];
          for (const c of toScore) {
            const out = await pipe({
              text: query,
              text_pair: (c.content || c.metadata?.title || '').slice(0, 512),
            });
            // text-classification returns { label, score }; for a single-label
            // cross-encoder the score is the relevance signal — ordering by it
            // is correct regardless of absolute calibration. Output may be a
            // single object or a 1-element array depending on transformers.js
            // version; handle both.
            const o: any = Array.isArray(out) ? out[0] : out;
            scored.push({ c, score: o?.score ?? 0 });
          }

          scored.sort((a, b) => b.score - a.score);
          console.log(
            `rerank: cross-encoder (${Date.now() - t0}ms, ${toScore.length} candidates)`,
          );
          return [...scored.map((s) => s.c), ...rest];
        }
      } catch (err) {
        console.log(
          'rerank: cross-encoder failed at runtime, falling back to LLM —',
          err,
        );
      }
    }

    // Fallback: LLM-as-judge rerank. Errors here bubble to the caller's
    // try/catch in baseSearch.ts, which keeps the similarity order.
    const t0 = Date.now();
    const result = await llmRerankFallback(query, candidates, llm);
    console.log(`rerank: llm-fallback (${Date.now() - t0}ms)`);
    return result;
  }

  /**
   * S9 — Cross-encoder double-duty snippet compression. Reuse the loaded
   * cross-encoder to score each sentence in each snippet against the query;
   * keep the top `topK` sentences per snippet. This is the Perplexity
   * query-aware-context-compression technique (research.perplexity.ai)
   * implemented with the model already loaded for reranking — no new infra,
   * no LLM call. Drops nav/metadata/ad noise so the writer gets high-signal
   * spans. Falls back to the raw content if the cross-encoder isn't ready or
   * errors.
   */
  async compress(
    query: string,
    items: { content: string }[],
    topK = 2,
  ): Promise<string[]> {
    const raw = items.map((i) => i.content || '');

    if (!this.ready || !this.pipelinePromise) return raw;

    try {
      const pipe = await this.pipelinePromise;
      if (!pipe) return raw;

      const t0 = Date.now();
      const compressed: string[] = [];

      for (const item of items) {
        const sentences =
          (item.content || '')
            .match(/[^.!?]+[.!?]+/g)
            ?.map((s) => s.trim())
            .filter((s) => s.length >= 20) ?? [];

        if (sentences.length <= topK) {
          compressed.push(item.content || '');
          continue;
        }

        const scored: { s: string; score: number }[] = [];
        for (const s of sentences) {
          const out = await pipe({ text: query, text_pair: s.slice(0, 512) });
          const o: any = Array.isArray(out) ? out[0] : out;
          scored.push({ s, score: o?.score ?? 0 });
        }

        scored.sort((a, b) => b.score - a.score);
        compressed.push(scored.slice(0, topK).map((x) => x.s).join(' '));
      }

      console.log(
        `compress: cross-encoder (${Date.now() - t0}ms, ${items.length} items, top ${topK} sentences)`,
      );
      return compressed;
    } catch (err) {
      console.log('compress: failed, returning raw snippets —', err);
      return raw;
    }
  }
}

// Share the singleton across module contexts via globalThis. Next.js can hold
// separate module instances for the instrumentation hook vs route handlers; if
// each created its own Reranker, the instrumentation prewarm (which loads the
// model + sets ready=true) would not reach the route handler's instance (which
// would stay ready=false and fall back to the LLM rerank). globalThis is shared
// across all module contexts in the same Node process, so this guarantees one
// Reranker instance with one loaded cross-encoder.
const globalForReranker = globalThis as unknown as {
  __reranker?: Reranker;
};
if (!globalForReranker.__reranker) {
  globalForReranker.__reranker = new Reranker();
}
const reranker = globalForReranker.__reranker;
export default reranker;
