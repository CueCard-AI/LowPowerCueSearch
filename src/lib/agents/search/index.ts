import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { TextBlock, ResearchBlock, ReasoningResearchBlock, Chunk } from '@/lib/types';
import { getTokenCount } from '@/lib/utils/splitText';
import z from 'zod';
import { getGeminiModel } from '@/lib/models/geminiModel';
import { searchWriterStream } from './searchWriter';
import { DRAFTER_MODEL } from '@/lib/models/modeModels';
import { getDrafterPrompt, getVerifierPrompt } from '@/lib/prompts/search/drafterVerifierPrompt';

/**
 * E1 — FS-Researcher structured knowledge base. After the researcher gathers
 * raw search findings, this synthesizes them into a topic-organized KB (notes
 * by sub-topic + source IDs). The writer then composes section-by-section from
 * the KB instead of a concatenated `<search_results>` blob — avoiding the
 * "premature synthesis" the FS-Researcher paper (Zhu et al., ACL 2026) showed
 * is the largest quality drop in agentic research. Balanced/quality only (speed
 * keeps the fast S9 path). Falls back to the raw blob on any error.
 *
 * Uses **Gemini 3.1 Flash Lite** for the structured-output call (not GLM),
 * because Google's API enforces `response_format: json_schema` strictly —
 * guaranteeing schema-compliant JSON 100% of the time. z.ai doesn't enforce
 * it (GLM returns markdown or mismatched JSON), which caused the KB to fail
 * ~50% of the time with GLM. Gemini's `generateObject` (inherited from
 * OpenAILM) uses `chat.completions.parse()` — the strict, reliable path.
 *
 * This establishes the pattern: **Gemini for structured-output tasks** (KB,
 * and potentially classifier/gap-analysis/widgets), **GLM for prose tasks**
 * (writer, researcher reasoning). Both are zero-cost (free tiers).
 *
 * Paper: FS-Researcher (arXiv:2602.01566) — decoupling evidence gathering from
 * report writing; the writer reads structured notes, not a raw search dump.
 */
type KnowledgeBase = {
  summary: string;
  notes: { topic: string; facts: string; source_ids: number[] }[];
};

const knowledgeBaseSchema = z.object({
  summary: z.string().describe('A 1-2 sentence high-level summary of what was found.'),
  notes: z
    .array(
      z.object({
        topic: z.string().describe('A short topic/facet heading.'),
        facts: z
          .string()
          .describe('Key facts as concise prose, only supported by the sources.'),
        source_ids: z
          .array(z.number())
          .describe('1-based result indices that support these facts.'),
      }),
    )
    .describe('Topic-organized notes extracted from the search findings.'),
});

// Cache the Gemini KB model on globalThis (same singleton pattern as the
// Reranker — avoids re-loading on every query + survives Next.js module
// re-instantiation). Uses the shared `getGeminiModel` from
// `src/lib/models/geminiModel.ts`.
const GEMINI_KB_MODEL = 'models/gemini-3.1-flash-lite';

const buildKnowledgeBase = async (
  query: string,
  findings: Chunk[],
): Promise<KnowledgeBase | null> => {
  if (findings.length === 0) return null;

  const resultsList = findings
    .map(
      (f, i) =>
        `<result index=${i + 1} title=${f.metadata.title}>${(f.content || '').slice(0, 1000)}</result>`,
    )
    .join('\n');

  const geminiLLM = await getGeminiModel(GEMINI_KB_MODEL);
  if (!geminiLLM) {
    console.log('knowledge-base: Gemini model unavailable, using raw context');
    return null;
  }

  try {
    const t0 = Date.now();

    // Gemini's generateObject (inherited from OpenAILLM) uses
    // chat.completions.parse() — strict structured outputs enforced by
    // Google's API. The response is guaranteed schema-compliant. No
    // repairJson, no safeParse, no defensive mapping needed.
    const kb: any = await geminiLLM.generateObject({
      schema: knowledgeBaseSchema,
      messages: [
        {
          role: 'system',
          content:
            'You are a research librarian. Given the user query and the search results, organize the findings into a structured knowledge base. Group facts by topic/facet (aim for 3-6 notes). Each note states the facts concisely and tags which source indices (1-based) support them. Only include facts supported by the sources — no speculation.',
        },
        {
          role: 'user',
          content: `<query>${query}</query>\n<results>\n${resultsList}\n</results>`,
        },
      ],
    });

    if (!kb.notes || kb.notes.length === 0) {
      console.log('knowledge-base: Gemini returned empty notes, using raw context');
      return null;
    }

    console.log(
      `knowledge-base: built via Gemini (${Date.now() - t0}ms, ${kb.notes.length} notes)`,
    );
    return kb as KnowledgeBase;
  } catch (err) {
    console.log('knowledge-base: Gemini construction failed, using raw context —', err);
    return null;
  }
};

