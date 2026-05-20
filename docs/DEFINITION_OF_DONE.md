# Definition of Done Check

This document maps `SPEC.md` section 18 to the implementation.

- TypeScript project builds in strict mode.
  - `bun run typecheck` passes.
- Migrations create all required tables and indexes.
  - `migrations/0001_initial.sql` creates `issues`, `runs`, `run_attempts`, `run_events`, `scheduler_locks`, and `schema_migrations`, plus indexes.
- `alophony validate` catches missing config, DB auth failure, tracker auth failure, and missing Codex command.
  - Config parsing is Zod-backed.
  - DB connectivity is checked with `SELECT 1`.
  - Linear token absence is reported for `tracker.kind=linear`.
  - Codex command availability is checked with `command -v`.
- Scheduler dispatches eligible issues and respects max concurrency.
  - `Scheduler.tick()` counts active runs before dispatch.
  - E2E tests cover fake issue dispatch.
- Turso locks prevent duplicate runs.
  - `RunRepository.acquireLock`, `renewLock`, and `releaseLock` are backed by `scheduler_locks`.
  - Integration tests cover lock exclusivity and renewal.
- Codex app-server runner can process a full fake protocol stream.
  - `CodexAppServerClient` consumes JSONL stdout and maps normalized events.
  - Integration tests use `tests/fixtures/fake-codex/server.mjs`.
- Run state and events survive process restart.
  - State is persisted in Turso/libSQL tables.
  - E2E test dispatches, runs startup recovery, and verifies no duplicate dispatch.
- Terminal tracker states stop or prevent runs.
  - Startup recovery cleans terminal workspaces.
  - Reconciliation cancels terminal and non-active runs.
  - Scheduler eligibility rejects terminal states.
- Structured logs include run and issue context.
  - Pino logger is used, and scheduler/runner paths attach issue/run/attempt context where available.
- Core unit and integration tests pass.
  - `bun run test` covers config, repository, locks, workspace safety, prompt rendering, scheduler, retry, and fake Codex.

Known v1 boundaries:

- Tracker writes are intentionally not implemented.
- Rich dashboard is intentionally not implemented.
- Multi-process distributed scheduling is not the supported deployment mode, though DB locks are implemented.
