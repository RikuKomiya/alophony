import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config/schema.js";

describe("config schema", () => {
  it("rejects missing required config", () => {
    expect(() => ConfigSchema.parse({})).toThrow();
  });

  it("accepts a complete v1 config", () => {
    const config = ConfigSchema.parse({
      tracker: {
        kind: "fake",
        projectSlug: "TEST",
        activeStates: ["Todo"],
        terminalStates: ["Done"],
      },
      database: {
        url: "file::memory:",
      },
      workspace: {
        root: ".alophony/workspaces",
      },
      scheduler: {
        pollIntervalMs: 1_000,
        maxConcurrency: 1,
      },
      codex: {
        command: "node fake",
      },
      prompt: {},
    });
    expect(config.database.url).toBe("file::memory:");
    expect(config.scheduler.lockTtlMs).toBeGreaterThan(0);
  });
});
