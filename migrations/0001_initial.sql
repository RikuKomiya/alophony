PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  tracker_kind TEXT NOT NULL,
  tracker_issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  description TEXT,
  url TEXT,
  assignee TEXT,
  priority TEXT,
  raw_json TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tracker_kind, tracker_issue_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'running', 'succeeded', 'failed', 'retry_wait', 'canceled', 'terminal_cleanup')),
  status_reason TEXT,
  workspace_path TEXT NOT NULL,
  current_attempt_id TEXT,
  claimed_by TEXT,
  claim_expires_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'needs_input', 'succeeded', 'failed', 'timed_out', 'killed')),
  codex_thread_id TEXT,
  codex_turn_id TEXT,
  process_pid INTEGER,
  exit_code INTEGER,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  attempt_id TEXT REFERENCES run_attempts(id),
  type TEXT NOT NULL,
  message TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_locks (
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_tracker ON issues (tracker_kind, tracker_issue_id);
CREATE INDEX IF NOT EXISTS idx_issues_state ON issues (state);
CREATE INDEX IF NOT EXISTS idx_runs_issue_status ON runs (issue_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_attempts_run ON run_attempts (run_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_events_run_created ON run_events (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_locks_expires ON scheduler_locks (expires_at);
