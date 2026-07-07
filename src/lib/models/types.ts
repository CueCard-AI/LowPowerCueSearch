import z from 'zod';
import { Message } from '../types';

type Model = {
  name: string;
  key: string;
};

type ModelList = {
  embedding: Model[];
  chat: Model[];
};

type ProviderMetadata = {
  name: string;
  key: string;
};

type MinimalProvider = {
  id: string;
  name: string;
  chatModels: Model[];
  embeddingModels: Model[];
};

type ModelWithProvider = {
  key: string;
  providerId: string;
};

type GenerateOptions = {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
};

type Tool = {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
};

type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, any>;
  // Gemini-specific: required to round-trip tool calls back to the model
  // (Gemini's OpenAI-compat endpoint rejects assistant tool_calls without the
  // thought_signature that was returned on the streaming delta). See
  // https://ai.google.dev/gemini-api/docs/thought-signatures
  thoughtSignature?: string;
};

type GenerateTextInput = {
  messages: Message[];
  tools?: Tool[];
  options?: GenerateOptions;
  disableThinking?: boolean;
};

type GenerateTextOutput = {
  content: string;
  toolCalls: ToolCall[];
  additionalInfo?: Record<string, any>;
};

type StreamTextOutput = {
  contentChunk: string;
  toolCallChunk: ToolCall[];
  reasoningChunk?: string;
  additionalInfo?: Record<string, any>;
  done?: boolean;
};

type GenerateObjectInput = {
  schema: z.ZodTypeAny;
  messages: Message[];
  options?: GenerateOptions;
};

type GenerateObjectOutput<T> = {
  object: T;
  additionalInfo?: Record<string, any>;
};

type StreamObjectOutput<T> = {
  objectChunk: Partial<T>;
  additionalInfo?: Record<string, any>;
  done?: boolean;
};

export type {
  Model,
  ModelList,
  ProviderMetadata,
  MinimalProvider,
  ModelWithProvider,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  StreamTextOutput,
  GenerateObjectInput,
  GenerateObjectOutput,
  StreamObjectOutput,
  Tool,
  ToolCall,
};
