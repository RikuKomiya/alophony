import type pino from "pino";
import type { AlophonyConfig } from "../config/schema.js";
import type { CodexAppServerClient } from "../codex/client.js";
import type { RunRepository } from "../db/repository.js";
import { renderPrompt } from "../prompt/render.js";
import { shouldRetry } from "../retry/policy.js";
import type { TrackerClient } from "../tracker/client.js";
import type { CodexRateLimitSnapshot, CodexUsageTotals, NormalizedIssue, RunRecord } from "../types.js";
import { newId } from "../util/id.js";
import { WorkspaceManager } from "../workspace/manager.js";

export interface SchedulerDeps {
  config: AlophonyConfig;
  repository: RunRepository;
  tracker: TrackerClient;
  codex: CodexAppServerClient;
  workspace: WorkspaceManager;
  logger: pino.Logger;
  ownerId?: string;
}

export class Scheduler {
  private readonly ownerId: string;
  private pollTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private ticking = false;
  private reconciling = false;
  private stopped = false;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly retryQueue = new Map<string, RetryEntry>();
  private readonly completedRuns = new Set<string>();
  private codexTotals: CodexUsageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private latestRateLimits: CodexRateLimitSnapshot | undefined;

  constructor(private readonly deps: SchedulerDeps) {
    this.ownerId = deps.ownerId ?? newId("owner");
  }

  async startupRecovery(): Promise<void> {
    const stale = await this.deps.repository.markStaleRunningAttempts();
    const expired = await this.deps.repository.releaseExpiredLocks();
    this.deps.logger.info({ stale, expired }, "startup recovery completed");
    try {
      const terminalIssues = await this.deps.tracker.listTerminalIssues(this.deps.config);
      for (const issue of terminalIssues) {
        await this.deps.repository.upsertIssue(issue);
        const workspacePath = this.deps.workspace.workspacePathFor(issue);
        await this.deps.workspace.cleanup(workspacePath);
        this.deps.logger.info({ issue_id: issue.id, issue_identifier: issue.identifier }, "terminal workspace cleaned");
      }
    } catch (error) {
      this.deps.logger.warn({ err: error }, "startup terminal workspace cleanup failed");
    }
  }

