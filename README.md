# Alophony

Alophony is a TypeScript orchestration daemon for dispatching tracker issues to Codex through `codex app-server`, with Turso/libSQL as the persistent source of truth for runs, attempts, locks, and events.

## Stack

- TypeScript, Node.js 22+, ESM
- pnpm
- Turso via `@libsql/client`
- Zod config validation
- Pino structured logs
- Fastify optional status API
- Vitest tests

## Setup

```sh
pnpm install
pnpm typecheck
pnpm test
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
pnpm tsx src/cli/index.ts validate \
  --tracker-kind fake \
  --tracker-project-slug TEST \
  --database-url "file:.alophony/dev.db" \
  --codex-command "node tests/fixtures/fake-codex/server.mjs"
```

## Configuration

Config is resolved in this order:

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
pnpm tsx src/cli/index.ts migrate
pnpm tsx src/cli/index.ts validate
pnpm tsx src/cli/index.ts start --api
pnpm tsx src/cli/index.ts status
pnpm tsx src/cli/index.ts run-once <issue-id>
```

The built package exposes the same commands through `alophony`.

## Status API

When `api.enabled` or `start --api` is used:

- `GET /healthz`
- `GET /readyz`
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
- Rich dashboards and distributed scheduling are intentionally out of scope.
- Real Codex app-server protocol types are generated only when `codex.generateProtocolTypes` is enabled and the installed Codex command supports generation.

## Verification

```sh
pnpm typecheck
pnpm test
pnpm build
```
# alophony
