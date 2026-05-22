# Alophony

Alophony is a TypeScript orchestration daemon for dispatching tracker issues to Codex through `codex app-server`, with Turso/libSQL as the persistent source of truth for runs, attempts, locks, and events.

## Stack

- TypeScript, Node.js 22+, ESM
- Bun
- Turso via `@libsql/client`
- Zod config validation
- Pino structured logs
- Fastify optional status API
- Vitest tests

## Setup

```sh
bun install
bun run typecheck
bun run test
```

Required environment variables for Linear + Turso:

```sh
export TURSO_DATABASE_URL="libsql://..."
export TURSO_AUTH_TOKEN="..."
export LINEAR_API_TOKEN="..."
export TRACKER_PROJECT_SLUG="ENG"
export CODEX_MODEL="..."
```

For local development and tests, use a file database and fake tracker:

```sh
bunx tsx src/cli/index.ts validate \
  --tracker-kind fake \
  --tracker-project-slug TEST \
  --database-url "file:.alophony/dev.db" \
  --codex-command "node tests/fixtures/fake-codex/server.mjs"
```

## Configuration

The preferred configuration contract is `WORKFLOW.md` in the current directory, or an explicit path passed with `--workflow`.
When a workflow file is present, YAML front matter becomes the config object and the trimmed Markdown body becomes the prompt template.
Environment variables are only read when explicitly referenced as `$VAR_NAME` in workflow front matter; they do not globally override workflow values.

Example `WORKFLOW.md`:

```md
---
tracker:
  kind: linear
  projectSlug: ENG
  activeStates: [Todo, In Progress]
  terminalStates: [Done, Canceled, Cancelled, Duplicate]
  apiToken: $LINEAR_API_TOKEN
database:
  url: $TURSO_DATABASE_URL
  authToken: $TURSO_AUTH_TOKEN
workspace:
  root: .alophony/workspaces
codex:
  command: codex app-server
  approvalPolicy: never
  sandboxPolicy: workspace-write
---
Work on {{ issue.identifier }}: {{ issue.title }}

{{ issue.description }}
```

Legacy config is still supported when no workflow file is present. Legacy config is resolved in this order:

1. Built-in defaults
2. `alophony.config.ts`, `alophony.config.js`, `alophony.config.mjs`, or `alophony.config.json`
3. Environment variables
4. CLI flags

Example:

```ts
export default {
  tracker: {
    kind: "linear",
    projectSlug: "ENG",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Canceled", "Cancelled", "Duplicate"],
  },
  database: {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  workspace: {
    root: ".alophony/workspaces",
  },
  scheduler: {
    maxConcurrency: 2,
    pollIntervalMs: 30_000,
  },
  codex: {
    command: "codex app-server",
    model: process.env.CODEX_MODEL,
    approvalPolicy: "never",
    sandboxPolicy: "workspace-write",
  },
};
```

## CLI

```sh
bunx tsx src/cli/index.ts migrate
bunx tsx src/cli/index.ts validate
bunx tsx src/cli/index.ts start --api
bunx tsx src/cli/index.ts status
bunx tsx src/cli/index.ts run-once <issue-id>
```

The built package exposes the same commands through `alophony`.

## Status API

When `api.enabled` or `start --api` is used:

- `GET /`
- `GET /healthz`
- `GET /readyz`
- `GET /api/v1/state`
- `GET /api/v1/:issue_identifier`
- `POST /api/v1/refresh`
- `GET /api/v1/runs`
- `GET /api/v1/runs/:id`
- `GET /api/v1/issues/:id`
- `GET /api/v1/events?runId=...`
- `POST /api/v1/runs/:id/cancel`

Mutation endpoints require `api.operatorToken` when configured.

## v1 Constraints

- Single active scheduler process is the supported deployment model.
- Turso locks are still mandatory and prevent accidental duplicate processes.
- Tracker writes are not implemented in v1.
- Linear is the only production tracker boundary; fake tracker is for tests and local validation.
- The HTTP dashboard is intentionally minimal; the JSON API is the primary observability surface.
- Distributed scheduling is intentionally out of scope.
- Real Codex app-server protocol types are generated only when `codex.generateProtocolTypes` is enabled and the installed Codex command supports generation.

## Runtime Policy

- Approval policy is operator-defined config and defaults to `never`.
- Sandbox policy is operator-defined config and defaults to `workspace-write`.
- Interactive user input is unsupported in daemon runs. A Codex user-input request fails the attempt with `needs_input_unsupported`.
- Hook commands and workspace contents are inside the operator trust boundary. Tokens, prompt bodies, and large raw payloads are not written to normal logs by default.
- Unsupported dynamic tool-call requests are rejected as protocol failures rather than leaving a session stalled.

See [docs/SPEC_CONFORMANCE.md](docs/SPEC_CONFORMANCE.md) for the conformance matrix.

## Verification

```sh
bun run typecheck
bun run test
bun run build
```
# alophony
