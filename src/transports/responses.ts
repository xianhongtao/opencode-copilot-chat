import type { StreamRequestOptions } from "../core/transport";
import { normalizeResponsesFullResponse, normalizeResponsesStreamEvent } from "../core/routing";
import { createThinkTagFilter } from "./thinkTags";
import { createReasoningDebugger, streamOpenCodeResponse } from "./engine";
import { OpenAiResponseExtractor } from "./extractors";
import { extractChatCompletionParts } from "./extract";

/** OpenAI Responses API transport (GPT-family models). */
export async function streamResponsesApi(options: StreamRequestOptions): Promise<void> {
  const thinkFilter = createThinkTagFilter(options.stripThinkTags, options.modelId);
  const extractor = new OpenAiResponseExtractor(
    options.onReasoningContent,
    createReasoningDebugger(options.output, options.debugReasoning),
    thinkFilter,
    options.progress,
    options.requestHeaders["x-opencode-request"],
  );

  await streamOpenCodeResponse({
    ...options,
    extractStreamParts: (data) => extractor.extractStreamParts(normalizeResponsesStreamEvent(data)),
    extractFullParts: (data) => extractChatCompletionParts(normalizeResponsesFullResponse(data)),
  });

  extractor.flushRemainingToolCalls(options.progress, options.requestHeaders["x-opencode-request"]);
  extractor.flushReasoningFallback(options.progress, options.requestHeaders["x-opencode-request"]);
  options.output?.appendLine(
    `[stream-summary model=${options.modelId}] textChars=${String(extractor.emittedText)} toolCalls=${String(extractor.emittedTools)} reasoningChars=${String(extractor.reasoningChars)}`,
  );
}
