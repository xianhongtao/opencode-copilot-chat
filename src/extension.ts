import * as vscode from "vscode";
import { OpenCodeRequestError } from "./errors";
import {
  MODEL_METADATA_CACHE_KEY,
  MODEL_METADATA_REVISION,
  MODELS_DEV_API_URL,
  bundledModelMetadataSnapshot,
  getContextSizeOptionsForModel,
  hasExplicitModelLimits,
  isFreshModelMetadata,
  normalizeLiveModelMetadata,
  normalizeModelsDevSnapshot,
  resolveModelMetadata,
  toEffectiveModelId,
  VISION_CAPABLE_MODELS,
  type CachedModelMetadataSnapshot,
  type ModelMetadataFields,
  type ModelsDevResponse,
  type ResolvedModelMetadata,
} from "./models/metadata";
import { resolveModelRouting } from "./core/routing";
import { extractThinkingOverride, resolveThinkingConfig, thinkingFamily, thinkingProviderFor, type ThinkingSettings } from "./thinking";
import { shouldEchoThinkingHistory, thinkingTextFromValue } from "./reasoningHistory";
import { buildOpenCodeGatewayAuthHeaders } from "./openCodeAuth";
import {
  streamAnthropicMessages as runStreamAnthropicMessages,
  streamChatCompletions as runStreamChatCompletions,
  streamGoogleGenerateContent as runStreamGoogleGenerateContent,
  streamResponsesApi as runStreamResponsesApi,
  type TransportRequestSummary,
} from "./streaming";
import {
  GO_VENDOR,
  ZEN_VENDOR,
  AGENT_GO_VENDOR,
  AGENT_ZEN_VENDOR,
  resolveBaseVendor,
  type AllProviderVendor,
  type ProviderVendor,
} from "./providerTypes";
import { providerEnabledSetting } from "./providerEnablement";
import { isInternalDataPart, isReasoningMarkerPart, readReasoningMarker } from "./chatParts";
import { registerInlineCompletions } from "./autocomplete";
import { completionUsageToSeries, type CompletionUsageDay } from "./autocomplete/usage";
import { getImageDataUrlBase64Bytes, MAX_IMAGE_BASE64_BYTES, normalizeImageDataUrl } from "./imageNormalizer";
import { imageDescriptionKey, lookupImageDescriptions, storeImageDescriptions } from "./visionProxyCache";
import { providerModelDisplayName } from "./models/modelNames";
import { buildStableModelCapabilities } from "./models/modelCapabilities";
import { calculateModelLimits, type ModelLimits } from "./models/modelLimits";
import {
  buildAnthropicMessagesRequestBody,
  buildChatCompletionsRequestBody,
  buildGoogleGenerateContentBody,
  buildResponsesRequestBody,
  messagesHaveImages,
} from "./request/builders";
import type { ApiMessage, ApiSettings, OpenAiContentPart, OpenAiToolCall } from "./request/types";
import { runtimeDiagnosticsLines } from "./runtimeDiagnostics";
import { estimatePromptTokenCount, estimateTokenCount } from "./tokenEstimate";
import {
  AGENTS_BYOK_BRIDGE_STATE_KEY,
  AGENT_HOST_BYOK_ENABLED_SETTING,
  AGENT_HOST_BYOK_MINOR_VERSION,
  CAPACITY_LIMITED_MODEL_NOTES,
  COMPLETION_USAGE_KEY,
  CONFIG_SECTION,
  DEFAULT_REQUEST_TIMEOUT_SECONDS,
  DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
  DEFAULT_VISION_PROXY_PROMPT,
  EXTENSION_ID,
  FALLBACK_USER_AGENT,
  FREE_ZEN_MODEL_IDS,
  IMAGE_TOKEN_ESTIMATE,
  KNOWN_UNAVAILABLE_MODEL_IDS,
  MAX_HISTORY_IMAGES_KEPT,
  MAX_TOOL_RESULT_IMAGE_BYTES,
  MESSAGE_NAME_TOKEN_OVERHEAD,
  MESSAGE_TOKEN_OVERHEAD,
  MODEL_LIST_CACHE_KEY_PREFIX,
  MODEL_LIST_CACHE_TTL_MS,
  MODEL_LIST_FETCH_MAX_RETRIES,
  MODEL_LIST_FETCH_RETRY_BASE_MS,
  MODEL_LIST_FETCH_TIMEOUT_MS,
  MODEL_METADATA_FETCH_TIMEOUT_MS,
  OPEN_CODE_CLIENT,
  RECENT_TRANSPORT_SUMMARY_LIMIT,
  RECENT_TRANSPORT_SUMMARY_STORAGE_PREFIX,
  secretKeyFor,
  SETTING_AGENTS_WINDOW,
  SETTING_AUTO_ENABLE_AGENTS_WINDOW,
  SETTING_DEBUG_REASONING,
  SETTING_ENABLED,
  SETTING_FREE_ONLY,
  SETTING_MAX_INPUT_TOKENS,
  SETTING_MAX_TOKENS,
  SETTING_REQUEST_TIMEOUT_SECONDS,
  SETTING_SHOW_PROVIDER_PREFIX,
  SETTING_SHOW_USAGE_STATUS_BAR,
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
  SETTING_VISION_PROXY_WHOLE_CONVERSATION,
  SUPPORT_AGENTS_WINDOW_SETTING,
  SUPPORT_AGENTS_WINDOW_STATE_KEY,
  TEST_CONNECTION_TIMEOUT_MS,
  THINKING_DEFAULTS,
  TOOL_CALL_TOKEN_OVERHEAD,
  TOOL_RESULT_TOKEN_OVERHEAD,
  VISION_PROXY_MODEL_ID_KEY,
  VISION_PROXY_PROMPT_KEY,
  DEFAULT_USAGE_CODEBASE_ROW,
  DEFAULT_USAGE_CODEBASE_WINDOW_DAYS,
  DEFAULT_USAGE_DAY_BOUNDARY,
  DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS,
  DEFAULT_USAGE_CHART_DAYS,
  DEFAULT_USAGE_ROLLING_SESSION_METER,
  DEFAULT_USAGE_TODAY_YESTERDAY_SOURCE,
  SETTING_USAGE_CODEBASE_ROW,
  SETTING_USAGE_CODEBASE_WINDOW_DAYS,
  SETTING_USAGE_DAY_BOUNDARY,
  SETTING_USAGE_REFRESH_INTERVAL_SECONDS,
  SETTING_USAGE_CHART_DAYS,
  SETTING_USAGE_ROLLING_SESSION_METER,
  SETTING_USAGE_TODAY_YESTERDAY_SOURCE,
  type UsageTodayYesterdaySource,
} from "./config";
import {
  escapeHtml,
  formatCount,
  formatRelativeTime,
  formatTokenCount,
  formatUsd,
  getErrorMessage,
  isRecord,
  sleep,
  toFiniteNumber,
} from "./utils";
import { isFreeModel } from "./models/metadata";

import { formatCacheHitRatio, formatUsageStatusBarText, formatUsageStatusBarTooltip, type UsageSnapshot } from "./usage/usage";
import {
  GoUsageTracker,
  GO_LIMITS,
  formatGoUsageStatusBarText,
  buildUsageQuickPickItems,
  estimateCost,
  type GoUsageTrackerOptions,
  type UsageBaselineTargets,
} from "./goUsageTracker";
import { resolveResponseApiKey } from "./apiKeyResolution";
import {
  LEGACY_FINGERPRINT,
  keyFingerprint,
  readActiveProfile,
  readProfiles,
  writeActiveProfile,
  writeProfiles,
  readActiveProfiles,
  readMigratedTo,
  writeMigratedTo,
  findProfile,
  renameProfile,
  nonLegacyCount,
  type UsageProfile,
} from "./usage/usageProfile";

/**
 * VS Code core settings the extension manages (auto-configures and reverts)
 * so OpenCode models work in the Agents window (issue #122):
 *
 * - `chat.agentHost.byokModels.enabled`: wires the agent-host BYOK bridge
 *   (VS Code 1.129+); off by default, so extension-provided BYOK models never
 *   reach agent-host sessions until it is flipped on.
 * - `extensions.supportAgentsWindow.<id>`: the ONLY way a code extension is
 *   allowed to run in the Agents window (sessions window) process. Without
 *   it the extension is disabled there, its `languageModelChatProviders`
 *   vendors are not registered, and neither the model picker nor the
 *   "+ Add Models" list knows OpenCode Go/Zen.
 */

let usageStatusBarItem: vscode.StatusBarItem | undefined;
let goUsageStatusBarItem: vscode.StatusBarItem | undefined;
/** Singleton tracker — the first/legacy account. Used for backward compat until first migration. */
let goUsageTracker: GoUsageTracker | undefined;
/** Per-profile trackers indexed by key fingerprint. */
const goUsageTrackers = new Map<string, GoUsageTracker>();
/** API key per profile fingerprint — lets refreshes sync the active profile's own key. */
const profileApiKeys = new Map<string, string>();
let usageWebviewPanel: vscode.WebviewPanel | undefined;

let profilesCache: UsageProfile[] = [];
let activeProfileFingerprint: string = LEGACY_FINGERPRINT;

/**
 * Resolvers for the per-view usage knobs, read live from configuration so
 * changing a setting repaints the status bar / tooltip / card immediately.
 */
function usageTrackerOptions(): GoUsageTrackerOptions {
  const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    resolveWorkspaceFolders: () => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
    resolveTodayYesterdaySource: () =>
      config().get<UsageTodayYesterdaySource>(SETTING_USAGE_TODAY_YESTERDAY_SOURCE, DEFAULT_USAGE_TODAY_YESTERDAY_SOURCE),
    resolveCodebaseWindowDays: () => config().get<number>(SETTING_USAGE_CODEBASE_WINDOW_DAYS, DEFAULT_USAGE_CODEBASE_WINDOW_DAYS),
    resolveDayBoundary: () => config().get<"utc" | "local">(SETTING_USAGE_DAY_BOUNDARY, DEFAULT_USAGE_DAY_BOUNDARY),
  };
}

/** Whether the detailed usage views show the server 5h rolling meter. */
function usageRollingMeterVisible(): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>(SETTING_USAGE_ROLLING_SESSION_METER, DEFAULT_USAGE_ROLLING_SESSION_METER);
}

/** Whether the detailed usage views show the all-time codebase row. */
function usageCodebaseRowVisible(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_USAGE_CODEBASE_ROW, DEFAULT_USAGE_CODEBASE_ROW);
}

/** Every usage-view setting — a change to any of these repaints immediately. */
const USAGE_DISPLAY_SETTING_KEYS = [
  SETTING_USAGE_TODAY_YESTERDAY_SOURCE,
  SETTING_USAGE_CODEBASE_ROW,
  SETTING_USAGE_CODEBASE_WINDOW_DAYS,
  SETTING_USAGE_DAY_BOUNDARY,
  SETTING_USAGE_ROLLING_SESSION_METER,
  SETTING_USAGE_REFRESH_INTERVAL_SECONDS,
];

/**
 * Realtime usage updates: re-render the status bar (and webview) on a
 * configurable cadence so terminal-side OpenCode CLI usage, server meters and
 * day rollovers show up without waiting for the next chat request. The
 * interval re-reads the setting on every tick, so changes apply live.
 */
function startUsageRefreshLoop(context: vscode.ExtensionContext): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    timer = setTimeout(() => {
      refreshGoUsageStatusBar();
      schedule();
    }, usageRefreshIntervalSeconds() * 1000);
  };
  schedule();
  context.subscriptions.push({
    dispose: () => {
      if (timer) clearTimeout(timer);
    },
  });
}

function usageRefreshIntervalSeconds(): number {
  return Math.max(
    5,
    vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<number>(SETTING_USAGE_REFRESH_INTERVAL_SECONDS, DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS),
  );
}

/** Look up (or create) the GoUsageTracker for a given key fingerprint. */
function getOrCreateTracker(fingerprint: string): GoUsageTracker {
  // The singleton tracker does not have a storage suffix
  if (fingerprint === LEGACY_FINGERPRINT && goUsageTracker) return goUsageTracker;
  let tracker = goUsageTrackers.get(fingerprint);
  if (tracker) return tracker;
  tracker = new GoUsageTracker(
    extensionContext(),
    (msg) => {
      usageLogChannel().appendLine(`[${new Date().toISOString()}] [${fingerprint}] ${msg}`);
    },
    (modelId) => modelMetadataSnapshot?.providers[GO_VENDOR]?.[modelId]?.cost,
    fingerprint,
    usageTrackerOptions(),
  );
  goUsageTrackers.set(fingerprint, tracker);
  return tracker;
}

/** Return the tracker for the currently active profile. */
function activeGoUsageTracker(): GoUsageTracker | undefined {
  if (activeProfileFingerprint === LEGACY_FINGERPRINT) return goUsageTracker;
  return goUsageTrackers.get(activeProfileFingerprint);
}

/** Switch the active profile and refresh the UI. */
async function setActiveProfile(fingerprint: string): Promise<void> {
  activeProfileFingerprint = fingerprint;
  await writeActiveProfile(extensionContext(), fingerprint);
  refreshGoUsageStatusBar();
  updateWebviewContent();
}

/**
 * Ensure a profile exists in the in-memory cache for the given API key.
 * This is called both from provideLanguageModelChatInformation (at startup,
 * when VS Code resolves all providers) and from onTransportSummary (when
 * a request completes). The first call creates the profile; subsequent
 * calls are no-ops. Persistence is fire-and-forget.
 */
function ensureProfileSync(apiKey: string): void {
  const fp = keyFingerprint(apiKey);
  const tracker = getOrCreateTracker(fp);

  if (!findProfile(profilesCache, fp)) {
    const nextNumber = nonLegacyCount(profilesCache) + 1;
    profilesCache.push({
      fingerprint: fp,
      label: `Profile ${String(nextNumber)}`,
      lastSeenAt: Date.now(),
    });
    void writeProfiles(extensionContext(), profilesCache);
  }

  // One-time migration from singleton
  if (!readMigratedTo(extensionContext())) {
    if (goUsageTracker && fp !== LEGACY_FINGERPRINT) {
      tracker.migrateFromSingleton();
    }
    void writeMigratedTo(extensionContext(), fp);
    profilesCache = readProfiles(extensionContext());
  }

  // Update active profile to this one
  activeProfileFingerprint = fp;
  void writeActiveProfile(extensionContext(), fp);
}

/**
 * Same as ensureProfileSync, but also refreshes the UI.
 * Called from onTransportSummary during request recording.
 */
function ensureProfileForApiKey(apiKey: string): GoUsageTracker {
  ensureProfileSync(apiKey);
  // Remember which API key owns each profile, so status-bar refreshes can
  // sync the ACTIVE profile's meters with its own key instead of the
  // extension secret (which may belong to another account).
  profileApiKeys.set(keyFingerprint(apiKey), apiKey);
  return getOrCreateTracker(keyFingerprint(apiKey));
}

let _extensionContext: vscode.ExtensionContext | undefined;
let _usageLogChannel: vscode.OutputChannel | undefined;

/**
 * Returns the extension context, or throws if the extension has not been
 * activated yet. Callers must be reached after `activate()` has run.
 */
function extensionContext(): vscode.ExtensionContext {
  if (!_extensionContext) {
    throw new Error("extension context not initialized");
  }
  return _extensionContext;
}

/**
 * Returns the usage log output channel, or throws if the extension has not
 * been activated yet. Callers must be reached after `activate()` has run.
 */
function usageLogChannel(): vscode.OutputChannel {
  if (!_usageLogChannel) {
    throw new Error("usage log channel not initialized");
  }
  return _usageLogChannel;
}

interface ProviderDefinition {
  vendor: AllProviderVendor;
  displayName: string;
  modelNamePrefix: string;
  modelsUrl: string;
  chatCompletionsUrl: string;
  messagesUrl: string;
  responsesUrl?: string;
  testModelId: string;
  fallbackModels: string[];
  filterModel?: (modelId: string) => boolean;
  /** When true, this provider only serves agent-host models (targetChatSessionType=copilotcli). */
  isAgentVariant?: boolean;
  /** The vendor key for the main (non-agent) provider definition this variant mirrors. */
  baseVendor?: typeof GO_VENDOR | typeof ZEN_VENDOR;
}

type ModelEndpointKind = "chat-completions" | "messages" | "responses" | "google";

let cachedUserAgent: string | undefined;

/**
 * Build the User-Agent string from the extension's declared version.
 *
 * CONTRACT:
 * - Reads `context.extension.packageJSON.version` once, caches the result.
 * - Falls back to {@link FALLBACK_USER_AGENT} when version is unavailable
 *   (e.g. tests that construct a stub context).
 * - Avoids the drift that previously hardcoded a version literal here
 *   (issue #78: header reported `0.3.6` while package.json was `0.4.1`).
 */
function getUserAgent(): string {
  if (cachedUserAgent) return cachedUserAgent;
  const packageJSON = vscode.extensions.getExtension("ltmoerdani.opencode-copilot-chat")?.packageJSON as { version?: unknown } | undefined;
  const version = typeof packageJSON?.version === "string" ? packageJSON.version : undefined;
  cachedUserAgent = version ? `opencode-copilot-chat/${version} VSCode` : FALLBACK_USER_AGENT;
  return cachedUserAgent;
}

/**
 * Classify a fetch error as transient (worth retrying) vs. permanent.
 *
 * RULES:
 * - Network-layer errors (DNS, TCP reset, connect timeout, socket errors)
 *   are transient — undici exposes the real code via `error.cause`.
 * - HTTP 4xx (except 408/429) is permanent — retrying won't help.
 * - HTTP 408/429/5xx is transient — gateway/rate-limit style failures.
 *   These arrive via the "Model list request failed (NNN): ..." message
 *   that `fetchModels()` throws on a non-2xx response.
 * - AbortError from a CancellationToken is NEVER retried. TimeoutError from
 *   AbortSignal.timeout is transient and can be retried.
 */
function isTransientFetchError(error: unknown): boolean {
  // DOMException is a global since Node 17; guard anyway so a hypothetical
  // older host never crashes inside error classification.
  if (typeof DOMException === "function" && error instanceof DOMException) {
    if (error.name === "AbortError") return false;
    if (error.name === "TimeoutError") return true;
  }
  const cause = (error as { cause?: { code?: string; name?: string } } | undefined)?.cause;
  const code = cause?.code ?? (error as { code?: string } | undefined)?.code;
  const name = cause?.name ?? (error as { name?: string } | undefined)?.name;
  // undici network error codes
  if (code && /^E(AI_AGAIN|CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|HOSTUNREACH|NETUNREACH|PROTO|PIPE)$/.test(code)) {
    return true;
  }
  if (name && /^UND_ERR_(CONNECT_TIMEOUT|SOCKET|REQUEST_TIMEOUT)$/.test(name)) {
    return true;
  }
  // TypeError: fetch failed (the generic wrapper undici throws) — always retry;
  // if the cause turns out to be non-transient, the inner check above handles it.
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  // Extract HTTP status from either an explicit `.status` field or the
  // "Model list request failed (NNN): ..." message pattern.
  const explicitStatus = (error as { status?: number } | undefined)?.status;
  const msg = getErrorMessage(error);
  const msgMatch = msg.match(/\((\d{3})\)/);
  const httpStatus = typeof explicitStatus === "number" ? explicitStatus : msgMatch ? Number(msgMatch[1]) : undefined;
  if (typeof httpStatus === "number") {
    if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return true;
    return false;
  }
  return false;
}

/** Create an agent-variant provider definition that inherits URLs, models, and filters from a base. */
function providerVariant(
  base: ProviderDefinition,
  agentVendor: typeof AGENT_GO_VENDOR | typeof AGENT_ZEN_VENDOR,
  displayName: string,
): ProviderDefinition {
  return {
    vendor: agentVendor,
    displayName,
    modelNamePrefix: base.modelNamePrefix,
    modelsUrl: base.modelsUrl,
    chatCompletionsUrl: base.chatCompletionsUrl,
    messagesUrl: base.messagesUrl,
    responsesUrl: base.responsesUrl,
    testModelId: base.testModelId,
    fallbackModels: base.fallbackModels,
    filterModel: base.filterModel,
  };
}

const PROVIDERS: Record<ProviderDefinition["vendor"], ProviderDefinition> = (() => {
  const go: ProviderDefinition = {
    vendor: GO_VENDOR,
    displayName: "OpenCode Go",
    modelNamePrefix: "OpenCode Go",
    modelsUrl: "https://opencode.ai/zen/go/v1/models",
    chatCompletionsUrl: "https://opencode.ai/zen/go/v1/chat/completions",
    messagesUrl: "https://opencode.ai/zen/go/v1/messages",
    responsesUrl: "https://opencode.ai/zen/go/v1/responses",
    testModelId: "deepseek-v4-flash",
    fallbackModels: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "glm-5.1",
      "glm-5",
      "hy3-preview",
      "kimi-k2.6",
      "kimi-k2.5",
      "mimo-v2-omni",
      "mimo-v2-pro",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m2.7",
      "minimax-m2.5",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
      "qwen3.5-plus",
      "gpt-5.6-luna",
    ],
  };
  const zen: ProviderDefinition = {
    vendor: ZEN_VENDOR,
    displayName: "OpenCode Zen",
    modelNamePrefix: "OpenCode Zen",
    modelsUrl: "https://opencode.ai/zen/v1/models",
    chatCompletionsUrl: "https://opencode.ai/zen/v1/chat/completions",
    messagesUrl: "https://opencode.ai/zen/v1/messages",
    responsesUrl: "https://opencode.ai/zen/v1/responses",
    testModelId: "deepseek-v4-flash-free",
    fallbackModels: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4",
      "claude-haiku-4-5",
      "deepseek-v4-flash-free",
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "gemini-3-flash",
      "glm-5.1",
      "glm-5",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5",
      "gpt-5-codex",
      "gpt-5-nano",
      "grok-build-0.1",
      "kimi-k2.6",
      "kimi-k2.5",
      "minimax-m2.7",
      "minimax-m2.5",
      "minimax-m2.5-free",
      "nemotron-3-super-free",
      "qwen3.6-plus",
      "qwen3.6-plus-free",
      "qwen3.5-plus",
      "big-pickle",
    ],
    filterModel: (modelId) =>
      vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_FREE_ONLY, true)
        ? modelId.endsWith("-free") || FREE_ZEN_MODEL_IDS.has(modelId)
        : true,
  };
  return {
    [GO_VENDOR]: go,
    [ZEN_VENDOR]: zen,
    [AGENT_GO_VENDOR]: { ...providerVariant(go, AGENT_GO_VENDOR, "OpenCode Go (Agents)"), isAgentVariant: true, baseVendor: GO_VENDOR },
    [AGENT_ZEN_VENDOR]: {
      ...providerVariant(zen, AGENT_ZEN_VENDOR, "OpenCode Zen (Agents)"),
      isAgentVariant: true,
      baseVendor: ZEN_VENDOR,
    },
  };
})();

interface OpenCodeModel extends vscode.LanguageModelChatInformation {
  endpointKind: ModelEndpointKind;
  provider: ProviderDefinition;
  rawModelId?: string;
  isUserSelectable?: boolean;
  configurationSchema?: vscode.LanguageModelConfigurationSchema;
}

