import { zodResponseFormat } from 'openai/helpers/zod';
import { repairJson } from '@toolsycc/json-repair';
import { parse } from 'partial-json';
import { GenerateObjectInput, GenerateTextInput, StreamTextOutput } from '../../types';
import OpenAILLM from '../openai/openaiLLM';
import z from 'zod';

class GlmLLM extends OpenAILLM {
  /**
   * Structured-output generation with GLM-specific handling:
   * - `thinking: { type: 'disabled' }` — classifier/widgets/KB don't need to
   *   reason; keeps them fast.
   * - `chat.completions.create` (NOT `.parse()`) — GLM wraps JSON in ```json
   *   fences; `.parse()` strict-parses internally before repairJson can run.
   * - `repairJson({ extractJson: true })` — strips fences + repairs malformed
   *   JSON.
   * - `safeParse` — if the schema validates, return the typed result. If it
   *   doesn't (z.ai doesn't enforce `response_format` as strictly as OpenAI),
   *   and `lenient: true` was passed, return the raw parsed object so the
   *   caller can do defensive mapping. Without `lenient`, throw (strict mode
   *   for callers that need validated data — classifier, widgets, etc.).
   */
  async generateObject<T>(
    input: GenerateObjectInput & { lenient?: boolean },
  ): Promise<T> {
    const response = await this.openAIClient.chat.completions.create({
      messages: this.convertToOpenAIMessages(input.messages),
      model: this.config.model,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ?? this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      response_format: zodResponseFormat(input.schema, 'object'),
      thinking: { type: 'disabled' },
    } as any);

    if (response.choices && response.choices.length > 0) {
      const rawContent = response.choices[0].message.content ?? '';
      try {
        const repaired = repairJson(rawContent, {
          extractJson: true,
        }) as string;
        const parsed = JSON.parse(repaired);

        const result = input.schema.safeParse(parsed);
        if (result.success) {
          return result.data as T;
        }

        if (input.lenient) {
          console.log(
            'generateObject: schema validation failed, returning raw (lenient). Keys:',
            Object.keys(parsed),
            'Preview:',
            JSON.stringify(parsed).slice(0, 300),
          );
          return parsed as T;
        }

        throw new Error(
          `Error parsing response from GLM: schema validation failed — ${JSON.stringify(result.error.issues).slice(0, 200)}`,
        );
      } catch (err) {
        throw new Error(`Error parsing response from GLM: ${err}`);
      }
    }

    throw new Error('No response from GLM');
  }

  /**
   * Streaming text generation with GLM-specific thinking control.
   *
   * When `input.disableThinking` is true, injects `thinking: { type: 'disabled' }`
   * into the request — this prevents GLM from spending 30-40s "thinking" before
   * generating the answer. Used by the Search-o1 writer's second streamText call
   * (answer generation) where the search results are already available and no
   * reasoning is needed — just write the answer. The first streamText call
   * (reasoning + tool selection) keeps thinking enabled for the UI reasoning trace.
   *
   * When `disableThinking` is false/absent, the base OpenAILLM.streamText runs
   * (thinking enabled — for the researcher loop, the balanced/quality writer,
   * and the Search-o1 writer's first call).
   */
  async *streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput> {
    if (!input.disableThinking) {
      // No thinking override — delegate to the base class (thinking enabled).
      yield* super.streamText(input);
      return;
    }

    // Thinking disabled — replicate the base streamText but inject the
    // thinking parameter. This is the same as OpenAILLM.streamText but with
    // `thinking: { type: 'disabled' }` added to the request.
    const openaiTools: any[] = [];

    input.tools?.forEach((tool) => {
      openaiTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: z.toJSONSchema(tool.schema),
        },
      });
    });

    const stream: any = await this.openAIClient.chat.completions.create({
      model: this.config.model,
      messages: this.convertToOpenAIMessages(input.messages),
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature:
        input.options?.temperature ?? this.config.options?.temperature ?? 1.0,
      top_p: input.options?.topP ?? this.config.options?.topP,
      max_completion_tokens:
        input.options?.maxTokens ?? this.config.options?.maxTokens,
      stop: input.options?.stopSequences ?? this.config.options?.stopSequences,
      frequency_penalty:
        input.options?.frequencyPenalty ??
        this.config.options?.frequencyPenalty,
      presence_penalty:
        input.options?.presencePenalty ?? this.config.options?.presencePenalty,
      stream: true,
      thinking: { type: 'disabled' },
    } as any);

    let recievedToolCalls: { name: string; id: string; arguments: string }[] =
      [];

    for await (const chunk of stream) {
      if (chunk.choices && chunk.choices.length > 0) {
        const toolCalls = chunk.choices[0].delta.tool_calls;
        const reasoningContent = (
          chunk.choices[0].delta as any
        )?.reasoning_content as string | undefined;
        yield {
          contentChunk: chunk.choices[0].delta.content || '',
          reasoningChunk: reasoningContent || '',
          toolCallChunk:
            toolCalls?.map((tc: any) => {
              if (!recievedToolCalls[tc.index]) {
                const call = {
                  name: tc.function?.name!,
                  id: tc.id!,
                  arguments: tc.function?.arguments || '',
                };
                recievedToolCalls.push(call);
                return { ...call, arguments: parse(call.arguments || '{}') };
              } else {
                const existingCall = recievedToolCalls[tc.index];
                existingCall.arguments += tc.function?.arguments || '';
                return {
                  ...existingCall,
                  arguments: parse(existingCall.arguments),
                };
              }
            }) || [],
          done: chunk.choices[0].finish_reason !== null,
          additionalInfo: {
            finishReason: chunk.choices[0].finish_reason,
          },
        };
      }
    }
  }
}

export default GlmLLM;
