/**
 * Executors for the Search-o1-style writer's tools. Each wraps existing
 * infrastructure — SearxNG + cross-encoder + compression for web_search,
 * the widget executors for weather/stock/calculation.
 *
 * See docs/BUILD_TRACKER.md Build 3.5 for the full spec.
 */
import { Chunk, ResearchBlock } from '@/lib/types';
import { searchSearxng } from '@/lib/searxng';
import { executeSearch } from '../researcher/actions/search/baseSearch';
import reranker from '@/lib/reranker';
import SessionManager from '@/lib/session';
import BaseLLM from '@/lib/models/base/llm';
import BaseEmbedding from '@/lib/models/base/embedding';
import { WidgetExecutor } from '../widgets';
import { evaluate as mathEval } from 'mathjs';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';

/**
 * Execute a web_search tool call. Wraps the full search pipeline:
 * SearxNG → batched embeddings → dedup → domain cap → cross-encoder rerank (S1)
 * → snippet compression (S9). Returns numbered results for the writer to cite.
 * Emits searching/search_results subSteps to the session for the UI progress bar.
 */
export const executeWebSearch = async (
  queries: string[],
  llm: BaseLLM<any>,
  embedding: BaseEmbedding<any>,
  session: SessionManager,
  researchBlockId: string,
): Promise<string> => {
  const researchBlock = session.getBlock(researchBlockId) as ResearchBlock | undefined;
  if (!researchBlock) throw new Error('Failed to retrieve research block');

  // Use the existing executeSearch which handles SearxNG + embeddings + dedup
  // + domain cap + rerank + compression (speed path).
  const results = await executeSearch({
    queries,
    mode: 'speed',
    researchBlock,
    session,
    llm,
    embedding,
  });

  if (results.length === 0) {
    return '<search_results>No results found. Try answering from your own knowledge.</search_results>';
  }

  // S13 — cap to top 8 results after rerank. The cross-encoder already
  // ranked them; the top 8 are the most relevant. Fewer results → less
  // context → faster answer generation. The writer doesn't need all 20
  // to write a good answer.
  const cappedResults = results.slice(0, 8);

  // Format as numbered results for the writer to cite.
  const formatted = cappedResults
    .map(
      (r, index) =>
        `<result index=${index + 1} title=${r.metadata.title}>${r.content}</result>`,
    )
    .join('\n');

  // Emit a source block so the UI shows the sources.
  session.emitBlock({
    id: crypto.randomUUID(),
    type: 'source',
    data: cappedResults,
  });

  return `<search_results note="These are the search results. Cite them using [number] notation.">\n${formatted}\n</search_results>`;
};

/**
 * Execute a trigger_weather tool call. Wraps the weather widget executor.
 * Emits a widget block to the session for the UI.
 */
export const executeWeatherWidget = async (
  location: string,
  llm: BaseLLM<any>,
  chatHistory: any[],
  followUp: string,
  session: SessionManager,
): Promise<string> => {
  // The weather widget expects a WidgetInput with classification, chatHistory,
  // followUp, and llm. We construct a synthetic classification that triggers
  // the weather widget.
  const syntheticClassification = {
    classification: {
      skipSearch: false,
      personalSearch: false,
      academicSearch: false,
      discussionSearch: false,
      showWeatherWidget: true,
      showStockWidget: false,
      showCalculationWidget: false,
    },
    standaloneFollowUp: followUp,
  };

  const widgetInput = {
    classification: syntheticClassification,
    chatHistory,
    followUp,
    llm,
  };

  // Find the weather widget and execute it directly.
  const weatherWidget = WidgetExecutor.getWidget('weatherWidget');
  if (!weatherWidget) {
    return '<widget_result>Weather widget not available.</widget_result>';
  }

  try {
    const output = await weatherWidget.execute(widgetInput);
    if (output) {
      session.emitBlock({
        id: crypto.randomUUID(),
        type: 'widget',
        data: { widgetType: output.type, params: output.data },
      });
      return `<widget_result note="Weather data (already shown to user as a widget). Use this to answer but do NOT cite as a source.">\n${output.llmContext}\n</widget_result>`;
    }
    return '<widget_result>Could not determine location for weather.</widget_result>';
  } catch (err) {
    return `<widget_result>Failed to fetch weather: ${err}</widget_result>`;
  }
};

/**
 * Execute a trigger_stock tool call. Wraps the stock widget executor.
 */
export const executeStockWidget = async (
  symbol: string,
  llm: BaseLLM<any>,
  chatHistory: any[],
  followUp: string,
  session: SessionManager,
): Promise<string> => {
  const syntheticClassification = {
    classification: {
      skipSearch: false,
      personalSearch: false,
      academicSearch: false,
      discussionSearch: false,
      showWeatherWidget: false,
      showStockWidget: true,
      showCalculationWidget: false,
    },
    standaloneFollowUp: followUp,
  };

  const widgetInput = {
    classification: syntheticClassification,
    chatHistory,
    followUp,
    llm,
  };

  const stockWidget = WidgetExecutor.getWidget('stockWidget');
  if (!stockWidget) {
    return '<widget_result>Stock widget not available.</widget_result>';
  }

  try {
    const output = await stockWidget.execute(widgetInput);
    if (output) {
      session.emitBlock({
        id: crypto.randomUUID(),
        type: 'widget',
        data: { widgetType: output.type, params: output.data },
      });
      return `<widget_result note="Stock data (already shown to user as a widget). Use this to answer but do NOT cite as a source.">\n${output.llmContext}\n</widget_result>`;
    }
    return '<widget_result>Could not determine stock symbol.</widget_result>';
  } catch (err) {
    return `<widget_result>Failed to fetch stock data: ${err}</widget_result>`;
  }
};

/**
 * Execute a trigger_calculation tool call. Uses mathjs directly (no LLM needed).
 */
export const executeCalculationWidget = async (
  expression: string,
  session: SessionManager,
): Promise<string> => {
  try {
    const result = mathEval(expression);
    const resultStr = String(result);

    session.emitBlock({
      id: crypto.randomUUID(),
      type: 'widget',
      data: { widgetType: 'calculation', params: { expression, result: resultStr } },
    });

    return `<widget_result note="Calculation result (already shown to user as a widget). Use this to answer.">\n${expression} = ${resultStr}\n</widget_result>`;
  } catch (err) {
    return `<widget_result>Failed to evaluate expression: ${err}</widget_result>`;
  }
};