  start(): void {
    this.stopped = false;
    this.pollTimer = setInterval(() => void this.tick(), this.deps.config.scheduler.pollIntervalMs);
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.deps.config.scheduler.reconcileIntervalMs);
    void this.tick();
    void this.reconcile();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
    }
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    for (const retry of this.retryQueue.values()) {
      clearTimeout(retry.timerHandle);
    }
    this.retryQueue.clear();
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.reconcile();
      let issues: NormalizedIssue[];
      try {
        issues = await this.deps.tracker.listCandidateIssues(this.deps.config);
      } catch (error) {
        this.deps.logger.error({ err: error, event_type: "tracker_poll_failed" }, "tracker poll failed");
        return;
      }

      for (const issue of issues) {
        await this.deps.repository.upsertIssue(issue);
      }

      let available = this.deps.config.scheduler.maxConcurrency - await this.deps.repository.countActiveRuns();
      if (available <= 0) {
        return;
      }
      const dispatches: Array<Promise<RunRecord | undefined>> = [];
      const sorted = [...issues].sort(compareIssues);
      for (const issue of sorted) {
        if (available <= 0) {
          break;
        }
        if (!(await this.isEligible(issue)) || !(await this.hasStateSlot(issue))) {
          continue;
        }
        available -= 1;
        dispatches.push(
          this.dispatch(issue).catch((error) => {
            this.deps.logger.error({ err: error, issue_id: issue.id, issue_identifier: issue.identifier }, "dispatch failed");
            return undefined;
          }),
        );
      }
      await Promise.all(dispatches);
    } finally {
      this.ticking = false;
    }
  }

  async cancelRun(runId: string, reason = "operator_cancel"): Promise<boolean> {
    const run = await this.deps.repository.getRun(runId);
    if (!run) {
      return false;
    }
    await this.deps.repository.markRunStatus(runId, "canceled", reason);
    this.activeControllers.get(runId)?.abort();
    return true;
  }

  async dispatch(issue: NormalizedIssue): Promise<RunRecord | undefined> {
    const lockKey = `issue:${issue.trackerKind}:${issue.trackerIssueId}`;
    const locked = await this.deps.repository.acquireLock(lockKey, this.ownerId, this.deps.config.scheduler.lockTtlMs);
    if (!locked) {
      this.deps.logger.info({ issue_id: issue.id, issue_identifier: issue.identifier }, "issue lock already held");
      return undefined;
    }

    let renewTimer: NodeJS.Timeout | undefined;
    let activeRunId: string | undefined;
    try {
      const workspacePath = await this.deps.workspace.create(issue);
      const run = await this.deps.repository.createOrReuseRun(issue.id, workspacePath);
      await this.deps.repository.claimRun(run.id, this.ownerId, this.deps.config.scheduler.lockTtlMs);
      const abortController = new AbortController();
      activeRunId = run.id;
      this.activeControllers.set(run.id, abortController);
      renewTimer = setInterval(() => {
        void this.deps.repository.renewLock(lockKey, this.ownerId, this.deps.config.scheduler.lockTtlMs).then((renewed) => {
          if (!renewed) {
            this.deps.logger.error({ issue_id: issue.id, run_id: run.id }, "issue lock renewal failed");
          }
        });
      }, this.deps.config.scheduler.lockRenewIntervalMs);

      let finalRun = run;
      const attempt = await this.deps.repository.createAttempt(run.id);
      const prompt = await renderPrompt(this.deps.config.prompt, {
        issue,
        workspacePath,
        attemptNumber: attempt.attemptNumber,
      });
      await this.deps.repository.appendEvent({
        runId: run.id,
        attemptId: attempt.id,
        type: "prompt_rendered",
        payload: { redacted: true, length: prompt.length },
      });
      await this.deps.workspace.beforeRun(workspacePath);
      const result = await this.deps.codex.run(
        {
          workspacePath,
          prompt,
          runId: run.id,
          attemptId: attempt.id,
          signal: abortController.signal,
          nextPrompt: async (completedTurns) => {
            if (completedTurns >= this.deps.config.agent.maxTurns) {
              return undefined;
            }
            const current = await this.deps.tracker.getIssue(issue.trackerIssueId);
            if (!current) {
              return undefined;
            }
            await this.deps.repository.upsertIssue(current);
            if (!(await this.isActiveForContinuation(current))) {
              return undefined;
            }
            const continuation = continuationPrompt(current, completedTurns + 1, this.deps.config.agent.maxTurns);
            await this.deps.repository.appendEvent({
              runId: run.id,
              attemptId: attempt.id,
              type: "continuation_prompt_rendered",
              payload: { redacted: true, length: continuation.length, turn: completedTurns + 1 },
            });
            return continuation;
          },
        },
        async (event) => {
          this.recordCodexTelemetry(event.payload);
          await this.deps.repository.appendEvent({
            runId: run.id,
            attemptId: attempt.id,
            type: event.type,
            message: event.message,
            payload: event.payload,
          });
          const patch: Parameters<RunRepository["updateAttempt"]>[1] = {};
          if (event.codexThreadId) {
            patch.codexThreadId = event.codexThreadId;
          }
          if (event.codexTurnId) {
            patch.codexTurnId = event.codexTurnId;
          }
          if (Object.keys(patch).length > 0) {
            await this.deps.repository.updateAttempt(attempt.id, patch);
          }
        },
      );
      await this.deps.workspace.afterRun(workspacePath);
      const attemptStatus = result.status === "canceled" ? "killed" : result.status === "needs_input" ? "needs_input" : result.status;
      await this.deps.repository.updateAttempt(attempt.id, {
        status: attemptStatus,
        processPid: result.processPid,
        exitCode: result.exitCode,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        codexThreadId: result.codexThreadId,
        codexTurnId: result.codexTurnId,
        finished: true,
      });

      if (result.status === "canceled") {
        const current = await this.deps.repository.getRun(run.id);
        await this.deps.repository.markRunStatus(run.id, "canceled", current?.statusReason ?? result.errorCode ?? "canceled");
        finalRun = (await this.deps.repository.getRun(run.id)) ?? run;
      } else if (result.status === "succeeded") {
        await this.deps.repository.markRunStatus(run.id, "succeeded");
        this.completedRuns.add(run.id);
        finalRun = (await this.deps.repository.getRun(run.id)) ?? run;
        this.scheduleRetry(issue, 1, this.deps.config.agent.continuationDelayMs, "continuation_after_success");
      } else {
        const code = result.errorCode ?? "codex_failure";
        await this.deps.repository.markRunStatus(run.id, "failed", code);
        if (shouldRetry(this.deps.config.retry, attempt.attemptNumber, code)) {
          this.scheduleRetry(issue, attempt.attemptNumber, failureBackoffMs(attempt.attemptNumber, this.deps.config.agent.maxRetryBackoffMs), code);
        }
        finalRun = (await this.deps.repository.getRun(run.id)) ?? run;
      }
      return finalRun;
    } catch (error) {
      this.deps.logger.error({ err: error, issue_id: issue.id, issue_identifier: issue.identifier }, "dispatch failed");
      throw error;
    } finally {
      if (renewTimer) {
        clearInterval(renewTimer);
      }
      if (activeRunId) {
        this.activeControllers.delete(activeRunId);
      }
      await this.deps.repository.releaseLock(lockKey, this.ownerId);
    }
  }

  async reconcile(): Promise<void> {
    if (this.stopped || this.reconciling) {
      return;
    }
    this.reconciling = true;
    try {
      const activeRuns = await this.deps.repository.listActiveRuns();
      for (const run of activeRuns) {
        const issue = await this.deps.repository.getIssueById(run.issueId);
        if (!issue) {
          continue;
        }
        const current = await this.deps.tracker.getIssue(issue.trackerIssueId);
        if (!current) {
          await this.cancelRun(run.id, "issue_missing");
          continue;
        }
        if (this.includesState(this.deps.config.tracker.terminalStates, current.state)) {
          await this.cancelRun(run.id, "terminal_tracker_state");
          await this.deps.workspace.cleanup(run.workspacePath);
          continue;
        }
        if (!this.includesState(this.deps.config.tracker.activeStates, current.state)) {
          await this.cancelRun(run.id, "non_active_tracker_state");
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async isEligible(issue: NormalizedIssue): Promise<boolean> {
    if (!this.includesState(this.deps.config.tracker.activeStates, issue.state)) {
      return false;
    }
    if (this.includesState(this.deps.config.tracker.terminalStates, issue.state)) {
      return false;
    }
    if (await this.deps.repository.hasNonTerminalRun(issue.id)) {
      return false;
    }
    if (issue.state.toLowerCase() !== "todo") {
      return true;
    }
    const blockers = await this.deps.tracker.listBlockingIssues(issue.trackerIssueId);
    return blockers.every((blocker) => this.includesState(this.deps.config.tracker.terminalStates, blocker.state));
  }

  private async isActiveForContinuation(issue: NormalizedIssue): Promise<boolean> {
    if (!this.includesState(this.deps.config.tracker.activeStates, issue.state)) {
      return false;
    }
    if (this.includesState(this.deps.config.tracker.terminalStates, issue.state)) {
      return false;
    }
    if (issue.state.toLowerCase() !== "todo") {
      return true;
    }
    const blockers = await this.deps.tracker.listBlockingIssues(issue.trackerIssueId);
    return blockers.every((blocker) => this.includesState(this.deps.config.tracker.terminalStates, blocker.state));
  }

  private async hasStateSlot(issue: NormalizedIssue): Promise<boolean> {
    const limit = this.deps.config.agent.maxConcurrentAgentsByState[issue.state.toLowerCase()]
      ?? this.deps.config.agent.maxConcurrentAgentsByState[issue.state];
    if (!limit) {
      return true;
    }
    const activeRuns = await this.deps.repository.listActiveRuns();
    let activeInState = 0;
    for (const run of activeRuns) {
      const activeIssue = await this.deps.repository.getIssueById(run.issueId);
      if (activeIssue?.state.toLowerCase() === issue.state.toLowerCase()) {
        activeInState += 1;
      }
    }
    return activeInState < limit;
  }

  private includesState(states: string[], state: string): boolean {
    return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
  }

  private scheduleRetry(issue: NormalizedIssue, attempt: number, delayMs: number, error: string): void {
    const key = issue.id;
    const existing = this.retryQueue.get(key);
    if (existing) {
      clearTimeout(existing.timerHandle);
    }
    const dueAtMs = Date.now() + delayMs;
    const timerHandle = setTimeout(() => {
      void this.fireRetry(key).catch((error) => {
        this.deps.logger.error({ err: error, issue_id: issue.id, issue_identifier: issue.identifier }, "retry dispatch failed");
      });
    }, delayMs);
    timerHandle.unref();
    this.retryQueue.set(key, {
      issueId: issue.id,
      identifier: issue.identifier,
      trackerIssueId: issue.trackerIssueId,
      attempt,
      dueAtMs,
      timerHandle,
      error,
    });
  }

  private async fireRetry(key: string): Promise<void> {
    const entry = this.retryQueue.get(key);
    if (!entry || this.stopped) {
      return;
    }
    this.retryQueue.delete(key);
    let issue = await this.deps.tracker.getIssue(entry.trackerIssueId);
    if (!issue) {
      this.deps.logger.info({ issue_id: entry.issueId, issue_identifier: entry.identifier }, "retry released because issue is missing");
      return;
    }
    await this.deps.repository.upsertIssue(issue);
    if (!(await this.isEligible(issue))) {
      this.deps.logger.info({ issue_id: issue.id, issue_identifier: issue.identifier }, "retry released because issue is no longer active");
      return;
    }
    if ((await this.deps.repository.countActiveRuns()) >= this.deps.config.scheduler.maxConcurrency || !(await this.hasStateSlot(issue))) {
      this.scheduleRetry(issue, entry.attempt, 1_000, "no available orchestrator slots");
      return;
    }
    await this.dispatch(issue);
  }

  getRuntimeState() {
    return {
      running: Array.from(this.activeControllers.keys()),
      claimed: Array.from(this.activeControllers.keys()),
      retry_attempts: Array.from(this.retryQueue.values()).map(({ timerHandle: _timerHandle, ...retry }) => retry),
      completed: Array.from(this.completedRuns),
      codex_totals: this.codexTotals,
      codex_rate_limits: this.latestRateLimits,
    };
  }

  private recordCodexTelemetry(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const usage = findRecord(record, ["usage", "token_usage", "tokens"]);
    if (usage) {
      const input = numberField(usage, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
      const output = numberField(usage, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
      const total = numberField(usage, ["total_tokens", "totalTokens"]);
      if (input !== undefined) {
        this.codexTotals.inputTokens = Math.max(this.codexTotals.inputTokens, input);
      }
      if (output !== undefined) {
        this.codexTotals.outputTokens = Math.max(this.codexTotals.outputTokens, output);
      }
      if (total !== undefined) {
        this.codexTotals.totalTokens = Math.max(this.codexTotals.totalTokens, total);
      } else {
        this.codexTotals.totalTokens = Math.max(this.codexTotals.totalTokens, this.codexTotals.inputTokens + this.codexTotals.outputTokens);
      }
    }
    const rateLimits = findRecord(record, ["rate_limits", "rateLimits"]);
    if (rateLimits) {
      this.latestRateLimits = { payload: rateLimits, observedAt: new Date().toISOString() };
    }
  }
}

function compareIssues(a: NormalizedIssue, b: NormalizedIssue): number {
  const priority = priorityValue(a.priority) - priorityValue(b.priority);
  if (priority !== 0) {
    return priority;
  }
  const created = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (created !== 0) {
    return created;
  }
  return a.identifier.localeCompare(b.identifier);
}

function priorityValue(priority: number | null): number {
  return priority ?? Number.MAX_SAFE_INTEGER;
}

function failureBackoffMs(attempt: number, maxRetryBackoffMs: number): number {
  return Math.min(10_000 * 2 ** (attempt - 1), maxRetryBackoffMs);
}

function continuationPrompt(issue: NormalizedIssue, nextTurn: number, maxTurns: number): string {
  return `Continue work on ${issue.identifier}: ${issue.title}

This is continuation turn ${nextTurn} of ${maxTurns}. Refresh the current workspace state, continue from the previous turn, and stop once the issue is complete or blocked. Do not repeat the full original task brief unless it is needed for correctness.`;
}

function findRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  for (const value of Object.values(record)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const found = findRecord(value as Record<string, unknown>, keys);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  trackerIssueId: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: NodeJS.Timeout;
  error: string;
}
