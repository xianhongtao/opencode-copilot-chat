/**
 * Provider request-body builders — public barrel.
 *
 * Each OpenCode endpoint family owns its own module:
 *   - `./openai.ts`    — chat-completions + Responses API
 *   - `./anthropic.ts` — Anthropic Messages API
 *   - `./google.ts`    — Google generateContent
 * Shared helpers live in `./schema.ts` (tool-schema sanitize) and
 * `./shared.ts` (messagesHaveImages). This barrel keeps the legacy
 * `import { ... } from "./request/builders"` call sites stable.
 */
export { buildChatCompletionsRequestBody, buildResponsesRequestBody } from "./openai";
export { buildAnthropicMessagesRequestBody, buildAnthropicMessages } from "./anthropic";
export { buildGoogleGenerateContentBody } from "./google";
export { messagesHaveImages } from "./shared";
export { sanitizeToolSchema } from "./schema";
export type { ApiMessage, ApiSettings, AnthropicRequestMessage, AnthropicContentBlock } from "./types";
