import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type AlophonyConfig, type PartialAlophonyConfig } from "../src/config/schema.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `alophony-${prefix}-`));
}

export function repoRoot(): string {
  return root;
}

export function testConfig(overrides: PartialAlophonyConfig = {}): AlophonyConfig {
  const base = {
    tracker: {
      kind: "fake",
      projectSlug: "TEST",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Canceled", "Cancelled", "Duplicate"],
    },
    database: {
      url: "file::memory:",
      migrationsDir: path.join(root, "migrations"),
    },
    workspace: {
      root: path.join(os.tmpdir(), "alophony-test-workspaces"),
    },
    scheduler: {
      pollIntervalMs: 1_000,
      reconcileIntervalMs: 1_000,
      maxConcurrency: 1,
      lockTtlMs: 60_000,
      lockRenewIntervalMs: 10_000,
    },
    codex: {
      command: `node ${path.join(root, "tests/fixtures/fake-codex/server.mjs")}`,
      approvalPolicy: "never",
      sandboxPolicy: "workspace-write",
      startupTimeoutMs: 2_000,
      turnTimeoutMs: 5_000,
      idleTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      generateProtocolTypes: false,
    },
    prompt: {},
    retry: {
      maxAttempts: 2,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      backoffMultiplier: 1,
    },
    api: {
      enabled: false,
      host: "127.0.0.1",
      port: 3000,
    },
    logLevel: "silent",
  };
  return ConfigSchema.parse(deepMerge(base, overrides));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isObject(result[key]) && isObject(value) ? deepMerge(result[key], value) : value;
  }
  return result as T;
}
