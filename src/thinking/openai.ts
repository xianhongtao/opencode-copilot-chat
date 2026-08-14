/**
 * OpenAI GPT thinking strategy.
 *
 * GPT 5.x models route through the Responses API where reasoning is a nested
 * `reasoning: { effort }` object. Supported values: none/minimal/low/medium/
 * high/xhigh/max (the gateway forwards `reasoning.effort` to the Responses API).
 */
import { BaseThinkingProvider } from "./base";
import { schemaFromReasoningOptions, effortProperty, type ThinkingSchema } from "./schema";
import type { ResolvedModelMetadata } from "../metadata";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";

const OPENAI_EFFORTS = ["off", "low", "medium", "high", "xhigh"] as const;

export class OpenAiThinking extends BaseThinkingProvider {
  readonly family: ThinkingFamily = "openai";

  constructor(readonly modelId: string) {
    super();
  }

  schema(metadata?: ResolvedModelMetadata): ThinkingSchema | undefined {
    return (
      schemaFromReasoningOptions(metadata) ?? {
        properties: {
          reasoningEffort: effortProperty({
            enum: OPENAI_EFFORTS,
            labels: ["Off", "Low", "Medium", "High", "XHigh"],
            descriptions: [
              "Fastest responses",
              "Faster responses with less reasoning",
              "Balanced reasoning and speed",
              "Greater reasoning depth",
              "Maximum reasoning depth",
            ],
            default: "off",
          }),
        },
      }
    );
  }

  applyOverride(settings: ThinkingSettings, override: Record<string, unknown>): ThinkingSettings {
    return this.applyEffort(settings, override, "openai", OPENAI_EFFORTS);
  }

  buildPayload(thinking: ThinkingSettings, _opts?: BuildThinkingPayloadOptions): Record<string, unknown> {
    if (thinking.openai === "off") {
      return {};
    }
    return { reasoning: { effort: thinking.openai } };
  }

  requestsThinking(thinking: ThinkingSettings): boolean {
    return thinking.openai !== "off";
  }
}