const formatKnowledgeBaseContext = (kb: KnowledgeBase, findings: Chunk[]): string => {
  const notesBlock = kb.notes
    .map((n) => `## ${n.topic}\n${n.facts}\n[sources: ${n.source_ids.join(', ')}]`)
    .join('\n\n');

  const sourcesBlock = findings
    .map(
      (f, index) =>
        `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
    )
    .join('\n');

  return `<knowledge_base note="Structured notes from the research. Compose your answer section-by-section from these topics, citing the source indices.">
Summary: ${kb.summary}

${notesBlock}
</knowledge_base>

<sources note="The original search results for citation lookup. Cite by [number] matching the result index.">
${sourcesBlock}
</sources>`;
};

class SearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    // --- Speed mode: Search-o1-style single-stream writer ---
    // Cuts from 3 LLM calls (classify + researcher + writer) to 1-2 (writer
    // with tool-call breaks for SearxNG/widgets). Target: 11-14s.
    // Balanced/quality keep the full pipeline below (unchanged).
    // See docs/BUILD_TRACKER.md Build 3.5 for the full spec.
    if (input.config.mode === 'speed') {
      await searchWriterStream(session, input);
      return;
    }

    // --- Balanced/quality: full pipeline (classify → researcher → KB → writer) ---
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.followUp,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }

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
    }).then((widgetOutputs) => {
      widgetOutputs.forEach((o) => {
        session.emitBlock({
          id: crypto.randomUUID(),
          type: 'widget',
          data: {
            widgetType: o.type,
            params: o.data,
          },
        });
      });
      return widgetOutputs;
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

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

    session.emit('data', {
      type: 'researchComplete',
    });

    let finalContext =
      '<Query to be answered without searching; Search not made>';

    if (searchResults) {
      const findings = searchResults.searchFindings;

      // E1 — structured knowledge base for balanced/quality (decoupled
      // gather/write per FS-Researcher). Speed mode is handled by the
      // Search-o1 writer above (early return), so this always runs for
      // balanced/quality. The KB organizes findings into topic-structured
      // notes so the writer composes section-by-section instead of from a
      // raw concatenated blob (avoids "premature synthesis"). KB
      // construction falls back to the raw blob on any error.
      {
        const kb = await buildKnowledgeBase(
          input.followUp,
          findings,
        );
        if (kb) {
          finalContext = formatKnowledgeBaseContext(kb, findings);
        } else {
          finalContext = findings
            .map(
              (f, index) =>
                `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
            )
            .join('\n');
        }
      }
    }

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    // E3 — Speculative RAG drafter/verifier writer (balanced/quality).
    // The drafter (glm-4.5-air, thinking disabled) generates a quick draft
    // from the KB. The verifier (the mode's chat model) refines the draft
    // into the final cited answer. Two passes → better quality than one.
    // Paper: Speculative RAG (Google, arXiv:2407.08223).

    // --- Phase 1: Drafter generates a quick draft (thinking disabled) ---
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
      console.log(`drafter: generated draft (${draftAnswer.length} chars)`);
    } catch (err) {
      console.log('drafter: failed, falling back to single-pass writer —', err);
    }

    // --- Phase 2: Verifier refines the draft into the final answer ---
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
        {
          role: 'system',
          content: verifierPrompt,
        },
        ...input.chatHistory,
        {
          role: 'user',
          content: input.followUp,
        },
      ],
    });

    let responseBlockId = '';
    let reasoningBlockId = '';
    let reasoningSubStepId = '';
    let reasoningEmitted = false;
    let lastReasoningEmitLen = 0;

    for await (const chunk of answerStream) {
      if (chunk.reasoningChunk) {
        if (!reasoningEmitted) {
          reasoningEmitted = true;
          reasoningSubStepId = crypto.randomUUID();
          reasoningBlockId = crypto.randomUUID();

          const reasoningBlock: ResearchBlock = {
            id: reasoningBlockId,
            type: 'research',
            data: {
              subSteps: [
                {
                  id: reasoningSubStepId,
                  type: 'reasoning',
                  reasoning: chunk.reasoningChunk,
                } as ReasoningResearchBlock,
              ],
            },
          };

          lastReasoningEmitLen = chunk.reasoningChunk.length;

          session.emitBlock(reasoningBlock);
        } else {
          const block = session.getBlock(reasoningBlockId) as
            | ResearchBlock
            | null;

          if (block && block.type === 'research') {
            const subStep = block.data.subSteps.find(
              (s) => s.id === reasoningSubStepId,
            ) as ReasoningResearchBlock | undefined;

            if (subStep) {
              subStep.reasoning += chunk.reasoningChunk;

              // Throttle: only re-emit when reasoning has grown by >= 64
              // chars. Per-chunk emits flood the client with full-array
              // patches and can OOM the browser renderer.
              if (subStep.reasoning.length - lastReasoningEmitLen >= 64) {
                lastReasoningEmitLen = subStep.reasoning.length;
                session.updateBlock(reasoningBlockId, [
                  {
                    op: 'replace',
                    path: '/data/subSteps',
                    value: block.data.subSteps,
                  },
                ]);
              }
            }
          }
        }
      }

      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);

        responseBlockId = block.id;
      } else {
        const block = session.getBlock(responseBlockId) as TextBlock | null;

        if (!block) {
          continue;
        }

        block.data += chunk.contentChunk;

        session.updateBlock(block.id, [
          {
            op: 'replace',
            path: '/data',
            value: block.data,
          },
        ]);
      }
    }

    // Final flush of the throttled writer reasoning subStep.
    if (reasoningEmitted && reasoningBlockId) {
      const rBlock = session.getBlock(reasoningBlockId) as
        | ResearchBlock
        | null;
      if (rBlock && rBlock.type === 'research') {
        const subStep = rBlock.data.subSteps.find(
          (s) => s.id === reasoningSubStepId,
        ) as ReasoningResearchBlock | undefined;
        if (subStep && subStep.reasoning.length !== lastReasoningEmitLen) {
          session.updateBlock(reasoningBlockId, [
            {
              op: 'replace',
              path: '/data/subSteps',
              value: rBlock.data.subSteps,
            },
          ]);
        }
      }
    }

    session.emit('end', {});

    await db
      .update(messages)
      .set({
        status: 'completed',
        responseBlocks: session.getAllBlocks(),
      })
      .where(
        and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
        ),
      )
      .execute();
  }
}

export default SearchAgent;
