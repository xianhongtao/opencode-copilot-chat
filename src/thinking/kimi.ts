/**
 * Kimi thinking strategy.
 *
 * K2.7-code cannot disable thinking (Moonshot API constraint): the payload is
 * always `{ thinking: { type: "enabled", keep: "all" } }` and the resolved
 * setting is forced on via {@link normalize}.
 */
import { BaseThinkingProvider } from "./base";
import { schemaFromReasoningOptions, effortProperty, type ThinkingSchema } from "./schema";
import type { ResolvedModelMetadata } from "../models/metadata";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";

// "off" first so the picker shows Off → On (matches the workspace default flow).
const KIMI_MODES = ["off", "on"] as const;

export class KimiThinking extends BaseThinkingProvider {
  readonly family: ThinkingFamily = "kimi";

  constructor(readonly modelId: string) {
    super();
  }

  schema(metadata?: ResolvedModelMetadata): ThinkingSchema | undefined {
    const fromOptions = schemaFromReasoningOptions(metadata);
    if (fromOptions) return fromOptions;

    // K2.7-code: thinking cannot be disabled — expose a single informational
    // option so users understand the model always reasons.
    if (/^kimi-k2\.7/i.test(this.modelId)) {
      return {
        properties: {
          reasoningEffort: effortProperty({
            enum: ["on"],
            labels: ["Always On (K2.7)"],
            descriptions: ["Kimi K2.7-code requires thinking enabled (Moonshot API constraint)"],
            default: "on",
          }),
        },
      };
    }

    return {
      properties: {
        reasoningEffort: effortProperty({
          enum: KIMI_MODES,
          labels: ["Off", "On"],
          descriptions: ["Fastest responses", "Enable thinking"],
          default: "off",
        }),
      },
    };
  }

  applyOverride(settings: ThinkingSettings, override: Record<string, unknown>): ThinkingSettings {
    let next = this.applyEffort(settings, override, "kimi", KIMI_MODES);
    next = this.applyMode(next, override, "kimi", KIMI_MODES);
    return next;
  }

  normalize(settings: ThinkingSettings): ThinkingSettings {
    // K2.7-code forces thinking on regardless of picker selection (defensive —
    // the picker schema only exposes "on", but VS Code may cache a stale value).
    if (/^kimi-k2\.7/i.test(this.modelId) && settings.kimi !== "on") {
      return { ...settings, kimi: "on" };
    }
    return settings;
  }

  buildPayload(thinking: ThinkingSettings, _opts?: BuildThinkingPayloadOptions): Record<string, unknown> {
    // K2.7-code: only type=enabled is allowed; keep:"all" preserves
    // reasoning_content across multi-turn conversations (Moonshot spec).
    if (/^kimi-k2\.7/i.test(this.modelId)) {
      return { thinking: { type: "enabled", keep: "all" } };
    }
    return { thinking: { type: thinking.kimi === "on" ? "enabled" : "disabled" } };
  }

  requestsThinking(thinking: ThinkingSettings): boolean {
    return thinking.kimi === "on";
  }
}
