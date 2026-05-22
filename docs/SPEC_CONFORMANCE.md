# Spec Conformance Matrix

Last updated: 2026-05-22

## Configuration And Workflow

| Requirement | Implementation | Tests |
| --- | --- | --- |
| Default and explicit `WORKFLOW.md` loading | `src/config/load.ts`, `src/config/workflow.ts`, `src/cli/index.ts` | `tests/unit/config.test.ts` |
| YAML front matter config plus Markdown prompt body | `src/config/workflow.ts` | `tests/unit/config.test.ts` |
| Typed workflow errors | `WorkflowLoaderError` in `src/config/workflow.ts` | `tests/unit/config.test.ts` |
| `$VAR` references without global env override | `resolveEnvReferences` in `src/config/workflow.ts` | `tests/unit/config.test.ts` |
| Dynamic reload and last-known-good preservation | `watchWorkflowConfig` in `src/config/workflow.ts` | `tests/unit/config.test.ts` |

## Scheduler And Runtime State

| Requirement | Implementation | Tests |
| --- | --- | --- |
| Success does not permanently block redispatch | `Scheduler.isEligible` in `src/scheduler/scheduler.ts` | `tests/e2e/scheduler.test.ts` |
| Short continuation retry after normal exit | `Scheduler.scheduleRetry` | `tests/e2e/scheduler.test.ts` |
| Multiple turns in one app-server lifetime | `CodexRunInput.nextPrompt`, `CodexAppServerClient.run` | fake app-server supports `multi` mode |
| Continuation guidance instead of original prompt | `continuationPrompt` in `src/scheduler/scheduler.ts` | `tests/e2e/scheduler.test.ts` |
| Orchestrator retry queue and backoff | `retryQueue`, `failureBackoffMs`, `getRuntimeState` | `tests/e2e/scheduler.test.ts` |
| Reconcile before dispatch | `Scheduler.tick` | `tests/e2e/scheduler.test.ts` |

## Codex App-Server

| Requirement | Implementation | Tests |
| --- | --- | --- |
| Launch through `bash -lc` in workspace | `src/codex/client.ts` | `tests/integration/codex-client.test.ts` |
| Startup/thread/turn protocol flow | `CodexAppServerClient.run` | `tests/integration/codex-client.test.ts` |
| `session_started` event | `src/codex/client.ts` | `tests/integration/codex-client.test.ts` |
| User-input-required failure | `isNeedsInput` handling | `tests/integration/codex-client.test.ts` |
| Usage and rate-limit telemetry | `Scheduler.recordCodexTelemetry` | `tests/e2e/scheduler.test.ts` |

## Tracker And Issue Model

| Requirement | Implementation | Tests |
| --- | --- | --- |
| Expanded normalized issue fields | `src/types.ts`, `src/tracker/linear.ts`, `src/tracker/fake.ts`, `src/db/repository.ts` | `tests/unit/linear.test.ts`, `tests/integration/repository.test.ts` |
| Lowercase labels, integer priority, blockers | `src/tracker/linear.ts`, `src/tracker/fake.ts` | `tests/unit/linear.test.ts`, `tests/e2e/scheduler.test.ts` |
| Configurable endpoint, timeout, stable errors | `LinearTrackerClient` | `tests/unit/linear.test.ts` |
| `fetchIssueStatesByIds` with `[ID!]` | `LinearTrackerClient.fetchIssueStatesByIds` | `tests/unit/linear.test.ts` |
| Pagination order and missing cursor failure | `LinearTrackerClient.fetchIssues` | `tests/unit/linear.test.ts` |

## Dispatch, Workspace, API, Observability

| Requirement | Implementation | Tests |
| --- | --- | --- |
| Priority/created/identifier sorting | `compareIssues` in `src/scheduler/scheduler.ts` | `tests/e2e/scheduler.test.ts` |
| Blockers only apply to `Todo` | `Scheduler.isEligible` | `tests/e2e/scheduler.test.ts` |
| Per-state concurrency limits | `Scheduler.hasStateSlot` | scheduler coverage |
| Workspace sanitization and hook semantics | `src/workspace/manager.ts` | `tests/unit/workspace.test.ts` |
| HTTP dashboard/state/issue/refresh | `src/api/status.ts` | API surface retained with Fastify |
| Token/runtime/rate-limit snapshots | `Scheduler.getRuntimeState`, `src/api/status.ts` | `tests/e2e/scheduler.test.ts` |

## Policy

- Approval policy is explicit config and defaults to `never`.
- Sandbox policy is explicit config and defaults to `workspace-write`.
- User-input-required signals fail attempts with `needs_input_unsupported`.
- The trust boundary includes operator-provided hook commands, workspaces, and tracker/Codex credentials.
- Optional tracker writes and distributed scheduling are not implemented extensions.
