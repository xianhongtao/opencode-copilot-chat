/**
 * Shared picker-schema builders for the thinking system.
 *
 * CONTRACT: pure functions only — no `vscode` import, no side effects.
 */
import type { ResolvedModelMetadata } from "../metadata";

/** A plain JSON-schema-like object; the caller adds the VS Code annotation. */
export interface ThinkingSchema {
  properties: Record<string, unknown>;
}

/** Build a `reasoningEffort` schema property with the given enum options. */
export function effortProperty(opts: {
  enum: readonly string[];
  labels: readonly string[];
  descriptions: readonly string[];
  default?: string;
  title?: string;
  group?: string;
}): Record<string, unknown> {
  return {
    type: "string",
    title: opts.title ?? "Thinking Effort",
    enum: [...opts.enum],
    enumItemLabels: [...opts.labels],
    enumDescriptions: [...opts.descriptions],
    default: opts.default ?? "off",
    group: opts.group ?? "navigation",
  };
}

/**
 * Priority 1 schema: derive options from models.dev `reasoning_options`.
 * Returns undefined when no usable toggle/effort options exist, so callers
 * fall back to their family-specific schema.
 */
export function schemaFromReasoningOptions(metadata?: ResolvedModelMetadata): ThinkingSchema | undefined {
  const opts = metadata?.reasoningOptions;
  if (!opts || opts.length === 0) return undefined;

  // Collect unique effort values across all effort-type options.
  const effortValues = opts
    .filter((o): o is { type: "effort"; values: string[] } => o.type === "effort" && Array.isArray(o.values) && o.values.length > 0)
    .flatMap((o) => o.values)
    .filter((v, i, a) => a.indexOf(v) === i);

  const hasToggle = opts.some((o) => o.type === "toggle");

  if (!hasToggle && effortValues.length === 0) return undefined;

  const enumOptions: string[] = ["off"];
  const enumLabels: string[] = ["Off"];
  const enumDescriptions: string[] = ["Fastest responses"];

  // Toggle-only (no effort values): add "on" for a simple off/on choice.
  if (hasToggle && effortValues.length === 0) {
    enumOptions.push("on");
    enumLabels.push("On");
    enumDescriptions.push("Enable reasoning");
  }

  for (const v of effortValues) {
    enumOptions.push(v);
    enumLabels.push(v.charAt(0).toUpperCase() + v.slice(1));
    switch (v) {
      case "low":
        enumDescriptions.push("Faster responses with less reasoning");
        break;
      case "medium":
        enumDescriptions.push("Balanced reasoning and speed");
        break;
      case "high":
        enumDescriptions.push("Greater reasoning depth but slower");
        break;
      case "xhigh":
        enumDescriptions.push("Maximum reasoning depth");
        break;
      case "max":
        enumDescriptions.push("Maximum reasoning effort");
        break;
      default:
        enumDescriptions.push(`Effort: ${v}`);
    }
  }

  return {
    properties: {
      reasoningEffort: effortProperty({ enum: enumOptions, labels: enumLabels, descriptions: enumDescriptions, default: "off" }),
    },
  };
}

/** Generic off/on schema for any reasoning-capable model (Priority 3 fallback). */
export function genericReasoningSchema(): ThinkingSchema {
  return {
    properties: {
      reasoningEffort: effortProperty({
        enum: ["off", "on"],
        labels: ["Off", "On"],
        descriptions: ["Fastest responses", "Enable reasoning"],
        default: "off",
      }),
    },
  };
}
