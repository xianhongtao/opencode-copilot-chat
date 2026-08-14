/**
 * Shared plumbing for per-provider thinking strategies.
 *
 * Each model family gets its own concrete {@link ThinkingProvider} so its
 * schema, override mapping, request payload shape and display decision stay
 * encapsulated. This base class only holds the common contract and small
 * pure helpers — it never special-cases a provider.
 *
 * CONTRACT: pure only — no `vscode` import, no side effects.
 */
import type { ResolvedModelMetadata } from "../models/metadata";
// Type-only import from the sibling registry module — erased at runtime, so
// there is no circular dependency between the base class and the concrete
// providers that extend it.
import type { ThinkingProvider } from "./provider";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";

export abstract class BaseThinkingProvider implements ThinkingProvider {
  abstract readonly family: ThinkingFamily;
  abstract readonly modelId: string;

  abstract schema(metadata?: ResolvedModelMetadata): { properties: Record<string, unknown> } | undefined;
  abstract buildPayload(thinking: ThinkingSettings, opts?: BuildThinkingPayloadOptions): Record<string, unknown>;
  abstract requestsThinking(thinking: ThinkingSettings): boolean;

  /**
   * Map a per-model override (modelConfiguration / persisted fallback) onto the
   * family settings. Returns the SAME reference when nothing changed so the
   * resolver can detect whether an override actually applied.
   */
  applyOverride(settings: ThinkingSettings, _override: Record<string, unknown>): ThinkingSettings {
    return settings;
  }

  /** Model-level constraints applied after resolution (default: none). */
  normalize(settings: ThinkingSettings): ThinkingSettings {
    return settings;
  }

  /**
   * Display decision: should `reasoning_content` be surfaced as visible text
   * instead of a thinking part? Default false — reasoning is genuine CoT.
   */
  treatReasoningAsContent(_url: string, _thinking: ThinkingSettings): boolean {
    return false;
  }

  /** Set a family field from `override.reasoningEffort` when valid and different. */
  protected applyEffort(
    settings: ThinkingSettings,
    override: Record<string, unknown>,
    field: keyof ThinkingSettings,
    allowed: readonly string[],
  ): ThinkingSettings {
    const value = override.reasoningEffort;
    if (typeof value === "string" && allowed.includes(value) && settings[field] !== value) {
      return { ...settings, [field]: value };
    }
    return settings;
  }

  /** Set a family field from `override.thinkingMode` when valid and different. */
  protected applyMode(
    settings: ThinkingSettings,
    override: Record<string, unknown>,
    field: keyof ThinkingSettings,
    allowed: readonly string[],
  ): ThinkingSettings {
    const value = override.thinkingMode;
    if (typeof value === "string" && allowed.includes(value) && settings[field] !== value) {
      return { ...settings, [field]: value };
    }
    return settings;
  }
}
