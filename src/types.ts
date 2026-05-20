export type TrackerKind = "linear" | "fake";

export interface NormalizedIssue {
  id: string;
  trackerKind: TrackerKind | string;
  trackerIssueId: string;
  identifier: string;
  title: string;
  state: string;
  description?: string | undefined;
  url?: string | undefined;
  assignee?: string | undefined;
  priority?: string | undefined;
  raw: unknown;
  updatedAt: string;
}

export type RunStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "retry_wait"
  | "canceled"
  | "terminal_cleanup";

export type AttemptStatus =
  | "starting"
  | "running"
  | "needs_input"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "killed";

export interface RunRecord {
  id: string;
  issueId: string;
  status: RunStatus;
  statusReason?: string | undefined;
  workspacePath: string;
  currentAttemptId?: string | undefined;
  claimedBy?: string | undefined;
  claimExpiresAt?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRecord {
  id: string;
  runId: string;
  attemptNumber: number;
  status: AttemptStatus;
  codexThreadId?: string | undefined;
  codexTurnId?: string | undefined;
  processPid?: number | undefined;
  exitCode?: number | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  startedAt: string;
  finishedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  attemptId?: string | undefined;
  type: string;
  message?: string | undefined;
  payload: unknown;
  createdAt: string;
}
