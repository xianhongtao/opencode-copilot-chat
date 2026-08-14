import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_PROFILE_KEY,
  AGENT_HOST_BYOK_MINOR_VERSION,
  COMPLETION_REQUEST_TIMEOUT_MS,
  CONFIG_SECTION,
  DEFAULT_INLINE_DEBOUNCE_MS,
  DEFAULT_INLINE_MAX_TOKENS,
  DEFAULT_INLINE_MODEL,
  DEFAULT_INLINE_PREFIX_LINES,
  DEFAULT_INLINE_SUFFIX_CHARS,
  DEFAULT_INLINE_TIMEOUT_MS,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_VISION_PROXY_PROMPT,
  EXTENSION_ID,
  FALLBACK_USER_AGENT,
  FREE_ZEN_MODEL_IDS,
  GO_LIMITS,
  GO_MAX_LOG_ENTRIES,
  GO_MAX_SESSIONS,
  GO_SESSION_IDLE_MS,
  GO_USAGE_API_URL,
  GO_USAGE_SYNC_TTL_MS,
  IMAGE_DESCRIPTION_CACHE_LIMIT,
  KNOWN_UNAVAILABLE_MODEL_IDS,
  LEGACY_FINGERPRINT,
  MAX_HISTORY_IMAGES_KEPT,
  MAX_IMAGE_BASE64_BYTES,
  MAX_TOOL_RESULT_IMAGE_BYTES,
  MODEL_LIST_CACHE_TTL_MS,
  MODEL_LIST_FETCH_MAX_RETRIES,
  MODEL_LIST_FETCH_TIMEOUT_MS,
  MODEL_METADATA_CACHE_TTL_MS,
  MODEL_METADATA_REVISION,
  MODELS_DEV_API_URL,
  PROFILES_REGISTRY_KEY,
  REASONING_CACHE_LIMIT,
  RECENT_TRANSPORT_SUMMARY_LIMIT,
  SECRET_KEY,
  TRANSIENT_5XX_MAX_RETRIES,
  TRANSIENT_5XX_RETRY_BASE_MS,
  TRANSIENT_5XX_RETRY_JITTER_MS,
  UI_OUTPUT_TOKEN_RESERVE,
  WEEK_MS,
  ZEN_SECRET_KEY,
  secretKeyFor,
} from "../config.js";

/**
 * Data-driven sanity checks. Each row asserts a predicate over a config value;
 * the predicate is applied at runtime so the checks stay meaningful regression
 * guards without tripping the constant-folding lint rule.
 */
function expectValue<T, A extends unknown[]>(
  name: string,
  actual: T,
  predicate: (value: T, ...args: A) => boolean,
  description: string,
  ...args: A
): void {
  assert.ok(predicate(actual, ...args), `${name}: ${description} (got ${String(actual)})`);
}

describe("config — identity", () => {
  it("carries the extension identity", () => {
    assert.equal(CONFIG_SECTION, "opencodego");
    assert.equal(EXTENSION_ID, "ltmoerdani.opencode-copilot-chat");
    assert.equal(SECRET_KEY, "opencodego.apiKey");
    expectValue("FALLBACK_USER_AGENT", FALLBACK_USER_AGENT, (v) => v.startsWith("opencode-copilot-chat/"), "versioned prefix");
  });
});

describe("config — secret keys", () => {
  it("resolves per-vendor SecretStorage keys so Go and Zen never collide", () => {
    assert.equal(secretKeyFor("opencodego"), SECRET_KEY);
    assert.equal(secretKeyFor("opencodezen"), ZEN_SECRET_KEY);
    assert.notEqual(secretKeyFor("opencodego"), secretKeyFor("opencodezen"));
  });
});

describe("config — timeouts are sane", () => {
  it("keeps request timeouts positive and ordered sensibly", () => {
    expectValue(
      "request ≥ stream-idle",
      DEFAULT_REQUEST_TIMEOUT_MS,
      (v) => v >= DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      "request timeout must cover the stream window",
    );
    expectValue(
      "stream-idle > model-list",
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      (v) => v > MODEL_LIST_FETCH_TIMEOUT_MS,
      "model-list fetch must be the tightest",
    );
    expectValue(
      "model-list ≥ completion",
      MODEL_LIST_FETCH_TIMEOUT_MS,
      (v) => v >= COMPLETION_REQUEST_TIMEOUT_MS,
      "completion must be tighter than model list",
    );
    expectValue(
      "completion ≥ inline",
      COMPLETION_REQUEST_TIMEOUT_MS,
      (v) => v >= DEFAULT_INLINE_TIMEOUT_MS,
      "inline completions must be the tightest",
    );
    expectValue("metadata TTL", MODEL_METADATA_CACHE_TTL_MS, (v) => v > 0, "positive");
    expectValue("usage sync TTL", GO_USAGE_SYNC_TTL_MS, (v) => v > 0, "positive");
  });

  it("keeps the transient-5xx retry budget finite", () => {
    expectValue("retries", TRANSIENT_5XX_MAX_RETRIES, (v) => v >= 1, "at least one retry");
    expectValue("base backoff", TRANSIENT_5XX_RETRY_BASE_MS, (v) => v > 0, "positive");
    expectValue("jitter", TRANSIENT_5XX_RETRY_JITTER_MS, (v) => v >= 0, "non-negative");
  });
});

