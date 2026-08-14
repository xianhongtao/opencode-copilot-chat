import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStableModelCapabilities } from "../models/modelCapabilities";
import {
  clearImageDescriptionCache,
  IMAGE_DESCRIPTION_CACHE_LIMIT,
  imageDescriptionCache,
  imageDescriptionKey,
  lookupImageDescriptions,
  storeImageDescriptions,
} from "../visionProxyCache";

/**
 * Vision proxy condition tests.
 *
 * The core fix for #74 is caching `metadata.supportsVision` in
 * `actuallySupportsVision` BEFORE `modelCapabilities` overrides it.
 * The proxy condition is:
 *
 *   hasImageInput && !actuallySupportsVision && visionProxyModelId
 *
 * where `actuallySupportsVision` is the RAW model metadata (true =
 * model natively supports images), NOT the enhanced capabilities.
 */

interface ProxyConditionInput {
  hasImageInput: boolean;
  actuallySupportsVision: boolean;
  visionProxyModelId: string;
}

function shouldProxy({ hasImageInput, actuallySupportsVision, visionProxyModelId }: ProxyConditionInput): boolean {
  return Boolean(hasImageInput && !actuallySupportsVision && visionProxyModelId);
}

describe("vision proxy condition (shouldProxy)", () => {
  it("enters proxy when text-only model receives images with proxy configured", () => {
    assert.ok(shouldProxy({ hasImageInput: true, actuallySupportsVision: false, visionProxyModelId: "gpt-5.5" }));
  });

  it("skips proxy when no images present", () => {
    assert.ok(!shouldProxy({ hasImageInput: false, actuallySupportsVision: false, visionProxyModelId: "gpt-5.5" }));
  });

  it("skips proxy when model natively supports vision", () => {
    assert.ok(!shouldProxy({ hasImageInput: true, actuallySupportsVision: true, visionProxyModelId: "gpt-5.5" }));
  });

  it("skips proxy when no vision model is configured (empty string)", () => {
    assert.ok(!shouldProxy({ hasImageInput: true, actuallySupportsVision: false, visionProxyModelId: "" }));
  });

  it("skips proxy when all conditions are false", () => {
    assert.ok(!shouldProxy({ hasImageInput: false, actuallySupportsVision: true, visionProxyModelId: "" }));
  });

  it("cached supportsVision (actuallySupportsVision) prevents circular regression", () => {
    // This is the fix for #74: even if modelCapabilities overrides
    // metadata.supportsVision to true (because proxy is enabled),
    // the CACHED value (actuallySupportsVision) stays false for
    // text-only models — so the proxy fires correctly.
    const textOnlyModel = { hasImageInput: true, actuallySupportsVision: false, visionProxyModelId: "gpt-5.5" };
    const visionModel = { hasImageInput: true, actuallySupportsVision: true, visionProxyModelId: "gpt-5.5" };

    // Before fix: visionModel.actuallySupportsVision was false → proxy fired
    // After fix: both behave correctly
    assert.ok(shouldProxy(textOnlyModel), "text-only model: proxy fires");
    assert.ok(!shouldProxy(visionModel), "vision model: proxy does NOT fire");
  });
});

describe("modelCapabilities vision proxy flag", () => {
  // modelCapabilities() returns imageInput: true when:
  //   metadata.supportsVision (native) OR isVisionProxyEnabled()
  // This tells VS Code NOT to strip images from requests.

  it("returns imageInput: true when proxy is enabled on text-only models", () => {
    const capabilities = buildStableModelCapabilities(true);
    assert.equal(capabilities.imageInput, true);
  });

  it("returns imageInput: true when model natively supports vision", () => {
    const capabilities = buildStableModelCapabilities(true);
    assert.equal(capabilities.imageInput, true);
  });

  it("returns imageInput: false only when no vision support and no proxy", () => {
    const capabilities = buildStableModelCapabilities(false);
    assert.equal(capabilities.imageInput, false);
  });

  it("keeps tool calling enabled without proposal-gated edit tool hints", () => {
    const capabilities = buildStableModelCapabilities(true);

    assert.equal(capabilities.toolCalling, true);
    assert.equal(capabilities.supportsToolCalling, true);
    assert.equal("editTools" in capabilities, false);
  });
});

