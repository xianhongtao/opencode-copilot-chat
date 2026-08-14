import type { StreamRequestOptions } from "../core/transport";
import { createThinkTagFilter } from "./thinkTags";
import { createReasoningDebugger, streamOpenCodeResponse } from "./engine";
import { AnthropicResponseExtractor } from "./extractors";
import { extractAnthropicParts } from "./extract";

/** Anthropic Messages API transport (Claude-family / MiniMax m2.x / Qwen 3.x-plus). */
export async function streamAnthropicMessages(options: StreamRequestOptions): Promise<void> {
  const thinkFilter = createThinkTagFilter(options.stripThinkTags, options.modelId);
  const extractor = new AnthropicResponseExtractor(
    options.onReasoningContent,
    createReasoningDebugger(options.output, options.debugReasoning),
    thinkFilter,
    options.progress,
    options.requestHeaders["x-opencode-request"],
  );

  await streamOpenCodeResponse({
    ...options,
    extractStreamParts: (data) => extractor.extractStreamParts(data),
    extractFullParts: extractAnthropicParts,
  });

  extractor.flushReasoningFallback(options.progress, options.requestHeaders["x-opencode-request"]);
  options.output?.appendLine(
    `[stream-summary model=${options.modelId}] textChars=${String(extractor.emittedText)} toolCalls=${String(extractor.emittedTools)} reasoningChars=${String(extractor.reasoningChars)}`,
  );
}
