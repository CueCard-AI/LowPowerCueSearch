/**
 * Retry wrapper for async generators that stream LLM output.
 *
 * Retries the underlying call ONLY if it throws before yielding the first
 * chunk. Once a chunk has been yielded, a retry would double-emit to the
 * consumer, so we re-throw instead. This covers the common failure mode
 * (network/RPM errors at connection setup — e.g. Gemini "fetch failed"
 * under concurrency) safely without risking duplicated output.
 *
 * Usage:
 *   const stream = retryStream(() => llm.streamText({...}), 2, 500);
 */
export async function* retryStream<T>(
  makeStream: () => AsyncGenerator<T>,
  retries = 2,
  baseBackoffMs = 500,
): AsyncGenerator<T> {
  let attempt = 0;
  while (true) {
    const stream = makeStream();
    let yielded = false;
    try {
      for await (const chunk of stream) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (!yielded && attempt < retries) {
        attempt++;
        const backoff = baseBackoffMs * attempt;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
}
