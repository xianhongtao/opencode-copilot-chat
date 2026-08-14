/**
 * Mimo (Xiaomi) thinking strategy.
 *
 * Uses `reasoning_effort` + a `budget_tokens` cap per effort level to prevent
 * the infinite thinking loops observed in mimo-v2.5 / mimo-v2.5-pro (issue #36).
 *
 * DISPLAY: Mimo is a native reasoning model — `reasoning_content` is always
 * genuine chain-of-thought and goes to the thinking panel, never surfaced as
 * visible text. (The old #37635 gateway mislabel — wrapping answers in
 * `reasoning_content` — is a gateway bug, not worked around here.)
 */
import { BaseThinkingProvider } from "./base";
import { schemaFromReasoningOptions, effortProperty, type ThinkingSchema } from "./schema";
import type { ResolvedModelMetadata } from "../metadata";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";

const MIMO_EFFORTS = ["off", "low", "medium", "high"] as const;

/** Effort → reasoning-token budget cap (conservative; see buildPayload). */
const MIMO_BUDGET_MAP: Record<string, number | undefined> = {
  low: 8192,
  medium: 16384,
  high: 32768,
};

export class MimoThinking extends BaseThinkingProvider {
  readonly family: ThinkingFamily = "mimo";

  constructor(readonly modelId: string) {
    super();
  }

  schema(metadata?: ResolvedModelMetadata): ThinkingSchema | undefined {
    return (
      schemaFromReasoningOptions(metadata) ?? {
        properties: {
          reasoningEffort: effortProperty({
            enum: MIMO_EFFORTS,
            labels: ["Off", "Low", "Medium", "High"],
            descriptions: ["Fastest responses", "Minimal reasoning", "Balanced reasoning", "Enable reasoning"],
            default: "off",
          }),
        },
      }
    );
  }

  applyOverride(settings: ThinkingSettings, override: Record<string, unknown>): ThinkingSettings {
    return this.applyEffort(settings, override, "mimo", MIMO_EFFORTS);
  }

  buildPayload(thinking: ThinkingSettings, _opts?: BuildThinkingPayloadOptions): Record<string, unknown> {
    if (thinking.mimo === "off") {
      return {};
    }
    const mimoBudget = MIMO_BUDGET_MAP[thinking.mimo];
    return {
      reasoning_effort: thinking.mimo,
      ...(mimoBudget !== undefined ? { budget_tokens: mimoBudget } : {}),
    };
  }

  requestsThinking(thinking: ThinkingSettings): boolean {
    return thinking.mimo !== "off";
  }

  // reasoning_content is always genuine CoT → never surfaced as visible text
  // (the #37635 gateway mislabel is the gateway's bug, not worked around).
  treatReasoningAsContent(_url: string, _thinking: ThinkingSettings): boolean {
    return false;
  }
}