describe("config — Go limits", () => {
  it("matches the documented subscription tiers", () => {
    assert.equal(GO_LIMITS.session, 12);
    assert.equal(GO_LIMITS.weekly, 30);
    assert.equal(GO_LIMITS.monthly, 60);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- literal tier comparison intended as a regression guard
    const tierOrdered = GO_LIMITS.monthly > GO_LIMITS.weekly && GO_LIMITS.weekly > GO_LIMITS.session;
    assert.ok(tierOrdered, "monthly > weekly > session");
  });

  it("keeps tracker caps bounded", () => {
    expectValue("log ≥ sessions", GO_MAX_LOG_ENTRIES, (v) => v >= GO_MAX_SESSIONS, "log must hold all sessions");
    expectValue("session idle", GO_SESSION_IDLE_MS, (v) => v > 0, "positive");
  });
});

describe("config — model limits", () => {
  it("keeps default windows large but finite", () => {
    expectValue("window > output", DEFAULT_MODEL_CONTEXT_WINDOW, (v) => v > DEFAULT_MODEL_MAX_OUTPUT_TOKENS, "context must exceed output");
    expectValue(
      "output > UI reserve",
      DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
      (v) => v > UI_OUTPUT_TOKEN_RESERVE,
      "output must exceed the UI reserve",
    );
  });
});

describe("config — payload bounds", () => {
  it("keeps image limits proportional", () => {
    expectValue(
      "base64 > tool-result",
      MAX_IMAGE_BASE64_BYTES,
      (v) => v > MAX_TOOL_RESULT_IMAGE_BYTES,
      "full images may exceed tool-result images",
    );
    expectValue("history images", MAX_HISTORY_IMAGES_KEPT, (v) => v >= 1, "at least the latest image survives");
  });

  it("caps caches and history", () => {
    expectValue("reasoning cache", REASONING_CACHE_LIMIT, (v) => v > 0, "positive");
    expectValue("vision cache", IMAGE_DESCRIPTION_CACHE_LIMIT, (v) => v > 0, "positive");
    expectValue("transport summaries", RECENT_TRANSPORT_SUMMARY_LIMIT, (v) => v > 0, "positive");
  });
});

describe("config — model classification sets", () => {
  it("keeps the availability sets disjoint", () => {
    for (const id of KNOWN_UNAVAILABLE_MODEL_IDS) {
      assert.ok(!FREE_ZEN_MODEL_IDS.has(id), `${id} is both unavailable and free`);
    }
  });
});

describe("config — storage keys", () => {
  it("uses the versioned keys", () => {
    assert.equal(PROFILES_REGISTRY_KEY, "opencodego.profiles.v1");
    assert.equal(ACTIVE_PROFILE_KEY, "opencodego.activeProfile.v1");
    assert.equal(LEGACY_FINGERPRINT, "legacy");
  });
});

describe("config — autocomplete defaults", () => {
  it("keeps the inline-completion knobs in a usable range", () => {
    assert.equal(DEFAULT_INLINE_MODEL, "qwen3.5-plus");
    expectValue("debounce", DEFAULT_INLINE_DEBOUNCE_MS, (v) => v >= 50, "at least 50ms");
    expectValue("max tokens", DEFAULT_INLINE_MAX_TOKENS, (v) => v >= 16, "at least 16 tokens");
    expectValue("prefix lines", DEFAULT_INLINE_PREFIX_LINES, (v) => v >= 1, "at least 1 line");
    expectValue("suffix chars", DEFAULT_INLINE_SUFFIX_CHARS, (v) => v >= 0, "non-negative");
    expectValue("timeout ≥ debounce", DEFAULT_INLINE_TIMEOUT_MS, (v) => v >= DEFAULT_INLINE_DEBOUNCE_MS, "timeout must cover the debounce");
  });
});

describe("config — references", () => {
  it("points at live endpoints and revisions", () => {
    expectValue("models.dev URL", MODELS_DEV_API_URL, (v) => v.startsWith("https://"), "https");
    expectValue("usage URL", GO_USAGE_API_URL, (v) => v.startsWith("https://"), "https");
    expectValue("revision", MODEL_METADATA_REVISION, (v) => v.length > 0, "non-empty");
    expectValue("week", WEEK_MS, (v) => v > 0, "positive");
    expectValue("model-list retries", MODEL_LIST_FETCH_MAX_RETRIES, (v) => v >= 1, "at least one retry");
    expectValue("model-list TTL", MODEL_LIST_CACHE_TTL_MS, (v) => v > 0, "positive");
    expectValue("agent-host minor", AGENT_HOST_BYOK_MINOR_VERSION, (v) => v >= 100, "1.1xx era");
    expectValue("vision prompt", DEFAULT_VISION_PROXY_PROMPT, (v) => v.length > 0, "non-empty");
  });
});
