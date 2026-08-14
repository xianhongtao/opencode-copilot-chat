/**
 * Thinking config resolution — the single place that merges all thinking-mode
 * sources into one effective value, with explicit provenance.
 *
 * Priority (highest first):
 *   1. `modelConfiguration`  — live per-model config delivered by VS Code
 *                              (picker submenu / Manage Language Models). This
 *                              is the SINGLE authority for per-model thinking.
 *   2. `workspace`           — `opencodego.thinking.*` settings (default).
 *   3. `default`             — `THINKING_DEFAULTS` baked into the settings.
 *
 * CONTRACT: pure only — no `vscode` import, no side effects. The extension
 * provides the raw sources; this module resolves them.
 */
import type { ResolvedModelMetadata } from "../models/metadata";
import type { ThinkingSettings, ThinkingSource, ResolvedThinking, ThinkingOverride } from "./types";
import { thinkingProviderFor } from "./provider";

export interface ResolveThinkingConfigInput {
  modelId: string;
  metadata?: ResolvedModelMetadata;
  /** Workspace settings (`opencodego.thinking.*`), already defaulted. */
  workspace: ThinkingSettings;
  /** Live per-model config from `options.modelConfiguration` (may be absent). */
  modelConfiguration?: Record<string, unknown>;
}

/** Resolve the effective thinking settings with provenance. */
export function resolveThinkingConfig(input: ResolveThinkingConfigInput): ResolvedThinking {
  const provider = thinkingProviderFor(input.modelId, input.metadata);

  let settings: ThinkingSettings = input.workspace;
  let source: ThinkingSource = "workspace";
  let overrideApplied = false;

  // A delivered modelConfiguration always wins (even if its value equals the
  // workspace baseline) — VS Code's per-model config is the single authority.
  const liveOverride = extractThinkingOverride(input.modelConfiguration);
  if (liveOverride) {
    const next = provider.applyOverride(settings, input.modelConfiguration ?? {});
    overrideApplied = next !== settings;
    settings = next;
    source = "modelConfiguration";
  }

  // Apply model-level constraints (e.g. kimi-k2.7 force-on).
  settings = provider.normalize(settings);

  return { settings, source, overrideApplied };
}

/**
 * Extract the thinking-relevant keys from a `modelConfiguration` object.
 * Returns undefined when none of the known keys carry a string value.
 */
export function extractThinkingOverride(modelConfiguration: Record<string, unknown> | undefined): ThinkingOverride | undefined {
  if (!modelConfiguration) return undefined;
  const picked: ThinkingOverride = {};
  for (const key of ["reasoningEffort", "thinkingMode", "thinkingBudget"] as const) {
    const value = modelConfiguration[key];
    if (typeof value === "string") {
      picked[key] = value;
    }
  }
  return Object.keys(picked).length ? picked : undefined;
}
