# Symphony Spec Conformance TODO

This checklist tracks known gaps between the current Alophony implementation and the Symphony Service Specification Draft v1 reviewed in the conversation.

Use this file as an agent-operable TODO list. Keep each item checked only when the implementation, tests, and relevant documentation are complete.

## P0 Required Gaps

### WORKFLOW.md Contract

- [x] Implement `WORKFLOW.md` discovery and loading.
  - Current gap: configuration is loaded from `alophony.config.*`, environment variables, and CLI flags.
  - References: `src/config/load.ts`, `README.md`.
  - Done when: explicit workflow path and default `./WORKFLOW.md` are supported.

- [x] Parse optional YAML front matter and Markdown prompt body.
  - Done when: front matter maps to the workflow config root object and the trimmed Markdown body becomes the prompt template.

- [x] Add typed workflow loader errors.
  - Required errors: `missing_workflow_file`, `workflow_parse_error`, `workflow_front_matter_not_a_map`.

- [x] Implement workflow config defaults, `$VAR` resolution, and path normalization according to the spec.
  - Done when: env vars do not globally override YAML unless explicitly referenced as `$VAR_NAME`.

- [x] Implement dynamic `WORKFLOW.md` reload.
  - Done when: changes are detected and future behavior uses the reloaded config/prompt without restart.

- [x] Preserve last known good config on invalid reload.
  - Done when: invalid reload emits an operator-visible error and the service keeps running.

### Continuation And Redispatch Semantics

- [x] Remove permanent dispatch blocking after a successful run.
  - Current gap: successful runs are marked `succeeded` and `hasSucceededRun` prevents future dispatch.
  - References: `src/scheduler/scheduler.ts`.
  - Done when: a successful worker exit does not permanently make an active issue ineligible.

- [x] Schedule a short continuation retry after normal worker exit.
  - Required behavior: about `1000` ms delay, attempt `1`.
  - Done when: the retry path re-checks whether the issue remains active and dispatches again if eligible.

- [x] Support multiple continuation turns inside one worker lifetime.
  - Done when: after a successful turn, the worker refreshes issue state and starts another turn on the same live thread until inactive or `agent.max_turns`.

- [x] Send continuation guidance instead of resending the full original prompt.
  - Done when: first turn uses rendered task prompt, later in-worker turns use concise continuation guidance.

### Orchestrator Retry Queue And State Machine

- [x] Implement orchestrator-owned runtime state.
  - Required logical state: `running`, `claimed`, `retry_attempts`, `completed`, `codex_totals`, `codex_rate_limits`.
  - Current gap: retry behavior is mostly DB status plus worker-local sleep.

- [x] Replace worker-local retry sleep with orchestrator retry timers.
  - Reference: `src/scheduler/scheduler.ts`.
  - Done when: failed workers exit and retry scheduling is owned by the orchestrator.

- [x] Add retry entries with `issue_id`, `identifier`, `attempt`, `due_at_ms`, `timer_handle`, and `error`.

- [x] Implement failure backoff formula.
  - Required formula: `min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`.

- [x] Requeue retries when orchestrator slots are unavailable.
  - Required error reason: `no available orchestrator slots`.

- [x] Release claims when a retry fires and the issue is no longer an active candidate.

- [x] Ensure reconciliation runs before dispatch on every tick.

## P1 Required Gaps

### Codex App-Server Client

- [x] Launch Codex through `bash -lc <codex.command>` in the per-issue workspace.
  - Current gap: process uses `shell: true`.
  - Reference: `src/codex/client.ts`.

- [x] Validate `cwd == workspace_path` before launching Codex.

- [x] Align startup, thread, and turn messages with the targeted Codex app-server protocol.
  - Done when: implementation is validated against the installed Codex schema or documented protocol source.

- [x] Keep the app-server subprocess alive across in-worker continuation turns.
  - Current gap: process is killed after terminal success.

- [x] Emit `session_started` with `session_id = <thread_id>-<turn_id>`.

- [x] Handle targeted-protocol turn success, failure, cancellation, subprocess exit, read timeout, turn timeout, and user-input-required signals.

- [x] Document approval, sandbox, and user-input policy.
  - Done when: the chosen posture is explicit in docs and enforced by the client.

- [x] Reject unsupported dynamic tool calls without stalling the session.

- [x] Extract usage and rate-limit telemetry from Codex events where available.

### Linear And Issue Domain Model

- [x] Expand `NormalizedIssue` to the spec fields.
  - Required fields include: `id`, `identifier`, `title`, `description`, `priority`, `state`, `branch_name`, `url`, `labels`, `blocked_by`, `created_at`, `updated_at`.
  - Reference: `src/types.ts`.

- [x] Normalize labels to lowercase.

- [x] Normalize blockers from inverse relations of type `blocks`.

- [x] Convert priority to integer or `null`.
  - Current gap: `priorityLabel` is stored as a string.

- [x] Add configurable Linear endpoint.
  - Current gap: endpoint is hardcoded.
  - Reference: `src/tracker/linear.ts`.