interface ModelListEntry {
  id?: string;
  owned_by?: string;
  status?: string;
  deprecated?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  context_window?: number;
  contextWindow?: number;
  max_output_tokens?: number;
  maxOutputTokens?: number;
  attachment?: boolean;
  image_input?: boolean;
  imageInput?: boolean;
  reasoning?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

interface ModelListResponse {
  data?: ModelListEntry[];
}

interface ConvertedMessageResult {
  messages: ApiMessage[];
  normalizedImageCount: number;
}

/**
 * Reasoning effort levels per model family, sourced from the upstream
 * OpenCode provider transform (anomalyco/opencode, packages/opencode/src/provider/transform.ts):
 *
 *   WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
 *   OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"]
 *
 * For @ai-sdk/openai-compatible (Mimo, and most models routed through
 * chat-completions): the default is WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"].
 * DeepSeek V4 on openai-compatible additionally adds "max" → ["low", "medium", "high", "max"].
 */
interface LanguageModelConfiguration {
  apiKey?: unknown;
}

type ConfiguredLanguageModelInfoOptions = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: LanguageModelConfiguration;
};

type ConfiguredLanguageModelResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  configuration?: LanguageModelConfiguration;
};

/**
 * Hard upper limit (in bytes of raw image data) for a single image embedded
 * in a tool result. MCP screenshots from chrome-devtools-mcp / playwright-mcp
 * are typically 50–300 KB; anything above 1 MB is almost always an oversized
 * raw capture that bloats the request payload (each image becomes a base64
 * data URI ≈ 1.33× its byte size) and triggers upstream 400 "Upstream request
 * failed" rejections from OpenCode Go. Larger images are replaced with a
 * placeholder text part so the model still knows an image was returned.
 */

/**
 * Maximum number of image attachments (top-level + tool-result combined) to
 * keep in conversation history before older ones are replaced with a
 * placeholder text note.
 *
 * Rationale (evidence-based, issue #38 follow-up):
 *   - Doc `docs/issues/34-20260720-mcp-tool-result-image-dropped.md` line 264+
 *     documents a 4.6 MB payload causing `400 Upstream request failed` on
 *     `mimo-v2.5` after 8 MCP screenshots accumulated in history (~1-2 MB each
 *     → base64 ~1.33× → 4.6 MB total JSON body).
 *   - VS Code Copilot Chat is *supposed* to trim conversation history based on
 *     `advertisedMaxInputTokens`, but our local estimator under-counts base64
 *     image data (`IMAGE_TOKEN_ESTIMATE = 1024` per image, vs the realistic
 *     ~80K tokens/MB). This means VS Code never sees the true payload weight
 *     and forwards a multi-MB request that the OpenCode Go gateway rejects.
 *   - Keeping the most recent 2 images preserves the immediate agentic context
 *     (the model needs to compare current vs. previous screenshot in most MCP
 *     workflows) while bounding the cumulative payload to a safe ceiling.
 *   - OpenAI and Anthropic vision models auto-resize each image to a patch
 *     budget (1568-2576 px) upstream, so old screenshots lose most of their
 *     pixel value once a newer one arrives — the model rarely benefits from
 *     keeping more than 2 in flight.
 *
 * Older images are replaced with a short placeholder text note so the model
 * still knows a screenshot existed at that point in the conversation (useful
 * for understanding agent-loop context) without incurring the payload cost.
 */

let modelMetadataSnapshot: CachedModelMetadataSnapshot | undefined;
let modelMetadataRefreshPromise: Promise<CachedModelMetadataSnapshot> | undefined;

interface RecentTransportSummary extends TransportRequestSummary {
  recordedAt: string;
  endpointKind: string;
  metadataSource: string;
  requestInitiator?: string;
}

export function activate(context: vscode.ExtensionContext) {
  const goUsageLogChannel = vscode.window.createOutputChannel("OpenCode Go Usage");
  context.subscriptions.push(goUsageLogChannel);
  goUsageTracker = new GoUsageTracker(
    context,
    (msg) => {
      goUsageLogChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
    },
    (modelId) => {
      return modelMetadataSnapshot?.providers[GO_VENDOR]?.[modelId]?.cost;
    },
    "",
    usageTrackerOptions(),
  );
  _extensionContext = context;
  _usageLogChannel = goUsageLogChannel;
  profilesCache = readProfiles(context);
  activeProfileFingerprint = readActiveProfile(context);

  // Eagerly load the tracker for the active profile so the status bar
  // has data to display immediately, even before the first request.
  if (activeProfileFingerprint !== LEGACY_FINGERPRINT) {
    getOrCreateTracker(activeProfileFingerprint);
  }

  ensureUsageStatusBar(context);
  ensureGoUsageStatusBar(context);
  // Startup diagnostic: report whether the CLI history is readable so any
  // silent zero-usage state is immediately visible in the usage output
  // channel (the tracker also logs the exact failure reason on error).
  {
    const startupTracker = activeGoUsageTracker();
    if (startupTracker) {
      const startupSummary = startupTracker.getSummary();
      goUsageLogChannel.appendLine(
        `[go-usage] CLI history available: ${String(startupSummary.sqliteAvailable)} — ` +
          `today=${String(startupSummary.today.requests)} req, codebase=${String(startupSummary.codebase.requests)} req`,
      );
    }
  }
  // Pull the server-accurate account meters once at startup (TTL-guarded).
  void (async () => {
    const apiKey = await context.secrets.get(secretKeyFor(GO_VENDOR));
    if (!apiKey) return;
    await syncTrackerUsage(getOrCreateTracker(keyFingerprint(apiKey)), apiKey);
  })();
  // Read from the root configuration with the FULL setting key: section-scoped
  // reads (getConfiguration("opencodego")) resolve keys relative to the
  // section, which would misread the Zen flag as opencodego.opencodezen.enabled.
  const goProviderEnabled = vscode.workspace.getConfiguration().get<boolean>(providerEnabledSetting(GO_VENDOR), true);
  const zenProviderEnabled = vscode.workspace.getConfiguration().get<boolean>(providerEnabledSetting(ZEN_VENDOR), true);
  const goProvider = new OpenCodeProvider(context, PROVIDERS[GO_VENDOR]);
  const zenProvider = new OpenCodeProvider(context, PROVIDERS[ZEN_VENDOR]);
  const modelInfoProviders: OpenCodeProvider[] = [goProvider, zenProvider];

  const subscriptions: vscode.Disposable[] = [
    // Register the chat providers only while the matching `opencodego.enabled`
    // / `opencodezen.enabled` setting is on, so a disabled provider disappears
    // from the Language Models list and every model picker (its vendor
    // contribution carries the same `when` clause). The provider instances are
    // still created so the management commands keep working for re-enabling.
    ...(goProviderEnabled ? [vscode.lm.registerLanguageModelChatProvider(GO_VENDOR, goProvider)] : []),
    ...(zenProviderEnabled ? [vscode.lm.registerLanguageModelChatProvider(ZEN_VENDOR, zenProvider)] : []),
    vscode.commands.registerCommand("opencodego.manage", () => goProvider.manage()),
    vscode.commands.registerCommand("opencodego.diagnostics", () => goProvider.showDiagnostics()),
    vscode.commands.registerCommand("opencodego.refreshModels", () => goProvider.refreshModels()),
    vscode.commands.registerCommand("opencodego.toggleProvider", () => toggleProviderEnabled(GO_VENDOR, "OpenCode Go")),
    vscode.commands.registerCommand("opencodego.configureUtilityModels", () => configureUtilityModels()),
    vscode.commands.registerCommand("opencodezen.diagnostics", () => zenProvider.showDiagnostics()),
    vscode.commands.registerCommand("opencodezen.manage", () => zenProvider.manage()),
    vscode.commands.registerCommand("opencodezen.refreshModels", () => zenProvider.refreshModels()),
    vscode.commands.registerCommand("opencodezen.toggleProvider", () => toggleProviderEnabled(ZEN_VENDOR, "OpenCode Zen")),
    vscode.commands.registerCommand("opencodego.modelPickerDiagnostics", () => showModelPickerDiagnostics()),
    vscode.commands.registerCommand("opencodego.setThinkingEffort", () => showThinkingEffortPicker()),
    vscode.commands.registerCommand("opencodego.showUsageDetails", () => {
      showUsageWebview(context);
    }),
    vscode.commands.registerCommand("opencodego.refreshUsage", () => {
      refreshGoUsageStatusBar();
    }),
    vscode.commands.registerCommand("opencodego.setUsageTargets", async () => {
      const tracker = activeGoUsageTracker();
      if (!tracker) return;
      const targets = await showUsageTargetEditor(tracker);
      if (targets) {
        tracker.setManualSpentTargets(targets);
        refreshGoUsageStatusBar();
        vscode.window.showInformationMessage("OpenCode Go usage targets updated.");
      }
    }),
    vscode.commands.registerCommand("opencodego.showUsageQuickPick", async () => {
      const tracker = activeGoUsageTracker();
      if (!tracker) return;
      const summary = tracker.getSummary();
      const items = buildUsageQuickPickItems(summary, tracker.hasServerUsage, usageRollingMeterVisible());

      // All-time usage in the current workspace (from the OpenCode CLI
      // history) — replaces the old "Latest Session (est)" estimate row.
      if (usageCodebaseRowVisible()) {
        const codebaseItem: vscode.QuickPickItem = {
          label: "$(repo) Codebase",
          description: formatUsd(summary.codebase.cost),
          detail: `${formatTokenCount(summary.codebase.tokens)} tokens · ${formatCount(summary.codebase.requests)} requests`,
          alwaysShow: true,
        };
        const dailyIdx = items.findIndex((i) => i.kind === vscode.QuickPickItemKind.Separator && i.label === "Daily Summary");
        if (dailyIdx >= 0) {
          items.splice(dailyIdx + 1, 0, codebaseItem);
        } else {
          items.push(codebaseItem);
        }
      }

      // Profile switching section — visible when 2+ profiles exist.
      // Lists ALL profiles; the active one is marked and serves as
      // a no-op picker label while others are clickable switches.
      if (profilesCache.length > 1) {
        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
        for (const p of profilesCache) {
          if (p.fingerprint === activeProfileFingerprint) {
            items.push({
              label: `$(check) ${p.label} (active)`,
              _fp: p.fingerprint,
              _action: "none",
            } as vscode.QuickPickItem & { _fp?: string; _action?: string });
          } else {
            items.push({
              label: `       Switch to ${p.label}`,
              _fp: p.fingerprint,
              _action: "switchProfile",
            } as vscode.QuickPickItem & { _fp?: string; _action?: string });
          }
        }
        items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
      }

      const separator: vscode.QuickPickItem = { label: "", kind: vscode.QuickPickItemKind.Separator };
      const setTargetItem: vscode.QuickPickItem & { _action?: string } = {
        label: "$(edit) Set spent targets…",
        _action: "setUsageTargets",
      };
      const panelItem: vscode.QuickPickItem & { _action?: string } = {
        label: "$(graph) Open full usage panel",
        _action: "showUsageDetails",
      };
      items.push(separator, setTargetItem, panelItem);
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "OpenCode Go — Current Usage",
        title: "Usage Summary",
      });
      if (!picked || !("_action" in picked)) return;
      const action = (picked as { _action: string })._action;
      if (action === "setUsageTargets") {
        vscode.commands.executeCommand("opencodego.setUsageTargets");
      } else if (action === "showUsageDetails") {
        vscode.commands.executeCommand("opencodego.showUsageDetails");
      } else if (action === "openConsole") {
        void vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai"));
      } else if (action === "switchProfile" && "_fp" in picked) {
        void setActiveProfile((picked as { _fp: string })._fp);
      }
    }),
    vscode.commands.registerCommand("opencodego.renameActiveProfile", async () => {
      const active = findProfile(profilesCache, activeProfileFingerprint);
      if (!active) {
        vscode.window.showInformationMessage("No active profile to rename.");
        return;
      }
      const newLabel = await vscode.window.showInputBox({
        title: "Rename Go Profile",
        prompt: `Current label: ${active.label}`,
        value: active.label,
        placeHolder: "e.g. OpenCode Go (Works)",
      });
      if (!newLabel || !newLabel.trim()) return;
      await renameProfile(extensionContext(), activeProfileFingerprint, newLabel);
      profilesCache = readProfiles(extensionContext());
      refreshGoUsageStatusBar();
      updateWebviewContent();
      vscode.window.showInformationMessage(`Profile renamed to "${newLabel}".`);
    }),
    vscode.commands.registerCommand("opencodego.deleteProfile", async () => {
      const profiles = readActiveProfiles(extensionContext());
      if (profiles.length === 0) {
        vscode.window.showInformationMessage("No profiles to delete.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        profiles.map((p) => ({
          label: p.label,
          description: `fingerprint: ${p.fingerprint}`,
          _fp: p.fingerprint,
        })),
        { placeHolder: "Select a profile to delete" },
      );
      if (!picked || !("_fp" in picked)) return;
      const fp = (picked as { _fp: string })._fp;
      const profile = findProfile(profiles, fp);
      if (!profile) return;
      const confirm = await vscode.window.showWarningMessage(
        `Permanently delete profile "${profile.label}"? Its usage history will be removed. This cannot be undone.`,
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") return;

      goUsageTrackers.delete(fp);
      const ctx = extensionContext();
      ctx.globalState.update(`opencodego.usageLog.v1.${fp}`, []);
      ctx.globalState.update(`opencodego.usageBaseline.v1.${fp}`, {});
      ctx.globalState.update(`opencodego.sessionCosts.v1.${fp}`, []);

      const remaining = readProfiles(ctx).filter((p) => p.fingerprint !== fp);
      await writeProfiles(ctx, remaining);
      profilesCache = remaining;

      if (activeProfileFingerprint === fp) {
        activeProfileFingerprint = LEGACY_FINGERPRINT;
        await writeActiveProfile(ctx, LEGACY_FINGERPRINT);
      }

      refreshGoUsageStatusBar();
      updateWebviewContent();
      vscode.window.showInformationMessage(`Profile "${profile.label}" deleted.`);
    }),
    vscode.commands.registerCommand("opencodego.configureVisionProxy", async () => {
      await showVisionProxyPicker(context);
      // The proxy model changed — refresh capabilities so VS Code stops
      // stripping images from non-vision models when the proxy is on.
      goProvider.notifyModelInfoChanged();
      zenProvider.notifyModelInfoChanged();
    }),
  ];

  // Agent-host providers for the Copilot Agents window (opt-in via config).
  const enableAgents = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_AGENTS_WINDOW, true);
  if (enableAgents && (goProviderEnabled || zenProviderEnabled)) {
    const agentGoProvider = new OpenCodeProvider(context, PROVIDERS[AGENT_GO_VENDOR]);
    const agentZenProvider = new OpenCodeProvider(context, PROVIDERS[AGENT_ZEN_VENDOR]);
    modelInfoProviders.push(agentGoProvider, agentZenProvider);
    subscriptions.push(
      ...(goProviderEnabled ? [vscode.lm.registerLanguageModelChatProvider(AGENT_GO_VENDOR, agentGoProvider)] : []),
      ...(zenProviderEnabled ? [vscode.lm.registerLanguageModelChatProvider(AGENT_ZEN_VENDOR, agentZenProvider)] : []),
    );
    // On VS Code 1.129+ the Agents window runs in the agent host process,
    // where extension BYOK models are only reachable through VS Code's BYOK
    // language-model bridge — which is off by default. Make sure it is on so
    // OpenCode models actually show up there (issue #122).
    void ensureAgentsWindowSupport(context);
  }

  context.subscriptions.push(...subscriptions);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${SETTING_SHOW_USAGE_STATUS_BAR}`)) {
        resetUsageStatusBar();
      }
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${SETTING_SHOW_PROVIDER_PREFIX}`)) {
        for (const provider of modelInfoProviders) {
          provider.notifyModelInfoChanged();
        }
      }
      if (
        event.affectsConfiguration(`${CONFIG_SECTION}.${SETTING_AGENTS_WINDOW}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${SETTING_AUTO_ENABLE_AGENTS_WINDOW}`)
      ) {
        const agentsWindowEnabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_AGENTS_WINDOW, true);
        const autoEnabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_AUTO_ENABLE_AGENTS_WINDOW, true);
        if (agentsWindowEnabled && autoEnabled) {
          void ensureAgentsWindowSupport(context);
        } else if (!agentsWindowEnabled) {
          // We may have enabled core settings for the Agents window; revert
          // them when the user turns the feature off so the user's global
          // configuration is restored.
          void revertAgentsWindowSupport(context);
        }
      }
      // Any usage-display setting change repaints the status bar / panel
      // immediately (no waiting for the next request or refresh tick).
      if (USAGE_DISPLAY_SETTING_KEYS.some((key) => event.affectsConfiguration(`${CONFIG_SECTION}.${key}`))) {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.${SETTING_USAGE_CHART_DAYS}`)) {
          usageChartWindowDays = vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<number>(SETTING_USAGE_CHART_DAYS, DEFAULT_USAGE_CHART_DAYS);
        }
        refreshGoUsageStatusBar();
        updateWebviewContent();
      }
    }),
  );

  startUsageRefreshLoop(context);

  void warmModelPickerMetadata();

  // Experimental inline code suggestions (issue #49). Opt-in via
  // `opencodego.inlineSuggestions`; the provider reads the config live.
  registerInlineCompletions(context, {
    chatCompletionsUrl: PROVIDERS[GO_VENDOR].chatCompletionsUrl,
    // Same resolution order as the chat path: the active profile's own key
    // first (covers multi-profile / BYOK-group setups), then the secret.
    resolveApiKey: async () => profileApiKeys.get(activeProfileFingerprint) ?? _extensionContext?.secrets.get(secretKeyFor(GO_VENDOR)),
  });
}

async function configureUtilityModels(): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "@id:chat.byokUtilityModelDefault @id:chat.utilityModel @id:chat.utilitySmallModel",
  );
}

/**
 * Toggle whether a provider (`opencodego` / `opencodezen`) is registered at
 * all. Disabling removes the provider from the Language Models list and every
 * model picker — the provider's vendor contribution is gated by the same
 * `when` clause (`config.<vendor>.enabled`) and its runtime registration is
 * skipped. Previously configured BYOK groups and API keys are kept, so
 * re-enabling restores the provider exactly as it was.
 *
 * Provider registration happens at startup, so a window reload is required
 * for the change to take effect.
 */
async function toggleProviderEnabled(vendor: string, displayName: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(vendor);
  const current = cfg.get<boolean>(SETTING_ENABLED, true);
  const next = !current;
  await cfg.update("enabled", next, vscode.ConfigurationTarget.Global);

  const reload = await vscode.window.showInformationMessage(
    next
      ? `${displayName} re-enabled. Reload the window for the provider to appear in Language Models again.`
      : `${displayName} removed from Language Models. Reload the window for it to disappear from the model picker and the manage list. Your API key and group settings are kept.`,
    "Reload Now",
  );
  if (reload === "Reload Now") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

/**
 * Whether this VS Code has the modern agent-host BYOK bridge (1.129+).
 *
 * From VS Code 1.129 the Agents window runs in a separate agent host
 * process. Extension-provided BYOK models (isBYOK, no `targetChatSessionType`)
 * are mirrored into agent-host sessions exclusively through the BYOK
 * language-model bridge, which VS Code keeps OFF by default
 * (`chat.agentHost.byokModels.enabled`, experimental). On older versions the
 * extension's own agent-host providers (`targetChatSessionType: "copilotcli"`)
 * are the only path, which is why they stay registered.
 */
function isModernAgentHostVscode(): boolean {
  const [major = 1, minor = 0] = vscode.version.split(".").map(Number);
  return major > 1 || (major === 1 && minor >= AGENT_HOST_BYOK_MINOR_VERSION);
}

/**
 * Ensure the VS Code core settings that make OpenCode Go/Zen models usable in
 * the Agents window are enabled (issue #122):
 *
 * 1. `extensions.supportAgentsWindow.<id>` — the only way a code extension is
 *    allowed to run in the Agents window (sessions window) process. VS Code
 *    disables any extension with a `main` entry there by default, so without
 *    this setting the extension's `languageModelChatProviders` vendors are
 *    not registered in that window: neither the model picker nor the
 *    "+ Add Models" list can show OpenCode Go/Zen.
 * 2. `chat.agentHost.byokModels.enabled` (VS Code 1.129+) — the BYOK
 *    language-model bridge that mirrors extension BYOK models into
 *    agent-host sessions. Off by default and experimental.
 *
 * CONTRACT:
 * - Only writes the settings while the user keeps `opencodego.agentsWindow`
 *   and `opencodego.autoEnableAgentsWindow` on; the settings are merged with
 *   existing user values (never clobbering unrelated entries).
 * - Records in globalState which settings the extension flipped itself, so
 *   {@link revertAgentsWindowSupport} can restore them when the user disables
 *   the Agents feature.
 * - Both settings take effect after a window reload (extension host /
 *   agent host restart) — surface an actionable notification the first time
 *   anything was changed.
 */
async function ensureAgentsWindowSupport(context: vscode.ExtensionContext): Promise<void> {
  const opencodeCfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (!opencodeCfg.get<boolean>(SETTING_AGENTS_WINDOW, true) || !opencodeCfg.get<boolean>(SETTING_AUTO_ENABLE_AGENTS_WINDOW, true)) {
    return;
  }

  let changed = false;
  const extensionCfg = vscode.workspace.getConfiguration("extensions");
  const support = extensionCfg.get<Record<string, boolean>>(SUPPORT_AGENTS_WINDOW_SETTING, {});
  if (!support[EXTENSION_ID]) {
    await extensionCfg.update(SUPPORT_AGENTS_WINDOW_SETTING, { ...support, [EXTENSION_ID]: true }, vscode.ConfigurationTarget.Global);
    await context.globalState.update(SUPPORT_AGENTS_WINDOW_STATE_KEY, true);
    changed = true;
  }

  if (isModernAgentHostVscode()) {
    const agentHostCfg = vscode.workspace.getConfiguration("chat.agentHost");
    if (!agentHostCfg.get<boolean>(AGENT_HOST_BYOK_ENABLED_SETTING, false)) {
      await agentHostCfg.update(AGENT_HOST_BYOK_ENABLED_SETTING, true, vscode.ConfigurationTarget.Global);
      await context.globalState.update(AGENTS_BYOK_BRIDGE_STATE_KEY, true);
      changed = true;
    }
  }

  if (changed) {
    const reload = await vscode.window.showInformationMessage(
      "OpenCode: enabled VS Code's Agents window support so OpenCode Go/Zen models can run in the Agents window. Reload the window for it to take effect.",
      "Reload Now",
    );
    if (reload === "Reload Now") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }
}

/**
 * Revert the core settings that {@link ensureAgentsWindowSupport} enabled on
 * this machine (and only those — settings the user configured manually are
 * left untouched).
 */
async function revertAgentsWindowSupport(context: vscode.ExtensionContext): Promise<void> {
  const extensionCfg = vscode.workspace.getConfiguration("extensions");
  if (context.globalState.get<boolean>(SUPPORT_AGENTS_WINDOW_STATE_KEY)) {
    const support = extensionCfg.get<Record<string, boolean>>(SUPPORT_AGENTS_WINDOW_SETTING, {});
    if (support[EXTENSION_ID]) {
      const next: Record<string, boolean> = Object.fromEntries(Object.entries(support).filter(([id]) => id !== EXTENSION_ID));
      await extensionCfg.update(
        SUPPORT_AGENTS_WINDOW_SETTING,
        Object.keys(next).length > 0 ? next : undefined,
        vscode.ConfigurationTarget.Global,
      );
    }
    await context.globalState.update(SUPPORT_AGENTS_WINDOW_STATE_KEY, undefined);
  }

  if (context.globalState.get<boolean>(AGENTS_BYOK_BRIDGE_STATE_KEY)) {
    await vscode.workspace
      .getConfiguration("chat.agentHost")
      .update(AGENT_HOST_BYOK_ENABLED_SETTING, false, vscode.ConfigurationTarget.Global);
    await context.globalState.update(AGENTS_BYOK_BRIDGE_STATE_KEY, undefined);
  }
}

async function warmModelPickerMetadata(): Promise<void> {
  const vendors: string[] = [
    ...(vscode.workspace.getConfiguration().get<boolean>(providerEnabledSetting(GO_VENDOR), true) ? [GO_VENDOR] : []),
    ...(vscode.workspace.getConfiguration().get<boolean>(providerEnabledSetting(ZEN_VENDOR), true) ? [ZEN_VENDOR] : []),
  ];
  if (vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_AGENTS_WINDOW, true) && vendors.length > 0) {
    vendors.push(AGENT_GO_VENDOR, AGENT_ZEN_VENDOR);
  }
  await Promise.allSettled(vendors.map((v) => vscode.lm.selectChatModels({ vendor: v })));
}

async function showModelPickerDiagnostics(): Promise<void> {
  const vendors: string[] = [GO_VENDOR, ZEN_VENDOR, "copilot"];
  if (vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_AGENTS_WINDOW, true)) {
    vendors.splice(2, 0, AGENT_GO_VENDOR, AGENT_ZEN_VENDOR);
  }
  const sections: string[] = [];

  for (const vendor of vendors) {
    const models = await vscode.lm.selectChatModels({ vendor });
    sections.push(`## vendor: ${vendor}`, "", `models: ${String(models.length)}`, "");
    for (const model of models) {
      const internalModel = model as unknown as { configurationSchema?: unknown; detail?: unknown };
      const schema = internalModel.configurationSchema;
      sections.push(
        `### ${model.name}`,
        "",
        `- id: \`${model.id}\``,
        `- family: \`${model.family}\``,
        `- version: \`${model.version}\``,
        `- vendor: \`${model.vendor}\``,
        `- detail: \`${typeof internalModel.detail === "string" ? internalModel.detail : ""}\``,
        `- schema:`,
        "```json",
        JSON.stringify(schema ?? null, null, 2),
        "```",
        "",
      );
    }
  }

  const doc = await vscode.workspace.openTextDocument({
    content: ["# OpenCode Model Picker Diagnostics", "", ...sections].join("\n"),
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function showThinkingEffortPicker(): Promise<void> {
  const families: { label: string; key: keyof ThinkingSettings; options: string[] }[] = [
    { label: "DeepSeek (deepseek-v4-*)", key: "deepseek", options: ["off", "low", "medium", "high", "max"] },
    { label: "GLM (glm-5, glm-5.1, glm-5.2)", key: "glm", options: ["off", "high", "max"] },
    { label: "Kimi (kimi-k2.*)", key: "kimi", options: ["on", "off"] },
    { label: "Mimo (mimo-v2.*)", key: "mimo", options: ["off", "low", "medium", "high"] },
    { label: "MiniMax (minimax-m*)", key: "minimax", options: ["off", "on"] },
    { label: "OpenAI GPT (gpt-*)", key: "openai", options: ["off", "low", "medium", "high", "xhigh"] },
    { label: "Qwen (qwen3.*)", key: "qwen", options: ["auto", "on", "off"] },
    { label: "Qwen Thinking Budget", key: "qwenBudget", options: ["auto", "4096", "16384", "32768", "81920"] },
  ];
  const settings = getSettings().thinking;
  const family = await vscode.window.showQuickPick(
    families.map((f) => ({ label: f.label, description: `current: ${settings[f.key]}`, family: f })),
    { placeHolder: "Pick a model family to configure Thinking" },
  );
  if (!family) return;
  const choice = await vscode.window.showQuickPick(family.family.options, {
    placeHolder: `Set ${family.family.label} → Thinking value`,
  });
  if (!choice) return;
  const cfg = vscode.workspace.getConfiguration(`${CONFIG_SECTION}.thinking`);
  await cfg.update(family.family.key, choice, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`OpenCode Thinking — ${family.family.label}: ${choice}`);
}

export async function deactivate(): Promise<void> {
  // no-op: experimental context indicator hooks removed in 0.1.8
}

function ensureUsageStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  if (!usageStatusBarItem) {
    usageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
    context.subscriptions.push(usageStatusBarItem);
  }

  resetUsageStatusBar();
  return usageStatusBarItem;
}

function shouldShowUsageStatusBar(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get(SETTING_SHOW_USAGE_STATUS_BAR, true);
}

function resetUsageStatusBar(): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  usageStatusBarItem.text = "OpenCode";
  usageStatusBarItem.tooltip = "OpenCode usage summary";
  usageStatusBarItem.show();
}

