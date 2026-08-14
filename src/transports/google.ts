import type { StreamRequestOptions } from "../core/transport";
import { normalizeGoogleFullResponse, normalizeGoogleStreamEvent } from "../routing";
import { createThinkTagFilter } from "./thinkTags";
import { createReasoningDebugger, streamOpenCodeResponse } from "./engine";
import { OpenAiResponseExtractor } from "./extractors";
import { extractChatCompletionParts } from "./extract";

/** Google Generative Language API transport (Gemini via Zen). */
export async function streamGoogleGenerateContent(options: StreamRequestOptions): Promise<void> {
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
    url: `${options.url}:streamGenerateContent?alt=sse`,
    extractStreamParts: (data) => extractor.extractStreamParts(normalizeGoogleStreamEvent(data)),
    extractFullParts: (data) => extractChatCompletionParts(normalizeGoogleFullResponse(data)),
  });

  extractor.flushRemainingToolCalls(options.progress, options.requestHeaders["x-opencode-request"]);
  extractor.flushReasoningFallback(options.progress, options.requestHeaders["x-opencode-request"]);
  options.output?.appendLine(
    `[stream-summary model=${options.modelId}] textChars=${String(extractor.emittedText)} toolCalls=${String(extractor.emittedTools)} reasoningChars=${String(extractor.reasoningChars)}`,
  );
}
