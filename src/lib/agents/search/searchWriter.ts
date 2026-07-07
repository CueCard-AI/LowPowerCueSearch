/**
 * Search-o1-style single-stream writer for speed mode.
 *
 * Instead of the 3-call pipeline (classify → researcher → writer), the writer
 * reasons → calls tools (web_search / widget tools) → gets results → writes
 * the answer. 1-2 LLM calls instead of 3. Target: 11-14s.
 *
 * Flow:
 *  1. Start streamText with tools (web_search + widget tools).
 *  2. Stream reasoning + content to the UI.
 *  3. Collect tool calls from the stream.
 *  4. If no tool calls → the writer answered directly (0 searches). Done.
 *  5. If tool calls → execute them, feed results back, start a SECOND
 *     streamText (without web_search — forces the writer to answer).
 *  6. Stream the second call's content + reasoning to the UI.
 *
 * Paper: Search-o1 (Li et al., EMNLP 2025).
 * See docs/BUILD_TRACKER.md Build 3.5 for the full spec.
 */
import { SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { TextBlock, ResearchBlock, ReasoningResearchBlock } from '@/lib/types';
import { ToolCall } from '@/lib/models/types';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { searchWriterTools } from './tools/searchWriterTools';
import {
  executeWebSearch,
  executeWeatherWidget,
  executeStockWidget,
  executeCalculationWidget,
} from './tools/searchWriterExecutor';
import { getSearchWriterPrompt } from '@/lib/prompts/search/searchWriterPrompt';

const MAX_TOOL_ROUNDS = 1; // speed mode: at most 1 search round

export const searchWriterStream = async (
  session: SessionManager,
  input: SearchAgentInput,
): Promise<void> => {
  // --- DB setup (same as searchAsync) ---
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

  const systemPrompt = getSearchWriterPrompt(
    input.config.systemInstructions || 'None',
  );

  // Create a research block for the UI (searching/search_results subSteps).
  const researchBlockId = crypto.randomUUID();
  session.emitBlock({
    id: researchBlockId,
    type: 'research',
    data: { subSteps: [] },
  });

  // --- Message history (system + chat history + user query) ---
  const baseMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...input.chatHistory,
    { role: 'user' as const, content: input.followUp },
  ];

  let toolRound = 0;
  let currentMessages = [...baseMessages];

  while (toolRound <= MAX_TOOL_ROUNDS) {
    // On the last round, provide NO tools at all — force the writer to
    // write the answer. If we keep widget tools, the model might call
    // them instead of writing, producing an incomplete answer.
    const tools =
      toolRound < MAX_TOOL_ROUNDS
        ? searchWriterTools
        : undefined;

    const stream = input.config.llm.streamText({
      messages: currentMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      // Disable thinking on the answer-generation round (toolRound > 0) —
      // the search results are already available, no reasoning needed, just
      // write the answer. This cuts the 39s answer generation to ~5-8s.
      // The first round (toolRound === 0) keeps thinking enabled for the
      // UI reasoning trace ("Thinking" step).
      disableThinking: toolRound > 0,
    });

    let responseBlockId = '';
    let reasoningBlockId = '';
    let reasoningSubStepId = '';
    let reasoningEmitted = false;
    let lastReasoningEmitLen = 0;

    const finalToolCalls: ToolCall[] = [];

    for await (const chunk of stream) {
      // --- Reasoning trace (throttled, same as the current writer) ---
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

      // --- Tool calls ---
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

      // --- Content (the answer text) ---
      if (chunk.contentChunk) {
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
          if (block) {
            block.data += chunk.contentChunk;
            session.updateBlock(block.id, [
              { op: 'replace', path: '/data', value: block.data },
            ]);
          }
        }
      }
    }

    // Final flush of reasoning.
    if (reasoningEmitted && reasoningBlockId) {
      const rBlock = session.getBlock(reasoningBlockId) as ResearchBlock | null;
      if (rBlock && rBlock.type === 'research') {
        const subStep = rBlock.data.subSteps.find(
          (s) => s.id === reasoningSubStepId,
        ) as ReasoningResearchBlock | undefined;
        if (subStep && subStep.reasoning.length !== lastReasoningEmitLen) {
          session.updateBlock(reasoningBlockId, [
            { op: 'replace', path: '/data/subSteps', value: rBlock.data.subSteps },
          ]);
        }
      }
    }

    // --- If no tool calls, the writer answered directly. Done. ---
    if (finalToolCalls.length === 0) {
      console.log('search-writer: no tool calls, writer answered directly');
      break;
    }

    // --- Check if the last tool call is 'done' (shouldn't happen but just in case) ---
    if (finalToolCalls[finalToolCalls.length - 1].name === 'done') {
      break;
    }

    // --- Execute tool calls ---
    if (toolRound >= MAX_TOOL_ROUNDS) {
      // We've hit the tool round limit but the model still wants tools.
      // Force it to answer by breaking (the answer so far is what we have).
      console.log(
        `search-writer: hit max tool rounds (${MAX_TOOL_ROUNDS}), forcing answer`,
      );
      break;
    }

    console.log(
      `search-writer: round ${toolRound + 1}, executing ${finalToolCalls.length} tool calls: ${finalToolCalls.map((tc) => tc.name).join(', ')}`,
    );

    // Add the assistant's tool calls to the message history.
    currentMessages.push({
      role: 'assistant',
      content: '',
      tool_calls: finalToolCalls,
    } as any);

    // Execute each tool call and add the result as a tool message.
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
        console.log(`search-writer: tool ${tc.name} failed —`, err);
        currentMessages.push({
          role: 'tool',
          id: tc.id,
          name: tc.name,
          content: `<tool_result>Error executing ${tc.name}: ${err}</tool_result>`,
        } as any);
      }
    }

    toolRound++;
  }

  // --- Emit researchComplete + end ---
  session.emit('data', { type: 'researchComplete' });
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
};
