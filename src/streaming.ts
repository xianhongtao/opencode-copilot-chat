/**
 * Barrel — the streaming module was split into `src/transports/` (one entry
 * per transport + shared engine/extractors/SSE) and `src/core/transport.ts`
 * (the transport contract types). This module re-exports the historical
 * public API so existing importers (extension.ts, goUsageTracker.ts) keep
 * working during the refactor.
 */
export { streamChatCompletions } from "./transports/chatCompletions";
export { streamAnthropicMessages } from "./transports/anthropic";
export { streamResponsesApi } from "./transports/responses";
export { streamGoogleGenerateContent } from "./transports/google";
export { type StreamRequestOptions, type TransportRequestSummary } from "./core/transport";
