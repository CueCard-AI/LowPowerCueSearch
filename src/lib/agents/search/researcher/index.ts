import { ActionOutput, ResearcherInput, ResearcherOutput } from '../types';
import { ActionRegistry } from './actions';
import { getResearcherPrompt } from '@/lib/prompts/search/researcher';
import SessionManager from '@/lib/session';
import { Message, ReasoningResearchBlock } from '@/lib/types';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';
import { ToolCall } from '@/lib/models/types';
import z from 'zod';
import { getGeminiModel } from '@/lib/models/geminiModel';

class Researcher {
  async research(
    session: SessionManager,
    input: ResearcherInput,
  ): Promise<ResearcherOutput> {
    let actionOutput: ActionOutput[] = [];
    let maxIteration =
      input.config.mode === 'speed'
        ? 1
        : input.config.mode === 'balanced'
          ? 3
          : 10;

    const availableTools = ActionRegistry.getAvailableActionTools({
      classification: input.classification,
      fileIds: input.config.fileIds,
      mode: input.config.mode,
      sources: input.config.sources,
    });

    // Search tool names that get removed on the last iteration (code arbiter).
    const searchToolNames = ['web_search', 'academic_search', 'social_search', 'uploads_search'];

    const availableActionsDescription =
      ActionRegistry.getAvailableActionsDescriptions({
        classification: input.classification,
        fileIds: input.config.fileIds,
        mode: input.config.mode,
        sources: input.config.sources,
      });

    const researchBlockId = crypto.randomUUID();

    session.emitBlock({
      id: researchBlockId,
      type: 'research',
      data: {
        subSteps: [],
      },
    });

    const agentMessageHistory: Message[] = [
      {
        role: 'user',
        content: `
          <conversation>
          ${formatChatHistoryAsString(input.chatHistory.slice(-10))}
           User: ${input.followUp} (Standalone question: ${input.classification.standaloneFollowUp})
           </conversation>
        `,
      },
    ];

    for (let i = 0; i < maxIteration; i++) {
      const isLastIteration = i === maxIteration - 1;

      // CODE ARBITER: on the last iteration, remove search tools so the
      // model can only call done. This is code-enforced — the tool literally
      // isn't in the list. The model can't search anymore.
      const toolsForThisIteration = isLastIteration
        ? availableTools.filter(t => !searchToolNames.includes(t.name))
        : availableTools;

      // PROMPT INFLUENCER: inject research_status (remaining calls + gathered
      // summary) into the prompt. This is informational — helps the model plan
      // within the constraint. If the model ignores it, the code arbiter still
      // bounds the time. Not a separate LLM call — just appended to the prompt.
      const progressSummary = actionOutput
        .filter(a => a.type === 'search_results')
        .flatMap(a => a.results.slice(0, 3).map(r => r.metadata.title))
        .join(', ');

      const budgetInfo = `\n<research_status>
Tool calls remaining: ${maxIteration - i} out of ${maxIteration}${isLastIteration ? ' (FINAL — search tools removed, call done)' : ''}.
Gathered so far: ${progressSummary || 'nothing yet'}.
</research_status>`;

      const researcherPrompt = getResearcherPrompt(
        availableActionsDescription,
        input.config.mode,
        i,
        maxIteration,
        input.config.fileIds,
      ) + budgetInfo;

      const actionStream = input.config.llm.streamText({
        messages: [
          {
            role: 'system',
            content: researcherPrompt,
          },
          ...agentMessageHistory,
        ],
        tools: toolsForThisIteration,
      });

      const block = session.getBlock(researchBlockId);

      let reasoningEmitted = false;
      let reasoningId = crypto.randomUUID();

      let rawReasoningEmitted = false;
      let rawReasoningId = crypto.randomUUID();
      let lastReasoningEmitLen = 0;

      let finalToolCalls: ToolCall[] = [];

      for await (const partialRes of actionStream) {
        if (partialRes.reasoningChunk) {
          if (!rawReasoningEmitted && block && block.type === 'research') {
            rawReasoningEmitted = true;

            block.data.subSteps.push({
              id: rawReasoningId,
              type: 'reasoning',
              reasoning: partialRes.reasoningChunk,
            });

            lastReasoningEmitLen = partialRes.reasoningChunk.length;

            session.updateBlock(researchBlockId, [
              {
                op: 'replace',
                path: '/data/subSteps',
                value: block.data.subSteps,
              },
            ]);
          } else if (
            rawReasoningEmitted &&
            block &&
            block.type === 'research'
          ) {
            const subStepIndex = block.data.subSteps.findIndex(
              (step: any) => step.id === rawReasoningId,
            );

            if (subStepIndex !== -1) {
              const subStep = block.data.subSteps[
                subStepIndex
              ] as ReasoningResearchBlock;
              subStep.reasoning += partialRes.reasoningChunk;

              // Throttle: only re-emit the full subSteps array when the
              // reasoning has grown by >= 64 chars. Emitting on every tiny
              // reasoning_content chunk floods the client with full-array
              // patches and can OOM the browser renderer.
              if (subStep.reasoning.length - lastReasoningEmitLen >= 64) {
                lastReasoningEmitLen = subStep.reasoning.length;
                session.updateBlock(researchBlockId, [
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

        if (partialRes.toolCallChunk.length > 0) {
          partialRes.toolCallChunk.forEach((tc) => {
            if (
              tc.name === '__reasoning_preamble' &&
              tc.arguments['plan'] &&
              !reasoningEmitted &&
              block &&
              block.type === 'research'
            ) {
              reasoningEmitted = true;

              block.data.subSteps.push({
                id: reasoningId,
                type: 'reasoning',
                reasoning: tc.arguments['plan'],
              });

              session.updateBlock(researchBlockId, [
                {
                  op: 'replace',
                  path: '/data/subSteps',
                  value: block.data.subSteps,
                },
              ]);
            } else if (
              tc.name === '__reasoning_preamble' &&
              tc.arguments['plan'] &&
              reasoningEmitted &&
              block &&
              block.type === 'research'
            ) {
              const subStepIndex = block.data.subSteps.findIndex(
                (step: any) => step.id === reasoningId,
              );

              if (subStepIndex !== -1) {
                const subStep = block.data.subSteps[
                  subStepIndex
                ] as ReasoningResearchBlock;
                subStep.reasoning = tc.arguments['plan'];
                session.updateBlock(researchBlockId, [
                  {
                    op: 'replace',
                    path: '/data/subSteps',
                    value: block.data.subSteps,
                  },
                ]);
              }
            }

            const existingIndex = finalToolCalls.findIndex(
              (ftc) => ftc.id === tc.id,
            );

            if (existingIndex !== -1) {
              finalToolCalls[existingIndex].arguments = tc.arguments;
            } else {
              finalToolCalls.push(tc);
            }
          });
        }
      }

      // Final flush of the throttled reasoning subStep so the last
      // <64 chars of reasoning_content actually reach the UI.
      if (
        rawReasoningEmitted &&
        block &&
        block.type === 'research'
      ) {
        const subStepIndex = block.data.subSteps.findIndex(
          (step: any) => step.id === rawReasoningId,
        );
        if (subStepIndex !== -1) {
          const subStep = block.data.subSteps[
            subStepIndex
          ] as ReasoningResearchBlock;
          if (subStep.reasoning.length !== lastReasoningEmitLen) {
            lastReasoningEmitLen = subStep.reasoning.length;
            session.updateBlock(researchBlockId, [
              {
                op: 'replace',
                path: '/data/subSteps',
                value: block.data.subSteps,
              },
            ]);
          }
        }
      }

      if (finalToolCalls.length === 0) {
        break;
      }

      if (finalToolCalls[finalToolCalls.length - 1].name === 'done') {
        break;
      }

      agentMessageHistory.push({
        role: 'assistant',
        content: '',
        tool_calls: finalToolCalls,
      });

      const actionResults = await ActionRegistry.executeAll(finalToolCalls, {
        llm: input.config.llm,
        embedding: input.config.embedding,
        session: session,
        researchBlockId: researchBlockId,
        fileIds: input.config.fileIds,
        mode: input.config.mode,
      });

      actionOutput.push(...actionResults);

      actionResults.forEach((action, i) => {
        agentMessageHistory.push({
          role: 'tool',
          id: finalToolCalls[i].id,
          name: finalToolCalls[i].name,
          content: JSON.stringify(action),
        });
      });

      // Gap-driven refinement: after the first research round (balanced/quality),
      // run a structured gap analysis and inject it as guidance for the next
      // iterations so they target what's still missing instead of re-searching.
      if (
        i === 0 &&
        input.config.mode !== 'speed' &&
        i < maxIteration - 1
      ) {
        try {
          const gapSchema = z.object({
            covered: z
              .array(z.string())
              .describe(
                'Aspects of the query already answered by the gathered info',
              ),
            missing: z
              .array(z.string())
              .describe('Aspects still missing or uncertain'),
            next_queries: z
              .array(z.string())
              .describe('Targeted queries to fill the missing gaps'),
          });

          const researchSoFar = actionOutput
            .map((a) => JSON.stringify(a))
            .join('\n')
            .slice(0, 4000);

          const gapResponse =
            await input.config.llm.generateObject<typeof gapSchema>({
              schema: gapSchema,
              messages: [
                {
                  role: 'system',
                  content:
                    'You are a research gap analyzer. Given the user query and the research gathered so far, identify what is covered, what is still missing, and the most targeted next queries to fill the gaps. Be concise.',
                },
                {
                  role: 'user',
                  content: `<query>${input.followUp}</query>\n<research_so_far>\n${researchSoFar}\n</research_so_far>`,
                },
              ],
            });

          agentMessageHistory.push({
            role: 'user',
            content: `<gap_analysis>\nCovered: ${gapResponse.covered.join('; ')}\nMissing: ${gapResponse.missing.join('; ')}\nNext queries to consider: ${gapResponse.next_queries.join(', ')}\n</gap_analysis>`,
          });
        } catch (err) {
          console.log('Gap analysis failed:', err);
        }
      }

      // E2 confidence-gated early stop was here — REVERTED (superseded by
      // Search-o1 speed mode, which lets the writer decide when to stop
      // naturally via tool calls, no separate confidence check needed).
      // For balanced/quality, the researcher's existing __reasoning_preamble
      // + done tool mechanism handles the stop decision.
    }

    const searchResults = actionOutput
      .filter((a) => a.type === 'search_results')
      .flatMap((a) => a.results);

    const seenUrls = new Map<string, number>();

    const filteredSearchResults = searchResults
      .map((result, index) => {
        if (result.metadata.url && !seenUrls.has(result.metadata.url)) {
          seenUrls.set(result.metadata.url, index);
          return result;
        } else if (result.metadata.url && seenUrls.has(result.metadata.url)) {
          const existingIndex = seenUrls.get(result.metadata.url)!;

          const existingResult = searchResults[existingIndex];

          existingResult.content += `\n\n${result.content}`;

          return undefined;
        }

        return result;
      })
      .filter((r) => r !== undefined);

    session.emitBlock({
      id: crypto.randomUUID(),
      type: 'source',
      data: filteredSearchResults,
    });

    return {
      findings: actionOutput,
      searchFindings: filteredSearchResults,
    };
  }
}

export default Researcher;
