import type { ModelCost } from "../models/metadata";

/** Callback to resolve live model cost from the models.dev metadata cache. */
export type CostResolver = (modelId: string) => ModelCost | undefined;

// ─── Go model pricing ($/1M tokens) — bundled snapshot fallback ────────────
// This table is a static snapshot kept as a last resort. The primary source
// is the live models.dev metadata cache injected via CostResolver.

const GO_MODEL_PRICING: Record<string, ModelCost | undefined> = {
  "glm-5.1": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "glm-5": { input: 1.0, output: 3.2, cache_read: 0.2 },
  "kimi-k2.6": { input: 0.95, output: 4.0, cache_read: 0.16 },
  "kimi-k2.5": { input: 0.6, output: 3.0, cache_read: 0.1 },
  "minimax-m3": { input: 0.6, output: 2.4, cache_read: 0.12 },
  "minimax-m2.7": { input: 0.3, output: 1.2, cache_read: 0.06 },
  "minimax-m2.5": { input: 0.3, output: 1.2, cache_read: 0.06 },
  "mimo-v2.5": { input: 0.14, output: 0.28, cache_read: 0.003 },
  "mimo-v2.5-pro": { input: 1.74, output: 3.48, cache_read: 0.015 },
  "mimo-v2-omni": { input: 0.14, output: 0.28, cache_read: 0.003 },
  "mimo-v2-pro": { input: 1.74, output: 3.48, cache_read: 0.015 },
  "qwen3.7-max": { input: 2.5, output: 7.5, cache_read: 0.5 },
  "qwen3.7-plus": { input: 0.4, output: 1.6, cache_read: 0.04 },
  "qwen3.6-plus": { input: 0.5, output: 3.0, cache_read: 0.05 },
  "qwen3.5-plus": { input: 0.2, output: 1.2, cache_read: 0.02 },
  "deepseek-v4-pro": { input: 1.74, output: 3.48, cache_read: 0.015 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cache_read: 0.003 },
  "hy3-preview": { input: 0.5, output: 1.5, cache_read: 0.05 },
};

// ─── Cost calculation ────────────────────────────────────────────────────────

/** Priority: caller-provided cost > live models.dev snapshot > bundled table */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  externalCost?: ModelCost,
  liveCostResolver?: CostResolver,
): number {
  // Priority: caller-provided cost > live models.dev snapshot > bundled table
  const pricing = externalCost ?? liveCostResolver?.(modelId) ?? GO_MODEL_PRICING[modelId];
  if (!pricing) return 0;

  const billablePrompt = Math.max(0, promptTokens - cachedTokens);
  return (
    (billablePrompt * pricing.input) / 1_000_000 +
    (completionTokens * pricing.output) / 1_000_000 +
    (cachedTokens * (pricing.cache_read ?? pricing.input * 0.1)) / 1_000_000
  );
}
