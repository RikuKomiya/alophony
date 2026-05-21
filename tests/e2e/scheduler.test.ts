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
      expect.objectContaining({ type: "turn_completed" }),
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

  it("dispatches up to maxConcurrency in parallel", async () => {
    const dir = await tempDir("scheduler");
    const config = testConfig({
      database: { url: `file:${path.join(dir, "state.db")}` },
      workspace: { root: path.join(dir, "workspaces") },
      scheduler: { maxConcurrency: 2 },
      codex: { command: `${testConfig().codex.command} slow` },
    });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    const tracker = new FakeTrackerClient([
      { id: "issue-1", identifier: "TEST-1", title: "One", state: "Todo" },
      { id: "issue-2", identifier: "TEST-2", title: "Two", state: "Todo" },
    ]);
    const scheduler = new Scheduler({
      config,
      repository: repo,
      tracker,
      codex: new CodexAppServerClient(config.codex),
      workspace: new WorkspaceManager(config.workspace),
      logger: createLogger("silent"),
    });

    const tick = scheduler.tick();
    await waitFor(async () => await repo.countActiveRuns() === 2);
    await tick;

    const runs = await repo.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    db.close();
  });

  it("cancels an active Codex run through the scheduler", async () => {
    const dir = await tempDir("scheduler");
    const config = testConfig({
      database: { url: `file:${path.join(dir, "state.db")}` },
      workspace: { root: path.join(dir, "workspaces") },
      codex: { command: `${testConfig().codex.command} slow` },
    });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    const tracker = new FakeTrackerClient();
    const issue = {
      id: "issue-1",
      identifier: "TEST-1",
      title: "Cancelable",
      state: "Todo",
    };
    const scheduler = new Scheduler({
      config,
      repository: repo,
      tracker,
      codex: new CodexAppServerClient(config.codex),
      workspace: new WorkspaceManager(config.workspace),
      logger: createLogger("silent"),
    });

    const normalizedIssue = {
      id: "fake:issue-1",
      trackerKind: "fake",
      trackerIssueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      raw: issue,
      updatedAt: new Date().toISOString(),
    };
    await repo.upsertIssue(normalizedIssue);
    const dispatch = scheduler.dispatch(normalizedIssue);
    const run = await waitFor(async () => (await repo.listRuns())[0]);
    expect(await scheduler.cancelRun(run.id)).toBe(true);
    await dispatch;

    expect((await repo.getRun(run.id))?.status).toBe("canceled");
    expect((await repo.getRun(run.id))?.statusReason).toBe("operator_cancel");
    db.close();
  });

  it("skips overlapping ticks", async () => {
    const dir = await tempDir("scheduler");
    const config = testConfig({
      database: { url: `file:${path.join(dir, "state.db")}` },
      workspace: { root: path.join(dir, "workspaces") },
    });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    class SlowTracker extends FakeTrackerClient {
      calls = 0;

      override async listCandidateIssues() {
        this.calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return [];
      }
    }
    const tracker = new SlowTracker();
    const scheduler = new Scheduler({
      config,
      repository: repo,
      tracker,
      codex: new CodexAppServerClient(config.codex),
      workspace: new WorkspaceManager(config.workspace),
      logger: createLogger("silent"),
    });

    await Promise.all([scheduler.tick(), scheduler.tick()]);

    expect(tracker.calls).toBe(1);
    db.close();
  });
});

async function waitFor<T>(read: () => Promise<T | false | null | undefined>, timeoutMs = 1_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}
