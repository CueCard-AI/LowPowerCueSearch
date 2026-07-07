import OpenAILLM from '../openai/openaiLLM';
import { Message } from '@/lib/types';
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources/index.mjs';

/**
 * Gemini (via the OpenAI-compatible endpoint) requires that when an assistant
 * message containing tool_calls is sent back to the model, each tool_call
 * carries the `thought_signature` that was returned on the streaming delta.
 * Without it the API returns 400:
 *   "Function call is missing a thought_signature in functionCall parts."
 *
 * The signature is captured during streamText and stored on the ToolCall as
 * `thoughtSignature`. Here we re-attach it under
 * `extra_content.google.thought_signature` (the shape Gemini expects).
 */
class GeminiLLM extends OpenAILLM {
  convertToOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.id,
          content: msg.content,
        } as ChatCompletionToolMessageParam;
      } else if (msg.role === 'assistant') {
        const toolCalls = msg.tool_calls;

        if (toolCalls && toolCalls.length > 0) {
          const mappedToolCalls = toolCalls.map((tc) => {
            const base: any = {
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            };
            if (tc.thoughtSignature) {
              base.extra_content = {
                google: { thought_signature: tc.thoughtSignature },
              };
            }
            return base;
          });

          return {
            role: 'assistant',
            content: msg.content,
            tool_calls: mappedToolCalls,
          } as ChatCompletionAssistantMessageParam;
        }

        return {
          role: 'assistant',
          content: msg.content,
        } as ChatCompletionAssistantMessageParam;
      }

      return msg as ChatCompletionMessageParam;
    });
  }
}

export default GeminiLLM;
