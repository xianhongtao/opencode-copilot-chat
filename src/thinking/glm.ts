/**
 * GLM (ZhipuAI) thinking strategy.
 *
 * Uses `thinking: { type: "enabled" | "disabled" }` when off, and
 * `reasoning_effort` for concrete effort levels (high/max). The gateway does
 * not transform GLM thinking params, so we send them through as-is.
 */
import { BaseThinkingProvider } from "./base";
import { schemaFromReasoningOptions, effortProperty, type ThinkingSchema } from "./schema";
import type { ResolvedModelMetadata } from "../models/metadata";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";

const GLM_EFFORTS = ["off", "high", "max"] as const;

export class GlmThinking extends BaseThinkingProvider {
  readonly family: ThinkingFamily = "glm";

  constructor(readonly modelId: string) {
    super();
  }

  schema(metadata?: ResolvedModelMetadata): ThinkingSchema | undefined {
    return (
      schemaFromReasoningOptions(metadata) ?? {
        properties: {
          reasoningEffort: effortProperty({
            enum: GLM_EFFORTS,
            labels: ["Off", "High", "Max"],
            descriptions: ["Fastest responses", "Greater reasoning depth", "Maximum reasoning effort"],
            default: "off",
          }),
        },
      }
    );
  }

  applyOverride(settings: ThinkingSettings, override: Record<string, unknown>): ThinkingSettings {
    let next = this.applyEffort(settings, override, "glm", GLM_EFFORTS);
    next = this.applyMode(next, override, "glm", GLM_EFFORTS);
    return next;
  }

  buildPayload(thinking: ThinkingSettings, _opts?: BuildThinkingPayloadOptions): Record<string, unknown> {
    if (thinking.glm === "off") {
      return { thinking: { type: "disabled" } };
    }
    return { reasoning_effort: thinking.glm };
  }

  requestsThinking(thinking: ThinkingSettings): boolean {
    return thinking.glm !== "off";
  }
}
