import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateModelLimits } from "../models/modelLimits.js";

const metadata = {
  contextWindow: 100_000,
  maxOutputTokens: 32_000,
};

describe("calculateModelLimits", () => {
  it("uses a conservative registration budget when prompt size is unknown", () => {
    const limits = calculateModelLimits(metadata);

    assert.equal(limits.maxOutputTokens, 19_936);
    assert.equal(limits.advertisedContextWindow, 100_000);
    assert.equal(limits.advertisedMaxOutputTokens, 8_192);
    assert.equal(limits.advertisedMaxInputTokens, 91_808);
  });

  it("caps output to the context remaining after the prompt and safety margin", () => {
    const limits = calculateModelLimits(metadata, { promptTokens: 70_000 });

    assert.equal(limits.maxOutputTokens, 21_600);
  });

  it("never restores a 4K minimum that would overflow a nearly full context", () => {
    const limits = calculateModelLimits(metadata, { promptTokens: 99_990 });

    assert.equal(limits.maxOutputTokens, 1);
  });

  it("honors context and output overrides without exceeding either", () => {
    const limits = calculateModelLimits(metadata, {
      contextSize: 50_000,
      maxOutputTokens: 12_000,
      promptTokens: 35_000,
    });

    assert.equal(limits.contextWindow, 50_000);
    assert.equal(limits.maxOutputTokens, 10_800);
  });

  it("keeps the issue #109 DeepSeek request below the real context limit", () => {
    const limits = calculateModelLimits({ contextWindow: 1_048_576, maxOutputTokens: 384_000 }, { promptTokens: 604_839 });

    assert.equal(limits.maxOutputTokens, 371_156);
    assert.ok(666_237 + limits.maxOutputTokens < 1_048_576);
  });
});