- [x] Add Linear request timeout of `30000` ms.

- [x] Implement `fetch_issue_states_by_ids(issue_ids)` using GraphQL variable type `[ID!]`.

- [x] Preserve pagination order and fail on missing `endCursor` when `hasNextPage` is true.

- [x] Map Linear transport, status, GraphQL, and malformed payload failures to stable error categories.

### Dispatch Eligibility And Sorting

- [x] Sort dispatch candidates by priority integer ascending.
  - Current gap: priority is string compared with `localeCompare`.
  - Reference: `src/scheduler/scheduler.ts`.

- [x] Sort priority ties by `created_at` oldest first.
  - Current gap: sorting uses `updatedAt`.

- [x] Sort remaining ties by `identifier` lexicographically.

- [x] Apply blocker rule only to `Todo` issues.
  - Current gap: blockers are checked for all active states.

- [x] Compare issue states using normalized lowercase values.

- [x] Implement per-state concurrency limits via `agent.max_concurrent_agents_by_state`.

### Workspace Hooks And Safety

- [x] Change workspace key sanitization to replace non-`[A-Za-z0-9._-]` characters with `_`.
  - Current gap: sanitization lowercases and uses `-`.
  - Reference: `src/workspace/manager.ts`.

- [x] Use `<workspace.root>/<sanitized_issue_identifier>` as the per-issue workspace path unless an implementation-defined extension is documented.

- [x] Run `after_create` only when the workspace directory is newly created.
  - Current gap: it runs on every create call.

- [x] Make `after_create` failure or timeout fatal to workspace creation.

- [x] Make `before_run` failure or timeout fatal to the current attempt.

- [x] Log and ignore `after_run` failure or timeout.

- [x] Rename or map `beforeCleanup` to spec `before_remove`.

- [x] Log and ignore `before_remove` failure or timeout, then continue cleanup.

- [x] Use `hooks.timeout_ms` default `60000`.
  - Current gap: default is `30000`.

## P2 Extension And Observability Gaps

### Optional HTTP API Extension

- [x] Decide whether to keep the HTTP API extension.
  - If kept, make it conform to the spec baseline.

- [x] Add `GET /` human-readable dashboard.

- [x] Add `GET /api/v1/state`.
  - Required data: running sessions, retry queue, token/runtime totals, latest rate limits.

- [x] Add `GET /api/v1/<issue_identifier>`.
  - Required behavior: return issue-specific runtime/debug details or 404 JSON error envelope.

- [x] Add `POST /api/v1/refresh`.
  - Required behavior: queue best-effort poll + reconciliation and return `202 Accepted`.

- [x] Preserve or replace existing endpoints intentionally.
  - Current endpoints: `/api/v1/runs`, `/api/v1/runs/:id`, `/api/v1/issues/:id`, `/api/v1/events`, `/api/v1/runs/:id/cancel`.
  - Reference: `src/api/status.ts`.

### Logs, Metrics, And Status

- [x] Ensure issue-related logs include `issue_id` and `issue_identifier`.

- [x] Ensure session lifecycle logs include `session_id`.

- [x] Track aggregate Codex input, output, and total tokens using absolute totals when available.

- [x] Track aggregate runtime seconds, including active session elapsed time in snapshots.

- [x] Track the latest Codex rate-limit payload.

- [x] Avoid logging prompt bodies, API tokens, or large raw payloads by default.

## Test TODO

- [x] Add workflow path precedence tests.
- [x] Add `WORKFLOW.md` YAML front matter parsing tests.
- [x] Add non-map front matter error test.
- [x] Add invalid reload keeps last known good config test.
- [x] Add strict prompt unknown variable/filter tests against workflow prompt body.
- [x] Add workspace creation/reuse and hook semantics tests.
- [x] Add workspace path sanitization and root containment tests.
- [x] Add Linear pagination and normalization tests.
- [x] Add issue state refresh by IDs test.
- [x] Add dispatch sort order test.
- [x] Add `Todo` blocker-only eligibility test.
- [x] Add continuation retry after normal worker exit test.
- [x] Add exponential backoff cap test using spec formula.
- [x] Add retry slot exhaustion requeue test.
- [x] Add terminal/non-active reconciliation tests.
- [x] Add stall detection test.
- [x] Add Codex user-input-required failure test.
- [x] Add Codex usage/rate-limit extraction test.
- [x] Add HTTP API conformance tests if HTTP extension is kept.
- [x] Add CLI default `./WORKFLOW.md` and explicit workflow path tests.

## Documentation TODO

- [x] Document implementation-defined approval policy.
- [x] Document implementation-defined sandbox policy.
- [x] Document implementation-defined user-input-required policy.
- [x] Document trust boundary and harness hardening posture.
- [x] Document optional extensions that are not implemented.
- [x] Add or update a conformance matrix mapping spec requirements to files and tests.

## Final Verification

- [x] `bun run typecheck`
- [x] `bun run test`
- [x] `bun run build`
