/**
 * Thinking provider registry.
 *
 * Each model family has its own strategy class (see `./deepseek.ts` etc.),
 * selected by {@link thinkingProviderFor}. This module owns the interface and
 * the single routing point from a raw model id to its strategy.
 *
 * CONTRACT: pure only — no `vscode` import, no side effects.
 */
import type { ResolvedModelMetadata } from "../metadata";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";
import { DeepSeekThinking } from "./deepseek";
import { GlmThinking } from "./glm";
import { KimiThinking } from "./kimi";
import { MiniMaxThinking } from "./minimax";
import { OpenAiThinking } from "./openai";
import { QwenThinking } from "./qwen";
import { MimoThinking } from "./mimo";
import { FallbackThinking } from "./fallback";

/** Strategy interface implemented by each per-provider thinking class. */
export interface ThinkingProvider {
  /** Thinking family this strategy handles; `null` = fallback/unknown. */
  readonly family: ThinkingFamily;
  /** Raw model id this strategy is bound to. */
  readonly modelId: string;
  /** Picker schema properties (reasoningEffort / thinkingBudget). */
  schema(metadata?: ResolvedModelMetadata): { properties: Record<string, unknown> } | undefined;
  /** Map a per-model override onto the family settings (same ref if no change). */
  applyOverride(settings: ThinkingSettings, override: Record<string, unknown>): ThinkingSettings;
  /** Build the request payload thinking fields (spread into the body). */
  buildPayload(thinking: ThinkingSettings, opts?: BuildThinkingPayloadOptions): Record<string, unknown>;
  /** Whether the resolved settings request thinking through any channel. */
  requestsThinking(thinking: ThinkingSettings): boolean;
  /** Whether `reasoning_content` should be surfaced as visible text. */
  treatReasoningAsContent(url: string, thinking: ThinkingSettings): boolean;
  /** Model-level constraints applied after resolution (e.g. k2.7 force-on). */
  normalize(settings: ThinkingSettings): ThinkingSettings;
}

/**
 * Detect which Thinking family a raw model id belongs to. Used both to render
 * the per-model picker submenu (configurationSchema) and to map the user's
 * per-request selection back to the right OpenCode request field.
 */
export function thinkingFamily(modelId: string): ThinkingFamily {
  if (/^deepseek-/i.test(modelId)) return "deepseek";
  if (/^glm-/i.test(modelId)) return "glm";
  if (/^kimi-/i.test(modelId)) return "kimi";
  if (/^minimax-/i.test(modelId)) return "minimax";
  if (/^gpt-/i.test(modelId)) return "openai";
  if (/^qwen3(?:\.|-)/i.test(modelId)) return "qwen";
  if (/^mimo-/i.test(modelId)) return "mimo";
  return null;
}

/** Resolve the thinking strategy for a raw model id. */
export function thinkingProviderFor(modelId: string, metadata?: ResolvedModelMetadata): ThinkingProvider {
  switch (thinkingFamily(modelId)) {
    case "deepseek":
      return new DeepSeekThinking(modelId);
    case "glm":
      return new GlmThinking(modelId);
    case "kimi":
      return new KimiThinking(modelId);
    case "minimax":
      return new MiniMaxThinking(modelId);
    case "openai":
      return new OpenAiThinking(modelId);
    case "qwen":
      return new QwenThinking(modelId);
    case "mimo":
      return new MimoThinking(modelId);
    default:
      return new FallbackThinking(modelId, metadata);
  }
}
