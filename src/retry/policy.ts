import type { AlophonyConfig } from "../config/schema.js";

const NON_RETRYABLE = new Set([
  "invalid_configuration",
  "invalid_prompt_template",
  "workspace_path_safety_violation",
  "terminal_tracker_state",
  "needs_input_unsupported",
]);

const RETRYABLE = new Set([
  "tracker_transient_error",
  "codex_startup_failure",
  "codex_process_crash",
  "idle_timeout",
  "turn_timeout",
  "process_restarted",
]);

export function isRetryable(errorCode: string): boolean {
  if (NON_RETRYABLE.has(errorCode)) {
    return false;
  }
  return RETRYABLE.has(errorCode);
}

export function nextBackoffMs(policy: AlophonyConfig["retry"], attemptNumber: number): number {
  const exponent = Math.max(0, attemptNumber - 1);
  const calculated = policy.initialBackoffMs * policy.backoffMultiplier ** exponent;
  return Math.min(calculated, policy.maxBackoffMs);
}

export function shouldRetry(policy: AlophonyConfig["retry"], attemptNumber: number, errorCode: string): boolean {
  return attemptNumber < policy.maxAttempts && isRetryable(errorCode);
}