function updateUsageStatusBar(providerDisplayName: string, modelId: string, summary: TransportRequestSummary): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  const usage: UsageSnapshot = {
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    cachedTokens: summary.cachedTokens,
    finishReason: summary.finishReason,
  };
  const text = formatUsageStatusBarText(providerDisplayName, usage);

  usageStatusBarItem.text = text ?? providerDisplayName;
  usageStatusBarItem.tooltip = formatUsageStatusBarTooltip(providerDisplayName, modelId, usage);
  usageStatusBarItem.show();
}

function ensureGoUsageStatusBar(context: vscode.ExtensionContext): void {
  if (goUsageStatusBarItem) return;
  goUsageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 94);
  goUsageStatusBarItem.command = "opencodego.showUsageQuickPick";
  context.subscriptions.push(goUsageStatusBarItem);
  refreshGoUsageStatusBar();
}

function refreshGoUsageStatusBar(): void {
  if (!goUsageStatusBarItem) return;
  const tracker = activeGoUsageTracker();
  if (!tracker) {
    goUsageStatusBarItem.text = "OpenCode Go";
    goUsageStatusBarItem.tooltip = new vscode.MarkdownString("");
    goUsageStatusBarItem.show();
    return;
  }
  const s = tracker.getSummary();
  const activeProfile = findProfile(profilesCache, activeProfileFingerprint);
  const baseText = formatGoUsageStatusBarText(s);
  goUsageStatusBarItem.text = activeProfile && profilesCache.length > 1 ? `${baseText} [${activeProfile.label}]` : baseText;
  goUsageStatusBarItem.tooltip = buildUsageTooltip(s);
  goUsageStatusBarItem.show();
  updateWebviewContent();

  // Refresh the server-accurate meters in the background (TTL-guarded); when
  // a new snapshot lands, rebuild the status bar with it. Use the active
  // profile's own key when known, falling back to the extension secret.
  void (async () => {
    const apiKey = profileApiKeys.get(activeProfileFingerprint) ?? (await _extensionContext?.secrets.get(secretKeyFor(GO_VENDOR)));
    if (!apiKey) return;
    const changed = await tracker.syncServerUsage(apiKey);
    if (changed) refreshGoUsageStatusBar();
  })();
}

/**
 * Fetch server-accurate usage for a key and repaint the status bar when a new
 * snapshot arrived. Uses the tracker owning that key (creating its profile on
 * first use), so multi-account setups keep per-key meters.
 */
async function syncTrackerUsage(tracker: GoUsageTracker, apiKey: string): Promise<void> {
  const changed = await tracker.syncServerUsage(apiKey);
  if (changed) refreshGoUsageStatusBar();
}

