import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDbClient } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { RunRepository } from "../../src/db/repository.js";
import { issueDbId } from "../../src/tracker/client.js";
import { repoRoot, tempDir, testConfig } from "../helpers.js";

describe("RunRepository", () => {
  it("runs migrations and enforces lock acquisition", async () => {
    const dir = await tempDir("db");
    const config = testConfig({ database: { url: `file:${path.join(dir, "test.db")}` } });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);

    expect(await repo.acquireLock("issue:fake:1", "owner-a", 60_000)).toBe(true);
    expect(await repo.acquireLock("issue:fake:1", "owner-b", 60_000)).toBe(false);
    expect(await repo.renewLock("issue:fake:1", "owner-a", 60_000)).toBe(true);
    await repo.releaseLock("issue:fake:1", "owner-a");
    expect(await repo.acquireLock("issue:fake:1", "owner-b", 60_000)).toBe(true);

    db.close();
  });

  it("persists issues, runs, attempts, and events", async () => {
    const dir = await tempDir("db");
    const config = testConfig({ database: { url: `file:${path.join(dir, "test.db")}` } });
    const db = createDbClient(config.database);
    await runMigrations(db, path.join(repoRoot(), "migrations"));
    const repo = new RunRepository(db);
    const issue = {
      id: issueDbId("fake", "1"),
      trackerKind: "fake",
      trackerIssueId: "1",
      identifier: "TEST-1",
      title: "Title",
      state: "Todo",
      priority: null,
      labels: [],
      blockedBy: [],
      createdAt: new Date().toISOString(),
      raw: {},
      updatedAt: new Date().toISOString(),
    };
    await repo.upsertIssue(issue);
    const run = await repo.createOrReuseRun(issue.id, "/tmp/work");
    const attempt = await repo.createAttempt(run.id);
    await repo.appendEvent({ runId: run.id, attemptId: attempt.id, type: "turn_started", payload: { ok: true } });
    await repo.updateAttempt(attempt.id, { status: "succeeded", finished: true });
    await repo.markRunStatus(run.id, "succeeded");

    expect((await repo.listRuns())[0]?.status).toBe("succeeded");
    expect(await repo.listEvents(run.id)).toHaveLength(1);
    db.close();
  });
});
