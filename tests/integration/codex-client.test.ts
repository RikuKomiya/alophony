import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../../src/codex/client.js";
import { tempDir, testConfig } from "../helpers.js";

describe("CodexAppServerClient", () => {
  it("maps fake Codex app-server JSONL into normalized events", async () => {
    const workspacePath = await tempDir("codex");
    const config = testConfig();
    const client = new CodexAppServerClient(config.codex);
    const events: string[] = [];
    const result = await client.run({
      workspacePath,
      prompt: "do work",
      runId: "run_1",
      attemptId: "attempt_1",
    }, async (event) => {
      events.push(event.type);
    });
    expect(result.status).toBe("succeeded");
    expect(result.codexThreadId).toBe("thread_fake");
    expect(result.codexTurnId).toBe("turn_fake");
    expect(events).toContain("thread_started");
    expect(events).toContain("turn_completed");
  });

  it("fails unsupported user input requests explicitly", async () => {
    const workspacePath = await tempDir("codex");
    const config = testConfig({ codex: { command: `${testConfig().codex.command} needs-input` } });
    const client = new CodexAppServerClient(config.codex);
    const result = await client.run({
      workspacePath,
      prompt: "do work",
      runId: "run_1",
      attemptId: "attempt_1",
    }, async () => {});
    expect(result.status).toBe("needs_input");
    expect(result.errorCode).toBe("needs_input_unsupported");
  });
});
