/**
 * Qwen thinking strategy.
 *
 * Qwen routes through BOTH the chat-completions endpoint (`enable_thinking` /
 * `thinking_budget`) and the Anthropic messages endpoint (native
 * `thinking: { type, budget_tokens }`). The endpoint is chosen by the caller
 * via {@link BuildThinkingPayloadOptions.endpoint}.
 */
import { BaseThinkingProvider } from "./base";
import { schemaFromReasoningOptions, effortProperty, type ThinkingSchema } from "./schema";
import type { ResolvedModelMetadata } from "../models/metadata";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";

const QWEN_MODES = ["auto", "on", "off"] as const;
const QWEN_BUDGETS = ["auto", "4096", "16384", "32768", "81920"] as const;

export class QwenThinking extends BaseThinkingProvider {
  readonly family: ThinkingFamily = "qwen";

  constructor(readonly modelId: string) {
    super();
  }

  schema(metadata?: ResolvedModelMetadata): ThinkingSchema | undefined {
    return (
      schemaFromReasoningOptions(metadata) ?? {
        properties: {
          reasoningEffort: effortProperty({
            enum: QWEN_MODES,
            labels: ["Off", "Auto", "On"],
            descriptions: ["Fastest responses", "Model decides", "Enable thinking"],
            default: "off",
          }),
          thinkingBudget: effortProperty({
            enum: QWEN_BUDGETS,
            labels: ["Auto", "4K", "16K", "32K", "80K"],
            descriptions: ["Provider default", "Small budget", "Medium budget", "Large budget", "Maximum budget"],
            default: "auto",
            title: "Thinking Budget",
            group: "",
          }),
        },
      }
    );
  }

  applyOverride(settings: ThinkingSettings, override: Record<string, unknown>): ThinkingSettings {
    let next = this.applyEffort(settings, override, "qwen", QWEN_MODES);
    next = this.applyMode(next, override, "qwen", QWEN_MODES);
    const budget = override.thinkingBudget;
    if (typeof budget === "string" && (QWEN_BUDGETS as readonly string[]).includes(budget) && settings.qwenBudget !== budget) {
      next = { ...next, qwenBudget: budget as ThinkingSettings["qwenBudget"] };
    }
    return next;
  }

  buildPayload(thinking: ThinkingSettings, opts?: BuildThinkingPayloadOptions): Record<string, unknown> {
    if (opts?.endpoint === "messages") {
      return this.buildAnthropicPayload(thinking);
    }
    return this.buildChatPayload(thinking, opts?.hasImageInput ?? false);
  }

  requestsThinking(thinking: ThinkingSettings): boolean {
    return thinking.qwen === "on";
  }

  private buildChatPayload(thinking: ThinkingSettings, hasImageInput: boolean): Record<string, unknown> {
    if (thinking.qwen === "auto") {
      // Let the model decide; don't send enable_thinking. Budget is only
      // meaningful when thinking is active. Vision requests are already
      // token-heavy; keep "auto" truly automatic.
      if (hasImageInput) {
        return {};
      }
      return thinking.qwenBudget === "auto" ? {} : { thinking_budget: Number(thinking.qwenBudget) };
    }
    if (thinking.qwen === "on") {
      return thinking.qwenBudget === "auto"
        ? { enable_thinking: true }
        : { enable_thinking: true, thinking_budget: Number(thinking.qwenBudget) };
    }
    return { enable_thinking: false };
  }

  /** Anthropic messages endpoint expects { type: "enabled"|"disabled", budget_tokens }. */
  private buildAnthropicPayload(thinking: ThinkingSettings): Record<string, unknown> {
    if (thinking.qwen === "on") {
      const budget = thinking.qwenBudget === "auto" ? undefined : Number(thinking.qwenBudget);
      return {
        thinking: {
          type: "enabled",
          ...(budget !== undefined ? { budget_tokens: budget } : {}),
        },
      };
    }
    if (thinking.qwen === "off") {
      return { thinking: { type: "disabled" } };
    }
    // "auto" — let the provider decide; send no thinking directive.
    return {};
  }
}
