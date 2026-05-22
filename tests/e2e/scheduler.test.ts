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
  it("dispatches one fake issue, persists events, and redispatches active succeeded issues after restart", async () => {
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
    expect(await repo.listRuns()).toHaveLength(2);
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

  it("applies blockers only to Todo issues", async () => {
    const dir = await tempDir("scheduler");
    const config = testConfig({
      database: { url: `file:${path.join(dir, "state.db")}` },
      workspace: { root: path.join(dir, "workspaces") },
    });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    const tracker = new FakeTrackerClient([
      { id: "blocker", identifier: "TEST-0", title: "Blocker", state: "Todo" },
      { id: "issue-1", identifier: "TEST-1", title: "In progress", state: "In Progress", blockers: ["blocker"] },
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

    expect(await repo.listRuns()).toHaveLength(1);
    db.close();
  });

  it("sorts dispatch by priority, created time, then identifier", async () => {
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
      { id: "issue-3", identifier: "TEST-3", title: "Later", state: "Todo", priority: 2, createdAt: "2026-01-03T00:00:00.000Z" },
      { id: "issue-2", identifier: "TEST-2", title: "Old", state: "Todo", priority: 1, createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "issue-1", identifier: "TEST-1", title: "Older", state: "Todo", priority: 1, createdAt: "2026-01-01T00:00:00.000Z" },
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
    const run = (await repo.listRuns())[0]!;
    const issue = await repo.getIssueById(run.issueId);

    expect(issue?.identifier).toBe("TEST-1");
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

  it("schedules continuation retry after normal worker exit", async () => {
    const dir = await tempDir("scheduler");
    const config = testConfig({
      database: { url: `file:${path.join(dir, "state.db")}` },
      workspace: { root: path.join(dir, "workspaces") },
      agent: { continuationDelayMs: 10_000 },
    });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    const tracker = new FakeTrackerClient([{ id: "issue-1", identifier: "TEST-1", title: "One", state: "Todo" }]);
    const scheduler = new Scheduler({
      config,
      repository: repo,
      tracker,
      codex: new CodexAppServerClient(config.codex),
      workspace: new WorkspaceManager(config.workspace),
      logger: createLogger("silent"),
    });

    await scheduler.tick();

    expect(scheduler.getRuntimeState().retry_attempts).toEqual([
      expect.objectContaining({ identifier: "TEST-1", attempt: 1, error: "continuation_after_success" }),
    ]);
    await scheduler.stop();
    db.close();
  });

  it("uses spec exponential backoff capped by agent.maxRetryBackoffMs", async () => {
    const dir = await tempDir("scheduler");
    const config = testConfig({
      database: { url: `file:${path.join(dir, "state.db")}` },
      workspace: { root: path.join(dir, "workspaces") },
      codex: { command: `${testConfig().codex.command} fail` },
      agent: { maxRetryBackoffMs: 1_234 },
    });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    const tracker = new FakeTrackerClient([{ id: "issue-1", identifier: "TEST-1", title: "One", state: "Todo" }]);
    const scheduler = new Scheduler({
      config,
      repository: repo,
      tracker,
      codex: new CodexAppServerClient(config.codex),
      workspace: new WorkspaceManager(config.workspace),
      logger: createLogger("silent"),
    });

    await scheduler.tick();
    const retry = scheduler.getRuntimeState().retry_attempts[0]!;

    expect(retry.error).toBe("codex_process_crash");
    expect(retry.dueAtMs - Date.now()).toBeLessThanOrEqual(1_234);
    await scheduler.stop();
    db.close();
  });

  it("tracks Codex usage totals and latest rate-limit payload", async () => {
    const dir = await tempDir("scheduler");
    const config = testConfig({
      database: { url: `file:${path.join(dir, "state.db")}` },
      workspace: { root: path.join(dir, "workspaces") },
      codex: { command: `${testConfig().codex.command} usage` },
    });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    const tracker = new FakeTrackerClient([{ id: "issue-1", identifier: "TEST-1", title: "One", state: "Todo" }]);
    const scheduler = new Scheduler({
      config,
      repository: repo,
      tracker,
      codex: new CodexAppServerClient(config.codex),
      workspace: new WorkspaceManager(config.workspace),
      logger: createLogger("silent"),
    });

    await scheduler.tick();
    const state = scheduler.getRuntimeState();

    expect(state.codex_totals).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(state.codex_rate_limits?.payload).toEqual({ requests: { remaining: 99 } });
    await scheduler.stop();
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
      priority: null,
      labels: [],
      blockedBy: [],
      createdAt: new Date().toISOString(),
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
