import type { BaseModelLimits } from "./metadata";
import { UI_OUTPUT_TOKEN_RESERVE, MIN_TOKEN_ESTIMATE_SAFETY_MARGIN, TOKEN_ESTIMATE_SAFETY_RATIO } from "../config";

export interface ModelLimits extends BaseModelLimits {
  advertisedContextWindow: number;
  advertisedMaxInputTokens: number;
  advertisedMaxOutputTokens: number;
}

export interface ModelLimitOverrides {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  contextSize?: number;
  promptTokens?: number;
}

/**
 * Resolve the limits advertised to VS Code and the output budget sent upstream.
 * When the prompt size is known, reserve proportional headroom for differences
 * between the local heuristic and each provider's tokenizer. This matters most
 * for large prompts with tool schemas, where a fixed margin is not meaningful.
 */
export function calculateModelLimits(metadata: BaseModelLimits, overrides: ModelLimitOverrides = {}): ModelLimits {
  const baseContextWindow = positiveOverride(overrides.maxInputTokens) ?? metadata.contextWindow;
  const contextSize = positiveOverride(overrides.contextSize);
  const contextWindow = contextSize === undefined ? baseContextWindow : Math.min(baseContextWindow, contextSize);
  const configuredMaxOutputTokens = positiveOverride(overrides.maxOutputTokens) ?? metadata.maxOutputTokens;

  const promptEstimate = overrides.promptTokens ?? Math.floor(contextWindow * 0.8);
  const safetyMargin =
    overrides.promptTokens === undefined
      ? MIN_TOKEN_ESTIMATE_SAFETY_MARGIN
      : Math.max(MIN_TOKEN_ESTIMATE_SAFETY_MARGIN, Math.ceil(promptEstimate * TOKEN_ESTIMATE_SAFETY_RATIO));
  const promptReserve = promptEstimate + safetyMargin;
  const remainingContext = Math.max(1, contextWindow - promptReserve);
  const maxOutputTokens = Math.max(1, Math.min(configuredMaxOutputTokens, remainingContext));

  const advertisedContextWindow = contextWindow;
  const advertisedMaxOutputTokens = Math.max(1, Math.min(maxOutputTokens, UI_OUTPUT_TOKEN_RESERVE));

  return {
    contextWindow,
    maxOutputTokens,
    advertisedContextWindow,
    advertisedMaxInputTokens: Math.max(1, advertisedContextWindow - advertisedMaxOutputTokens),
    advertisedMaxOutputTokens,
  };
}

function positiveOverride(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
