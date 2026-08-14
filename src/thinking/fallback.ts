/**
 * Fallback thinking strategy for models with no known family.
 *
 * Only reasoning-capable models (`metadata.reasoning`) get a generic off/on
 * picker schema; no thinking fields are ever emitted to the request, and
 * `reasoning_content` is always treated as genuine CoT (never visible text).
 */
import { BaseThinkingProvider } from "./base";
import { schemaFromReasoningOptions, genericReasoningSchema, type ThinkingSchema } from "./schema";
import type { ResolvedModelMetadata } from "../models/metadata";
import type { ThinkingSettings, ThinkingFamily, BuildThinkingPayloadOptions } from "./types";

export class FallbackThinking extends BaseThinkingProvider {
  readonly family: ThinkingFamily = null;

  constructor(
    readonly modelId: string,
    private readonly metadata?: ResolvedModelMetadata,
  ) {
    super();
  }

  schema(metadata?: ResolvedModelMetadata): ThinkingSchema | undefined {
    const effective = this.metadata ?? metadata;
    return schemaFromReasoningOptions(effective) ?? (effective?.reasoning ? genericReasoningSchema() : undefined);
  }

  // applyOverride: no known family → no override mapping (inherited default).

  buildPayload(_thinking: ThinkingSettings, _opts?: BuildThinkingPayloadOptions): Record<string, unknown> {
    return {};
  }

  requestsThinking(_thinking: ThinkingSettings): boolean {
    return false;
  }

  // treatReasoningAsContent: reasoning is genuine CoT → default false.
}
