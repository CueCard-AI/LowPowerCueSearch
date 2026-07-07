/**
 * Enrichment agent — uses the same pipeline as SearchAgent but captures
 * reasoning traces, sources, and answer text for the /api/enrich endpoint.
 *
 * Speed mode → Search-o1 writer (searchWriterStream).
 * Balanced/quality → classify → researcher (BATS) → Gemini KB → drafter → verifier.
 *
 * Emits structured events the route handler captures:
 * - `response` — answer text chunks
 * - `reasoning` — reasoning trace chunks (structured by phase + iteration)
 * - `searchResults` — the sources found
 * - `end` — all done, route handler parses citations
 */
import { SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { TextBlock, ResearchBlock, ReasoningResearchBlock } from '@/lib/types';
import { ToolCall } from '@/lib/models/types';
import { searchWriterTools } from './tools/searchWriterTools';
import {
  executeWebSearch,
  executeWeatherWidget,
  executeStockWidget,
  executeCalculationWidget,
} from './tools/searchWriterExecutor';
import { getSearchWriterPrompt } from '@/lib/prompts/search/searchWriterPrompt';
import { retryStream } from '@/lib/models/retryStream';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import { getGeminiModel } from '@/lib/models/geminiModel';
import { DRAFTER_MODEL } from '@/lib/models/modeModels';
import { getDrafterPrompt, getVerifierPrompt } from '@/lib/prompts/search/drafterVerifierPrompt';

const MAX_TOOL_ROUNDS = 1;

export interface EnrichmentResult {
  answer: string;
  sources: any[];
  reasoning: { phase: string; iteration: number; reasoning: string }[];
  citations: { citation: string; sourceIndex: number; sourceUrl: string; sourceTitle: string; context: string }[];
}

class EnrichmentAgent {
  async enrich(
    session: SessionManager,
    input: SearchAgentInput,
  ): Promise<EnrichmentResult> {
    let answer = '';
    let sources: any[] = [];
    const reasoning: { phase: string; iteration: number; reasoning: string }[] = [];

    // Helper to accumulate reasoning into the structured array.
    let currentReasoningPhase = '';
    let currentReasoningIter = 0;
    let currentReasoningText = '';

    const flushReasoning = () => {
      if (currentReasoningText) {
        reasoning.push({
          phase: currentReasoningPhase,
          iteration: currentReasoningIter,
          reasoning: currentReasoningText,
        });
        currentReasoningText = '';
      }
    };

    // Subscribe to session events to capture the output.
    const eventCapture = new Promise<void>((resolve) => {
      session.subscribe((event: string, data: any) => {
        if (event === 'data') {
          if (data.type === 'response') {
            answer += data.data;
          } else if (data.type === 'searchResults') {
            sources = data.data;
          } else if (data.type === 'reasoning') {
            if (data.phase !== currentReasoningPhase || data.iteration !== currentReasoningIter) {
              flushReasoning();
              currentReasoningPhase = data.phase;
              currentReasoningIter = data.iteration;
            }
            currentReasoningText += data.data;
          }
        } else if (event === 'end') {
          flushReasoning();
          resolve();
        } else if (event === 'error') {
          flushReasoning();
          resolve();
        }
      });
    });

    if (input.config.mode === 'speed') {
      // --- Speed mode: Search-o1 writer ---
      await this.runSearchWriter(session, input);
    } else {
      // --- Balanced/quality: full pipeline ---
      await this.runFullPipeline(session, input);
    }

    await eventCapture;

    // Parse citations from the answer.
    const citations = this.parseCitations(answer, sources);

    return { answer, sources, reasoning, citations };
  }

  private async runSearchWriter(
    session: SessionManager,
    input: SearchAgentInput,
  ): Promise<void> {
    const systemPrompt = getSearchWriterPrompt(
      input.config.systemInstructions || 'None',
      { requireSearch: true },
    );

    const researchBlockId = crypto.randomUUID();
    session.emitBlock({
      id: researchBlockId,
      type: 'research',
      data: { subSteps: [] },
    });

    const baseMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...input.chatHistory,
      { role: 'user' as const, content: input.followUp },
    ];

    let toolRound = 0;
    let currentMessages = [...baseMessages];

    while (toolRound <= MAX_TOOL_ROUNDS) {
      const tools =
        toolRound < MAX_TOOL_ROUNDS ? searchWriterTools : undefined;

      const stream = retryStream(
        () =>
          input.config.llm.streamText({
            messages: currentMessages,
            tools: tools && tools.length > 0 ? tools : undefined,
            disableThinking: toolRound > 0,
          }),
        2,
        500,
      );

      const finalToolCalls: ToolCall[] = [];

      for await (const chunk of stream) {
        if (chunk.reasoningChunk) {
          session.emit('data', {
            type: 'reasoning',
            phase: 'research',
            iteration: toolRound + 1,
            data: chunk.reasoningChunk,
          });
        }

        if (chunk.toolCallChunk && chunk.toolCallChunk.length > 0) {
          chunk.toolCallChunk.forEach((tc) => {
            const existingIndex = finalToolCalls.findIndex(
              (ftc) => ftc.id === tc.id,
            );
            if (existingIndex !== -1) {
              finalToolCalls[existingIndex].arguments = tc.arguments;
              if (tc.thoughtSignature) {
                finalToolCalls[existingIndex].thoughtSignature =
                  tc.thoughtSignature;
              }
            } else {
              finalToolCalls.push(tc);
            }
          });
        }

        if (chunk.contentChunk) {
          session.emit('data', {
            type: 'response',
            data: chunk.contentChunk,
          });
        }
      }

      if (finalToolCalls.length === 0) {
        // requireSearch prompt asks the model to always search, but under
        // concurrency Gemini Flash Lite sometimes answers from memory
        // anyway. We don't nudge-retry here — that doubles LLM calls and
        // worsens RPM pressure under load. The caller sees a 0-source
        // answer and can retry the lead. Reliable tool-calling under load
        // is fixed at the infra layer (paid Gemini + bounded concurrency).
        break;
      }

      if (finalToolCalls[finalToolCalls.length - 1].name === 'done') {
        break;
      }

      if (toolRound >= MAX_TOOL_ROUNDS) {
        break;
      }

      currentMessages.push({
        role: 'assistant',
        content: '',
        tool_calls: finalToolCalls,
      } as any);

      for (const tc of finalToolCalls) {
        try {
          let result = '';

          if (tc.name === 'web_search') {
            const queries = Array.isArray(tc.arguments.queries)
              ? tc.arguments.queries
              : [tc.arguments.queries];
            result = await executeWebSearch(
              queries,
              input.config.llm,
              input.config.embedding,
              session,
              researchBlockId,
            );
            // Emit sources from the web_search results.
            const block = session.getBlock(researchBlockId);
          } else if (tc.name === 'trigger_weather') {
            result = await executeWeatherWidget(
              tc.arguments.location || '',
              input.config.llm,
              input.chatHistory,
              input.followUp,
              session,
            );
          } else if (tc.name === 'trigger_stock') {
            result = await executeStockWidget(
              tc.arguments.symbol || '',
              input.config.llm,
              input.chatHistory,
              input.followUp,
              session,
            );
          } else if (tc.name === 'trigger_calculation') {
            result = await executeCalculationWidget(
              tc.arguments.expression || '',
              session,
            );
          } else {
            result = `<tool_result>Unknown tool: ${tc.name}</tool_result>`;
          }

          currentMessages.push({
            role: 'tool',
            id: tc.id,
            name: tc.name,
            content: result,
          } as any);
        } catch (err) {
          currentMessages.push({
            role: 'tool',
            id: tc.id,
            name: tc.name,
            content: `<tool_result>Error: ${err}</tool_result>`,
          } as any);
        }
      }

      toolRound++;
    }

    // Emit search results if any source blocks were created.
    const allBlocks = session.getAllBlocks();
    const sourceBlocks = allBlocks.filter((b: any) => b.type === 'source');
    if (sourceBlocks.length > 0) {
      const allSources = sourceBlocks.flatMap((b: any) => b.data);
      session.emit('data', { type: 'searchResults', data: allSources });
    }

    session.emit('data', { type: 'researchComplete' });
    session.emit('end', {});
  }

  private async runFullPipeline(
    session: SessionManager,
    input: SearchAgentInput,
  ): Promise<void> {
    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).catch(() => []);

    let searchPromise: Promise<any> | null = null;

    if (!classification.classification.skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(session, {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
      });
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    // Emit sources.
    if (searchResults) {
      session.emit('data', {
        type: 'searchResults',
        data: searchResults.searchFindings,
      });
    }

    session.emit('data', { type: 'researchComplete' });

    // Build context (with E1 Gemini KB for balanced/quality).
    let finalContext = '<Query to be answered without searching; Search not made>';

    if (searchResults) {
      const findings = searchResults.searchFindings;
      // E1 — Gemini KB.
      const GEMINI_KB_MODEL = 'models/gemini-3.1-flash-lite';
      const geminiLLM = await getGeminiModel(GEMINI_KB_MODEL);
      if (geminiLLM) {
        try {
          const kbSchema = await import('zod').then((z) =>
            z.object({
              summary: z.string(),
              notes: z.array(
                z.object({
                  topic: z.string(),
                  facts: z.string(),
                  source_ids: z.array(z.number()),
                }),
              ),
            }),
          );
          const kb: any = await geminiLLM.generateObject({
            schema: kbSchema,
            messages: [
              {
                role: 'system',
                content:
                  'You are a research librarian. Group facts by topic (3-6 notes). Each note tags source indices (1-based). Only supported facts.',
              },
              {
                role: 'user',
                content: `<query>${input.followUp}</query>\n<results>\n${findings.map((f: any, i: number) => `<result index=${i + 1} title=${f.metadata.title}>${(f.content || '').slice(0, 1000)}</result>`).join('\n')}\n</results>`,
              },
            ],
          });
          if (kb?.notes?.length > 0) {
            const notesBlock = kb.notes
              .map((n: any) => `## ${n.topic}\n${n.facts}\n[sources: ${n.source_ids.join(', ')}]`)
              .join('\n\n');
            const sourcesBlock = findings
              .map((f: any, i: number) => `<result index=${i + 1} title=${f.metadata.title}>${f.content}</result>`)
              .join('\n');
            finalContext = `<knowledge_base>\nSummary: ${kb.summary}\n\n${notesBlock}\n</knowledge_base>\n\n<sources>\n${sourcesBlock}\n</sources>`;
          } else {
            finalContext = findings
              .map((f: any, i: number) => `<result index=${i + 1} title=${f.metadata.title}>${f.content}</result>`)
              .join('\n');
          }
        } catch {
          finalContext = findings
            .map((f: any, i: number) => `<result index=${i + 1} title=${f.metadata.title}>${f.content}</result>`)
            .join('\n');
        }
      } else {
        finalContext = findings
          .map((f: any, i: number) => `<result index=${i + 1} title=${f.metadata.title}>${f.content}</result>`)
          .join('\n');
      }
    }

    const widgetContext = widgetOutputs
      .map((o: any) => `<result>${o.llmContext}</result>`)
      .join('\n-------------\n');

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    // E3 — Drafter/verifier.
    let draftAnswer = '';
    try {
      const { default: ModelRegistry } = await import('@/lib/models/registry');
      const registry = new ModelRegistry();
      const drafterLLM = await registry.loadChatModelByType(
        DRAFTER_MODEL.providerType,
        DRAFTER_MODEL.key,
      );
      const drafterPrompt = getDrafterPrompt(
        finalContextWithWidgets,
        input.config.systemInstructions || 'None',
      );
      const drafterResponse = await drafterLLM.generateText({
        messages: [
          { role: 'system', content: drafterPrompt },
          ...input.chatHistory,
          { role: 'user', content: input.followUp },
        ],
        disableThinking: true,
      });
      draftAnswer = drafterResponse.content || '';
    } catch {}

    const verifierPrompt = draftAnswer
      ? getVerifierPrompt(
          finalContextWithWidgets,
          draftAnswer,
          input.config.systemInstructions || 'None',
          input.config.mode,
        )
      : getWriterPrompt(
          finalContextWithWidgets,
          input.config.systemInstructions || 'None',
          input.config.mode,
        );

    const answerStream = input.config.llm.streamText({
      messages: [
        { role: 'system', content: verifierPrompt },
        ...input.chatHistory,
        { role: 'user', content: input.followUp },
      ],
    });

    for await (const chunk of answerStream) {
      if (chunk.reasoningChunk) {
        session.emit('data', {
          type: 'reasoning',
          phase: 'writer',
          iteration: 1,
          data: chunk.reasoningChunk,
        });
      }
      if (chunk.contentChunk) {
        session.emit('data', {
          type: 'response',
          data: chunk.contentChunk,
        });
      }
    }

    session.emit('end', {});
  }

  private parseCitations(
    answer: string,
    sources: any[],
  ): { citation: string; sourceIndex: number; sourceUrl: string; sourceTitle: string; context: string }[] {
    const citations: { citation: string; sourceIndex: number; sourceUrl: string; sourceTitle: string; context: string }[] = [];
    const citationRegex = /\[(\d+)\]/g;
    let match;
    const seen = new Set<string>();

    while ((match = citationRegex.exec(answer)) !== null) {
      const citationStr = match[0];
      if (seen.has(citationStr)) continue;
      seen.add(citationStr);

      const idx = parseInt(match[1]) - 1;
      const start = Math.max(0, match.index - 100);
      const end = Math.min(answer.length, match.index + match[0].length + 100);

      citations.push({
        citation: citationStr,
        sourceIndex: idx,
        sourceUrl: sources[idx]?.metadata?.url || '',
        sourceTitle: sources[idx]?.metadata?.title || '',
        context: answer.slice(start, end).trim(),
      });
    }

    return citations;
  }
}

export default EnrichmentAgent;
