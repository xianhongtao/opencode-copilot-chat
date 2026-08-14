import * as vscode from "vscode";
import {
  CONFIG_SECTION,
  DEFAULT_REQUEST_TIMEOUT_SECONDS,
  DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
  SETTING_DEBUG_REASONING,
  SETTING_MAX_INPUT_TOKENS,
  SETTING_MAX_TOKENS,
  SETTING_REQUEST_TIMEOUT_SECONDS,
  SETTING_STREAM_IDLE_TIMEOUT_SECONDS,
  SETTING_STRIP_THINK_TAGS,
  SETTING_TEMPERATURE,
  SETTING_THINKING_DEEPSEEK,
  SETTING_THINKING_GLM,
  SETTING_THINKING_KIMI,
  SETTING_THINKING_MIMO,
  SETTING_THINKING_MINIMAX,
  SETTING_THINKING_OPENAI,
  SETTING_THINKING_QWEN,
  SETTING_THINKING_QWEN_BUDGET,
  THINKING_DEFAULTS,
  VISION_PROXY_MODEL_ID_KEY,
} from "../config";
import { getContextSizeOptionsForModel, type CachedModelMetadataSnapshot, type ResolvedModelMetadata } from "../models/metadata";
import { buildStableModelCapabilities } from "../models/modelCapabilities";
import { calculateModelLimits, type ModelLimits } from "../models/modelLimits";
import { AGENT_GO_VENDOR, AGENT_ZEN_VENDOR, GO_VENDOR, ZEN_VENDOR, resolveBaseVendor, type AllProviderVendor } from "../providerTypes";
import type { ApiSettings } from "../request/types";
import { thinkingProviderFor, type ThinkingSettings } from "../thinking";
import { extensionContext } from "../usage/dashboard";
import { toFiniteNumber } from "../utils";
import type { LanguageModelConfiguration, ProviderDefinition } from "./definitions";

export function getConfiguredApiKey(options?: { configuration?: LanguageModelConfiguration }): string | undefined {
  const configuredApiKey = options?.configuration?.apiKey;
  return typeof configuredApiKey === "string" && configuredApiKey.trim() ? configuredApiKey.trim() : undefined;
}

export function modelConfigurationSchema(
  modelId: string,
  metadata?: ResolvedModelMetadata,
): vscode.LanguageModelConfigurationSchema | undefined {
  const properties: Record<string, unknown> = {};

  // --- Thinking / Reasoning Effort ---
  // Delegated to the per-provider strategy (schemaFromReasoningOptions first,
  // then family hardcoded, then generic reasoning fallback).
  const builtinSchema = thinkingProviderFor(modelId, metadata).schema(metadata);

  if (builtinSchema) {
    Object.assign(properties, builtinSchema.properties);
  }

  // --- Context Size (tiered pricing) ---
  const contextSizeOptions = metadata ? getContextSizeOptionsForModel(modelId, metadata.cost, metadata.contextWindow) : undefined;
  if (contextSizeOptions && contextSizeOptions.length > 0) {
    properties.contextSize = {
      type: "number",
      title: "Context Size",
      enum: contextSizeOptions.map((o) => o.value),
      enumItemLabels: contextSizeOptions.map((o) => o.label),
      enumDescriptions: contextSizeOptions.map((o) => o.description),
      default: contextSizeOptions.find((o) => o.isDefault)?.value ?? contextSizeOptions[0].value,
      group: "tokens",
    };
  }

  if (Object.keys(properties).length === 0) {
    return undefined;
  }

  return { type: "object", properties: properties as vscode.LanguageModelConfigurationSchema["properties"] };
}

export function getRequestModelConfiguration(options: vscode.ProvideLanguageModelChatResponseOptions): Record<string, unknown> | undefined {
  // The field is `modelConfiguration` in the current proposed API; older
  // builds shipped it under `configuration` alongside the auth config. Accept
  // both shapes defensively so the picker keeps working across VS Code
  // versions.
  const opts = options as vscode.ProvideLanguageModelChatResponseOptions & {
    modelConfiguration?: Record<string, unknown>;
    configuration?: Record<string, unknown>;
  };
  return opts.modelConfiguration ?? opts.configuration;
}

