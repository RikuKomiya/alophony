import { describe, expect, it } from "vitest";
import { isRetryable, nextBackoffMs, shouldRetry } from "../../src/retry/policy.js";
import { testConfig } from "../helpers.js";

describe("retry policy", () => {
  it("classifies retryable and non-retryable errors", () => {
    expect(isRetryable("codex_process_crash")).toBe(true);
    expect(isRetryable("invalid_configuration")).toBe(false);
  });

  it("calculates bounded backoff", () => {
    const config = testConfig({ retry: { initialBackoffMs: 10, maxBackoffMs: 15, backoffMultiplier: 2, maxAttempts: 3 } });
    expect(nextBackoffMs(config.retry, 1)).toBe(10);
    expect(nextBackoffMs(config.retry, 3)).toBe(15);
    expect(shouldRetry(config.retry, 1, "codex_process_crash")).toBe(true);
    expect(shouldRetry(config.retry, 3, "codex_process_crash")).toBe(false);
  });
});