function showUsageWebview(context: vscode.ExtensionContext): void {
  if (usageWebviewPanel) {
    usageWebviewPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  usageWebviewPanel = vscode.window.createWebviewPanel("opencodego.usageWebview", "OpenCode Usage", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  usageWebviewPanel.onDidDispose(
    () => {
      usageWebviewPanel = undefined;
      usageWebviewRendered = false;
    },
    null,
    context.subscriptions,
  );

  usageWebviewPanel.webview.onDidReceiveMessage(
    (message: { type?: string }) => {
      switch (message.type) {
        case "refresh":
          refreshGoUsageStatusBar();
          break;
        case "setTargets":
          void vscode.commands.executeCommand("opencodego.setUsageTargets");
          break;
        case "renameProfile":
          void vscode.commands.executeCommand("opencodego.renameActiveProfile");
          break;
        case "window": {
          const days = Number((message as { days?: unknown }).days);
          if (Number.isFinite(days) && days >= 0 && days <= 370) {
            usageChartWindowDays = days;
            updateWebviewContent();
          }
          break;
        }
      }
    },
    null,
    context.subscriptions,
  );

  usageWebviewRendered = false;
  updateWebviewContent();
}

/** Escape a JSON payload for embedding in an HTML <script> block. */
function jsonForWebview(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

/** Whether the usage webview has received its initial HTML (data flows via postMessage after that). */
let usageWebviewRendered = false;
/** Selected chart window in days (0 = lifetime); the webview toggles it via message. */
let usageChartWindowDays: number = vscode.workspace
  .getConfiguration(CONFIG_SECTION)
  .get<number>(SETTING_USAGE_CHART_DAYS, DEFAULT_USAGE_CHART_DAYS);

/** Build the chart/stat payload shown by the usage webview. */
function usageWebviewData(): Record<string, unknown> | undefined {
  if (!goUsageTracker) return undefined;
  const tracker = activeGoUsageTracker();
  if (!tracker) return undefined;
  const s = tracker.getSummary();
  const windowDays = usageChartWindowDays;
  const series = tracker.getUsageSeries(windowDays);
  const completionDays = contextCompletionUsage();
  // The completion series must share the EXACT day buckets of the usage
  // series (they can differ in length on lifetime windows), otherwise the
  // charts misalign and hovers resolve to undefined values.
  const completions = completionUsageToSeries(
    completionDays,
    trackerDayStart(tracker),
    windowDays,
    series.days.length > 0 ? series.days[0].dayStart : undefined,
  );
  const activeProfile = findProfile(profilesCache, activeProfileFingerprint);
  const showRolling = usageRollingMeterVisible();

  const rings = [
    ...(showRolling
      ? [
          {
            key: "session",
            label: "Session (5h)",
            percent: s.session.percent,
            spent: s.session.spent,
            limit: s.session.limit,
            resetsIn: formatRelativeTime(s.session.resetsAt),
          },
        ]
      : []),
    {
      key: "weekly",
      label: "Weekly",
      percent: s.weekly.percent,
      spent: s.weekly.spent,
      limit: s.weekly.limit,
      resetsIn: formatRelativeTime(s.weekly.resetsAt),
    },
    {
      key: "monthly",
      label: "Monthly",
      percent: s.monthly.percent,
      spent: s.monthly.spent,
      limit: s.monthly.limit,
      resetsIn: formatRelativeTime(s.monthly.resetsAt),
    },
  ];

  return {
    profile: activeProfile?.label ?? "OpenCode Go",
    showRename: nonLegacyCount(profilesCache) > 0,
    windowDays,
    completions,
    rings,
    stats: {
      total: { label: "Codebase", cost: s.codebase.cost, tokens: s.codebase.tokens, requests: s.codebase.requests },
      today: { label: "Today", cost: s.today.cost, tokens: s.today.tokens, requests: s.today.requests },
      yesterday: { label: "Yesterday", cost: s.yesterday.cost, tokens: s.yesterday.tokens, requests: s.yesterday.requests },
    },
    days: series.days,
    byModel: series.byModel,
  };
}

/** Read the persisted per-day completion counters. */
function contextCompletionUsage(): CompletionUsageDay[] {
  const stored = _extensionContext?.globalState.get<CompletionUsageDay[]>(COMPLETION_USAGE_KEY, []);
  return Array.isArray(stored) ? stored : [];
}

/** Day-start used by the current tracker (matches the chart boundary). */
function trackerDayStart(_tracker: GoUsageTracker): number {
  const now = new Date();
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<"utc" | "local">(SETTING_USAGE_DAY_BOUNDARY, "utc") === "local"
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function updateWebviewContent(): void {
  if (!usageWebviewPanel || !goUsageTracker) return;
  const data = usageWebviewData();
  if (!data) {
    usageWebviewPanel.webview.html = `<html><body><p>No active tracker</p></body></html>`;
    usageWebviewRendered = false;
    return;
  }

  if (!usageWebviewRendered) {
    // First paint: render the full page. Later refreshes only push new data
    // via postMessage so the user's active tab and chart stay in place.
    usageWebviewPanel.webview.html = usageWebviewHtml(String(data.profile));
    usageWebviewRendered = true;
  }
  void usageWebviewPanel.webview.postMessage({ type: "usage", data });
}

function usageWebviewHtml(profileLabel: string): string {
  const data = usageWebviewData() ?? {};
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">
    <title>OpenCode Usage</title>
    <style>
      :root{
        --bg-0: #101216; --bg-1: #161a20; --bg-2: #1b2029; --bg-3: #222936;
        --line: #242a33; --line-soft: #1b2028;
        --text-hi: #eef1f5; --text-mid: #9aa4b2; --text-lo: #5b6472;
        --amber: #e3b341; --teal: #3fdbb0; --coral: #ef7f6b; --blue: #5aa9ff; --violet: #a98ef9;
        --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
        --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        --s: clamp(10px, 1.6vh, 18px);
        --radius: clamp(8px, 1vh, 14px);
      }
      *{box-sizing:border-box; margin:0; padding:0;}
      html, body{ height:100%; width:100%; overflow:hidden; background:var(--bg-0); color:var(--text-hi); font-family:var(--sans); -webkit-font-smoothing:antialiased; }
      body{
        display:grid; grid-template-rows:auto auto 1fr; grid-template-areas:"topbar" "rings" "main";
        row-gap: var(--s); height:100vh; padding: var(--s);
        background:
          radial-gradient(1100px 500px at 90% -20%, rgba(227,179,65,0.05), transparent 60%),
          radial-gradient(900px 500px at -10% 0%, rgba(63,219,176,0.04), transparent 55%),
          var(--bg-0);
      }
      ::selection{ background:#7a6427; color:var(--text-hi); }
      *{ min-width:0; min-height:0; }

      .topbar{ grid-area:topbar; display:flex; align-items:center; gap: var(--s); }
      .topbar .actions{ margin-left:auto; display:flex; gap: calc(var(--s)/2); flex:none; }
      .brand{ display:flex; align-items:center; gap: clamp(6px,1vw,10px); min-width:0; }
      .brand .mark{
        width: clamp(20px, 2.4vh, 28px); height: clamp(20px, 2.4vh, 28px);
        border-radius: 7px; background:linear-gradient(135deg, var(--amber), var(--coral));
        display:flex; align-items:center; justify-content:center;
        font-family:var(--mono); font-weight:700; font-size: clamp(9px, 1.2vh, 12px);
        line-height:1; color:#141205; flex:none;
      }
      .brand .name{ font-weight:700; font-size: clamp(12px, 1.6vh, 15px); letter-spacing:-0.01em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .brand .sub{ color:var(--text-lo); font-size: clamp(9px, 1.1vh, 11px); font-family:var(--mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

      .rings-row{ grid-area:rings; display:flex; gap: var(--s); }
      .ring-card{
        flex:1 1 0; background:var(--bg-1); border:1px solid var(--line-soft); border-radius: var(--radius);
        padding: var(--s); display:flex; align-items:center; gap: var(--s); overflow:hidden;
      }
      .ring-wrap{ position:relative; width: clamp(38px, 6vh, 58px); height: clamp(38px, 6vh, 58px); flex:none; }
      .ring-wrap svg{ width:100%; height:100%; transform:rotate(-90deg); display:block; }
      .ring-bg{ fill:none; stroke:var(--bg-3); stroke-width:8; }
      .ring-fg{ fill:none; stroke-width:8; stroke-linecap:round; transition:stroke-dashoffset 1s cubic-bezier(.4,0,.2,1); }
      .ring-card.session .ring-fg{ stroke:var(--blue); }
      .ring-card.weekly .ring-fg{ stroke:var(--amber); }
      .ring-card.monthly .ring-fg{ stroke:var(--teal); }
      .ring-pct{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-family:var(--mono); font-weight:700; font-size: clamp(9px, 1.4vh, 13px); }
      .ring-info{ min-width:0; overflow:hidden; }
      .ring-info .label{ font-size: clamp(10px, 1.3vh, 12.5px); font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ring-info .reset{ font-family:var(--mono); font-size: clamp(8.5px, 1vh, 10.5px); color:var(--text-lo); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ring-info .amounts{ font-family:var(--mono); font-size: clamp(9.5px, 1.2vh, 12px); color:var(--text-mid); margin-top: clamp(3px,0.5vh,6px); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ring-info .amounts b{ color:var(--text-hi); font-weight:700; }

      .main-panel{
        grid-area:main; background:var(--bg-1); border:1px solid var(--line-soft); border-radius: var(--radius);
        padding: var(--s); display:flex; flex-direction:column; gap: var(--s); overflow:hidden; position:relative;
      }
      .panel-top{ display:flex; align-items:center; justify-content:space-between; gap: var(--s); flex:none; flex-wrap:nowrap; }
      .tabs{ display:flex; gap: calc(var(--s)/3); background:var(--bg-2); border:1px solid var(--line-soft); border-radius: calc(var(--radius) - 2px); padding: calc(var(--s)/5); flex:none; }
      .tab-btn{
        font-family:var(--sans); font-weight:600; font-size: clamp(9.5px, 1.1vh, 11.5px);
        padding: calc(var(--s)/2.4) calc(var(--s)*0.85); border-radius: calc(var(--radius) - 4px);
        border:none; background:transparent; color:var(--text-mid); cursor:pointer; white-space:nowrap;
        transition: background .15s ease, color .15s ease;
      }
      .tab-btn:hover{ color:var(--text-hi); }
      .tab-btn.active{ background:var(--bg-3); color:var(--text-hi); }
      .tab-btn .sw{ display:inline-block; width:7px; height:7px; border-radius:2px; margin-right:6px; opacity:.55; }
      .tab-btn.active .sw{ opacity:1; }

      .stat-chips{ display:flex; gap: var(--s); flex:none; }
      .stat-chip{ text-align:right; }
      .stat-chip .k{ font-size: clamp(8.5px, 1vh, 10px); color:var(--text-lo); text-transform:uppercase; letter-spacing:.05em; white-space:nowrap; }
      .stat-chip .v{ font-family:var(--mono); font-weight:700; font-size: clamp(12px, 1.5vh, 15px); color:var(--text-hi); white-space:nowrap; margin-top:2px; }

      .chart-box{ position:relative; flex:1; min-height:0; }
      .chart-box svg{ width:100%; height:100%; display:block; overflow:visible; }
      .chart-box text{ font-family:var(--mono); }

      /* cursor-follow tooltip */
      .ttip{
        position:absolute; pointer-events:none; z-index:5; display:none;
        background:var(--bg-3); border:1px solid var(--line); border-radius:6px;
        padding:6px 9px; font-family:var(--mono); font-size:11px; color:var(--text-hi);
        white-space:nowrap; box-shadow:0 4px 14px rgba(0,0,0,.35);
      }
      .ttip .t-line{ color:var(--text-lo); margin-right:6px; }
      .ttip b{ color:var(--text-hi); }
      .ttip .t-sub{ color:var(--text-mid); font-size:10px; margin-top:2px; }

      .btn{
        background:var(--bg-2); border:1px solid var(--line); color:var(--text-mid);
        font-family:var(--sans); font-size: clamp(9.5px, 1.1vh, 11px); font-weight:600;
        padding: clamp(5px, 0.8vh, 8px) clamp(10px, 1.4vh, 14px);
        border-radius: calc(var(--radius) - 4px); text-decoration:none; cursor:pointer;
        white-space:nowrap; transition: background .15s ease, color .15s ease, border-color .15s ease;
      }
      .btn:hover{ background:var(--bg-3); color:var(--text-hi); border-color:var(--text-lo); }
      .btn.primary{ color:var(--text-hi); border-color:var(--line); }
      .btn.primary:hover{ border-color:var(--amber); }

      .legend{ display:flex; gap: clamp(10px, 1.4vh, 16px); flex-wrap:wrap; flex:none; align-items:center; padding: 2px 0 0 2px; }
      .legend .l-item{ display:flex; align-items:center; gap:7px; font-size: clamp(10px, 1.2vh, 12px); line-height:1; color:var(--text-mid); white-space:nowrap; }
      .legend .l-swatch{ width: clamp(10px, 1.2vh, 12px); height: clamp(10px, 1.2vh, 12px); border-radius:3px; flex:none; display:inline-block; }
      .legend .l-more{ color:var(--text-lo); font-size: clamp(9px, 1.05vh, 11px); }

      @media (max-width: 620px){
        .rings-row{ flex-wrap:wrap; }
        .ring-card{ flex:1 1 100%; }
        .panel-top{ flex-wrap:wrap; }
        .stat-chips{ display:none; }
      }
      @media (prefers-reduced-motion: reduce){ *{ transition:none !important; animation:none !important; } }
    </style>
    </head>
    <body>
      <div class="topbar">
        <div class="brand">
          <div class="mark">OC</div>
          <div class="name" id="brandName">${escapeHtml(profileLabel)}</div>
        </div>
        <div class="actions">
          <button class="btn" id="btnWindow" title="Switch the chart window: week / 14 days / month / lifetime">14 days</button>
          <button class="btn" id="btnTargets" title="Set manual spent targets for Session / Weekly / Monthly">Set targets</button>
          <button class="btn" id="btnRename" title="Rename the active profile" style="display:none">Rename</button>
          <button class="btn primary" id="btnRefresh" title="Refresh usage data now">Refresh</button>
        </div>
      </div>

      <div class="rings-row" id="rings"></div>

      <div class="main-panel">
        <div class="panel-top">
          <div class="tabs" id="tabs">
            <button class="tab-btn active" data-metric="spend"><span class="sw" style="background:var(--amber)"></span>Spend</button>
            <button class="tab-btn" data-metric="requests"><span class="sw" style="background:var(--blue)"></span>Requests</button>
            <button class="tab-btn" data-metric="tokens"><span class="sw" style="background:var(--teal)"></span>Tokens</button>
            <button class="tab-btn" data-metric="models"><span class="sw" style="background:var(--coral)"></span>Models</button>
            <button class="tab-btn" data-metric="suggested"><span class="sw" style="background:var(--violet)"></span>Suggested</button>
            <button class="tab-btn" data-metric="approved"><span class="sw" style="background:#7fd1a8"></span>Approved</button>
          </div>
          <div class="stat-chips" id="statChips"></div>
        </div>
        <div class="legend" id="legend"></div>
        <div class="chart-box" id="chartBox">
          <svg id="chartSvg" xmlns="http://www.w3.org/2000/svg"></svg>
          <div class="ttip" id="ttip"></div>
        </div>
      </div>

      <script type="application/json" id="usage-data">${jsonForWebview(data)}</script>
      <script>
      (function () {
        'use strict';
        var vscode = acquireVsCodeApi();
        var DATA = JSON.parse(document.getElementById('usage-data').textContent);
        var MODEL_COLORS = ['#e3b341','#5aa9ff','#3fdbb0','#ef7f6b','#a98ef9','#7fd1a8'];
        var svgNS = 'http://www.w3.org/2000/svg';
        var svg = document.getElementById('chartSvg');
        var box = document.getElementById('chartBox');
        var chips = document.getElementById('statChips');
        var ttip = document.getElementById('ttip');
        var current = 'spend';

        function el(tag, attrs, text) {
          var n = document.createElementNS(svgNS, tag);
          for (var k in attrs) n.setAttribute(k, attrs[k]);
          if (text !== undefined) n.textContent = text;
          return n;
        }
        function clear() { while (svg.firstChild) svg.removeChild(svg.firstChild); }
        function fmtUsd(v) { return v >= 1000 ? '$' + (v/1000).toFixed(2) + 'K' : '$' + v.toFixed(2); }
        function fmtCount(v) {
          if (v >= 1e9) return (v/1e9).toFixed(1) + 'B';
          if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
          if (v >= 1e3) return (v/1e3).toFixed(1) + 'k';
          return String(v);
        }
        function fmtTokens(v) { return fmtCount(v); }
        function dayLabel(ms) {
          var d = new Date(ms);
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        }
        function niceMax(v) {
          if (v <= 0) return 1;
          var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
          var norm = v / mag;
          return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
        }
        // Round tick step (1/2/2.5/5 x 10^n) so axis gaps stay clean: never
        // 1.25 / 2.50 / 3.75-style odd divisions.
        function niceStep(v) {
          if (v <= 0) return 1;
          var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
          var norm = v / mag;
          var cand = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
          return cand * mag;
        }
        // Round the max up to a multiple of a round step, then emit 0..top ticks.
        // forceInt keeps counts whole (suggestions/approvals never show 2.5).
        function axisTicks(maxVal, bands, forceInt) {
          var step = niceStep(maxVal / Math.max(1, bands));
          if (forceInt) step = Math.max(1, Math.round(step));
          var top = Math.ceil(maxVal / step) * step;
          var ticks = [];
          for (var v = top; v > -1e-9; v -= step) ticks.push(Math.round(v * 10000) / 10000);
          return { top: top, step: step, ticks: ticks };
        }
        function fmtAxisUsd(v) {
          if (v >= 1000) return fmtUsd(v);
          return '$' + String(Math.round(v * 100) / 100);
        }
        function metricValues(m) {
          if (m === 'spend') return DATA.days.map(function (d) { return d.cost; });
          if (m === 'requests') return DATA.days.map(function (d) { return d.requests; });
          if (m === 'tokens') return DATA.days.map(function (d) { return d.tokens; });
          var vals = (DATA.completions || []).map(function (d) { return m === 'suggested' ? d.suggested : d.approved; });
          // zero-fill so every day bucket has a value (lifetime ranges differ)
          while (vals.length < DATA.days.length) vals.push(0);
          return vals;
        }
        function metricFmt(m) {
          if (m === 'spend') return fmtUsd;
          return fmtCount;
        }
        function metricUnit(m) {
          if (m === 'spend') return '';
          if (m === 'requests') return ' requests';
          if (m === 'tokens') return ' tokens';
          return m === 'suggested' ? ' suggestions' : ' approvals';
        }
        function metricColor(m) {
          return m === 'spend' ? '#e3b341' : m === 'requests' ? '#5aa9ff' : m === 'tokens' ? '#3fdbb0' : m === 'suggested' ? '#a98ef9' : '#7fd1a8';
        }
        function metricTotal(m) {
          var vals = metricValues(m);
          return vals.reduce(function (a, b) { return a + b; }, 0);
        }
        function showTooltip(x, y, html) {
          ttip.innerHTML = html;
          ttip.style.display = 'block';
          var r = box.getBoundingClientRect();
          var px = x - r.left + 16, py = y - r.top + 14;
          if (px + 220 > r.width) px = x - r.left - 220;
          if (py + 60 > r.height) py = y - r.top - 60;
          ttip.style.left = px + 'px';
          ttip.style.top = py + 'px';
        }
        function hideTooltip() { ttip.style.display = 'none'; }

        function drawLine(m) {
          var W = box.clientWidth, H = box.clientHeight;
          if (!W || !H) return;
          svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
          clear();
          var padL = 44, padR = 10, padT = 12, padB = 24;
          var plotW = Math.max(1, W - padL - padR), plotH = Math.max(1, H - padT - padB);
          var vals = metricValues(m);
          var maxVal = niceMax(Math.max.apply(null, vals) * 1.15);
          var isCount = m === 'suggested' || m === 'approved';
          var axis = axisTicks(maxVal, 4, isCount);
          maxVal = axis.top;
          var color = metricColor(m);
          var fmt = metricFmt(m), unit = metricUnit(m);
          var fmtAxis = m === 'spend' ? fmtAxisUsd : fmt;
          function daySub(day) {
            if (isCount) {
              var c = { suggested: 0, approved: 0 };
              (DATA.completions || []).forEach(function (d) { if (d.dayStart === day.dayStart) c = d; });
              return fmtCount(c.suggested) + ' suggestions · ' + fmtCount(c.approved) + ' approved';
            }
            return fmtCount(day.tokens) + ' tokens · ' + fmtCount(day.requests) + ' requests';
          }
          var n = DATA.days.length;

          var defs = el('defs', {});
          var grad = el('linearGradient', { id: 'grad', x1: '0', y1: '0', x2: '0', y2: '1' });
          grad.appendChild(el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.30' }));
          grad.appendChild(el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0' }));
          defs.appendChild(grad);
          svg.appendChild(defs);

          axis.ticks.forEach(function (v) {
            var gy = padT + plotH - (v / maxVal) * plotH;
            svg.appendChild(el('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, stroke: 'rgba(255,255,255,0.06)', 'stroke-width': '1' }));
            svg.appendChild(el('text', { x: padL - 8, y: gy + 3, 'text-anchor': 'end', fill: '#5b6472', 'font-size': '9' }, fmtAxis(v)));
          });

          var step = n > 1 ? plotW / (n - 1) : plotW;
          var points = DATA.days.map(function (d, i) {
            var x = padL + step * i;
            var y = padT + plotH - (vals[i] / maxVal) * plotH;
            return { x: x, y: y, v: vals[i], day: d };
          });

          var labelEvery = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(plotW / 46))));
          DATA.days.forEach(function (d, i) {
            if (i % labelEvery !== 0 && i !== n - 1) return;
            svg.appendChild(el('text', { x: padL + step * i, y: H - 6, 'text-anchor': 'middle', fill: '#5b6472', 'font-size': '9' }, dayLabel(d.dayStart)));
          });

          var pathD = points.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
          var areaD = pathD + ' L' + points[points.length - 1].x.toFixed(1) + ',' + (padT + plotH) + ' L' + points[0].x.toFixed(1) + ',' + (padT + plotH) + ' Z';
          svg.appendChild(el('path', { d: areaD, fill: 'url(#grad)', stroke: 'none' }));
          svg.appendChild(el('path', { d: pathD, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

          // whole-chart hover: nearest day gets a guide line, dot and tooltip
          var guide = el('line', { y1: padT, y2: padT + plotH, stroke: 'rgba(255,255,255,0.18)', 'stroke-width': '1', 'stroke-dasharray': '3 3' });
          var dot = el('circle', { r: '3.5', fill: color, stroke: '#161a20', 'stroke-width': '2' });
          var overlay = el('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
          overlay.addEventListener('mousemove', function (ev) {
            var r = svg.getBoundingClientRect();
            var px = ev.clientX - r.left;
            var best = points[0], bd = Infinity;
            points.forEach(function (p) { var d = Math.abs(p.x - px); if (d < bd) { bd = d; best = p; } });
            guide.setAttribute('x1', String(best.x)); guide.setAttribute('x2', String(best.x));
            dot.setAttribute('cx', String(best.x)); dot.setAttribute('cy', String(best.y));
            svg.appendChild(guide); svg.appendChild(dot);
            showTooltip(ev.clientX, ev.clientY,
              '<span class="t-line">' + dayLabel(best.day.dayStart) + '</span><b>' + fmt(best.v) + '</b>' + unit +
              '<div class="t-sub">' + daySub(best.day) + '</div>');
          });
          overlay.addEventListener('mouseleave', function () { guide.remove(); dot.remove(); hideTooltip(); });
          svg.appendChild(overlay);
          svg.appendChild(el('line', { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, stroke: '#242a33', 'stroke-width': '1' }));
        }

        function drawModelLines() {
          var W = box.clientWidth, H = box.clientHeight;
          if (!W || !H) return;
          svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
          clear();

          // per-model daily spend, ranked by total
          var totals = {};
          var perModel = {};
          DATA.byModel.forEach(function (p) {
            totals[p.model] = (totals[p.model] || 0) + p.cost;
            (perModel[p.model] = perModel[p.model] || []).push(p);
          });
          var models = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
          if (models.length === 0) {
            svg.appendChild(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: '#5b6472', 'font-size': '11' }, 'No model usage in the selected window'));
            return;
          }

          var series = models.map(function (model) {
            return {
              model: model,
              total: totals[model],
              values: DATA.days.map(function (d) {
                var hit = null;
                (perModel[model] || []).forEach(function (p) { if (p.dayStart === d.dayStart) hit = p; });
                return hit ? hit : { cost: 0, tokens: 0, requests: 0, dayStart: d.dayStart };
              }),
            };
          });
          var maxVal = niceMax(Math.max.apply(null, series.map(function (s) { return s.total; })) * 1.15);
          var axis = axisTicks(maxVal, 4);
          maxVal = axis.top;

          var padL = 44, padR = 10, padT = 12, padB = 24;
          var plotW = Math.max(1, W - padL - padR), plotH = Math.max(1, H - padT - padB);
          var n = DATA.days.length;
          var step = n > 1 ? plotW / (n - 1) : plotW;

          axis.ticks.forEach(function (v) {
            var gy = padT + plotH - (v / maxVal) * plotH;
            svg.appendChild(el('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, stroke: 'rgba(255,255,255,0.06)', 'stroke-width': '1' }));
            svg.appendChild(el('text', { x: padL - 8, y: gy + 3, 'text-anchor': 'end', fill: '#5b6472', 'font-size': '9' }, fmtAxisUsd(v)));
          });
          var labelEvery = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(plotW / 46))));
          DATA.days.forEach(function (d, i) {
            if (i % labelEvery !== 0 && i !== n - 1) return;
            svg.appendChild(el('text', { x: padL + step * i, y: H - 6, 'text-anchor': 'middle', fill: '#5b6472', 'font-size': '9' }, dayLabel(d.dayStart)));
          });

          // one overlapping line per model (spend), colored per model
          series.forEach(function (s, si) {
            var color = MODEL_COLORS[si % MODEL_COLORS.length];
            var pts = s.values.map(function (p, i) {
              return { x: padL + step * i, y: padT + plotH - (p.cost / maxVal) * plotH, p: p };
            });
            var d = pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
            svg.appendChild(el('path', { d: d, fill: 'none', stroke: color, 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
            pts.forEach(function (p, i) {
              if (p.p.cost <= 0) return;
              var c = el('circle', { cx: p.x, cy: p.y, r: '7', fill: 'transparent', stroke: 'none' });
              c.addEventListener('mousemove', function (ev) {
                showTooltip(ev.clientX, ev.clientY,
                  '<span class="t-line">' + esc(s.model) + ' · ' + dayLabel(p.p.dayStart) + '</span><b>' + fmtUsd(p.p.cost) + '</b>' +
                  '<div class="t-sub">' + fmtCount(p.p.tokens) + ' tokens · ' + fmtCount(p.p.requests) + ' requests</div>');
              });
              c.addEventListener('mouseleave', hideTooltip);
              svg.appendChild(c);
            });
          });

          svg.appendChild(el('line', { x1: padL, y1: padT + plotH, x2: W - padR, y2: padT + plotH, stroke: '#242a33', 'stroke-width': '1' }));

          // whole-chart hover: nearest day highlights every model's point and
          // lists each model's spend for that day
          var guide2 = el('line', { y1: padT, y2: padT + plotH, stroke: 'rgba(255,255,255,0.18)', 'stroke-width': '1', 'stroke-dasharray': '3 3' });
          var dots2 = [];
          var overlay2 = el('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
          var modelPts = [];
          series.forEach(function (s, si) {
            var color2 = MODEL_COLORS[si % MODEL_COLORS.length];
            s.values.forEach(function (p, i) {
              modelPts.push({
                x: padL + step * i,
                y: padT + plotH - (p.cost / maxVal) * plotH,
                model: s.model,
                color: color2,
                p: p,
                i: i
              });
            });
          });
          overlay2.addEventListener('mousemove', function (ev) {
            var r = svg.getBoundingClientRect();
            var px = ev.clientX - r.left;
            var best = null, bd = Infinity;
            modelPts.forEach(function (pt) { var d = Math.abs(pt.x - px); if (d < bd) { bd = d; best = pt; } });
            if (!best) return;
            guide2.setAttribute('x1', String(best.x)); guide2.setAttribute('x2', String(best.x));
            svg.appendChild(guide2);
            dots2.forEach(function (d2) { d2.remove(); });
            dots2.length = 0;
            var lines2 = [];
            modelPts.forEach(function (pt) {
              if (pt.i !== best.i) return;
              var dd = el('circle', { cx: pt.x, cy: pt.y, r: '3.5', fill: pt.color, stroke: '#161a20', 'stroke-width': '2' });
              svg.appendChild(dd);
              dots2.push(dd);
              if (pt.p.cost > 0) lines2.push('<div class="t-sub"><span class="l-swatch" style="background:' + pt.color + ';display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px"></span>' + esc(pt.model) + ': <b>' + fmtUsd(pt.p.cost) + '</b></div>');
            });
            showTooltip(ev.clientX, ev.clientY,
              '<span class="t-line">' + dayLabel(best.p.dayStart) + '</span>' +
              (lines2.length ? lines2.join('') : '<span class="t-sub">No model spend this day</span>'));
          });
          overlay2.addEventListener('mouseleave', function () { guide2.remove(); dots2.forEach(function (d2) { d2.remove(); }); dots2.length = 0; hideTooltip(); });
          svg.appendChild(overlay2);

          // legend (up to 8 models, ranked by total spend)
          var legend = document.getElementById('legend');
          legend.innerHTML = series.slice(0, 8).map(function (s, i) {
            var color = MODEL_COLORS[i % MODEL_COLORS.length];
            return '<span class="l-item"><span class="l-swatch" style="background:' + color + '"></span>' + esc(s.model) + '</span>';
          }).join('') + (series.length > 8 ? '<span class="l-more">+' + (series.length - 8) + ' more</span>' : '');
        }

        function render(key) {
          current = key;
          var fmt = metricFmt(key), unit = metricUnit(key);
          if (key === 'models') {
            chips.innerHTML =
              '<div class="stat-chip"><div class="k">Total spend</div><div class="v">' + fmtUsd(metricTotal('spend')) + '</div></div>';
            drawModelLines();
            return;
          }
          document.getElementById('legend').innerHTML = '';
          if (key === 'suggested' || key === 'approved') {
            chips.innerHTML = '';
            drawLine(key);
            return;
          }
          var st = DATA.stats;
          var totalKey = key === 'spend' ? 'total' : key;
          chips.innerHTML =
            '<div class="stat-chip"><div class="k">' + st.today.label + '</div><div class="v">' + fmt(key === 'spend' ? st.today.cost : st.today[key]) + '</div></div>' +
            '<div class="stat-chip"><div class="k">' + st.yesterday.label + '</div><div class="v">' + fmt(key === 'spend' ? st.yesterday.cost : st.yesterday[key]) + '</div></div>' +
            '<div class="stat-chip"><div class="k">' + (key === 'spend' ? st.total.label : 'Total ' + key) + '</div><div class="v">' + fmt(key === 'spend' ? st.total.cost : st.total[key]) + '</div></div>';
          void unit;
          drawLine(key);
        }

        document.getElementById('tabs').addEventListener('click', function (e) {
          var btn = e.target.closest('.tab-btn');
          if (!btn) return;
          document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          render(btn.dataset.metric);
        });

        // rings (re-rendered on every data refresh)
        function renderRings() {
          var ringsBox = document.getElementById('rings');
          ringsBox.innerHTML = DATA.rings.map(function (r) {
            var c = 2 * Math.PI * 24;
            return '<div class="ring-card ' + r.key + '">' +
              '<div class="ring-wrap"><svg viewBox="0 0 58 58">' +
              '<circle class="ring-bg" cx="29" cy="29" r="24"></circle>' +
              '<circle class="ring-fg" cx="29" cy="29" r="24" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + c.toFixed(1) + '" data-pct="' + r.percent + '"></circle>' +
              '</svg><div class="ring-pct">' + Math.round(r.percent) + '%</div></div>' +
              '<div class="ring-info"><div class="label">' + r.label + '</div>' +
              '<div class="reset">resets in ' + r.resetsIn + '</div>' +
              '<div class="amounts"><b>' + fmtUsd(r.spent) + '</b> / ' + fmtUsd(r.limit) + '</div></div></div>';
          }).join('');
          document.querySelectorAll('.ring-fg').forEach(function (circle) {
            var pct = Math.max(0, Math.min(100, parseFloat(circle.getAttribute('data-pct'))));
            var c = 2 * Math.PI * 24;
            requestAnimationFrame(function () {
              setTimeout(function () { circle.style.strokeDashoffset = String(c - (pct / 100) * c); }, 120);
            });
          });
        }

        var resizeTimer = null;
        function scheduleRedraw() {
          if (resizeTimer) cancelAnimationFrame(resizeTimer);
          resizeTimer = requestAnimationFrame(function () { render(current); });
        }
        if (window.ResizeObserver) new ResizeObserver(scheduleRedraw).observe(box);
        else window.addEventListener('resize', scheduleRedraw);

        // buttons -> extension host
        var refreshBtn = document.getElementById('btnRefresh');
        document.getElementById('btnTargets').addEventListener('click', function () { vscode.postMessage({ type: 'setTargets' }); });
        document.getElementById('btnRename').addEventListener('click', function () { vscode.postMessage({ type: 'renameProfile' }); });
        refreshBtn.addEventListener('click', function () {
          refreshBtn.textContent = 'Refreshing\u2026';
          vscode.postMessage({ type: 'refresh' });
        });

        // live data updates keep the active tab (no full page reload)
        window.addEventListener('message', function (ev) {
          var msg = ev.data;
          if (!msg || msg.type !== 'usage') return;
          DATA = msg.data;
          document.getElementById('brandName').textContent = DATA.profile;
          document.getElementById('btnRename').style.display = DATA.showRename ? '' : 'none';
          windowBtn.textContent = windowLabel(DATA.windowDays);
          refreshBtn.textContent = 'Refresh';
          renderRings();
          render(current);
        });

        document.getElementById('brandName').textContent = DATA.profile;

        // window toggle: week -> 14 days -> month -> lifetime
        var WINDOWS = [
          { days: 7, label: 'Week' },
          { days: 14, label: '14 days' },
          { days: 30, label: 'Month' },
          { days: 0, label: 'Lifetime' }
        ];
        function windowLabel(days) {
          for (var i = 0; i < WINDOWS.length; i++) if (WINDOWS[i].days === days) return WINDOWS[i].label;
          return days + ' days';
        }
        var windowBtn = document.getElementById('btnWindow');
        windowBtn.textContent = windowLabel(DATA.windowDays);
        windowBtn.addEventListener('click', function () {
          var idx = 0;
          for (var i = 0; i < WINDOWS.length; i++) if (WINDOWS[i].days === DATA.windowDays) idx = i;
          var next = WINDOWS[(idx + 1) % WINDOWS.length];
          windowBtn.textContent = next.label;
          vscode.postMessage({ type: 'window', days: next.days });
        });

        renderRings();
        render('spend');
      })();
      </script>
    </body>
    </html>
  `;
}

function buildUsageTooltip(s: ReturnType<GoUsageTracker["getSummary"]>): vscode.MarkdownString {
  const md = new vscode.MarkdownString("", true);
  md.supportHtml = true;
  md.isTrusted = true;
  const activeProfile = findProfile(profilesCache, activeProfileFingerprint);
  const profileLabel = activeProfile?.label ?? "OpenCode Go";

  // The hover shows the summary card only; Set spent targets / Rename are
  // available from the Command Palette (opencodego.setUsageTargets,
  // opencodego.renameActiveProfile).
  md.appendMarkdown(`<img alt="Go usage summary" src="${usageTooltipSvgDataUri(s, profileLabel)}" width="440">`);
  return md;
}

/**
 * Show input boxes for the user to manually set Go usage targets.
 * Returns UsageBaselineTargets if the user completed the flow, or undefined if cancelled.
 */
/** Parse a user-entered currency value. Accepts comma or dot as decimal separator.
 *  Returns NaN if the string contains non-numeric characters beyond the decimal separator. */
function parseCurrencyInput(value: string): number {
  // Allow only digits, one comma or dot, and optional leading minus
  if (!/^-?\d+[.,]?\d*$/.test(value)) return NaN;
  return parseFloat(value.replace(",", "."));
}

async function showUsageTargetEditor(tracker: GoUsageTracker): Promise<UsageBaselineTargets | undefined> {
  const summary = tracker.getSummary();

  // Ask for session spent (pre-filled with current tracked value)
  const sessionStr = await vscode.window.showInputBox({
    title: "OpenCode Go — Session Spent",
    prompt: `Total spent in the 5-hour rolling window (limit: $${String(GO_LIMITS.session)}).`,
    placeHolder: "e.g. 3.50",
    value: summary.session.spent.toFixed(2),
    validateInput: (value: string) => {
      const n = parseCurrencyInput(value);
      if (isNaN(n) || n < 0) return "Enter a valid number using digits and . or , as decimal separator (e.g. 3.50).";
      if (n > GO_LIMITS.session)
        return `Session limit is $${String(GO_LIMITS.session)}. Enter a value between 0 and ${String(GO_LIMITS.session)}.`;
      return undefined;
    },
  });
  if (sessionStr === undefined) return undefined;

  // Ask for weekly spent (pre-filled)
  const weeklyStr = await vscode.window.showInputBox({
    title: "OpenCode Go — Weekly Spent",
    prompt: `Total spent this week Mon–Mon UTC (limit: $${String(GO_LIMITS.weekly)}).`,
    placeHolder: "e.g. 12.00",
    value: summary.weekly.spent.toFixed(2),
    validateInput: (value: string) => {
      const n = parseCurrencyInput(value);
      if (isNaN(n) || n < 0) return "Enter a valid number using digits and . or , as decimal separator (e.g. 12.00).";
      if (n > GO_LIMITS.weekly)
        return `Weekly limit is $${String(GO_LIMITS.weekly)}. Enter a value between 0 and ${String(GO_LIMITS.weekly)}.`;
      return undefined;
    },
  });
  if (weeklyStr === undefined) return undefined;

  // Ask for monthly spent (pre-filled)
  const monthlyStr = await vscode.window.showInputBox({
    title: "OpenCode Go — Monthly Spent",
    prompt: `Total spent this month (limit: $${String(GO_LIMITS.monthly)}).`,
    placeHolder: "e.g. 25.00",
    value: summary.monthly.spent.toFixed(2),
    validateInput: (value: string) => {
      const n = parseCurrencyInput(value);
      if (isNaN(n) || n < 0) return "Enter a valid number using digits and . or , as decimal separator (e.g. 25.00).";
      if (n > GO_LIMITS.monthly)
        return `Monthly limit is $${String(GO_LIMITS.monthly)}. Enter a value between 0 and ${String(GO_LIMITS.monthly)}.`;
      return undefined;
    },
  });
  if (monthlyStr === undefined) return undefined;

  // Ask for monthly reset day (1-31) — pre-filled
  const monthlyDayStr = await vscode.window.showInputBox({
    title: "OpenCode Go — Monthly Reset Day",
    prompt: "Day of month when monthly usage resets (1-31). Press Enter to keep current.",
    placeHolder: "e.g. 10",
    value: summary.monthly.resetsAt.getUTCDate().toString(),
    validateInput: (value: string) => {
      if (!value) return undefined;
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 31) return "Enter a day between 1 and 31.";
      return undefined;
    },
  });
  if (monthlyDayStr === undefined) return undefined;

  // Ask for monthly reset hour (0-23 UTC) — pre-filled
  const monthlyHourStr = await vscode.window.showInputBox({
    title: "OpenCode Go — Monthly Reset Hour",
    prompt: "Hour (UTC, 0-23) when monthly usage resets. Press Enter to keep current.",
    placeHolder: "e.g. 0",
    value: summary.monthly.resetsAt.getUTCHours().toString(),
    validateInput: (value: string) => {
      if (!value) return undefined;
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 0 || n > 23) return "Enter an hour between 0 and 23 (UTC).";
      return undefined;
    },
  });
  if (monthlyHourStr === undefined) return undefined;

  const monthlyAnchorDay = monthlyDayStr ? parseInt(monthlyDayStr, 10) : undefined;
  const monthlyAnchorHour = monthlyHourStr ? parseInt(monthlyHourStr, 10) : undefined;

  return {
    session: parseCurrencyInput(sessionStr),
    weekly: parseCurrencyInput(weeklyStr),
    monthly: parseCurrencyInput(monthlyStr),
    monthlyAnchorDay,
    monthlyAnchorHour,
  };
}

type _UsageSummary = ReturnType<GoUsageTracker["getSummary"]>;

function usageTooltipSvgDataUri(s: _UsageSummary, profileLabel?: string): string {
  const svg = buildUsageTooltipSvg(s, profileLabel);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function buildUsageTooltipSvg(s: _UsageSummary, profileLabel?: string): string {
  // Stable geometry: fixed card width and fixed columns, so the layout never
  // shifts when session data appears or a day has no usage yet.
  const width = 440;
  const padX = 14;
  const right = width - padX;
  const fg = "#d4d4d4";
  const muted = "#a6a6a6";
  const track = "#3c3c3c";
  const accent = "#73c991";
  const line = "#333333";
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const svgTitle = escapeHtml(profileLabel ? `${profileLabel} - Usage` : "OpenCode Go - Usage");
  const noDataMsg = s.hasData ? null : nonLegacyCount(profilesCache) > 0 ? "No data yet for this profile." : "No usage data yet.";

  const text = (value: string, x: number, y: number, size: number, weight = 400, color = fg, anchor: "start" | "end" = "start"): string =>
    `<text x="${String(x)}" y="${String(y)}" fill="${color}" font-family="${font}" font-size="${String(size)}" font-weight="${String(weight)}" text-anchor="${anchor}">${escapeHtml(value)}</text>`;

  const bar = (pct: number, x: number, y: number, barWidth: number): string => {
    const clamped = Math.min(Math.max(pct, 0), 100);
    const fillWidth = Math.max(0, Math.round((clamped / 100) * barWidth));
    return [
      `<rect x="${String(x)}" y="${String(y)}" width="${String(barWidth)}" height="5" rx="2.5" fill="${track}"/>`,
      fillWidth > 0 ? `<rect x="${String(x)}" y="${String(y)}" width="${String(fillWidth)}" height="5" rx="2.5" fill="${accent}"/>` : "",
    ].join("");
  };

  // Meter block with a uniform 14px gutter between blocks: label row with the
  // reset time right-aligned at the card's right padding, then the bar and
  // the spent/limit line below it.
  const period = (label: string, p: _UsageSummary["session"], y: number): string =>
    [
      text(label, padX, y, 14, 700),
      text(`Resets in ${formatRelativeTime(p.resetsAt)}`, right, y, 12, 400, muted, "end"),
      bar(p.percent, padX, y + 14, 340),
      text(`${p.percent.toFixed(1)}%`, right, y + 21, 14, 700, fg, "end"),
      text(`${formatUsd(p.spent)} / ${formatUsd(p.limit)} used`, padX, y + 36, 13, 400, fg),
    ].join("");

  // Device-local rows share one fixed column grid: label, cost, requests,
  // tokens. Always rendered (zeros included) so the card height is stable.
  const deviceRow = (label: string, cost: number, requests: number, tokenCount: number, y: number): string =>
    [
      text(label, padX, y, 13, 400, muted),
      text(formatUsd(cost), 120, y, 13, 700),
      text("Requests:", 190, y, 13, 400, muted),
      text(formatCount(requests), 262, y, 13, 700),
      text("Tokens:", 305, y, 13, 400, muted),
      text(formatTokenCount(tokenCount), 385, y, 13, 700),
    ].join("");

  if (!s.hasData) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="70" viewBox="0 0 ${width} 70">${text(svgTitle, padX, 28, 16, 700)}
${text(noDataMsg ?? "No usage data yet. Send a chat message to start tracking.", padX, 52, 12, 400, muted)}
</svg>`;
  }

  // Title starts at the same 14px gutter as the sides. Meter rows, the
  // divider and the device rows keep a consistent 14px rhythm.
  const meterRows = [
    ...(usageRollingMeterVisible() ? ([["Session (5h rolling)", s.session, 56]] as const) : []),
    ["Weekly", s.weekly, 116],
    ["Monthly", s.monthly, 176],
  ] as const;
  const dividerY = 46 + meterRows.length * 60;
  const firstRowY = dividerY + 22;
  const rowGap = 24;
  // All three rows are always rendered (zeros included) so the card is
  // stable regardless of whether a session is currently active.
  const deviceRows: Array<[string, number, number, number, number]> = [];
  if (usageCodebaseRowVisible()) {
    deviceRows.push(["Codebase:", s.codebase.cost, s.codebase.requests, s.codebase.tokens, firstRowY]);
  }
  const codebaseOffset = usageCodebaseRowVisible() ? 1 : 0;
  deviceRows.push(["Today:", s.today.cost, s.today.requests, s.today.tokens, firstRowY + codebaseOffset * rowGap]);
  deviceRows.push(["Yesterday:", s.yesterday.cost, s.yesterday.requests, s.yesterday.tokens, firstRowY + (codebaseOffset + 1) * rowGap]);

  const height = firstRowY + (deviceRows.length - 1) * rowGap + 14;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${text(svgTitle, padX, 28, 16, 700)}
${meterRows.map(([label, periodValue, y]) => period(label, periodValue, y)).join("")}
<line x1="${padX}" y1="${dividerY}" x2="${right}" y2="${dividerY}" stroke="${line}" stroke-width="1"/>
${deviceRows.map(([label, cost, requests, tokenCount, y]) => deviceRow(label, cost, requests, tokenCount, y)).join("")}</svg>`;
}

class OpenCodeProvider implements vscode.LanguageModelChatProvider<OpenCodeModel> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  /** Trigger a model information refresh (e.g. after visionModel setting changes). */
  notifyModelInfoChanged(): void {
    this.changeEmitter.fire();
  }
  private readonly apiKeysByModelId = new Map<string, string>();

  /**
   * globalState key tracking whether this vendor has a configured BYOK group
   * (issue #106). Set when a configured-group call is served; read by the
   * groupless call to decide whether to stay silent. Scoped per vendor so an
   * `opencodego` group does not affect `opencodezen`.
   */
  private get byokGroupStateKey(): string {
    return `opencode.byokGroup.v1.${this.definition.vendor}`;
  }

  private hasByokGroupConfigured(): boolean {
    return this.context.globalState.get<boolean>(this.byokGroupStateKey, false);
  }

  private async markByokGroupConfigured(): Promise<void> {
    await this.context.globalState.update(this.byokGroupStateKey, true);
  }
  /** Capped to prevent unbounded growth across long sessions. */
  private readonly reasoningContentByToolCallId = new Map<string, string>();
  private static readonly REASONING_CACHE_LIMIT = 500;
  private readonly liveModelMetadataById = new Map<string, ModelMetadataFields>();
  private readonly recentTransportSummaries: RecentTransportSummary[] = [];
  private outputChannel: vscode.OutputChannel | undefined;

  /**
   * Cached snapshot of the most recent successful model-list fetch for this
   * provider's base vendor. Persisted to globalState so it survives window
   * reloads and can cover transient network failures at startup (issue #78).
   */
  private cachedModelList: { ids: string[]; fetchedAt: number } | undefined;

  /** globalState key for {@link cachedModelList}, scoped to this provider's vendor. */
  private get modelListCacheKey(): string {
    return `${MODEL_LIST_CACHE_KEY_PREFIX}::${this.baseVendor}`;
  }

  /** Resolves agent-host variants to their base vendor for metadata/routing. */
  private get baseVendor(): ProviderVendor {
    return resolveBaseVendor(this.definition.vendor);
  }

  /** Store reasoning content with a cap to prevent unbounded memory growth. */
  private storeReasoningContent(toolCallIds: string[], reasoningContent: string): void {
    for (const toolCallId of toolCallIds) {
      this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
    }
    // Evict oldest entries if the cache exceeds the limit.
    if (this.reasoningContentByToolCallId.size > OpenCodeProvider.REASONING_CACHE_LIMIT) {
      const excess = this.reasoningContentByToolCallId.size - OpenCodeProvider.REASONING_CACHE_LIMIT;
      const keys = this.reasoningContentByToolCallId.keys();
      for (let i = 0; i < excess; i++) {
        const key = keys.next().value;
        if (key) this.reasoningContentByToolCallId.delete(key);
      }
    }
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly definition: ProviderDefinition,
  ) {
    this.restoreRecentTransportSummaries();
  }

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel("OpenCode");
      this.context.subscriptions.push(this.outputChannel);
    }
    return this.outputChannel;
  }

  private log(message: string): void {
    this.getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private async getMetadataSnapshot(): Promise<CachedModelMetadataSnapshot> {
    return getOpenCodeModelMetadata(this.context, this.getOutputChannel());
  }

  private resolveModelMetadata(modelId: string, snapshot: CachedModelMetadataSnapshot): ResolvedModelMetadata {
    return resolveModelMetadata(modelId, this.baseVendor, snapshot, this.liveModelMetadataById);
  }

  private replaceLiveModelMetadata(entries: ModelListEntry[] | undefined): void {
    this.liveModelMetadataById.clear();
    for (const entry of entries ?? []) {
      if (typeof entry.id !== "string" || !entry.id) {
        continue;
      }
      const metadata = normalizeLiveModelMetadata(entry);
      if (metadata) {
        this.liveModelMetadataById.set(entry.id, metadata);
      }
    }
  }

  private recentTransportSummariesStorageKey(): string {
    return `${RECENT_TRANSPORT_SUMMARY_STORAGE_PREFIX}.${this.definition.vendor}`;
  }

  private restoreRecentTransportSummaries(): void {
    const stored = this.context.globalState.get<RecentTransportSummary[]>(this.recentTransportSummariesStorageKey(), []);

    if (!Array.isArray(stored) || !stored.length) {
      return;
    }

    this.recentTransportSummaries.push(...stored.slice(-RECENT_TRANSPORT_SUMMARY_LIMIT));
  }

  private persistRecentTransportSummaries(): void {
    void this.context.globalState.update(this.recentTransportSummariesStorageKey(), this.recentTransportSummaries);
  }

  private recordTransportSummary(
    summary: TransportRequestSummary,
    endpointKind: string,
    metadataSource: string,
    requestInitiator: unknown,
  ): void {
    // requestInitiator is an arbitrary value from the transport layer. Only
    // stringify it when it is a primitive; objects are JSON-serialized and
    // nullish values are dropped so diagnostics never show "[object Object]".
    const initiator = stringifyInitiator(requestInitiator);

    this.recentTransportSummaries.push({
      ...summary,
      recordedAt: new Date().toISOString(),
      endpointKind,
      metadataSource,
      ...(initiator ? { requestInitiator: initiator } : {}),
    });

    if (this.recentTransportSummaries.length > RECENT_TRANSPORT_SUMMARY_LIMIT) {
      this.recentTransportSummaries.splice(0, this.recentTransportSummaries.length - RECENT_TRANSPORT_SUMMARY_LIMIT);
    }

    this.persistRecentTransportSummaries();
  }

  private recentTransportDiagnosticsLines(): string[] {
    if (!this.recentTransportSummaries.length) {
      return ["No requests recorded in this extension host yet.", ""];
    }

    return this.recentTransportSummaries
      .slice()
      .reverse()
      .flatMap((summary, index) => {
        const status = summary.status ?? summary.abortedReason ?? "n/a";
        const cacheHitRatio = formatCacheHitRatio({
          promptTokens: summary.promptTokens,
          cachedTokens: summary.cachedTokens,
        });
        const lines = [
          `### ${String(index + 1)}. ${summary.modelId}`,
          "",
          `- time: ${summary.recordedAt}`,
          `- endpoint: ${summary.endpointKind}`,
          `- initiator: ${summary.requestInitiator ?? "unknown"}`,
          `- metadataSource: ${summary.metadataSource}`,
          `- status: ${String(status)}`,
          `- durationMs: ${String(summary.durationMs)}`,
          `- ttfbMs: ${String(summary.ttfbMs ?? "n/a")}`,
          `- totalBytes: ${String(summary.totalBytes)}`,
          `- totalEvents: ${String(summary.totalEvents)}`,
          `- tokens: prompt=${String(summary.promptTokens ?? "n/a")}, completion=${String(summary.completionTokens ?? "n/a")}, total=${String(summary.totalTokens ?? "n/a")}, cached=${String(summary.cachedTokens ?? "n/a")}`,
          `- cacheHitRatio: ${cacheHitRatio ?? "n/a"}`,
          `- finishReason: ${summary.finishReason ?? "n/a"}`,
          `- requestId: ${summary.requestId ?? "n/a"}`,
          `- sessionId: ${summary.sessionId ?? "n/a"}`,
          `- url: ${summary.url}`,
        ];

        if (summary.rateLimitSummary) {
          lines.push(`- rateLimit: ${summary.rateLimitSummary}`);
        }
        if (summary.errorMessage) {
          lines.push(`- error: ${summary.errorMessage}`);
        }

        lines.push("");
        return lines;
      });
  }

  private async refreshMetadataAndModels(): Promise<void> {
    await clearOpenCodeModelMetadataCache(this.context);
    // Pass the stored API key so the gateway sees the authenticated
    // (per-key) model list, not the anonymous default.
    const apiKey = await this.context.secrets.get(secretKeyFor(this.baseVendor));
    await this.fetchModels(apiKey);
  }

  /**
   * Public entry point for the `OpenCode <Vendor>: Refresh Models` commands.
   *
   * CONTRACT:
   * - Skips the Manage Provider QuickPick and goes straight to a fetch.
   * - Reuses {@link refreshMetadataAndModels}, fires the change emitter so
   *   VS Code re-resolves the picker, and surfaces an informational toast.
   * - On missing API key, points the user at the BYOK flow instead of
   *   prompting for a key (API keys are configured via Manage Language
   *   Models / "+ Add Models" only).
   *
   * Background: this was added after issue #78 revealed that "Refresh Models"
   * was only reachable as a sub-item inside `OpenCode Go: Manage Provider`
   * (and Zen had no manual refresh path at all). The top-level command matches
   * what users naturally type in the Command Palette.
   */
  async refreshModels(): Promise<void> {
    const apiKey = await this.context.secrets.get(secretKeyFor(this.baseVendor));
    if (!apiKey) {
      vscode.window.showErrorMessage(
        `${this.definition.displayName}: No API key configured. Add the provider via Manage Language Models ("+ Add Models" → ${this.definition.displayName}) first.`,
      );
      return;
    }
    await this.refreshMetadataAndModels();
    this.changeEmitter.fire();
    vscode.window.showInformationMessage(`${this.definition.displayName} models refreshed.`);
  }

  async manage(): Promise<void> {
    // Read via the base-vendor full key so agent variants (opencodego-agent,
    // opencodezen-agent) follow the same switch as the vendor they mirror.
    const providerEnabled = vscode.workspace.getConfiguration().get<boolean>(providerEnabledSetting(this.definition.vendor), true);
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Test Connection", action: "test" as const },
        { label: "Refresh Models", action: "refresh" as const },
        { label: "Configure Utility Models", action: "utility" as const },
        { label: "Open Diagnostics", action: "diagnostics" as const },
        ...(providerEnabled
          ? [{ label: "Remove from Language Models", action: "remove" as const }]
          : [{ label: "Re-add to Language Models", action: "remove" as const }]),
      ],
      {
        title: `Manage ${this.definition.displayName}`,
        placeHolder: "Choose an action",
      },
    );

    if (!choice) {
      return;
    }

    if (choice.action === "remove") {
      await toggleProviderEnabled(this.definition.vendor, this.definition.displayName);
      return;
    }

    if (choice.action === "test") {
      await this.testConnection();
      return;
    }

    if (choice.action === "utility") {
      await configureUtilityModels();
      return;
    }

    if (choice.action === "diagnostics") {
      await this.showDiagnostics();
      return;
    }

    await this.refreshModels();
  }

  async testConnection(): Promise<void> {
    const apiKey = await this.context.secrets.get(secretKeyFor(this.baseVendor));
    if (!apiKey) {
      vscode.window.showErrorMessage(
        `${this.definition.displayName}: No API key configured. Add the provider via Manage Language Models ("+ Add Models" → ${this.definition.displayName}) first.`,
      );
      return;
    }

    const statusBar = vscode.window.setStatusBarMessage(`$(loading~spin) Testing ${this.definition.displayName} connection...`);
    this.log(`Testing connection to ${this.definition.chatCompletionsUrl}`);

    try {
      const response = await fetch(this.definition.chatCompletionsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.definition.testModelId,
          messages: [{ role: "user", content: "reply with just: ok" }],
          max_tokens: 10,
          stream: false,
        }),
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });

      const responseText = await response.text();
      this.log(`Test response (${String(response.status)}): ${responseText}`);

      if (response.ok) {
        vscode.window.showInformationMessage(
          `${this.definition.displayName}: Connection OK (HTTP ${String(response.status)}). Check Output panel for details.`,
        );
      } else {
        vscode.window.showErrorMessage(
          `${this.definition.displayName}: Connection failed (HTTP ${String(response.status)}). Check Output panel for details.`,
        );
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.log(`Test connection error: ${message}`);
      vscode.window.showErrorMessage(`${this.definition.displayName}: Connection error - ${message}`);
    } finally {
      statusBar.dispose();
    }
  }

  async showDiagnostics(): Promise<void> {
    let models: readonly vscode.LanguageModelChat[] = [];
    let modelSelectionError: string | undefined;
    try {
      models = await vscode.lm.selectChatModels({ vendor: this.definition.vendor });
    } catch (error) {
      modelSelectionError = getErrorMessage(error);
    }

    const hasStoredApiKey = Boolean(await this.context.secrets.get(secretKeyFor(this.baseVendor)));
    const metadataSnapshot = await this.getMetadataSnapshot();
    const lines = models.map((model) => {
      const rawModelId = resolveRawModelId(model.id);
      const metadata = this.resolveModelMetadata(rawModelId, metadataSnapshot);
      const limits = modelLimits(metadata);
      return [
        `- ${rawModelId}`,
        `  rawModelId: ${rawModelId}`,
        `  name: ${model.name}`,
        `  family: ${model.family}`,
        `  vendor: ${model.vendor}`,
        `  version: ${model.version}`,
        `  maxInputTokens: ${String(model.maxInputTokens)}`,
        `  advertisedMaxOutputTokens: ${String(limits.advertisedMaxOutputTokens)}`,
        `  advertisedContextWindow: ${String(limits.advertisedContextWindow)}`,
        `  apiMaxOutputTokens: ${String(limits.maxOutputTokens)}`,
        `  metadataSource: ${metadata.source}`,
        `  supportsVision: ${String(metadata.supportsVision)}`,
        `  status: ${metadata.status ?? "active"}`,
        `  thinkingFamily: ${thinkingFamily(rawModelId) ?? "none"}`,
        `  configurationSchema: ${JSON.stringify((model as unknown as { configurationSchema?: unknown }).configurationSchema ?? null)}`,
        ...(hasExplicitModelLimits(rawModelId, this.baseVendor) ? [] : ["  limits: using bundled fallback"]),
      ].join("\n");
    });

    const content = [
      `# ${this.definition.displayName} Diagnostics`,
      "",
      "## Runtime",
      "",
      ...runtimeDiagnosticsLines(this.context),
      `- credentialInSecretStorage: ${String(hasStoredApiKey)}`,
      `- modelSelectionError: ${modelSelectionError ?? "none"}`,
      "",
      "## Recent Requests",
      "",
      ...this.recentTransportDiagnosticsLines(),
      `## Models`,
      "",
      `Models visible through vscode.lm.selectChatModels({ vendor: "${this.definition.vendor}" }): ${String(models.length)}`,
      "",
      ...lines,
    ].join("\n");

    const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<OpenCodeModel[]> {
    const opts = options as ConfiguredLanguageModelInfoOptions & { group?: string };

    // 1. Try BYOK configuration first (VS Code may supply the API key directly).
    let apiKey = getConfiguredApiKey(opts);

    // A call that carries a BYOK key is a configured-group call. Record that
    // the vendor is configured natively, so the groupless call stays silent
    // (issue #106, see step 2 below).
    if (apiKey) {
      await this.markByokGroupConfigured();
    } else if (opts.configuration !== undefined) {
      // A group call with a non-undefined configuration that carries no API
      // key is a per-model configuration group (only `settings`, no key —
      // e.g. a `reasoningEffort` picked in the model picker). VS Code
      // resolves its configuration to `{}` here. The groupless call already
      // served the models via SecretStorage, so serving them again would
      // duplicate every model (issue #131). The per-model settings still
      // apply at request time via `modelConfiguration`.
      return [];
    }

    // 2. Fall back to the extension's own secret storage when BYOK did not
    //    provide a usable key. This supports users who stored their key via
    //    the extension's `Set API Key` command instead of VS Code's native
    //    Manage Models / BYOK flow.
    //
    //    CONTRACT: Per vscode.proposed.chatProvider.d.ts, `options.configuration`
    //    is only present when the provider declared a `configurationSchema` in
    //    package.json AND the user has configured a BYOK group. When the user
    //    stored the key via the extension command only, VS Code passes
    //    `configuration=undefined` — this is NOT a "still resolving" state
    //    that will be retried with a BYOK key, it means no BYOK group exists.
    //    Therefore we must consult secret storage unconditionally.
    //
    //    This mirrors the reference implementation in Copilot's own
    //    `AbstractLanguageModelChatProvider.provideLanguageModelChatInformation`,
    //    which always falls back to its own storage when `configuration.apiKey`
    //    is absent (see microsoft/vscode `extensions/copilot/src/extension/byok/
    //    vscode-node/abstractLanguageModelChatProvider.ts`).
    //
    //    See issue #86: non-agent `opencodezen` returned 0 models when the key
    //    was set via the extension command, because the previous guard
    //    `isAgentVariant || options.configuration` skipped the fallback for
    //    non-agent providers with `configuration=undefined`.
    //
    //    ISSUE #106: VS Code calls this method once WITHOUT a group (the
    //    groupless call, `configuration` undefined) and then once per configured
    //    group. It namespaces model identifiers by group (`toModelIdentifier`:
    //    `<vendor>/<group>/<id>` vs `<vendor>/<id>`), so a secrets-backed set
    //    returned on the groupless call is kept ALONGSIDE the group's set and
    //    every model is listed twice. When a BYOK group has been observed (flag
    //    set above), the group call(s) are authoritative — return [] here so the
    //    groupless call does not emit a duplicate set.
    if (!apiKey) {
      if (this.hasByokGroupConfigured()) {
        return [];
      }
      apiKey = await this.context.secrets.get(secretKeyFor(this.baseVendor));
    }

    if (!apiKey) {
      return [];
    }

    // When a non-agent provider resolves its API key, persist it so that
    // agent-variant providers (which have no BYOK entry) can inherit it
    // from the extension's secret storage.
    if (!this.definition.isAgentVariant) {
      const existing = await this.context.secrets.get(secretKeyFor(this.baseVendor));
      if (existing !== apiKey) {
        await this.context.secrets.store(secretKeyFor(this.baseVendor), apiKey);
      }
    }

    if (token.isCancellationRequested) {
      return [];
    }

    // Create profile for this API key before fetching models, so the
    // profile is always registered in both the in-memory cache and
    // globalState, regardless of whether a request has been recorded.
    if (this.baseVendor === GO_VENDOR) {
      ensureProfileSync(apiKey);
    }

    const models = await this.fetchModels(apiKey, token);
    if (models.length === 0) {
      return [];
    }

    const settings = getSettings();
    const metadataSnapshot = await this.getMetadataSnapshot();
    const showProviderPrefix = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_SHOW_PROVIDER_PREFIX, true);

    // CONTRACT: VS Code calls provideLanguageModelChatInformation frequently
    // (every ~300ms during UI refresh). Per-model logging produces thousands
    // of log lines per minute and obscures real signal. We accumulate a
    // single summary line per invocation instead of one line per model.
    let registeredCount = 0;
    let firstModelId = "";
    let lastModelId = "";

    const results = models.flatMap((modelId) => {
      const metadata = this.resolveModelMetadata(modelId, metadataSnapshot);
      const routing = resolveModelRouting(modelId, this.definition);
      const effectiveModelId = toEffectiveModelId(modelId, this.definition.vendor);
      // Stable model ID — deliberately NO key fingerprint. VS Code's per-model
      // configuration (chatLanguageModels.json) is keyed by this ID; keeping it
      // stable is what makes per-model thinking settings survive restarts and
      // key-source changes (the old `::<fp>` suffix made them go stale and
      // reset — see issue #131). Multi-key resolution relies on the BYOK
      // group's configuration.apiKey; apiKeysByModelId is only a fallback for
      // the SecretStorage path.
      const agentHostModelId = `${effectiveModelId}::agent-host`;
      const limits = modelLimits(metadata, settings);
      this.apiKeysByModelId.set(modelId, apiKey);
      this.apiKeysByModelId.set(effectiveModelId, apiKey);
      this.apiKeysByModelId.set(agentHostModelId, apiKey);

      const capacityNote = CAPACITY_LIMITED_MODEL_NOTES[modelId];
      const modalityBadges = formatModalityBadges(metadata);
      const baseDetail = this.baseVendor === ZEN_VENDOR && isFreeModel(modelId) ? "Free" : this.definition.displayName;
      const baseTooltip = `${this.definition.displayName} model: ${modelId}`;
      const configurationSchema = modelConfigurationSchema(modelId, metadata);

      const sharedFields: Omit<OpenCodeModel, "id" | "targetChatSessionType"> = {
        rawModelId: modelId,
        name: providerModelDisplayName(this.definition.modelNamePrefix, modelId, showProviderPrefix),
        family: `${this.definition.isAgentVariant && this.definition.baseVendor ? this.definition.baseVendor : this.definition.vendor}-${modelId}-${MODEL_METADATA_REVISION}`,
        // Include effective limits in version so VS Code invalidates stale
        // picker metadata after limit changes (eg. 2M -> 262K corrections).
        version: `1.2.0-${MODEL_METADATA_REVISION}-${String(limits.contextWindow)}-${String(limits.maxOutputTokens)}`,
        detail: capacityNote ? `${baseDetail} • Limited capacity` : modalityBadges ? `${baseDetail} • ${modalityBadges}` : baseDetail,
        tooltip: capacityNote ? `${baseTooltip}\n\n${capacityNote}` : modalityBadges ? `${baseTooltip}\n\n${modalityBadges}` : baseTooltip,
        isUserSelectable: true,
        isBYOK: true,
        maxInputTokens: limits.advertisedMaxInputTokens,
        maxOutputTokens: limits.advertisedMaxOutputTokens,
        capabilities: modelCapabilities(metadata),
        endpointKind: routing.endpointKind,
        provider: this.definition,
        ...(capacityNote ? { warningText: { capacity: capacityNote } } : {}),
        // Pricing fields (VS Code languageModelPricing proposal)
        ...modelPricingFields(modelId, this.baseVendor, metadata),
        // Inline so Copilot Chat picks up the Thinking submenu directly
        // (parity with zelosleone/Opencode-Go-For-Copilot pattern).
        ...(configurationSchema ? { configurationSchema } : {}),
      };

      if (this.definition.isAgentVariant) {
        // Agent-host variant — only returned by agent providers.
        // targetChatSessionType must match the `type` declared in the
        // Copilot extension's chatSessions contribution:
        //   { "type": "copilotcli", "requiresCustomModels": true, ... }
        const agentHostInfo: OpenCodeModel = {
          ...sharedFields,
          id: agentHostModelId,
          targetChatSessionType: "copilotcli",
        };

        registeredCount += 1;
        if (!firstModelId) firstModelId = agentHostInfo.id;
        lastModelId = agentHostInfo.id;
        return [agentHostInfo];
      }

      // General variant — no targetChatSessionType → visible in Chat view
      const info: OpenCodeModel = { ...sharedFields, id: effectiveModelId };

      registeredCount += 1;
      if (!firstModelId) firstModelId = info.id;
      lastModelId = info.id;
      return [info];
    });

    // Single summary log line per invocation — includes count + first/last
    // model ID so we can still debug registration issues without flooding
    // the Output channel when VS Code refreshes model info frequently.
    if (registeredCount > 0) {
      this.log(
        `Models registered: count=${String(registeredCount)} provider=${this.definition.vendor}` +
          ` first=${firstModelId} last=${lastModelId}` +
          (this.definition.isAgentVariant ? " (agents)" : ""),
      );
    }

    return results;
  }

  async provideLanguageModelChatResponse(
    model: OpenCodeModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // VS Code can invoke a cached selected model immediately after the
    // extension host restarts, before model discovery repopulates the in-memory
    // ID map. Keep SecretStorage as the cold-start fallback for that request.
    const apiKey = resolveResponseApiKey(
      getConfiguredApiKey(options as ConfiguredLanguageModelResponseOptions),
      this.apiKeysByModelId.get(model.id),
      await this.context.secrets.get(secretKeyFor(this.baseVendor)),
    );

    if (!apiKey) {
      throw new Error(
        `${this.definition.displayName} API key is required. Use the ${this.definition.displayName} gear icon in Language Models to configure it, then reload the window.`,
      );
    }

    const rawModelId = model.rawModelId ?? resolveRawModelId(model.id);
    const convertedMessages = await Promise.all(
      messages.map((message) => convertMessage(message, this.reasoningContentByToolCallId, rawModelId)),
    );
    const normalizedImageCount = convertedMessages.map((result) => result.normalizedImageCount).reduce((total, count) => total + count, 0);
    if (normalizedImageCount > 0) {
      this.log(`[vision] Normalized ${String(normalizedImageCount)} image attachment(s) to provider-safe dimensions/encoding.`);
    }

    // Flatten the converted messages, tracking which original message produced
    // each apiMessage. The vision proxy returns per-message descriptions keyed
    // by the original message index, so this mapping lets us apply the correct
    // description to the right apiMessage (convertMessage can emit several
    // messages per input — e.g. tool results — which shifts indices).
    const flatMessages: ApiMessage[] = [];
    const flatSourceIndex: number[] = [];
    for (let i = 0; i < convertedMessages.length; i++) {
      for (const msg of convertedMessages[i].messages) {
        flatMessages.push(msg);
        flatSourceIndex.push(i);
      }
    }

    const baseSettings = getSettings();
    const requestOverride = getRequestModelConfiguration(options);
    // Resolve the effective thinking config: VS Code's per-model configuration
    // (options.modelConfiguration, chatLanguageModels.json) is the SINGLE
    // authority for per-model thinking; the workspace setting is the default;
    // THINKING_DEFAULTS is the final fallback. No extension-side persisted
    // shadow state (removed — it fought the VS Code authority and could pin a
    // stale non-off value over the user's Off).
    const resolvedThinking = resolveThinkingConfig({
      modelId: rawModelId,
      workspace: baseSettings.thinking,
      modelConfiguration: requestOverride,
    });
    const settings: ApiSettings = {
      ...baseSettings,
      thinking: resolvedThinking.settings,
    };
    // Extract the context-size tier selected by the user (if any)
    const contextSizeOverride = typeof requestOverride?.contextSize === "number" ? requestOverride.contextSize : undefined;
    const metadataSnapshot = await this.getMetadataSnapshot();
    const metadata = this.resolveModelMetadata(rawModelId, metadataSnapshot);
    const routing = resolveModelRouting(rawModelId, this.definition);

    // `hasImageInput` is computed from the flattened (pre-normalize) messages:
    // normalization never creates or drops image parts, so this matches the
    // previous `messagesHaveImages(apiMessages)` result.
    const hasImageInput = messagesHaveImages(flatMessages);
    const actuallySupportsVision = metadata.supportsVision; // cached before capabilities override

    // Vision proxy: when a text-only model receives images, relay them
    // through a configured vision-capable Copilot model, then replace
    // the image parts with the text description. Descriptions are cached
    // per image (`imageDescriptionCache`), so already-described images are
    // reused on future turns without calling the vision model again.
    const visionProxyModelId = isVisionProxyEnabled() ? this.context.globalState.get<string>(VISION_PROXY_MODEL_ID_KEY, "") || "" : "";
    if (hasImageInput && !actuallySupportsVision && visionProxyModelId) {
      const visionProxyPrompt = this.context.globalState.get<string>(VISION_PROXY_PROMPT_KEY, "") || DEFAULT_VISION_PROXY_PROMPT;
      // When `opencodego.visionProxyWholeConversation` is on, describe the whole
      // conversation instead of only the message with a new image, so descriptions
      // keep conversation context (at the cost of more tokens).
      const describeWholeConversation = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>(SETTING_VISION_PROXY_WHOLE_CONVERSATION, false);
      let imagesHandled = false;
      try {
        this.log(`[vision-proxy] Forwarding images to ${visionProxyModelId}${describeWholeConversation ? " (whole conversation)" : ""}`);
        const { descriptions, cacheHits, cacheMisses } = await proxyVision(
          messages,
          visionProxyModelId,
          visionProxyPrompt,
          describeWholeConversation,
          token,
        );
        if (descriptions.size > 0) {
          const fallbackDescription = descriptions.values().next().value ?? "";
          for (let i = 0; i < flatMessages.length; i++) {
            const msg = flatMessages[i];
            if (!Array.isArray(msg.content)) continue;
            if (!msg.content.some((p) => p.type === "image_url")) continue;
            const textParts = msg.content
              .filter((p): p is OpenAiContentPart & { text: string } => p.type === "text" && typeof p.text === "string")
              .map((p) => p.text);
            // Tool-result images are not described by the proxy, so they fall
            // back to the first available description (matching the previous
            // single-description behavior).
            const description = descriptions.get(flatSourceIndex[i]) ?? fallbackDescription;
            msg.content = [{ type: "text", text: `[Image described by vision proxy]: ${description}` }];
            if (textParts.length > 0) {
              msg.content.push({ type: "text", text: textParts.join("\n") });
            }
            imagesHandled = true;
          }
          this.log(
            `[vision-proxy] Replaced images using vision proxy model (${String(cacheHits)} from cache, ${String(cacheMisses)} newly described)`,
          );
        }
      } catch (err) {
        this.log(`[vision-proxy] Error: ${getErrorMessage(err)}`);
      }

      // If the proxy didn't handle the images (error, empty response, or
      // model not found), strip them anyway so the non-vision model
      // doesn't receive image data it can't process (fixes 400 errors).
      if (!imagesHandled) {
        for (const msg of flatMessages) {
          if (!Array.isArray(msg.content)) continue;
          if (msg.content.some((p) => p.type === "image_url")) {
            const textParts = msg.content
              .filter((p): p is OpenAiContentPart & { text: string } => p.type === "text" && typeof p.text === "string")
              .map((p) => p.text);
            msg.content = [{ type: "text", text: "[Image unavailable — vision proxy unavailable]" }];
            if (textParts.length > 0) {
              msg.content.push({ type: "text", text: textParts.join("\n") });
            }
          }
        }
        this.log(`[vision-proxy] Stripped images (proxy unavailable), prevented 400`);
      }
    }

    const apiMessages = normalizeMessages(flatMessages);

    // Trim old images from conversation history to bound cumulative payload
    // weight. MCP screenshot loops (chrome-devtools-mcp, playwright-mcp) can
    // accumulate multi-MB base64 data URIs in history and trigger upstream
    // `400 Upstream request failed` rejections from OpenCode Go (issue #38
    // follow-up, documented in docs/issues/34 line 264+). Only the most recent
    // MAX_HISTORY_IMAGES_KEPT images are kept; older ones are replaced with a
    // short placeholder text note so the model retains conversation structure
    // without incurring the payload cost.
    //
    // Applied AFTER vision proxy so proxy-replaced text descriptions (already
    // small) are preserved, and applied BEFORE promptTokens estimation so the
    // output budget reflects the trimmed payload.
    const trimmedCount = trimOldImagesFromHistoryInPlace(apiMessages);
    if (trimmedCount > 0) {
      this.log(
        `[history-trim] Replaced ${String(trimmedCount)} old image(s) with placeholder text to bound payload (kept most recent ${String(MAX_HISTORY_IMAGES_KEPT)}).`,
      );
    }

    // Estimate after vision proxying and history trimming so the output budget
    // reflects the payload that is actually sent upstream.
    const promptTokens = estimatePromptTokenCount(apiMessages, options.tools);
    const limits = modelLimits(metadata, settings, contextSizeOverride, promptTokens);

    const thinkingPayload = thinkingProviderFor(rawModelId).buildPayload(settings.thinking, {
      hasImageInput: hasImageInput && metadata.supportsVision,
      endpoint: routing.endpointKind === "messages" ? "messages" : routing.endpointKind === "responses" ? "responses" : "chat",
    });
    const requestHeaders = buildOpenCodeRequestHeaders(messages, options, rawModelId);
    const outputChannel = this.getOutputChannel();
    const onTransportSummary = (summary: TransportRequestSummary) => {
      // Compute credits for VS Code session cost (1 credit = $0.01).
      // VS Code reads usage.copilotCredits from the LanguageModelDataPart
      // to accumulate session cost. We mutate the summary object directly
      // so emitSummary includes it in the usage data parts.
      // Use the same estimateCost() helper as goUsageTracker.record() to
      // guarantee cost and credits stay in sync.
      const prompt = summary.promptTokens ?? 0;
      const completion = summary.completionTokens ?? 0;
      const cached = summary.cachedTokens ?? 0;
      const cost = estimateCost(summary.modelId, prompt, completion, cached, metadata.cost);
      summary.copilotCredits = cost * 100;

      this.recordTransportSummary(summary, routing.endpointKind, metadata.source, options.requestInitiator);
      updateUsageStatusBar(this.definition.displayName, rawModelId, summary);
      if (this.baseVendor === GO_VENDOR) {
        const tracker = ensureProfileForApiKey(apiKey);
        this.log(
          `[go-usage] Recording profile=${activeProfileFingerprint}: model=${summary.modelId} promptTokens=${prompt} completionTokens=${completion} cachedTokens=${cached}`,
        );
        tracker.record(summary, metadata.cost);
        refreshGoUsageStatusBar();
        this.log(`[go-usage] After record profile=${activeProfileFingerprint}: entries=${tracker.getSummary().today.requests}`);
        // Re-sync the server-accurate account meters (TTL-guarded, uses the
        // exact key this request ran under — covers BYOK group keys too).
        void syncTrackerUsage(tracker, apiKey);
      }
    };

    this.log(
      `Request: initiator=${options.requestInitiator} model=${model.id} rawModel=${rawModelId} endpoint=${routing.endpointKind} metadataSource=${metadata.source} messages=${String(apiMessages.length)} promptEstimate=${String(promptTokens)} maxOutputTokens=${String(limits.maxOutputTokens)} session=${requestHeaders["x-opencode-session"]} request=${requestHeaders["x-opencode-request"]} modelConfiguration=${JSON.stringify(extractThinkingOverride(requestOverride))} thinkingSource=${resolvedThinking.source} thinking=${JSON.stringify(settings.thinking)} thinkingPayload=${JSON.stringify(thinkingPayload)}`,
    );
    if (settings.debugReasoning) {
      this.log("Reasoning debug is enabled. Provider reasoning_content will be written to this output channel when available.");
    }

    try {
      const contextWindowOutputBuffer = limits.advertisedMaxOutputTokens;

      if (routing.endpointKind === "messages") {
        await runStreamAnthropicMessages({
          url: routing.endpointUrl,
          providerDisplayName: this.definition.displayName,
          apiKey,
          modelId: rawModelId,
          body: buildAnthropicMessagesRequestBody(rawModelId, apiMessages, options, settings, metadata, limits),
          requestHeaders,
          progress,
          token,
          output: outputChannel,
          debugReasoning: settings.debugReasoning,
          requestTimeoutMs: settings.requestTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
          contextWindowOutputBuffer,
          authHeaders: buildOpenCodeGatewayAuthHeaders("messages", apiKey),
          capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
          onTransportSummary,
          stripThinkTags: settings.stripThinkTags,
        });
        return;
      }

      if (routing.endpointKind === "responses") {
        await runStreamResponsesApi({
          url: routing.endpointUrl,
          providerDisplayName: this.definition.displayName,
          apiKey,
          modelId: rawModelId,
          body: buildResponsesRequestBody(rawModelId, apiMessages, options, settings, metadata, limits),
          authHeaders: buildOpenCodeGatewayAuthHeaders("responses", apiKey),
          requestHeaders,
          progress,
          token,
          output: outputChannel,
          debugReasoning: settings.debugReasoning,
          requestTimeoutMs: settings.requestTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
          contextWindowOutputBuffer,
          capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
          onTransportSummary,
          stripThinkTags: settings.stripThinkTags,
          onReasoningContent: (toolCallIds, reasoningContent) => {
            this.storeReasoningContent(toolCallIds, reasoningContent);
          },
        });
        this.log(`Request completed: model=${model.id}`);
        return;
      }

      if (routing.endpointKind === "google") {
        await runStreamGoogleGenerateContent({
          url: routing.endpointUrl,
          providerDisplayName: this.definition.displayName,
          apiKey,
          modelId: rawModelId,
          body: buildGoogleGenerateContentBody(apiMessages, options, settings, limits),
          requestHeaders,
          progress,
          token,
          output: outputChannel,
          debugReasoning: settings.debugReasoning,
          requestTimeoutMs: settings.requestTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
          contextWindowOutputBuffer,
          authHeaders: buildOpenCodeGatewayAuthHeaders("google", apiKey),
          capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
          onTransportSummary,
          stripThinkTags: settings.stripThinkTags,
          onReasoningContent: (toolCallIds, reasoningContent) => {
            this.storeReasoningContent(toolCallIds, reasoningContent);
          },
        });
        return;
      }

      await runStreamChatCompletions({
        url: routing.endpointUrl,
        providerDisplayName: this.definition.displayName,
        apiKey,
        modelId: rawModelId,
        body: buildChatCompletionsRequestBody(rawModelId, apiMessages, options, settings, metadata, limits),
        authHeaders: buildOpenCodeGatewayAuthHeaders("chat-completions", apiKey),
        requestHeaders,
        progress,
        token,
        output: outputChannel,
        debugReasoning: settings.debugReasoning,
        requestTimeoutMs: settings.requestTimeoutMs,
        streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
        contextWindowOutputBuffer,
        capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
        onTransportSummary,
        stripThinkTags: settings.stripThinkTags,
        treatReasoningAsContent: thinkingProviderFor(rawModelId).treatReasoningAsContent(routing.endpointUrl, settings.thinking),
        onReasoningContent: (toolCallIds, reasoningContent) => {
          this.storeReasoningContent(toolCallIds, reasoningContent);
        },
      });
      this.log(`Request completed: model=${model.id}`);
    } catch (error) {
      const message = getErrorMessage(error);
      this.log(`ERROR model=${model.id}: ${message}`);
      if (error instanceof OpenCodeRequestError) {
        vscode.window.showErrorMessage(error.userMessage);
      }
      throw error;
    }
  }

  provideTokenCount(
    _model: OpenCodeModel,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    return Promise.resolve(typeof text === "string" ? estimateTokenCount(text) : estimateChatMessageTokenCount(text));
  }

  /**
   * Fetch the live model list from the OpenCode gateway.
   *
   * CONTRACT:
   * - Resilient to transient network failures (DNS, TCP reset, connect
   *   timeout, 5xx, 429): retries up to {@link MODEL_LIST_FETCH_MAX_RETRIES}
   *   times with exponential backoff. See {@link isTransientFetchError}.
   * - Hard timeout of {@link MODEL_LIST_FETCH_TIMEOUT_MS} per attempt —
   *   undici's default 300s `headersTimeout` is far too long for the picker
   *   (issue #78: picker appeared stuck for minutes on hung TCP).
   * - Sends `User-Agent` ({@link getUserAgent}) so strict gateways don't
   *   silently drop the request.
   * - On final failure, prefers the last successful snapshot (cached in
   *   globalState, TTL {@link MODEL_LIST_CACHE_TTL_MS}) over the bundled
   *   `fallbackModels`, so transient failures don't make the picker "flash
   *   then disappear" when VS Code 1.129's agent host re-resolves frequently.
   * - Respects the VS Code CancellationToken: bails early on abort, never
   *   retries an aborted request.
   */
  private async fetchModels(apiKey?: string, token?: vscode.CancellationToken): Promise<string[]> {
    if (token?.isCancellationRequested) return this.fallbackModelList();

    // Explicit Accept + User-Agent make this look like a legitimate API call
    // rather than an anonymous scanner. Some corporate firewalls / SSL
    // inspection proxies (Zscaler, Netskope, Fortinet) drop bare GETs that
    // lack these headers even when the host is allow-listed. Issue #78
    // reporter sits behind a VPN + corporate firewall on Windows 11.
    const headers: Record<string, string> = {
      "User-Agent": getUserAgent(),
      Accept: "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MODEL_LIST_FETCH_MAX_RETRIES; attempt++) {
      if (token?.isCancellationRequested) {
        return this.fallbackModelList();
      }
      let cancellationLink: { signal: AbortSignal; dispose: () => void } | undefined;
      try {
        // Compose the per-request abort with the caller's cancellation token
        // so either one tears down the in-flight fetch.
        const timeoutSignal = AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS);
        cancellationLink = token ? this.signalFromToken(token) : undefined;
        const signal = token && cancellationLink ? AbortSignal.any([timeoutSignal, cancellationLink.signal]) : timeoutSignal;

        const response = await fetch(this.definition.modelsUrl, { headers, signal });
        if (!response.ok) {
          throw new Error(`Model list request failed (${String(response.status)}): ${response.statusText}`);
        }
        const data = (await response.json()) as ModelListResponse;
        this.replaceLiveModelMetadata(data.data);
        const ids = data.data
          ?.map((model) => model.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
          .filter((id) => this.definition.filterModel?.(id) ?? true);

        const filtered = await this.filterAvailableModels(ids?.length ? ids : this.definition.fallbackModels);
        // Persist the successful snapshot for future fallback coverage.
        this.cachedModelList = { ids: filtered, fetchedAt: Date.now() };
        void this.context.globalState.update(this.modelListCacheKey, this.cachedModelList);
        return filtered;
      } catch (error) {
        cancellationLink?.dispose();
        cancellationLink = undefined;
        lastError = error;
        // 1. If the caller's cancellation token fired, never retry — bail.
        if (token?.isCancellationRequested) {
          return await this.fallbackModelList();
        }
        // 2. Classify the error. Timeout (AbortError without token cancel)
        //    and transient network errors are retryable; HTTP 4xx is not.
        const aborted = typeof DOMException === "function" && error instanceof DOMException && error.name === "AbortError";
        const transient = aborted || isTransientFetchError(error);
        // 3. On final attempt or non-transient error, fall through to
        //    cache/bundled fallback below.
        if (!transient || attempt === MODEL_LIST_FETCH_MAX_RETRIES) {
          break;
        }
        const backoff = MODEL_LIST_FETCH_RETRY_BASE_MS * Math.pow(2, attempt);
        this.log(
          `[fetchModels] ${this.definition.displayName}: transient error (attempt ${String(attempt + 1)}/${String(MODEL_LIST_FETCH_MAX_RETRIES + 1)}): ${this.errMsg(error)}. Retrying in ${String(backoff)}ms.`,
        );
        try {
          await sleep(backoff, token);
        } catch {
          // Cancellation during backoff — bail to fallback.
          return await this.fallbackModelList();
        }
      } finally {
        cancellationLink?.dispose();
      }
    }

    // Final failure: prefer cached snapshot (still fresh), then bundled list.
    const cached = this.loadCachedModelList();
    if (cached) {
      this.log(
        `[fetchModels] ${this.definition.displayName}: ${this.errMsg(lastError)}. Using cached model list (${String(cached.ids.length)} models, fetched ${new Date(cached.fetchedAt).toISOString()}).`,
      );
      return this.filterAvailableModels(cached.ids);
    }
    this.log(
      `[fetchModels] ${this.definition.displayName}: ${this.errMsg(lastError)}. Using bundled model list (${String(this.definition.fallbackModels.length)} models).`,
    );
    return this.filterAvailableModels(this.definition.fallbackModels);
  }

  /** Bundle the cancellation semantics of a VS Code token into an AbortSignal. */
  private signalFromToken(token: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    let subscription: vscode.Disposable | undefined;
    if (token.isCancellationRequested) {
      controller.abort();
    } else {
      // Already-cancelled tokens still invoke the listener (shortcutEvent),
      // so this single subscription covers the subscribe-time race too.
      subscription = token.onCancellationRequested(() => {
        controller.abort();
      });
    }
    return {
      signal: controller.signal,
      dispose: () => {
        subscription?.dispose();
        subscription = undefined;
      },
    };
  }

  private errMsg(error: unknown): string {
    const message = getErrorMessage(error);
    const cause = (error as { cause?: { code?: string; name?: string; message?: string } } | null | undefined)?.cause;
    return cause?.code ? `${message} [${cause.code}]` : message;
  }

  /**
   * Resolve the model list to use when the fetch path is short-circuited
   * (cancellation, early abort). Prefers a fresh cached snapshot over bundled.
   */
  private fallbackModelList(): Promise<string[]> {
    const cached = this.loadCachedModelList();
    if (cached) {
      return this.filterAvailableModels(cached.ids);
    }
    return this.filterAvailableModels(this.definition.fallbackModels);
  }

  /**
   * Read the last successful fetch from in-memory cache or globalState.
   * Returns undefined when absent or past {@link MODEL_LIST_CACHE_TTL_MS}.
   */
  private loadCachedModelList(): { ids: string[]; fetchedAt: number } | undefined {
    if (this.cachedModelList) {
      const fresh = Date.now() - this.cachedModelList.fetchedAt < MODEL_LIST_CACHE_TTL_MS;
      if (fresh) return this.cachedModelList;
    }
    const stored = this.context.globalState.get<{ ids: string[]; fetchedAt: number }>(this.modelListCacheKey);
    if (stored && Array.isArray(stored.ids) && typeof stored.fetchedAt === "number") {
      const fresh = Date.now() - stored.fetchedAt < MODEL_LIST_CACHE_TTL_MS;
      if (fresh) {
        this.cachedModelList = stored;
        return stored;
      }
    }
    return undefined;
  }

  private async filterAvailableModels(modelIds: string[]): Promise<string[]> {
    const uniqueModelIds = [...new Set(modelIds)];

    try {
      const metadataSnapshot = await this.getMetadataSnapshot();
      const filteredModelIds = uniqueModelIds.filter(
        (modelId) =>
          !KNOWN_UNAVAILABLE_MODEL_IDS.has(modelId) &&
          !shouldHideDeprecatedModel(modelId, this.baseVendor, metadataSnapshot) &&
          (this.definition.filterModel?.(modelId) ?? true),
      );

      const removedModelIds = uniqueModelIds.filter((modelId) => !filteredModelIds.includes(modelId));
      if (removedModelIds.length) {
        this.log(`Filtered unavailable/deprecated models: ${removedModelIds.join(", ")}`);
      }

      return filteredModelIds;
    } catch (error) {
      const message = getErrorMessage(error);
      this.log(`Could not fetch model status metadata from models.dev. Applying local unavailable model filter only. ${message}`);
      return uniqueModelIds.filter(
        (modelId) => !KNOWN_UNAVAILABLE_MODEL_IDS.has(modelId) && (this.definition.filterModel?.(modelId) ?? true),
      );
    }
  }
}

function getConfiguredApiKey(options?: { configuration?: LanguageModelConfiguration }): string | undefined {
  const configuredApiKey = options?.configuration?.apiKey;
  return typeof configuredApiKey === "string" && configuredApiKey.trim() ? configuredApiKey.trim() : undefined;
}

async function clearOpenCodeModelMetadataCache(context: vscode.ExtensionContext): Promise<void> {
  modelMetadataSnapshot = undefined;
  modelMetadataRefreshPromise = undefined;
  await context.globalState.update(MODEL_METADATA_CACHE_KEY, undefined);
}

async function getOpenCodeModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  const cached = modelMetadataSnapshot ?? context.globalState.get<CachedModelMetadataSnapshot>(MODEL_METADATA_CACHE_KEY);
  if (cached) {
    modelMetadataSnapshot = cached;
    if (isFreshModelMetadata(cached)) {
      return cached;
    }
    void refreshOpenCodeModelMetadata(context, output);
    return cached;
  }

  return refreshOpenCodeModelMetadata(context, output);
}

async function refreshOpenCodeModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  if (modelMetadataRefreshPromise) {
    return modelMetadataRefreshPromise;
  }

  modelMetadataRefreshPromise = (async () => {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: AbortSignal.timeout(MODEL_METADATA_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`models.dev request failed (${String(response.status)}): ${response.statusText}`);
    }

    const data = (await response.json()) as ModelsDevResponse;
    const snapshot = normalizeModelsDevSnapshot(data);
    modelMetadataSnapshot = snapshot;
    await context.globalState.update(MODEL_METADATA_CACHE_KEY, snapshot);
    output?.appendLine(
      `[metadata] refreshed models.dev cache go=${Object.keys(snapshot.providers[GO_VENDOR] ?? {}).length} zen=${Object.keys(snapshot.providers[ZEN_VENDOR] ?? {}).length}`,
    );
    return snapshot;
  })()
    .catch((error: unknown) => {
      const cached = modelMetadataSnapshot ?? context.globalState.get<CachedModelMetadataSnapshot>(MODEL_METADATA_CACHE_KEY);
      if (cached) {
        const message = getErrorMessage(error);
        output?.appendLine(`[metadata] refresh failed, using cached snapshot: ${message}`);
        modelMetadataSnapshot = cached;
        return cached;
      }

      const message = getErrorMessage(error);
      const fallback = bundledModelMetadataSnapshot();
      output?.appendLine(`[metadata] refresh failed, using bundled snapshot: ${message}`);
      modelMetadataSnapshot = fallback;
      return fallback;
    })
    .finally(() => {
      modelMetadataRefreshPromise = undefined;
    });

  return modelMetadataRefreshPromise;
}

// (chat/Anthropic/Responses/Google request builders migrated to src/request/builders.ts)

// (google request builders migrated to src/request/builders.ts)

// The official OpenCode client sends these headers on every request. The Zen
// gateway reads x-opencode-session first, then converts that sticky identifier
// into provider-specific affinity headers such as x-session-affinity upstream.
//
// VS Code's provider API does not currently expose a guaranteed public session
// identifier everywhere, so we first probe a few known internal fields and then
// fall back to a stable hash of the first messages in the conversation. That
// preserves sticky routing and cache affinity without depending on hidden state.
function buildOpenCodeRequestHeaders(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  modelId: string,
): Record<string, string> {
  const sessionId = cleanHeaderValue(
    findStringOption(options, [
      "sessionId",
      "sessionID",
      "chatSessionId",
      "chatSessionID",
      "conversationId",
      "conversationID",
      "threadId",
      "threadID",
      "session.id",
      "chatSession.id",
    ]) ?? `vscode-${stableHash(conversationAnchor(messages, modelId))}`,
  );
  const requestId = cleanHeaderValue(
    findStringOption(options, ["requestId", "requestID", "messageId", "messageID"]) ??
      `req-${stableHash(`${String(Date.now())}-${String(Math.random())}-${sessionId}-${modelId}`)}`,
  );

  return {
    "x-opencode-session": sessionId,
    "x-opencode-request": requestId,
    "x-opencode-client": OPEN_CODE_CLIENT,
    "User-Agent": getUserAgent(),
  };
}

/**
 * Stringify an arbitrary transport-layer initiator value for diagnostics.
 * Objects and functions are JSON-serialized, nullish values are dropped, and
 * primitives are converted directly so logs never show "[object Object]".
 */
function stringifyInitiator(initiator: unknown): string | undefined {
  if (initiator === undefined || initiator === null) {
    return undefined;
  }
  if (typeof initiator === "string") {
    return initiator;
  }
  if (typeof initiator === "object" || typeof initiator === "function") {
    return JSON.stringify(initiator);
  }
  if (typeof initiator === "symbol" || typeof initiator === "bigint") {
    return initiator.toString();
  }
  if (typeof initiator === "number" || typeof initiator === "boolean") {
    return String(initiator);
  }
  // No known primitive type left; nothing useful to stringify.
  return undefined;
}

function findStringOption(options: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = readPath(options, path.split("."));
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function conversationAnchor(messages: readonly vscode.LanguageModelChatRequestMessage[], modelId: string): string {
  const anchorMessages = messages.slice(0, 3).map((message) => `${String(message.role)}:${messageText(message).slice(0, 2048)}`);
  return anchorMessages.length ? anchorMessages.join("\n") : modelId;
}

function cleanHeaderValue(value: string): string {
  const cleaned = value.replace(/[\r\n]/g, " ").trim();
  return cleaned ? cleaned.slice(0, 256) : "unknown";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// (tool mapping + JSON-schema sanitize migrated to src/request/builders.ts)

async function convertMessage(
  message: vscode.LanguageModelChatRequestMessage,
  reasoningContentByToolCallId: ReadonlyMap<string, string>,
  rawModelId?: string,
): Promise<ConvertedMessageResult> {
  const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
  const textParts: string[] = [];
  const thinkingTextParts: string[] = [];
  const imageParts: OpenAiContentPart[] = [];
  const toolCalls: OpenAiToolCall[] = [];
  const toolResults: ApiMessage[] = [];
  let normalizedImageCount = 0;

  const normalizeImagePart = async (part: vscode.LanguageModelDataPart): Promise<string> => {
    const originalUrl = `data:${part.mimeType};base64,${dataPartToBase64(part.data)}`;
    const normalizedUrl = await normalizeImageDataUrl(originalUrl);
    if (normalizedUrl !== originalUrl) {
      normalizedImageCount += 1;
    }
    return normalizedUrl;
  };

  const finish = (messages: ApiMessage[]): ConvertedMessageResult => ({
    messages,
    normalizedImageCount,
  });

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({
        id: part.callId,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input),
        },
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      // CONTRACT: A LanguageModelToolResultPart.content is unknown[] and may
      // contain nested LanguageModelDataPart instances with image MIME types.
      // This happens when MCP tools (e.g. chrome-devtools-mcp screenshots)
      // return images. Previously we only ran partToText() which silently
      // dropped image DataParts (returned "" via the catch-all fallback),
      // so vision-capable models saw an empty tool result. We now serialize
      // nested images into OpenAiContentPart image_url parts and emit a
      // multimodal array on the tool message when any image is present.
      //
      // SIZE GUARD: Images larger than MAX_TOOL_RESULT_IMAGE_BYTES are
      // replaced with a placeholder text part. This prevents a single
      // oversized MCP screenshot from producing multi-MB payloads that
      // trigger upstream 400 errors when the conversation history grows.
      // Fallback for any non-text, non-image DataPart stays as plain text.
      const toolTextParts: string[] = [];
      const toolImageParts: OpenAiContentPart[] = [];
      for (const resultPart of part.content) {
        if (
          resultPart instanceof vscode.LanguageModelDataPart &&
          resultPart.mimeType.startsWith("image/") &&
          !isInternalDataPart(resultPart)
        ) {
          if (resultPart.data.byteLength > MAX_TOOL_RESULT_IMAGE_BYTES) {
            toolTextParts.push(
              `[Image attachment omitted: ${String(resultPart.data.byteLength)} bytes exceeds the ${String(MAX_TOOL_RESULT_IMAGE_BYTES)}-byte limit for tool results. Ask the tool to produce a smaller screenshot or save it to a file.]`,
            );
            continue;
          }
          const imageUrl = await normalizeImagePart(resultPart);
          toolImageParts.push({
            type: "image_url",
            image_url: { url: imageUrl },
          });
          continue;
        }

        const text = partToText(resultPart);
        if (text) {
          toolTextParts.push(text);
        }
      }

      let toolContent: string | OpenAiContentPart[];
      if (toolImageParts.length > 0) {
        // PROVIDER QUIRK: Xiaomi MiMo (and GLM-5.2) reject list-type tool
        // message content with HTTP 400 "text is not set" (upstream issue
        // anomalyco/opencode#32613). MiMo accepts multimodal content in
        // user/assistant messages but strictly requires `role: "tool"`
        // messages to have a plain string content. The OpenCode Go gateway
        // passes list-type content through unchanged, so we must flatten it
        // client-side for MiMo.
        //
        // For MiMo: emit a plain string — join text parts, and replace each
        // image with a short placeholder note (the model cannot see tool
        // images on MiMo upstream anyway, so we lose nothing and gain a
        // working request). For other providers: keep the multimodal array
        // (Kimi, GLM-5.1, MiniMax, Qwen all accept list-type tool content).
        const isMimoModel = rawModelId !== undefined && /^mimo-/i.test(rawModelId);
        if (isMimoModel) {
          const flattened: string[] = [...toolTextParts];
          for (let i = 0; i < toolImageParts.length; i++) {
            flattened.push(
              `[Tool returned an image attachment, but the MiMo upstream provider does not accept images in tool messages. Image ${String(i + 1)} of ${String(toolImageParts.length)} was dropped to keep the request valid.]`,
            );
          }
          toolContent = flattened.join("\n");
        } else {
          const multimodal: OpenAiContentPart[] = [];
          const joinedText = toolTextParts.join("\n");
          if (joinedText) {
            multimodal.push({ type: "text", text: joinedText });
          }
          multimodal.push(...toolImageParts);
          toolContent = multimodal;
        }
      } else {
        toolContent = toolTextParts.join("\n");
      }

      toolResults.push({
        role: "tool",
        tool_call_id: part.callId,
        content: toolContent,
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
      // Normalize before the final payload guard. The previous raw-byte guard
      // ran first and dropped images that could have been resized or compressed
      // into a provider-safe representation.
      const imageUrl = await normalizeImagePart(part);
      const base64Bytes = getImageDataUrlBase64Bytes(imageUrl);
      if (base64Bytes === undefined || base64Bytes > MAX_IMAGE_BASE64_BYTES) {
        textParts.push(
          `[Image attachment omitted: normalized payload exceeds the ` +
            `${String(Math.floor(MAX_IMAGE_BASE64_BYTES / (1024 * 1024)))} MB base64 limit. ` +
            `Resize or compress the image and re-attach it.]`,
        );
        continue;
      }
      imageParts.push({
        type: "image_url",
        image_url: { url: imageUrl },
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart && isInternalDataPart(part)) {
      continue;
    }

    if (part instanceof vscode.LanguageModelThinkingPart) {
      const thinking = thinkingPartText(part);
      if (thinking) {
        thinkingTextParts.push(thinking);
      }
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart && isReasoningMarkerPart(part)) {
      // Thinking-off responses carry their reasoning in a marker data part
      // (see streaming.ts / gateway bug #37635); echo it as reasoning_content
      // on the next turn or DeepSeek's validator 400s.
      const reasoning = readReasoningMarker(part);
      if (reasoning) {
        thinkingTextParts.push(reasoning);
      }
      continue;
    }

    const text = partToText(part);
    if (text) {
      textParts.push(text);
    }
  }

  // Build content: use multimodal array if images present, otherwise plain string
  const hasImages = imageParts.length > 0;
  const textContent = textParts.join("\n");

  // Thinking parts from the conversation history. Models like DeepSeek V4
  // (OpenAI-compatible chat-completions) REQUIRE the previously emitted
  // reasoning_content to be passed back unchanged on multi-turn requests —
  // omitting it yields HTTP 400 "The reasoning_content in the thinking mode
  // must be passed back to the API". This also enables cross-turn reasoning
  // continuity for other families (Kimi, GLM, Qwen, MiniMax, Gemini).
  const thinkingText = thinkingTextParts.length ? thinkingTextParts.join("\n").trim() : undefined;

  let content: string | null | OpenAiContentPart[] = textContent;
  if (hasImages) {
    const multimodal: OpenAiContentPart[] = [];
    if (textContent) {
      multimodal.push({ type: "text", text: textContent });
    }
    multimodal.push(...imageParts);
    content = multimodal;
  }

  if (role === "assistant" && toolCalls.length) {
    // CONTRACT: reasoning_content injection into tool_call assistant messages
    // is gated by model family. MiMo upstream (Xiaomi) uses a strict Pydantic-
    // style validator that rejects assistant tool_call messages carrying a
    // `reasoning_content` field with HTTP 400 `Upstream request failed`, once
    // the conversation history contains tool_calls with reasoning echo. This
    // mirrors the DeepSeek V4 issue (#36354 upstream) and was verified in this
    // extension's logs (issue #38, 2026-07-25): MiMo succeeds until the first
    // tool_call turn with reasoning_content, then every subsequent turn 400s.
    //
    // For MiMo we omit reasoning_content in the echoed assistant tool_call
    // history. The current live response still surfaces reasoning_content to
    // the user via the thinking panel — only the *history echo* is dropped.
    // Other families (DeepSeek, Kimi, GLM, Qwen, MiniMax) tolerate the echo
    // and keep it for cross-turn reasoning continuity.
    const shouldOmitReasoningEcho = rawModelId !== undefined && /^mimo-/i.test(rawModelId);
    return finish([
      {
        role,
        content: typeof content === "string" ? content || null : content,
        reasoning_content: shouldOmitReasoningEcho
          ? undefined
          : (reasoningForToolCalls(toolCalls, reasoningContentByToolCallId) ?? thinkingText),
        tool_calls: toolCalls,
      },
    ]);
  }

  if (toolResults.length) {
    return finish(content ? [{ role, content }, ...toolResults] : toolResults);
  }

  if (role === "assistant") {
    return finish([
      {
        role,
        content: typeof content === "string" ? content || null : content,
        reasoning_content: shouldEchoThinkingHistory(rawModelId) ? thinkingText : undefined,
      },
    ]);
  }

  return finish([{ role, content }]);
}

function dataPartToBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function reasoningForToolCalls(toolCalls: OpenAiToolCall[], reasoningContentByToolCallId: ReadonlyMap<string, string>): string | undefined {
  const reasoning = toolCalls
    .map((toolCall) => reasoningContentByToolCallId.get(toolCall.id))
    .filter((value): value is string => Boolean(value?.trim()));

  return reasoning.length ? reasoning.join("\n") : undefined;
}

/**
 * Extract the raw thinking text from a history `LanguageModelThinkingPart`.
 * `LanguageModelThinkingPart` is a proposed VS Code API available at runtime
 * on all hosts we target (^1.125.0); `partToText` intentionally ignores it so
 * the thinking text never leaks into the visible assistant `content`. The
 * `typeof` guard mirrors `streaming.ts` so we degrade gracefully on any
 * hypothetical older host.
 */
function thinkingPartText(part: unknown): string {
  if (typeof vscode.LanguageModelThinkingPart !== "function" || !(part instanceof vscode.LanguageModelThinkingPart)) {
    return "";
  }
  return thinkingTextFromValue(part.value);
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content.map(partToText).filter(Boolean).join("\n");
}

function estimateChatMessageTokenCount(message: vscode.LanguageModelChatRequestMessage): number {
  const role = typeof message.role === "string" ? message.role : String(message.role);
  const name = typeof message.name === "string" ? message.name : "";
  const contentTokens = message.content.map(partToTokenCount).reduce((total, count) => total + count, 0);

  return (
    MESSAGE_TOKEN_OVERHEAD + estimateTokenCount(role) + (name ? MESSAGE_NAME_TOKEN_OVERHEAD + estimateTokenCount(name) : 0) + contentTokens
  );
}

function partToTokenCount(part: unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return estimateTokenCount(part.value);
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    const contentTokens = part.content.map(partToTokenCount).reduce((total, count) => total + count, 0);
    return TOOL_RESULT_TOKEN_OVERHEAD + estimateTokenCount(part.callId) + contentTokens;
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return (
      TOOL_CALL_TOKEN_OVERHEAD + estimateTokenCount(part.callId) + estimateTokenCount(part.name) + estimateStructuredTokenCount(part.input)
    );
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    return isInternalDataPart(part) ? 0 : estimateDataPartTokenCount(part);
  }

  if (typeof part === "string") {
    return estimateTokenCount(part);
  }

  if (isRecord(part)) {
    return estimateStructuredTokenCount(part);
  }

  return 0;
}

function estimateStructuredTokenCount(value: unknown): number {
  try {
    return estimateTokenCount(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function estimateDataPartTokenCount(part: vscode.LanguageModelDataPart): number {
  if (part.mimeType.startsWith("image/")) {
    return IMAGE_TOKEN_ESTIMATE;
  }

  if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
    return estimateTokenCount(new TextDecoder().decode(part.data));
  }

  return Math.max(1, Math.ceil(part.data.byteLength / 4));
}

function partToText(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    return part.content.map(partToText).filter(Boolean).join("\n");
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return `[Tool call: ${part.name} ${JSON.stringify(part.input)}]`;
  }

  if (part instanceof vscode.LanguageModelDataPart && isInternalDataPart(part)) {
    return "";
  }

  if (typeof part === "string") {
    return part;
  }

  return "";
}

function normalizeMessages(messages: ApiMessage[]): ApiMessage[] {
  const normalized: ApiMessage[] = [];

  for (const message of messages) {
    if (!hasMessagePayload(message)) {
      continue;
    }

    const previous = normalized.at(-1);
    const prevContent = previous?.content;
    const msgContent = message.content;
    const prevIsString = typeof prevContent === "string";
    const msgIsString = typeof msgContent === "string";
    const prevHasToolCalls = !!(previous?.tool_calls?.length || previous?.tool_call_id);
    const msgHasToolCalls = !!(message.tool_calls?.length || message.tool_call_id);

    if (
      previous?.role === message.role &&
      message.role !== "tool" &&
      prevIsString &&
      msgIsString &&
      !prevHasToolCalls &&
      !msgHasToolCalls
    ) {
      previous.content = `${prevContent}\n\n${msgContent}`.trim();
    } else {
      normalized.push({ ...message });
    }
  }

  if (normalized[0]?.role === "assistant") {
    normalized.unshift({
      role: "user",
      content: "Continue the conversation based on the prior assistant message.",
    });
  }

  return normalized.length ? normalized : [{ role: "user", content: "" }];
}

// messagesHaveImages migrated to src/request/builders.ts

/**
 * Replace image content parts in older messages with a placeholder text note
 * in place, keeping only the most recent `MAX_HISTORY_IMAGES_KEPT` images in
 * the conversation. This bounds the cumulative payload weight when MCP
 * screenshot loops (chrome-devtools-mcp, playwright-mcp) accumulate base64
 * data URIs in history and trigger upstream `400 Upstream request failed`
 * rejections from OpenCode Go.
 *
 * CONTRACT:
 *   - Iterates messages from newest to oldest, counting `image_url` parts.
 *   - Once `MAX_HISTORY_IMAGES_KEPT` images have been seen, every subsequent
 *     (older) image part is replaced in place with a placeholder text note.
 *   - Non-image content parts (text, tool_calls, tool_call_id) are preserved
 *     unchanged — the conversation structure stays intact.
 *   - The placeholder replaces the image part in the same message's content
 *     array; the array shape is preserved so downstream transport builders
 *     still see a valid multimodal structure.
 *   - Mutates the input array's message `content` fields in place (safe: the
 *     caller `provideLanguageModelChatResponse` does not reuse the original
 *     array after this point).
 *
 * INVARIANTS:
 *   - Total `image_url` parts remaining in the array after the call ≤
 *     `MAX_HISTORY_IMAGES_KEPT`.
 *   - Every original image position is either preserved or replaced with a
 *     placeholder text part — no message is silently dropped.
 *
 * @param messages ApiMessage[] from convertMessage() — must be in chronological
 *                 order (oldest first, newest last), as produced by
 *                 `messages.flatMap(convertMessage)`. Mutated in place.
 * @returns Number of image parts that were replaced with a placeholder (for
 *          diagnostic logging). Returns 0 when no trimming was needed.
 */
function trimOldImagesFromHistoryInPlace(messages: ApiMessage[]): number {
  // Count total images to decide whether trimming is needed. Cheap pass that
  // skips allocation and mutation for the common case (short conversations,
  // 0-2 images).
  let totalImages = 0;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "image_url") totalImages++;
    }
  }
  if (totalImages <= MAX_HISTORY_IMAGES_KEPT) {
    return 0;
  }

  // Walk newest -> oldest, allowing the first MAX_HISTORY_IMAGES_KEPT images
  // to pass through and replacing every older image with a placeholder note.
  let imagesKept = 0;
  let replacedCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    const hasImage = msg.content.some((p) => p.type === "image_url");
    if (!hasImage) continue;
    // Build a new content array, replacing image parts once the budget is spent.
    // We rebuild the array rather than splice-in-place because the original
    // parts array may be shared with the caller's view.
    const newContent: OpenAiContentPart[] = [];
    for (const part of msg.content) {
      if (part.type === "image_url") {
        if (imagesKept < MAX_HISTORY_IMAGES_KEPT) {
          newContent.push(part);
          imagesKept++;
        } else {
          newContent.push({
            type: "text",
            text: "[Earlier screenshot omitted from history to keep request payload under gateway limit. The latest screenshots above are preserved.]",
          });
          replacedCount++;
        }
      } else {
        newContent.push(part);
      }
    }
    msg.content = newContent;
  }
  return replacedCount;
}

function hasMessagePayload(message: ApiMessage): boolean {
  if (message.tool_calls?.length || message.tool_call_id) {
    return true;
  }

  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }

  if (Array.isArray(message.content)) {
    return message.content.length > 0;
  }

  return false;
}

// Detect which Thinking family a raw model id belongs to. Used both to render
// the per-model picker submenu (configurationSchema) and to map the user's
// per-request selection back to the right OpenCode request field.
// Per-family JSON-Schema describing the native model-picker controls rendered
// by VS Code 1.120. Keep the primary property name aligned with VS Code's
// BYOK reasoning control so builds with narrower assumptions still recognize it.
// Accepts optional metadata for dynamic fallback: any model with
// `reasoning: true` in its resolved metadata gets a generic off/on schema
// even if no hardcoded family match exists.
function modelConfigurationSchema(modelId: string, metadata?: ResolvedModelMetadata): vscode.LanguageModelConfigurationSchema | undefined {
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

/**
 * Build the thinking-effort portion of the configuration schema.
 * Delegated to the per-provider strategy in `./thinking` (pure, testable).
 */

function getRequestModelConfiguration(options: vscode.ProvideLanguageModelChatResponseOptions): Record<string, unknown> | undefined {
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

function getSettings(): ApiSettings {
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

// The thinking provider strategies (thinkingProviderFor, resolveThinkingConfig)
// are imported from ./thinking (pure, testable).

function modelLimits(
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

function modelCapabilities(metadata: ResolvedModelMetadata): vscode.LanguageModelChatCapabilities {
  // When a vision proxy model is configured (non-empty ID in globalState),
  // report imageInput: true for ALL models so VS Code does not strip image
  // parts before they reach our provider. The vision proxy interceptor
  // forwards images to the configured model transparently.
  const supportsVision = metadata.supportsVision || isVisionProxyEnabled();

  // `editTools` is intentionally absent. VS Code 1.132 still gates that hint
  // behind the chatProvider proposal for non-allowlisted extensions.
  return buildStableModelCapabilities(supportsVision);
}

function formatModalityBadges(metadata: ResolvedModelMetadata): string {
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

function shouldHideDeprecatedModel(modelId: string, vendor: ProviderDefinition["vendor"], snapshot: CachedModelMetadataSnapshot): boolean {
  if (resolveBaseVendor(vendor) !== ZEN_VENDOR) {
    return false;
  }
  return snapshot.providers[ZEN_VENDOR]?.[modelId]?.status === "deprecated";
}

function resolveRawModelId(modelId: string): string {
  const [base] = modelId.split("::");
  const prefixes = [`${GO_VENDOR}:`, `${ZEN_VENDOR}:`, `${AGENT_GO_VENDOR}:`, `${AGENT_ZEN_VENDOR}:`];
  for (const prefix of prefixes) {
    if (base.startsWith(prefix)) {
      return base.slice(prefix.length);
    }
  }
  return base;
}

/** Result of a vision-proxy pass: per-message descriptions plus cache stats. */
interface VisionProxyResult {
  /** Original message index → text description (only for messages with images). */
  descriptions: ReadonlyMap<number, string>;
  /** Messages whose images were already cached — no vision model request was made. */
  cacheHits: number;
  /** Messages that required a new vision-model request. */
  cacheMisses: number;
}

/**
 * Collect the parts of a single message that the vision proxy should see:
 * image parts plus text parts, dropping tool parts.
 */
function collectRequestParts(msg: vscode.LanguageModelChatRequestMessage): (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] {
  const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [];
  for (const part of msg.content) {
    if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
      parts.push(part);
    } else if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part);
    } else if (typeof part === "object" && part !== null && "value" in part) {
      parts.push(new vscode.LanguageModelTextPart(String(part.value)));
    }
  }
  return parts;
}

/**
 * Build a vision-model request for a single message: keep its image parts and
 * text parts (dropping tool parts), then append the vision prompt. This lets
 * the proxy describe ONLY the message that contains a new image, instead of
 * re-sending the whole conversation on every turn.
 */
/**
 * Build a vision-model request: keep image and text parts from every message
 * (dropping tool parts), then append the vision prompt. Used both for the
 * per-message path (single message) and the whole-conversation path (all
 * messages) when `opencodego.visionProxyWholeConversation` is enabled.
 */
function buildVisionRequest(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  visionPrompt: string,
): vscode.LanguageModelChatMessage[] {
  const requestMessages: vscode.LanguageModelChatMessage[] = [];
  for (const msg of messages) {
    const parts = collectRequestParts(msg);
    if (parts.length > 0) {
      requestMessages.push(
        new vscode.LanguageModelChatMessage(
          msg.role === vscode.LanguageModelChatMessageRole.Assistant
            ? vscode.LanguageModelChatMessageRole.Assistant
            : vscode.LanguageModelChatMessageRole.User,
          parts,
        ),
      );
    }
  }
  // Append the vision prompt
  if (visionPrompt) {
    requestMessages.push(vscode.LanguageModelChatMessage.User(visionPrompt));
  }
  return requestMessages;
}

/**
 * Vision proxy: relay image messages through a vision-capable Copilot model
 * and return the text description. This lets text-only models "see" images
 * transparently (issue #74).
 *
 * By default (`describeWholeConversation` false), descriptions are cached per
 * image (`imageDescriptionCache`). A message whose images are ALL already
 * cached is reused without contacting the vision model; only messages that
 * contain at least one new image trigger a `sendRequest()` - for that single
 * message + prompt - and the result is stored in the cache for future turns.
 *
 * When `describeWholeConversation` is true (setting
 * `opencodego.visionProxyWholeConversation`), the proxy sends ONE request over
 * the whole conversation so descriptions keep full context; the combined
 * description is still stored under every image hash.
 */
async function proxyVision(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  visionModelId: string,
  visionPrompt: string,
  describeWholeConversation: boolean,
  token: vscode.CancellationToken,
): Promise<VisionProxyResult> {
  const descriptions = new Map<number, string>();
  let cacheHits = 0;
  let cacheMisses = 0;

  // Find the vision model lazily — only when a message actually needs a new
  // description. When every image is already cached we never call
  // `vscode.lm.selectChatModels()` or `model.sendRequest()`.
  let visionModel: vscode.LanguageModelChat | undefined;
  const resolveVisionModel = async (): Promise<vscode.LanguageModelChat> => {
    if (visionModel) {
      return visionModel;
    }
    // Matching strategies:
    // 1. Exact id match (full internal model id)
    // 2. Vendor:id partial (e.g. "opencodego:mimo-v2.5")
    // 3. Name or id substring (e.g. "mimo-v2.5" or "Mimo V2.5")
    // Filter out agent-host variants — they use a different transport and
    // don't have vision support. Prefer non-agent models.
    const nonAgent = (models: readonly vscode.LanguageModelChat[]) => models.filter((m) => !m.id.includes("-agent:"));

    let visionModels = nonAgent(await vscode.lm.selectChatModels({ id: visionModelId }));
    if (visionModels.length === 0) {
      // Try matching by name substring across all providers
      const allVisible = nonAgent(await vscode.lm.selectChatModels({}));
      visionModels = allVisible.filter(
        (m) =>
          m.id.toLowerCase().includes(visionModelId.toLowerCase()) ||
          m.name.toLowerCase().includes(visionModelId.toLowerCase()) ||
          m.family.toLowerCase().includes(visionModelId.toLowerCase()),
      );
    }
    if (visionModels.length === 0) {
      throw new Error(`Vision model "${visionModelId}" not found. ` + `Run "OpenCode Go: Configure Vision Proxy" to see available models.`);
    }

    // All models that matched are candidates. `selectChatModels` returns
    // `LanguageModelChat` which does not expose capabilities in the stable
    // API, so we just use the first match. Most vision models handle image
    // input gracefully — models without vision will report the error.
    visionModel = visionModels[0];
    return visionModel;
  };

  // Whole-conversation mode (opencodego.visionProxyWholeConversation): one
  // request over all messages, so descriptions carry full conversation context.
  if (describeWholeConversation) {
    const imageIndices: number[] = [];
    const allHashes: string[] = [];
    for (let index = 0; index < messages.length; index++) {
      const msg = messages[index];
      const imageParts = msg.content.filter(
        (part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/"),
      );
      if (imageParts.length === 0) {
        continue;
      }
      imageIndices.push(index);
      allHashes.push(...imageParts.map((part) => imageDescriptionKey(dataPartToBase64(part.data))));
    }
    if (imageIndices.length > 0) {
      cacheMisses++;
      const model = await resolveVisionModel();
      const response = await model.sendRequest(buildVisionRequest(messages, visionPrompt), {}, token);
      let fullDescription = "";
      for await (const part of response.text) {
        fullDescription += part;
      }
      if (fullDescription) {
        storeImageDescriptions(allHashes, fullDescription);
        for (const index of imageIndices) {
          descriptions.set(index, fullDescription);
        }
      }
    }
    return { descriptions, cacheHits, cacheMisses };
  }

  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const imageParts = msg.content.filter(
      (part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/"),
    );
    if (imageParts.length === 0) {
      continue;
    }
    const hashes = imageParts.map((part) => imageDescriptionKey(dataPartToBase64(part.data)));

    // All images already described → reuse the cached text, no model request.
    const cachedDescription = lookupImageDescriptions(hashes);
    if (cachedDescription !== undefined) {
      cacheHits++;
      descriptions.set(index, cachedDescription);
      continue;
    }

    // At least one new image → describe only this message and cache the result.
    cacheMisses++;
    const model = await resolveVisionModel();
    const response = await model.sendRequest(buildVisionRequest([msg], visionPrompt), {}, token);
    let fullDescription = "";
    for await (const part of response.text) {
      fullDescription += part;
    }
    if (!fullDescription) {
      continue;
    }
    storeImageDescriptions(hashes, fullDescription);
    descriptions.set(index, fullDescription);
  }

  return { descriptions, cacheHits, cacheMisses };
}

// ---------------------------------------------------------------------------
// Vision proxy — globalState storage keys & defaults
// ---------------------------------------------------------------------------

/**
 * True when a vision proxy model has been configured (non-empty model ID
 * stored in globalState via the "OpenCode Go: Configure Vision Proxy" command).
 */
function isVisionProxyEnabled(): boolean {
  return extensionContext().globalState.get<string>(VISION_PROXY_MODEL_ID_KEY, "").length > 0;
}

/**
 * QuickPick to configure vision proxy model and prompt.
 * Clean list of model names (no ugly IDs), with "None" to disable
 * and "Customize prompt..." to edit the description instruction.
 * Saves to globalState; toggles the visionProxy boolean accordingly.
 */
async function showVisionProxyPicker(context: vscode.ExtensionContext): Promise<void> {
  const currentModelId = context.globalState.get<string>(VISION_PROXY_MODEL_ID_KEY, "");
  const currentPrompt = context.globalState.get<string>(VISION_PROXY_PROMPT_KEY, "") || DEFAULT_VISION_PROXY_PROMPT;

  // --- Build the set of vision-capable model IDs ---
  const visionCapableIds = new Set<string>();
  const snapshot = modelMetadataSnapshot;
  if (snapshot) {
    for (const vendor of [GO_VENDOR, ZEN_VENDOR] as const) {
      const provider = snapshot.providers[vendor];
      if (!provider) continue;
      for (const [id, meta] of Object.entries(provider)) {
        if (meta.supportsVision) visionCapableIds.add(`${vendor}:${id}`);
      }
    }
  }
  for (const family of VISION_CAPABLE_MODELS) {
    visionCapableIds.add(`copilot:${family}`);
  }

  // --- Build QuickPick items from available models ---
  const allModels = (await vscode.lm.selectChatModels({})).filter((m) => !m.id.includes("-agent:"));

  const modelItems = allModels
    .map((m) => {
      const rawId = resolveRawModelId(m.id);
      const vendor = resolveVendorFromId(m.id);
      const lookupId = `${vendor}:${rawId}`;
      const fromLookup = visionCapableIds.has(lookupId);
      const fromName = [...visionCapableIds].some((id) => m.id.includes(id.replace(/^(opencodego|opencodezen|copilot):/, "")));
      const supportsVision = fromLookup || fromName;
      return {
        label: m.name,
        description: supportsVision ? "$(eye)" : "",
        detail: supportsVision ? (m.id === currentModelId ? "currently configured" : "vision-capable") : "",
        picked: m.id === currentModelId,
        _id: m.id,
        _kind: "model" as const,
        _supportsVision: supportsVision,
      };
    })
    .filter((m) => m._supportsVision);

  if (modelItems.length === 0) {
    vscode.window.showInformationMessage(
      "No vision-capable models found. Make sure you have a Copilot Chat provider with vision models installed.",
    );
    return;
  }

  modelItems.sort((a, b) => {
    if (a._id === currentModelId) return -1;
    if (b._id === currentModelId) return 1;
    return a.label.localeCompare(b.label);
  });

  const items: {
    label: string;
    description?: string;
    detail?: string;
    picked?: boolean;
    _id?: string;
    _kind: "none" | "prompt" | "model" | "separator";
    _supportsVision?: boolean;
    kind?: vscode.QuickPickItemKind;
  }[] = [
    { label: "$(circle-slash) None (disable)", detail: currentModelId ? "" : "currently selected", picked: !currentModelId, _kind: "none" },
    { label: "", kind: vscode.QuickPickItemKind.Separator, _kind: "separator" },
    {
      label: "$(edit) Customize description prompt...",
      description: "$(info) Sets how the vision model describes images",
      _kind: "prompt",
    },
    { label: "", kind: vscode.QuickPickItemKind.Separator, _kind: "separator" },
    ...modelItems,
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Pick a model, customize the prompt, or disable",
    title: "OpenCode Go — Vision Proxy",
    matchOnDescription: true,
  });

  if (!picked || !("_kind" in picked)) return;

  // --- "Customize prompt..." ---
  if (picked._kind === "prompt") {
    const newPrompt = await vscode.window.showInputBox({
      title: "Vision Proxy — Description Prompt",
      prompt: "Prompt sent to the vision model to describe the image.",
      value: currentPrompt,
      placeHolder: DEFAULT_VISION_PROXY_PROMPT,
      validateInput: (value: string) => (value.trim() ? undefined : "Prompt cannot be empty."),
    });
    if (newPrompt === undefined) return; // cancelled
    await context.globalState.update(VISION_PROXY_PROMPT_KEY, newPrompt.trim());
    vscode.window.showInformationMessage("Vision proxy prompt updated.");
    return;
  }

  // --- "None" ---
  if (picked._kind === "none") {
    await context.globalState.update(VISION_PROXY_MODEL_ID_KEY, "");
    vscode.window.showInformationMessage("Vision proxy disabled.");
    return;
  }

  // --- Model selected ---
  if (!picked._id) return;
  await context.globalState.update(VISION_PROXY_MODEL_ID_KEY, picked._id);
  vscode.window.showInformationMessage(`Vision proxy set to: ${picked.label}`);
}

/** Best-effort vendor resolution from a model ID. */
function resolveVendorFromId(modelId: string): AllProviderVendor {
  if (modelId.startsWith(`${AGENT_GO_VENDOR}:`)) return AGENT_GO_VENDOR;
  if (modelId.startsWith(`${AGENT_ZEN_VENDOR}:`)) return AGENT_ZEN_VENDOR;
  if (modelId.startsWith(`${ZEN_VENDOR}:`)) return ZEN_VENDOR;
  return GO_VENDOR;
}

/**
 * Returns pricing fields for VS Code's language model pricing proposal
 * (`vscode.proposed.languageModelPricing`).
 *
 * Cost data from models.dev is in USD; VS Code expects AI Credits
 * (1 credit = $0.01 USD). We convert by multiplying by 100 so the
 * pricing table shows values comparable to Copilot's own models.
 *
 * The `pricing` string matches the format used by the Copilot extension's
 * `formatPricingLabel` (`In: $X · Out: $Y /1M tokens`) so the picker hover
 * reads consistently across providers.
 */
function modelPricingFields(
  modelId: string,
  vendor: ProviderDefinition["vendor"],
  metadata: ResolvedModelMetadata,
): {
  pricing?: string;
  priceCategory?: string;
  inputCost?: number;
  outputCost?: number;
  cacheCost?: number;
} {
  const free = isFreeModel(modelId);

  if (free) {
    return { pricing: "Free", priceCategory: "low" };
  }

  const cost = metadata.cost;
  if (cost) {
    const inputCredits = Math.round(cost.input * 100);
    const outputCredits = Math.round(cost.output * 100);
    const cacheCredits = cost.cache_read !== undefined ? Math.round(cost.cache_read * 100) : undefined;

    const fmt = (v: number) => `$${v.toFixed(v < 0.1 ? 2 : 1)}`;
    return {
      pricing: `In: ${fmt(cost.input)} · Out: ${fmt(cost.output)} /1M tokens`,
      priceCategory: costCategory(cost),
      inputCost: inputCredits,
      outputCost: outputCredits,
      ...(cacheCredits !== undefined ? { cacheCost: cacheCredits } : {}),
    };
  }

  // No models.dev cost data: fall back to a neutral label so the picker
  // shows something instead of pretending we know the price.
  return {
    pricing: `${vendor === GO_VENDOR ? "Go" : "Zen"} subscription`,
  };
}

/**
 * Maps per-million-token USD cost to the four-tier `priceCategory` labels
 * (`low` / `medium` / `high` / `very_high`) that VS Code's language model
 * picker renders as a visual cost indicator.
 *
 * VS Code's own `getPriceCategoryLabel` (chatModelPicker.ts) just translates
 * the string but does not assign thresholds - the Copilot extension uses
 * billing multipliers and a weighted 3:1 input:output blend to mirror the
 * user's billing mix. We follow the same 3:1 weighting here so our category
 * lines up with what the user sees for the official Copilot models:
 *
 * - low       : qwen3.5-plus, deepseek-v4-flash-free, mimo-v2-flash-free
 * - medium    : kimi-k2.6, gemini-3-flash, claude-haiku-4-5, gpt-5,
 *               gpt-5.2, gpt-5.4, claude-sonnet-4-6
 * - high      : claude-opus-4-5, claude-opus-4-7, gpt-5.5
 * - very_high : gpt-5.4-pro, gpt-5.5-pro, claude-opus-4-1
 *
 * Free models (`cost.input == 0 && cost.output == 0`) are reported as `low`
 * because that is the bucket VS Code uses for "Free" entries in the picker.
 */
function costCategory(cost: { input: number; output: number }): string {
  if (cost.input <= 0 && cost.output <= 0) {
    return "low";
  }
  // Mirrors Copilot's 3:1 input:output blend (input tokens are usually the
  // larger share of a request, so they get more weight than raw sum).
  const weighted = cost.input * 3 + cost.output;
  if (weighted <= 2) return "low";
  if (weighted <= 25) return "medium";
  if (weighted <= 50) return "high";
  return "very_high";
}
