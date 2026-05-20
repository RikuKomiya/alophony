import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../../src/codex/client.js";
import { createDbClient } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { RunRepository } from "../../src/db/repository.js";
import { createLogger } from "../../src/logging/logger.js";
import { Scheduler } from "../../src/scheduler/scheduler.js";
import { FakeTrackerClient } from "../../src/tracker/fake.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { repoRoot, tempDir, testConfig } from "../helpers.js";

describe("scheduler e2e", () => {
  it("dispatches one fake issue, persists events, and avoids duplicate dispatch after restart", async () => {
    const dir = await tempDir("scheduler");
    const config = testConfig({
      database: { url: `file:${path.join(dir, "state.db")}` },
      workspace: { root: path.join(dir, "workspaces") },
      scheduler: { maxConcurrency: 1 },
    });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    const tracker = new FakeTrackerClient([
      {
        id: "issue-1",
        identifier: "TEST-1",
        title: "Implement feature",
        state: "Todo",
        description: "Do the work",
      },
    ]);
    const scheduler = new Scheduler({
      config,
      repository: repo,
      tracker,
      codex: new CodexAppServerClient(config.codex),
      workspace: new WorkspaceManager(config.workspace),
      logger: createLogger("silent"),
      ownerId: "owner-test",
    });

    await scheduler.tick();
    const runs = await repo.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");
    expect(await repo.listEvents(runs[0]!.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "prompt_rendered" }),
      expect.objectContaining({ type: "turn_finished" }),
    ]));

    const restarted = new Scheduler({
      config,
      repository: repo,
      tracker,
      codex: new CodexAppServerClient(config.codex),
      workspace: new WorkspaceManager(config.workspace),
      logger: createLogger("silent"),
      ownerId: "owner-restart",
    });
    await restarted.startupRecovery();
    await restarted.tick();
    expect(await repo.listRuns()).toHaveLength(1);
    db.close();
  });

  it("does not dispatch Todo issue while a blocker is non-terminal", async () => {
    const dir = await tempDir("scheduler");
    const config = testConfig({
      database: { url: `file:${path.join(dir, "state.db")}` },
      workspace: { root: path.join(dir, "workspaces") },
    });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    const tracker = new FakeTrackerClient([
      { id: "blocker", identifier: "TEST-0", title: "Blocker", state: "Backlog" },
      { id: "issue-1", identifier: "TEST-1", title: "Blocked", state: "Todo", blockers: ["blocker"] },
    ]);
    const scheduler = new Scheduler({
      config,
      repository: repo,
      tracker,
      codex: new CodexAppServerClient(config.codex),
      workspace: new WorkspaceManager(config.workspace),
      logger: createLogger("silent"),
    });
    await scheduler.tick();
    expect(await repo.listRuns()).toHaveLength(0);
    db.close();
  });
});
