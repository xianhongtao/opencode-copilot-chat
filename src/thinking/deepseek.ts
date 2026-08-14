/**
 * DeepSeek thinking strategy.
 *
 * DeepSeek V4 is a native reasoning model: `reasoning_content` is always
 * genuine chain-of-thought, so it must always go to the thinking panel —
 * never be surfaced as visible text, regardless of the thinking effort.
 */
import { BaseThinkingProvider } from "./base";
import { schemaFromReasoningOptions, effortProperty, type ThinkingSchema } from "./schema";
import type { ResolvedModelMetadata } from "../models/metadata";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";

const DEEPSEEK_EFFORTS = ["off", "low", "medium", "high", "max"] as const;

export class DeepSeekThinking extends BaseThinkingProvider {
  readonly family: ThinkingFamily = "deepseek";

  constructor(readonly modelId: string) {
    super();
  }

  schema(metadata?: ResolvedModelMetadata): ThinkingSchema | undefined {
    return (
      schemaFromReasoningOptions(metadata) ?? {
        properties: {
          reasoningEffort: effortProperty({
            enum: DEEPSEEK_EFFORTS,
            labels: ["Off", "Low", "Medium", "High", "Max"],
            descriptions: ["Fastest responses", "Minimal reasoning", "Balanced reasoning", "More reasoning", "Maximum reasoning"],
            default: "off",
          }),
        },
      }
    );
  }

  applyOverride(settings: ThinkingSettings, override: Record<string, unknown>): ThinkingSettings {
    return this.applyEffort(settings, override, "deepseek", DEEPSEEK_EFFORTS);
  }

  buildPayload(thinking: ThinkingSettings, _opts?: BuildThinkingPayloadOptions): Record<string, unknown> {
    if (thinking.deepseek === "off") {
      return {};
    }
    return { reasoning_effort: thinking.deepseek };
  }

  requestsThinking(thinking: ThinkingSettings): boolean {
    return thinking.deepseek !== "off";
  }

  // treatReasoningAsContent: DeepSeek always emits genuine CoT → never content.
}
