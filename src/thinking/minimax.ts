/**
 * MiniMax thinking strategy.
 *
 * The OpenCode gateway only supports on/off for this family (`reasoning_effort`
 * is silently ignored). m2.* models route through the messages endpoint with
 * standard Anthropic enabled; m3 uses adaptive.
 */
import { BaseThinkingProvider } from "./base";
import { schemaFromReasoningOptions, effortProperty, type ThinkingSchema } from "./schema";
import type { ResolvedModelMetadata } from "../metadata";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";

const MINIMAX_MODES = ["off", "on"] as const;

export class MiniMaxThinking extends BaseThinkingProvider {
  readonly family: ThinkingFamily = "minimax";

  constructor(readonly modelId: string) {
    super();
  }

  schema(metadata?: ResolvedModelMetadata): ThinkingSchema | undefined {
    return (
      schemaFromReasoningOptions(metadata) ?? {
        properties: {
          reasoningEffort: effortProperty({
            enum: MINIMAX_MODES,
            labels: ["Off", "On"],
            descriptions: ["Fastest responses", "Enable thinking"],
            default: "off",
          }),
        },
      }
    );
  }

  applyOverride(settings: ThinkingSettings, override: Record<string, unknown>): ThinkingSettings {
    return this.applyEffort(settings, override, "minimax", MINIMAX_MODES);
  }

  buildPayload(thinking: ThinkingSettings, _opts?: BuildThinkingPayloadOptions): Record<string, unknown> {
    if (thinking.minimax === "off") {
      return {};
    }
    if (/^minimax-m2\./i.test(this.modelId)) {
      return { thinking: { type: "enabled" } };
    }
    return { thinking: { type: "adaptive" } };
  }

  requestsThinking(thinking: ThinkingSettings): boolean {
    return thinking.minimax === "on";
  }
}
