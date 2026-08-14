/**
 * Shared helpers for the request builders.
 *
 * CONTRACT: pure functions only — no `vscode` import, no side effects.
 */
import type { ApiMessage } from "./types";

/** Whether any message in the conversation carries an image part. */
export function messagesHaveImages(messages: readonly ApiMessage[]): boolean {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
}
