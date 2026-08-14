import * as vscode from "vscode";
import { hasUsageSnapshot, toProviderUsagePayload, type UsageSnapshot } from "./usage/usage";

export const OPENCODE_USAGE_DATA_MIME = "application/vnd.opencode.usage+json";
export const COPILOT_USAGE_DATA_MIME = "usage";
export const OPENCODE_REASONING_DATA_MIME = "application/vnd.opencode.reasoning+json";

export function createUsageDataParts(usage: UsageSnapshot): vscode.LanguageModelDataPart[] {
  if (!hasUsageSnapshot(usage)) {
    return [];
  }

  const payload = toProviderUsagePayload(usage);
  if (!payload) {
    return [];
  }

  const data = new TextEncoder().encode(JSON.stringify(payload));
  return [
    new vscode.LanguageModelDataPart(data, COPILOT_USAGE_DATA_MIME),
    new vscode.LanguageModelDataPart(data, OPENCODE_USAGE_DATA_MIME),
  ];
}

export function isInternalDataPart(part: vscode.LanguageModelDataPart): boolean {
  return part.mimeType === OPENCODE_USAGE_DATA_MIME || part.mimeType === COPILOT_USAGE_DATA_MIME;
}

/**
 * A data part that marks text the model produced as reasoning while the
 * request had thinking OFF. The Go gateway wraps such responses in
 * `reasoning_content`, which the extension surfaces as visible text (gateway
 * bug #37635). The marker rides along in the conversation transcript so the
 * next turn can echo that text back as `reasoning_content` — DeepSeek's
 * thinking-mode validator 400s ("The reasoning_content in the thinking mode
 * must be passed back to the API") when it is missing.
 */
export function createReasoningMarkerPart(reasoning: string): vscode.LanguageModelDataPart {
  const data = new TextEncoder().encode(JSON.stringify({ reasoning }));
  return new vscode.LanguageModelDataPart(data, OPENCODE_REASONING_DATA_MIME);
}

export function isReasoningMarkerPart(part: vscode.LanguageModelDataPart): boolean {
  return part.mimeType === OPENCODE_REASONING_DATA_MIME;
}

/** Read the reasoning text carried by a marker part, if any. */
export function readReasoningMarker(part: vscode.LanguageModelDataPart): string | undefined {
  try {
    const payload = JSON.parse(new TextDecoder().decode(part.data)) as { reasoning?: unknown };
    return typeof payload.reasoning === "string" ? payload.reasoning : undefined;
  } catch {
    return undefined;
  }
}
