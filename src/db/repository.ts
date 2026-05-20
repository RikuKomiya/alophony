import type { InValue, Row } from "@libsql/client";
import type { AttemptRecord, AttemptStatus, NormalizedIssue, RunEventRecord, RunRecord, RunStatus } from "../types.js";
import { newId } from "../util/id.js";
import { addMsIso, nowIso } from "../util/time.js";
import type { DbClient } from "./client.js";

const NON_TERMINAL_RUNS: RunStatus[] = ["queued", "claimed", "running", "retry_wait", "terminal_cleanup"];
const ACTIVE_RUNS: RunStatus[] = ["claimed", "running", "terminal_cleanup"];

function stringValue(row: Row, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : String(value);
}

function numberValue(row: Row, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" ? value : value === null || value === undefined ? undefined : Number(value);
}

function toRun(row: Row): RunRecord {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    status: String(row.status) as RunStatus,
    ...(stringValue(row, "status_reason") ? { statusReason: stringValue(row, "status_reason") } : {}),
    workspacePath: String(row.workspace_path),
    ...(stringValue(row, "current_attempt_id") ? { currentAttemptId: stringValue(row, "current_attempt_id") } : {}),
    ...(stringValue(row, "claimed_by") ? { claimedBy: stringValue(row, "claimed_by") } : {}),
    ...(stringValue(row, "claim_expires_at") ? { claimExpiresAt: stringValue(row, "claim_expires_at") } : {}),
    ...(stringValue(row, "started_at") ? { startedAt: stringValue(row, "started_at") } : {}),
    ...(stringValue(row, "finished_at") ? { finishedAt: stringValue(row, "finished_at") } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAttempt(row: Row): AttemptRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    attemptNumber: Number(row.attempt_number),
    status: String(row.status) as AttemptStatus,
    ...(stringValue(row, "codex_thread_id") ? { codexThreadId: stringValue(row, "codex_thread_id") } : {}),
    ...(stringValue(row, "codex_turn_id") ? { codexTurnId: stringValue(row, "codex_turn_id") } : {}),
    ...(numberValue(row, "process_pid") !== undefined ? { processPid: numberValue(row, "process_pid") } : {}),
    ...(numberValue(row, "exit_code") !== undefined ? { exitCode: numberValue(row, "exit_code") } : {}),
    ...(stringValue(row, "error_code") ? { errorCode: stringValue(row, "error_code") } : {}),
    ...(stringValue(row, "error_message") ? { errorMessage: stringValue(row, "error_message") } : {}),
    startedAt: String(row.started_at),
    ...(stringValue(row, "finished_at") ? { finishedAt: stringValue(row, "finished_at") } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toEvent(row: Row): RunEventRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    ...(stringValue(row, "attempt_id") ? { attemptId: stringValue(row, "attempt_id") } : {}),
    type: String(row.type),
    ...(stringValue(row, "message") ? { message: stringValue(row, "message") } : {}),
    payload: JSON.parse(String(row.payload_json)),
    createdAt: String(row.created_at),
  };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export class RunRepository {
  constructor(private readonly client: DbClient) {}

  async upsertIssue(issue: NormalizedIssue): Promise<void> {
    const at = nowIso();
    await this.client.execute({
      sql: `
        INSERT INTO issues (
          id, tracker_kind, tracker_issue_id, identifier, title, state, description,
          url, assignee, priority, raw_json, seen_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tracker_kind, tracker_issue_id) DO UPDATE SET
          identifier = excluded.identifier,
          title = excluded.title,
          state = excluded.state,
          description = excluded.description,
          url = excluded.url,
          assignee = excluded.assignee,
          priority = excluded.priority,
          raw_json = excluded.raw_json,
          seen_at = excluded.seen_at,
          updated_at = excluded.updated_at
      `,
      args: [
        issue.id,
        issue.trackerKind,
        issue.trackerIssueId,
        issue.identifier,
        issue.title,
        issue.state,
        issue.description ?? null,
        issue.url ?? null,
        issue.assignee ?? null,
        issue.priority ?? null,
        JSON.stringify(issue.raw),
        at,
        issue.updatedAt,
      ],
    });
  }

  async getIssueByTrackerId(trackerKind: string, trackerIssueId: string): Promise<NormalizedIssue | undefined> {
    const result = await this.client.execute({
      sql: "SELECT * FROM issues WHERE tracker_kind = ? AND tracker_issue_id = ?",
      args: [trackerKind, trackerIssueId],
    });
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: String(row.id),
      trackerKind: String(row.tracker_kind),
      trackerIssueId: String(row.tracker_issue_id),
      identifier: String(row.identifier),
      title: String(row.title),
      state: String(row.state),
      ...(stringValue(row, "description") ? { description: stringValue(row, "description") } : {}),
      ...(stringValue(row, "url") ? { url: stringValue(row, "url") } : {}),
      ...(stringValue(row, "assignee") ? { assignee: stringValue(row, "assignee") } : {}),
      ...(stringValue(row, "priority") ? { priority: stringValue(row, "priority") } : {}),
      raw: JSON.parse(String(row.raw_json)),
      updatedAt: String(row.updated_at),
    };
  }

  async getIssueById(id: string): Promise<NormalizedIssue | undefined> {
    const result = await this.client.execute({
      sql: "SELECT * FROM issues WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: String(row.id),
      trackerKind: String(row.tracker_kind),
      trackerIssueId: String(row.tracker_issue_id),
      identifier: String(row.identifier),
      title: String(row.title),
      state: String(row.state),
      ...(stringValue(row, "description") ? { description: stringValue(row, "description") } : {}),
      ...(stringValue(row, "url") ? { url: stringValue(row, "url") } : {}),
      ...(stringValue(row, "assignee") ? { assignee: stringValue(row, "assignee") } : {}),
      ...(stringValue(row, "priority") ? { priority: stringValue(row, "priority") } : {}),
      raw: JSON.parse(String(row.raw_json)),
      updatedAt: String(row.updated_at),
    };
  }

  async hasNonTerminalRun(issueId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: `SELECT id FROM runs WHERE issue_id = ? AND status IN (${placeholders(NON_TERMINAL_RUNS)}) LIMIT 1`,
      args: [issueId, ...NON_TERMINAL_RUNS],
    });
    return result.rows.length > 0;
  }

  async hasSucceededRun(issueId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "SELECT id FROM runs WHERE issue_id = ? AND status = 'succeeded' LIMIT 1",
      args: [issueId],
    });
    return result.rows.length > 0;
  }

  async createOrReuseRun(issueId: string, workspacePath: string): Promise<RunRecord> {
    const existing = await this.client.execute({
      sql: `SELECT * FROM runs WHERE issue_id = ? AND status IN (${placeholders(NON_TERMINAL_RUNS)}) ORDER BY created_at DESC LIMIT 1`,
      args: [issueId, ...NON_TERMINAL_RUNS],
    });
    if (existing.rows[0]) {
      return toRun(existing.rows[0]);
    }
    const at = nowIso();
    const id = newId("run");
    await this.client.execute({
      sql: `
        INSERT INTO runs (id, issue_id, status, workspace_path, created_at, updated_at)
        VALUES (?, ?, 'queued', ?, ?, ?)
      `,
      args: [id, issueId, workspacePath, at, at],
    });
    const created = await this.getRun(id);
    if (!created) {
      throw new Error(`created run not found: ${id}`);
    }
    return created;
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const result = await this.client.execute({ sql: "SELECT * FROM runs WHERE id = ?", args: [id] });
    return result.rows[0] ? toRun(result.rows[0]) : undefined;
  }

  async listRuns(limit = 100): Promise<RunRecord[]> {
    const result = await this.client.execute({
      sql: "SELECT * FROM runs ORDER BY created_at DESC LIMIT ?",
      args: [limit],
    });
    return result.rows.map(toRun);
  }

  async listActiveRuns(): Promise<RunRecord[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM runs WHERE status IN (${placeholders(ACTIVE_RUNS)}) ORDER BY updated_at ASC`,
      args: ACTIVE_RUNS,
    });
    return result.rows.map(toRun);
  }

  async countActiveRuns(): Promise<number> {
    const result = await this.client.execute({
      sql: `SELECT COUNT(*) AS count FROM runs WHERE status IN (${placeholders(ACTIVE_RUNS)})`,
      args: ACTIVE_RUNS,
    });
    return Number(result.rows[0]?.count ?? 0);
  }

  async markRunStatus(id: string, status: RunStatus, reason?: string): Promise<void> {
    const at = nowIso();
    const terminal = ["succeeded", "failed", "canceled"].includes(status);
    await this.client.execute({
      sql: `
        UPDATE runs SET status = ?, status_reason = ?, updated_at = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END
        WHERE id = ?
      `,
      args: [status, reason ?? null, at, terminal ? 1 : 0, terminal ? at : null, id],
    });
  }

  async claimRun(runId: string, ownerId: string, ttlMs: number): Promise<void> {
    const at = nowIso();
    await this.client.execute({
      sql: `
        UPDATE runs
        SET status = 'claimed', claimed_by = ?, claim_expires_at = ?, updated_at = ?
        WHERE id = ?
      `,
      args: [ownerId, addMsIso(ttlMs), at, runId],
    });
  }

  async createAttempt(runId: string): Promise<AttemptRecord> {
    const count = await this.client.execute({
      sql: "SELECT COALESCE(MAX(attempt_number), 0) AS max_attempt FROM run_attempts WHERE run_id = ?",
      args: [runId],
    });
    const attemptNumber = Number(count.rows[0]?.max_attempt ?? 0) + 1;
    const id = newId("attempt");
    const at = nowIso();
    await this.client.execute({
      sql: `
        INSERT INTO run_attempts (id, run_id, attempt_number, status, started_at, created_at, updated_at)
        VALUES (?, ?, ?, 'starting', ?, ?, ?)
      `,
      args: [id, runId, attemptNumber, at, at, at],
    });
    await this.client.execute({
      sql: "UPDATE runs SET current_attempt_id = ?, status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
      args: [id, at, at, runId],
    });
    const attempt = await this.getAttempt(id);
    if (!attempt) {
      throw new Error(`created attempt not found: ${id}`);
    }
    return attempt;
  }

  async getAttempt(id: string): Promise<AttemptRecord | undefined> {
    const result = await this.client.execute({ sql: "SELECT * FROM run_attempts WHERE id = ?", args: [id] });
    return result.rows[0] ? toAttempt(result.rows[0]) : undefined;
  }

  async updateAttempt(
    id: string,
    patch: {
      status?: AttemptStatus;
      codexThreadId?: string | undefined;
      codexTurnId?: string | undefined;
      processPid?: number | undefined;
      exitCode?: number | undefined;
      errorCode?: string | undefined;
      errorMessage?: string | undefined;
      finished?: boolean;
    },
  ): Promise<void> {
    const at = nowIso();
    const fields: string[] = ["updated_at = ?"];
    const args: InValue[] = [at];
    if (patch.status) {
      fields.push("status = ?");
      args.push(patch.status);
    }
    if (patch.codexThreadId) {
      fields.push("codex_thread_id = ?");
      args.push(patch.codexThreadId);
    }
    if (patch.codexTurnId) {
      fields.push("codex_turn_id = ?");
      args.push(patch.codexTurnId);
    }
    if (patch.processPid !== undefined) {
      fields.push("process_pid = ?");
      args.push(patch.processPid);
    }
    if (patch.exitCode !== undefined) {
      fields.push("exit_code = ?");
      args.push(patch.exitCode);
    }
    if (patch.errorCode) {
      fields.push("error_code = ?");
      args.push(patch.errorCode);
    }
    if (patch.errorMessage) {
      fields.push("error_message = ?");
      args.push(patch.errorMessage);
    }
    if (patch.finished) {
      fields.push("finished_at = ?");
      args.push(at);
    }
    args.push(id);
    await this.client.execute({ sql: `UPDATE run_attempts SET ${fields.join(", ")} WHERE id = ?`, args });
  }

  async appendEvent(input: {
    runId: string;
    attemptId?: string | undefined;
    type: string;
    message?: string | undefined;
    payload?: unknown;
  }): Promise<RunEventRecord> {
    const id = newId("event");
    const at = nowIso();
    await this.client.execute({
      sql: `
        INSERT INTO run_events (id, run_id, attempt_id, type, message, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        input.runId,
        input.attemptId ?? null,
        input.type,
        input.message ?? null,
        JSON.stringify(input.payload ?? {}),
        at,
      ],
    });
    return {
      id,
      runId: input.runId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      type: input.type,
      ...(input.message ? { message: input.message } : {}),
      payload: input.payload ?? {},
      createdAt: at,
    };
  }

  async listEvents(runId: string, limit = 500): Promise<RunEventRecord[]> {
    const result = await this.client.execute({
      sql: "SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at ASC LIMIT ?",
      args: [runId, limit],
    });
    return result.rows.map(toEvent);
  }

  async acquireLock(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const at = nowIso();
    const expiresAt = addMsIso(ttlMs);
    const tx = await this.client.transaction("write");
    try {
      const existing = await tx.execute({ sql: "SELECT * FROM scheduler_locks WHERE key = ?", args: [key] });
      const row = existing.rows[0];
      if (!row) {
        await tx.execute({
          sql: "INSERT INTO scheduler_locks (key, owner_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          args: [key, ownerId, expiresAt, at, at],
        });
        await tx.commit();
        return true;
      }
      if (String(row.expires_at) <= at) {
        await tx.execute({
          sql: "UPDATE scheduler_locks SET owner_id = ?, expires_at = ?, updated_at = ? WHERE key = ?",
          args: [ownerId, expiresAt, at, key],
        });
        await tx.commit();
        return true;
      }
      await tx.rollback();
      return false;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }

  async renewLock(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const at = nowIso();
    const result = await this.client.execute({
      sql: "UPDATE scheduler_locks SET expires_at = ?, updated_at = ? WHERE key = ? AND owner_id = ? AND expires_at > ?",
      args: [addMsIso(ttlMs), at, key, ownerId, at],
    });
    return result.rowsAffected > 0;
  }

  async releaseLock(key: string, ownerId: string): Promise<void> {
    await this.client.execute({
      sql: "DELETE FROM scheduler_locks WHERE key = ? AND owner_id = ?",
      args: [key, ownerId],
    });
  }

  async releaseExpiredLocks(): Promise<number> {
    const result = await this.client.execute({
      sql: "DELETE FROM scheduler_locks WHERE expires_at <= ?",
      args: [nowIso()],
    });
    return result.rowsAffected;
  }

  async markStaleRunningAttempts(reason = "process_restarted"): Promise<number> {
    const at = nowIso();
    const staleStatuses: AttemptStatus[] = ["starting", "running", "needs_input"];
    const result = await this.client.execute({
      sql: `
        UPDATE run_attempts
        SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
        WHERE status IN (${placeholders(staleStatuses)})
      `,
      args: [reason, reason, at, at, ...staleStatuses],
    });
    await this.client.execute({
      sql: `
        UPDATE runs
        SET status = 'failed', status_reason = ?, finished_at = ?, updated_at = ?
        WHERE status IN ('claimed', 'running', 'terminal_cleanup')
      `,
      args: [reason, at, at],
    });
    return result.rowsAffected;
  }
}
