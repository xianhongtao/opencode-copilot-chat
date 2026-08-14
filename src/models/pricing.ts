import { isFreeModel, type ResolvedModelMetadata } from "../models/metadata";
import { GO_VENDOR } from "../providerTypes";
import type { ProviderDefinition } from "../provider/definitions";

/**
 * Returns pricing fields for VS Code's language model pricing proposal
 * (`vscode.proposed.languageModelPricing`).
 *
 * Cost data from models.dev is in USD; VS Code expects AI Credits
 * (1 credit = $0.01 USD). We convert by multiplying by 100 so the
 * pricing table shows values comparable to Copilot's own models.
 *
 * The `pricing` string matches the format used by the Copilot extension's
 * `formatPricingLabel` (`In: $X · Out: $Y /1M tokens`) so the picker hover
 * reads consistently across providers.
 */
export function modelPricingFields(
  modelId: string,
  vendor: ProviderDefinition["vendor"],
  metadata: ResolvedModelMetadata,
): {
  pricing?: string;
  priceCategory?: string;
  inputCost?: number;
  outputCost?: number;
  cacheCost?: number;
} {
  const free = isFreeModel(modelId);

  if (free) {
    return { pricing: "Free", priceCategory: "low" };
  }

  const cost = metadata.cost;
  if (cost) {
    const inputCredits = Math.round(cost.input * 100);
    const outputCredits = Math.round(cost.output * 100);
    const cacheCredits = cost.cache_read !== undefined ? Math.round(cost.cache_read * 100) : undefined;

    const fmt = (v: number) => `$${v.toFixed(v < 0.1 ? 2 : 1)}`;
    return {
      pricing: `In: ${fmt(cost.input)} · Out: ${fmt(cost.output)} /1M tokens`,
      priceCategory: costCategory(cost),
      inputCost: inputCredits,
      outputCost: outputCredits,
      ...(cacheCredits !== undefined ? { cacheCost: cacheCredits } : {}),
    };
  }

  // No models.dev cost data: fall back to a neutral label so the picker
  // shows something instead of pretending we know the price.
  return {
    pricing: `${vendor === GO_VENDOR ? "Go" : "Zen"} subscription`,
  };
}

/**
 * Maps per-million-token USD cost to the four-tier `priceCategory` labels
 * (`low` / `medium` / `high` / `very_high`) that VS Code's language model
 * picker renders as a visual cost indicator.
 *
 * VS Code's own `getPriceCategoryLabel` (chatModelPicker.ts) just translates
 * the string but does not assign thresholds - the Copilot extension uses
 * billing multipliers and a weighted 3:1 input:output blend to mirror the
 * user's billing mix. We follow the same 3:1 weighting here so our category
 * lines up with what the user sees for the official Copilot models:
 *
 * - low       : qwen3.5-plus, deepseek-v4-flash-free, mimo-v2-flash-free
 * - medium    : kimi-k2.6, gemini-3-flash, claude-haiku-4-5, gpt-5,
 *               gpt-5.2, gpt-5.4, claude-sonnet-4-6
 * - high      : claude-opus-4-5, claude-opus-4-7, gpt-5.5
 * - very_high : gpt-5.4-pro, gpt-5.5-pro, claude-opus-4-1
 *
 * Free models (`cost.input == 0 && cost.output == 0`) are reported as `low`
 * because that is the bucket VS Code uses for "Free" entries in the picker.
 */
export function costCategory(cost: { input: number; output: number }): string {
  if (cost.input <= 0 && cost.output <= 0) {
    return "low";
  }
  // Mirrors Copilot's 3:1 input:output blend (input tokens are usually the
  // larger share of a request, so they get more weight than raw sum).
  const weighted = cost.input * 3 + cost.output;
  if (weighted <= 2) return "low";
  if (weighted <= 25) return "medium";
  if (weighted <= 50) return "high";
  return "very_high";
}
