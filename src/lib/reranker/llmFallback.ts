import { Chunk } from '@/lib/types';
import BaseLLM from '@/lib/models/base/llm';

/**
 * LLM-as-judge rerank fallback. Used when the local cross-encoder reranker
 * isn't ready (still warming up, failed to load, or bundled weights missing).
 *
 * This is the original rerank path, extracted verbatim from baseSearch.ts so the
 * Reranker singleton can delegate to it without duplicating logic. It uses
 * `generateText` + a parsed comma-separated list (NOT `generateObject`), because
 * GLM ignores the JSON schema and returns a bare list like "0, 1, 3, 2, ..."
 * which `repairJson` cannot coerce into `{ ranking: [...] }`.
 *
 * Returns the candidates reordered by LLM-judged relevance, with any unranked
 * candidates appended in their original order. On any error, returns the
 * candidates unchanged (similarity order is preserved by the caller).
 */
export const llmRerankFallback = async (
  query: string,
  candidates: Chunk[],
  llm: BaseLLM<any>,
): Promise<Chunk[]> => {
  if (candidates.length <= 3) return candidates;

  const resultList = candidates
    .map(
      (r, i) =>
        `<result index="${i}">title: ${r.metadata.title} | url: ${r.metadata.url} | snippet: ${(r.content || '').slice(0, 200)}</result>`,
    )
    .join('\n');

  const rerankResponse = await llm.generateText({
    messages: [
      {
        role: 'system',
        content:
          'You are a search result reranker. Given a query and numbered results, output ONLY a comma-separated list of result indices in order of relevance to answering the query, most relevant first. Include every index exactly once. No prose, no JSON, no code fences — just the list, e.g. 0, 3, 1, 2, 4',
      },
      {
        role: 'user',
        content: `<query>${query}</query>\n<results>\n${resultList}\n</results>`,
      },
    ],
  });

  // Parse all integers out of the response (robust to stray prose/fences).
  const nums = (rerankResponse.content || '')
    .split(/[\s,]+/)
    .map((t) => parseInt(t, 10))
    .filter((n) => Number.isInteger(n));

  const seen = new Set<number>();
  const reranked: Chunk[] = [];
  for (const idx of nums) {
    if (idx >= 0 && idx < candidates.length && !seen.has(idx)) {
      reranked.push(candidates[idx]);
      seen.add(idx);
    }
  }
  const remaining = candidates.filter((_, i) => !seen.has(i));
  return [...reranked, ...remaining];
};
