/**
 * /api/enrich — Lead enrichment endpoint.
 *
 * Takes a prompt + company URL (+ optional name/context) and returns a
 * researched, cited answer with reasoning traces and citation mapping.
 * Uses the full Vane pipeline (Search-o1 for speed, full pipeline for
 * balanced/quality) — replaces Google Gemini's grounding search.
 *
 * Input:
 *   prompt (required) — the enrichment instruction
 *   companyUrl (required) — the company's website
 *   companyName (optional, nullable) — the company's name
 *   companyContext (optional, nullable) — existing enrichment data (string/object/array)
 *   mode (optional) — speed (default) / balanced / quality
 *   stream (optional) — false (default) / true
 *
 * Response:
 *   answer — the enrichment output with [N] citations
 *   sources — all web sources found (title, url, content)
 *   reasoning — compounding reasoning traces (structured by phase + iteration)
 *   citations — every [N] mapped to source + context
 */
import ModelRegistry from '@/lib/models/registry';
import { getModeModelRef, EMBEDDING_MODEL } from '@/lib/models/modeModels';
import { getLocalEmbeddingModel } from '@/lib/models/localEmbeddingModel';
import SessionManager from '@/lib/session';
import { SearchSources } from '@/lib/agents/search/types';
import EnrichmentAgent from '@/lib/agents/search/enrichmentAgent';

interface EnrichRequestBody {
  prompt: string;
  companyUrl: string;
  companyName?: string | null;
  companyContext?: string | Record<string, any> | Array<{ column: string; value: string }> | null;
  mode?: 'speed' | 'balanced' | 'quality';
  stream?: boolean;
}

/**
 * Format companyContext (string/object/array) into a readable context block.
 */
function formatContext(context: any): string {
  if (!context) return '';
  if (typeof context === 'string') return context;
  if (Array.isArray(context)) {
    return context
      .map((item: any) => `- ${item.column || item.key || 'Unknown'}: ${item.value}`)
      .join('\n');
  }
  if (typeof context === 'object') {
    return Object.entries(context)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');
  }
  return String(context);
}

export const POST = async (req: Request) => {
  try {
    const body: EnrichRequestBody = await req.json();

    if (!body.prompt || !body.companyUrl) {
      return Response.json(
        { message: 'Missing required fields: prompt and companyUrl' },
        { status: 400 },
      );
    }

    const mode = body.mode || 'speed';
    const stream = body.stream || false;

    // Construct the search query from the enrichment inputs.
    const companyPart = body.companyName
      ? `at ${body.companyUrl} (${body.companyName})`
      : `at ${body.companyUrl}`;

    const contextBlock = formatContext(body.companyContext);
    const query = `Research the company ${companyPart}.${
      contextBlock ? `\nExisting enrichment data:\n${contextBlock}` : ''
    }\nAnswer the following: ${body.prompt}`;

    const systemInstructions =
      'You are a lead enrichment assistant. Research the company and answer the prompt concisely with citations [N]. Use the existing enrichment data as context — do not re-search what is already known.';

    // Load models from the mode mapping. Enrich uses the LOCAL embedder
    // (transformers.js, bundled) so the hot path makes no Gemini embedding
    // API calls — fewer rate-limited dependencies under concurrency. If the
    // local embedder fails to load (missing bundle, OOM), fall back to the
    // Gemini embedding model.
    const registry = new ModelRegistry();
    const modeModelRef = getModeModelRef(mode);

    let embeddings: any = await getLocalEmbeddingModel();
    if (!embeddings) {
      console.log('enrich: local embedder unavailable, using Gemini embedding');
      embeddings = await registry.loadEmbeddingModelByType(
        EMBEDDING_MODEL.providerType,
        EMBEDDING_MODEL.key,
      );
    }

    const llm = await registry.loadChatModelByType(
      modeModelRef.providerType,
      modeModelRef.key,
    );

    const session = SessionManager.createSession();
    const agent = new EnrichmentAgent();

    // Start the enrichment (async, emits events to the session).
    const enrichmentPromise = agent.enrich(session, {
      chatHistory: [],
      followUp: query,
      chatId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      config: {
        llm,
        embedding: embeddings,
        sources: ['web'] as SearchSources[],
        mode,
        fileIds: [],
        systemInstructions,
      },
    });

    if (!stream) {
      // Non-streaming: wait for the enrichment to complete, return the full result.
      const result = await enrichmentPromise;

      return Response.json(
        {
          answer: result.answer,
          sources: result.sources,
          reasoning: result.reasoning,
          citations: result.citations || [],
        },
        { status: 200 },
      );
    }

    // Streaming: pipe session events to the client as SSE.
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    const { signal } = abortController;

    const responseStream = new ReadableStream({
      start(controller) {
        let sources: any[] = [];
        const reasoningBuffer: { phase: string; iteration: number; data: string }[] = [];

        controller.enqueue(
          encoder.encode(JSON.stringify({ type: 'init', data: 'Stream connected' }) + '\n'),
        );

        signal.addEventListener('abort', () => {
          session.removeAllListeners();
          try { controller.close(); } catch {}
        });

        session.subscribe((event: string, data: any) => {
          if (signal.aborted) return;

          if (event === 'data') {
            try {
              if (data.type === 'response') {
                controller.enqueue(
                  encoder.encode(JSON.stringify({ type: 'response', data: data.data }) + '\n'),
                );
              } else if (data.type === 'searchResults') {
                sources = data.data;
                controller.enqueue(
                  encoder.encode(JSON.stringify({ type: 'sources', data: sources }) + '\n'),
                );
              } else if (data.type === 'reasoning') {
                controller.enqueue(
                  encoder.encode(
                    JSON.stringify({
                      type: 'reasoning',
                      phase: data.phase,
                      iteration: data.iteration,
                      data: data.data,
                    }) + '\n',
                  ),
                );
              }
            } catch (error) {
              controller.error(error);
            }
          }

          if (event === 'end') {
            if (signal.aborted) return;
            // Parse citations from the accumulated answer.
            // The enrichment promise resolves with the full result including citations.
            enrichmentPromise.then((result) => {
              controller.enqueue(
                encoder.encode(
                  JSON.stringify({
                    type: 'done',
                    citations: result.citations || [],
                  }) + '\n',
                ),
              );
              controller.close();
            });
          }

          if (event === 'error') {
            if (signal.aborted) return;
            controller.error(data);
          }
        });
      },
      cancel() {
        abortController.abort();
      },
    });

    return new Response(responseStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err: any) {
    console.error(`Error in enrichment: ${err.message}`);
    return Response.json(
      { message: 'An error occurred during enrichment.' },
      { status: 500 },
    );
  }
};
