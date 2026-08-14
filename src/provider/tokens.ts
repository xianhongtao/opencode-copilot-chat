import * as vscode from "vscode";
import {
  MESSAGE_NAME_TOKEN_OVERHEAD,
  MESSAGE_TOKEN_OVERHEAD,
  TOOL_CALL_TOKEN_OVERHEAD,
  TOOL_RESULT_TOKEN_OVERHEAD,
  IMAGE_TOKEN_ESTIMATE,
} from "../config";
import { estimateTokenCount } from "../tokenEstimate";
import { isInternalDataPart } from "../chatParts";
import { isRecord } from "../utils";

/** Extract the visible text of a chat message (all parts joined). */
export function messageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content.map(partToText).filter(Boolean).join("\n");
}

/** Token estimate for a whole chat message (role/name overhead + content). */
export function estimateChatMessageTokenCount(message: vscode.LanguageModelChatRequestMessage): number {
  const role = typeof message.role === "string" ? message.role : String(message.role);
  const name = typeof message.name === "string" ? message.name : "";
  const contentTokens = message.content.map(partToTokenCount).reduce((total, count) => total + count, 0);

  return (
    MESSAGE_TOKEN_OVERHEAD + estimateTokenCount(role) + (name ? MESSAGE_NAME_TOKEN_OVERHEAD + estimateTokenCount(name) : 0) + contentTokens
  );
}

/** Token estimate for a single response part. */
export function partToTokenCount(part: unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return estimateTokenCount(part.value);
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    const contentTokens = part.content.map(partToTokenCount).reduce((total, count) => total + count, 0);
    return TOOL_RESULT_TOKEN_OVERHEAD + estimateTokenCount(part.callId) + contentTokens;
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return (
      TOOL_CALL_TOKEN_OVERHEAD + estimateTokenCount(part.callId) + estimateTokenCount(part.name) + estimateStructuredTokenCount(part.input)
    );
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    return isInternalDataPart(part) ? 0 : estimateDataPartTokenCount(part);
  }

  if (typeof part === "string") {
    return estimateTokenCount(part);
  }

  if (isRecord(part)) {
    return estimateStructuredTokenCount(part);
  }

  return 0;
}

/** Token estimate for an arbitrary structured value (JSON-serialized). */
export function estimateStructuredTokenCount(value: unknown): number {
  try {
    return estimateTokenCount(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/** Token estimate for a data part (images use a fixed per-image estimate). */
export function estimateDataPartTokenCount(part: vscode.LanguageModelDataPart): number {
  if (part.mimeType.startsWith("image/")) {
    return IMAGE_TOKEN_ESTIMATE;
  }

  if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
    return estimateTokenCount(new TextDecoder().decode(part.data));
  }

  return Math.max(1, Math.ceil(part.data.byteLength / 4));
}

/** Plain-text serialization of a response part (internal data parts → ""). */
export function partToText(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    return part.content.map(partToText).filter(Boolean).join("\n");
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return `[Tool call: ${part.name} ${JSON.stringify(part.input)}]`;
  }

  if (part instanceof vscode.LanguageModelDataPart && isInternalDataPart(part)) {
    return "";
  }

  if (typeof part === "string") {
    return part;
  }

  return "";
}