export function getSettings(): ApiSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  // Config values are sanitized so a misconfigured (e.g. string) value never
  // reaches the request body and 400s upstream.
  return {
    temperature: toFiniteNumber(config.get(SETTING_TEMPERATURE, 0.2), 0.2),
    maxOutputTokensOverride: toFiniteNumber(config.get(SETTING_MAX_TOKENS, 0), 0, 0),
    maxInputTokensOverride: toFiniteNumber(config.get(SETTING_MAX_INPUT_TOKENS, 0), 0, 0),
    debugReasoning: config.get(SETTING_DEBUG_REASONING, false),
    requestTimeoutMs:
      toFiniteNumber(config.get(SETTING_REQUEST_TIMEOUT_SECONDS, DEFAULT_REQUEST_TIMEOUT_SECONDS), DEFAULT_REQUEST_TIMEOUT_SECONDS, 1) *
      1000,
    streamIdleTimeoutMs:
      toFiniteNumber(
        config.get(SETTING_STREAM_IDLE_TIMEOUT_SECONDS, DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS),
        DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
        1,
      ) * 1000,
    thinking: {
      deepseek: config.get<ThinkingSettings["deepseek"]>(SETTING_THINKING_DEEPSEEK, THINKING_DEFAULTS.deepseek),
      glm: config.get<ThinkingSettings["glm"]>(SETTING_THINKING_GLM, THINKING_DEFAULTS.glm),
      kimi: config.get<ThinkingSettings["kimi"]>(SETTING_THINKING_KIMI, THINKING_DEFAULTS.kimi),
      minimax: config.get<ThinkingSettings["minimax"]>(SETTING_THINKING_MINIMAX, THINKING_DEFAULTS.minimax),
      openai: config.get<ThinkingSettings["openai"]>(SETTING_THINKING_OPENAI, THINKING_DEFAULTS.openai),
      qwen: config.get<ThinkingSettings["qwen"]>(SETTING_THINKING_QWEN, THINKING_DEFAULTS.qwen),
      qwenBudget: config.get<ThinkingSettings["qwenBudget"]>(SETTING_THINKING_QWEN_BUDGET, THINKING_DEFAULTS.qwenBudget),
      mimo: config.get<ThinkingSettings["mimo"]>(SETTING_THINKING_MIMO, THINKING_DEFAULTS.mimo),
    },
    stripThinkTags: config.get<ApiSettings["stripThinkTags"]>(SETTING_STRIP_THINK_TAGS, "auto"),
  };
}

export function modelLimits(
  metadata: ResolvedModelMetadata,
  settings = getSettings(),
  contextSizeOverride?: number,
  promptTokens?: number,
): ModelLimits {
  return calculateModelLimits(metadata, {
    maxInputTokens: settings.maxInputTokensOverride,
    maxOutputTokens: settings.maxOutputTokensOverride,
    contextSize: contextSizeOverride,
    promptTokens,
  });
}

export function modelCapabilities(metadata: ResolvedModelMetadata): vscode.LanguageModelChatCapabilities {
  // When a vision proxy model is configured (non-empty ID in globalState),
  // report imageInput: true for ALL models so VS Code does not strip image
  // parts before they reach our provider. The vision proxy interceptor
  // forwards images to the configured model transparently.
  const supportsVision = metadata.supportsVision || isVisionProxyEnabled();

  // `editTools` is intentionally absent. VS Code 1.132 still gates that hint
  // behind the chatProvider proposal for non-allowlisted extensions.
  return buildStableModelCapabilities(supportsVision);
}

export function formatModalityBadges(metadata: ResolvedModelMetadata): string {
  const badges: string[] = [];
  if (metadata.supportsVision) {
    badges.push("Image");
  }
  if (metadata.supportsPdf) {
    badges.push("PDF");
  }
  if (metadata.supportsVideo) {
    badges.push("Video");
  }
  if (metadata.supportsAudio) {
    badges.push("Audio");
  }
  return badges.join(" · ");
}

export function shouldHideDeprecatedModel(
  modelId: string,
  vendor: ProviderDefinition["vendor"],
  snapshot: CachedModelMetadataSnapshot,
): boolean {
  if (resolveBaseVendor(vendor) !== ZEN_VENDOR) {
    return false;
  }
  return snapshot.providers[ZEN_VENDOR]?.[modelId]?.status === "deprecated";
}

export function resolveRawModelId(modelId: string): string {
  const [base] = modelId.split("::");
  const prefixes = [`${GO_VENDOR}:`, `${ZEN_VENDOR}:`, `${AGENT_GO_VENDOR}:`, `${AGENT_ZEN_VENDOR}:`];
  for (const prefix of prefixes) {
    if (base.startsWith(prefix)) {
      return base.slice(prefix.length);
    }
  }
  return base;
}

/** Best-effort vendor resolution from a model ID. */
export function resolveVendorFromId(modelId: string): AllProviderVendor {
  if (modelId.startsWith(`${AGENT_GO_VENDOR}:`)) return AGENT_GO_VENDOR;
  if (modelId.startsWith(`${AGENT_ZEN_VENDOR}:`)) return AGENT_ZEN_VENDOR;
  if (modelId.startsWith(`${ZEN_VENDOR}:`)) return ZEN_VENDOR;
  return GO_VENDOR;
}

/**
 * True when a vision proxy model has been configured (non-empty model ID
 * stored in globalState via the "OpenCode Go: Configure Vision Proxy" command).
 */
export function isVisionProxyEnabled(): boolean {
  return extensionContext().globalState.get<string>(VISION_PROXY_MODEL_ID_KEY, "").length > 0;
}
