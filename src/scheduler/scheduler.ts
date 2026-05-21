import type pino from "pino";
import type { AlophonyConfig } from "../config/schema.js";
import type { CodexAppServerClient } from "../codex/client.js";
import type { RunRepository } from "../db/repository.js";
import { renderPrompt } from "../prompt/render.js";
import { nextBackoffMs, shouldRetry } from "../retry/policy.js";
import type { TrackerClient } from "../tracker/client.js";
import type { NormalizedIssue, RunRecord } from "../types.js";
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
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
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
        if (!(await this.isEligible(issue))) {
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
      let shouldContinue = true;
      while (shouldContinue) {
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
          payload: { prompt },
        });
        await this.deps.workspace.beforeRun(workspacePath);
        const result = await this.deps.codex.run(
          { workspacePath, prompt, runId: run.id, attemptId: attempt.id, signal: abortController.signal },
          async (event) => {
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
          shouldContinue = false;
        } else if (result.status === "succeeded") {
          await this.deps.repository.markRunStatus(run.id, "succeeded");
          finalRun = (await this.deps.repository.getRun(run.id)) ?? run;
          shouldContinue = false;
        } else {
          const code = result.errorCode ?? "codex_failure";
          if (shouldRetry(this.deps.config.retry, attempt.attemptNumber, code)) {
            await this.deps.repository.markRunStatus(run.id, "retry_wait", code);
            await sleep(nextBackoffMs(this.deps.config.retry, attempt.attemptNumber));
          } else {
            await this.deps.repository.markRunStatus(run.id, "failed", code);
            finalRun = (await this.deps.repository.getRun(run.id)) ?? run;
            shouldContinue = false;
          }
        }
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
        if (this.deps.config.tracker.terminalStates.includes(current.state)) {
          await this.cancelRun(run.id, "terminal_tracker_state");
          await this.deps.workspace.cleanup(run.workspacePath);
          continue;
        }
        if (!this.deps.config.tracker.activeStates.includes(current.state)) {
          await this.cancelRun(run.id, "non_active_tracker_state");
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async isEligible(issue: NormalizedIssue): Promise<boolean> {
    if (!this.deps.config.tracker.activeStates.includes(issue.state)) {
      return false;
    }
    if (this.deps.config.tracker.terminalStates.includes(issue.state)) {
      return false;
    }
    if (await this.deps.repository.hasNonTerminalRun(issue.id)) {
      return false;
    }
    if (await this.deps.repository.hasSucceededRun(issue.id)) {
      return false;
    }
    const blockers = await this.deps.tracker.listBlockingIssues(issue.trackerIssueId);
    return blockers.every((blocker) => this.deps.config.tracker.terminalStates.includes(blocker.state));
  }
}

function compareIssues(a: NormalizedIssue, b: NormalizedIssue): number {
  const priority = String(a.priority ?? "").localeCompare(String(b.priority ?? ""));
  if (priority !== 0) {
    return priority;
  }
  const updated = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  if (updated !== 0) {
    return updated;
  }
  return a.identifier.localeCompare(b.identifier);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