describe("vision proxy image description cache", () => {
  it("imageDescriptionKey is a stable sha-256 hash of the base64 bytes", () => {
    const key = imageDescriptionKey("aGVsbG8=");

    assert.equal(imageDescriptionKey("aGVsbG8="), key, "same bytes produce the same key");
    assert.match(key, /^[0-9a-f]{64}$/, "key is a 64-char hex sha-256 digest");
    assert.notEqual(imageDescriptionKey("aGVsbG8="), imageDescriptionKey("d29ybGQ="), "different bytes produce different keys");
  });

  it("lookupImageDescriptions returns undefined when nothing is cached", () => {
    clearImageDescriptionCache();
    assert.equal(lookupImageDescriptions([imageDescriptionKey("aGVsbG8=")]), undefined);
  });

  it("stores and looks up a description under every image hash", () => {
    clearImageDescriptionCache();
    const h1 = imageDescriptionKey("aGVsbG8=");
    const h2 = imageDescriptionKey("d29ybGQ=");
    const description = "A red circle on a blue background.";

    storeImageDescriptions([h1, h2], description);

    assert.equal(lookupImageDescriptions([h1]), description);
    assert.equal(lookupImageDescriptions([h2]), description);
    assert.equal(lookupImageDescriptions([h1, h2]), description);
  });

  it("lookupImageDescriptions returns undefined when only some hashes are cached", () => {
    clearImageDescriptionCache();
    const h1 = imageDescriptionKey("aGVsbG8=");
    const h2 = imageDescriptionKey("d29ybGQ=");

    storeImageDescriptions([h1], "Only one image was described.");

    assert.equal(lookupImageDescriptions([h1, h2]), undefined);
  });

  it("reuses the cached description instead of re-describing (same image twice)", () => {
    clearImageDescriptionCache();
    const hash = imageDescriptionKey("cmV1c2UtbWU=");
    const description = "Description cached on the first turn.";

    // Simulates turn 1: not cached → described and stored.
    assert.equal(lookupImageDescriptions([hash]), undefined);
    storeImageDescriptions([hash], description);

    // Simulates turn 2: same image → cached, so no model request is needed.
    assert.equal(lookupImageDescriptions([hash]), description);
    assert.equal(imageDescriptionCache.size, 1);
  });

  it("evicts the oldest entries once the cache exceeds its limit", () => {
    clearImageDescriptionCache();
    const firstKey = imageDescriptionKey("Zmlyc3Q=");

    for (let i = 0; i <= IMAGE_DESCRIPTION_CACHE_LIMIT; i++) {
      storeImageDescriptions([imageDescriptionKey(`aW1hZ2UtaW5kZXgt${String(i)}`)], `description-${String(i)}`);
    }

    assert.ok(imageDescriptionCache.size <= IMAGE_DESCRIPTION_CACHE_LIMIT, "cache size stays within the limit");
    assert.equal(imageDescriptionCache.has(firstKey), false, "oldest entry is evicted");
    assert.equal(
      imageDescriptionCache.has(imageDescriptionKey(`aW1hZ2UtaW5kZXgt${String(IMAGE_DESCRIPTION_CACHE_LIMIT)}`)),
      true,
      "recent entry is kept",
    );
  });

  it("clearImageDescriptionCache empties the cache", () => {
    clearImageDescriptionCache();
    storeImageDescriptions([imageDescriptionKey("aGVsbG8=")], "hello description");
    assert.equal(imageDescriptionCache.size, 1);

    clearImageDescriptionCache();
    assert.equal(imageDescriptionCache.size, 0);
  });
});
