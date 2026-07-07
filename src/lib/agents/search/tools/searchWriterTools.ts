/**
 * Search-o1-style tool definitions for the speed-mode writer.
 * Each tool wraps existing infrastructure (SearxNG + cross-encoder + widgets).
 * The writer calls these via the OpenAI tool-call mechanism during its
 * streamText reasoning — it decides which tool to use based on the query.
 *
 * Paper: Search-o1 (Li et al., EMNLP 2025) — agentic search-enhanced reasoning.
 * See docs/BUILD_TRACKER.md Build 3.5 for the full spec.
 */
import z from 'zod';
import { Tool } from '@/lib/models/types';

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    "Search the web for information. Provide up to 5 targeted, SEO-friendly search queries (keywords, not sentences). E.g., for 'who is the CEO of Retina Robotics', use queries like 'Retina Robotics CEO', 'Retina Robotics leadership'. Reformulate based on conversation context if needed.",
  schema: z.object({
    queries: z
      .array(z.string())
      .describe('1-5 SEO-friendly search queries (keywords, not full sentences)'),
  }),
};

export const triggerWeatherTool: Tool = {
  name: 'trigger_weather',
  description:
    'Get current weather and forecast for a location. Use this for weather-related queries instead of web_search.',
  schema: z.object({
    location: z
      .string()
      .describe('City/region name, e.g. "San Francisco, CA" or "London, UK"'),
  }),
};

export const triggerStockTool: Tool = {
  name: 'trigger_stock',
  description:
    'Get current stock price and performance for a ticker symbol. Use this for stock price queries instead of web_search.',
  schema: z.object({
    symbol: z.string().describe('Stock ticker symbol, e.g. "AAPL", "GOOGL"'),
  }),
};

export const triggerCalculationTool: Tool = {
  name: 'trigger_calculation',
  description:
    'Evaluate a mathematical expression. Use this for math/conversion queries instead of web_search.',
  schema: z.object({
    expression: z
      .string()
      .describe('Math expression to evaluate, e.g. "25% of 80" or "sqrt(144)"'),
  }),
};

export const searchWriterTools: Tool[] = [
  webSearchTool,
  triggerWeatherTool,
  triggerStockTool,
  triggerCalculationTool,
];
