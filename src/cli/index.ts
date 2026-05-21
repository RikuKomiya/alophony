#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { createStatusApi } from "../api/status.js";
import { generateCodexProtocolTypes } from "../codex/client.js";
import { loadConfig, type CliConfigOverrides } from "../config/load.js";
import { createDbClient } from "../db/client.js";
import { runMigrations } from "../db/migrations.js";
import { RunRepository } from "../db/repository.js";
import { createLogger } from "../logging/logger.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { createTrackerClient } from "../tracker/factory.js";
import { commandExists } from "../util/command.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { CodexAppServerClient } from "../codex/client.js";

const program = new Command();

program
  .name("alophony")
  .description("TypeScript/Turso/Codex app-server orchestration daemon")
  .option("-c, --config <path>", "config file path")
  .option("--database-url <url>", "Turso/libSQL database URL")
  .option("--database-auth-token <token>", "Turso auth token")
  .option("--tracker-kind <kind>", "tracker kind: linear or fake")
  .option("--tracker-project-slug <slug>", "tracker project slug")
  .option("--tracker-api-token <token>", "tracker API token")
  .option("--fake-issues-path <path>", "fake tracker issues JSON")
  .option("--workspace-root <path>", "workspace root")
  .option("--codex-command <command>", "Codex app-server command")
  .option("--max-concurrency <number>", "max concurrency", parseNumber)
  .option("--poll-interval-ms <number>", "poll interval", parseNumber)
  .option("--log-level <level>", "log level");

program.command("migrate").description("apply database migrations").action(async () => {
  const config = await loadFromProgram();
  const db = createDbClient(config.database);
  const result = await runMigrations(db, path.resolve(config.database.migrationsDir));
  db.close();
  console.log(JSON.stringify(result, null, 2));
});

program.command("validate").description("validate config and dependencies").action(async () => {
  const config = await loadFromProgram();
  const errors: string[] = [];
  let db: ReturnType<typeof createDbClient> | undefined;
  try {
    db = createDbClient(config.database);
    await db.execute("SELECT 1");
  } catch (error) {
    errors.push(`database connectivity failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db?.close();
  }
  if (config.tracker.kind === "linear" && !config.tracker.apiToken) {
    errors.push("tracker auth failure: LINEAR_API_TOKEN or tracker.apiToken is required");
  }
  if (!(await commandExists(config.codex.command))) {
    errors.push(`missing Codex command: ${config.codex.command}`);
  }
  if (config.codex.generateProtocolTypes) {
    const generated = await generateCodexProtocolTypes(config.codex.command, ".alophony/generated/codex-protocol");
    if (!generated) {
      errors.push("Codex protocol type generation failed");
    }
  }
  if (errors.length > 0) {
    console.error(JSON.stringify({ ok: false, errors }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true }, null, 2));
});

program.command("start").description("start daemon").option("--api", "enable status API").option("--api-port <port>", "status API port", parseNumber).action(async (cmd) => {
  const config = await loadFromProgram({ apiEnabled: Boolean(cmd.api), apiPort: cmd.apiPort });
  const logger = createLogger(config.logLevel);
  const db = createDbClient(config.database);
  await runMigrations(db, path.resolve(config.database.migrationsDir));
  if (config.codex.generateProtocolTypes) {
    const generated = await generateCodexProtocolTypes(config.codex.command, ".alophony/generated/codex-protocol");
    if (!generated) {
      throw new Error("Codex protocol type generation failed");
    }
  }
  const repository = new RunRepository(db);
  const scheduler = new Scheduler({
    config,
    repository,
    tracker: createTrackerClient(config),
    codex: new CodexAppServerClient(config.codex),
    workspace: new WorkspaceManager(config.workspace),
    logger,
  });
  await scheduler.startupRecovery();
  scheduler.start();

  const api = config.api.enabled ? createStatusApi({ config: config.api, repository, scheduler }) : undefined;
  if (api) {
    await api.listen({ host: config.api.host, port: config.api.port });
    logger.info({ port: config.api.port }, "status api listening");
  }
  const shutdown = async () => {
    await scheduler.stop();
    if (api) {
      await api.close();
    }
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
});

program.command("status").description("print runtime snapshot").action(async () => {
  const config = await loadFromProgram();
  const db = createDbClient(config.database);
  await runMigrations(db, path.resolve(config.database.migrationsDir));
  const repository = new RunRepository(db);
  const runs = await repository.listRuns(50);
  db.close();
  console.log(JSON.stringify({ runs }, null, 2));
});

program.command("run-once").description("dispatch one issue for debugging").argument("<issue-id>").action(async (issueId: string) => {
  const config = await loadFromProgram();
  const logger = createLogger(config.logLevel);
  const db = createDbClient(config.database);
  await runMigrations(db, path.resolve(config.database.migrationsDir));
  const repository = new RunRepository(db);
  const tracker = createTrackerClient(config);
  const issue = await tracker.getIssue(issueId);
  if (!issue) {
    console.error(`issue not found: ${issueId}`);
    process.exitCode = 1;
    return;
  }
  await repository.upsertIssue(issue);
  const scheduler = new Scheduler({
    config,
    repository,
    tracker,
    codex: new CodexAppServerClient(config.codex),
    workspace: new WorkspaceManager(config.workspace),
    logger,
  });
  const run = await scheduler.dispatch(issue);
  db.close();
  console.log(JSON.stringify({ run }, null, 2));
});

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid number: ${value}`);
  }
  return parsed;
}

async function loadFromProgram(extra: CliConfigOverrides = {}) {
  const opts = program.opts<{
    config?: string;
    databaseUrl?: string;
    databaseAuthToken?: string;
    trackerKind?: "linear" | "fake";
    trackerProjectSlug?: string;
    trackerApiToken?: string;
    fakeIssuesPath?: string;
    workspaceRoot?: string;
    codexCommand?: string;
    maxConcurrency?: number;
    pollIntervalMs?: number;
    logLevel?: string;
  }>();
  return loadConfig({
    configPath: opts.config,
    databaseUrl: opts.databaseUrl,
    databaseAuthToken: opts.databaseAuthToken,
    trackerKind: opts.trackerKind,
    trackerProjectSlug: opts.trackerProjectSlug,
    trackerApiToken: opts.trackerApiToken,
    fakeIssuesPath: opts.fakeIssuesPath,
    workspaceRoot: opts.workspaceRoot,
    codexCommand: opts.codexCommand,
    maxConcurrency: opts.maxConcurrency,
    pollIntervalMs: opts.pollIntervalMs,
    logLevel: opts.logLevel,
    ...extra,
  });
}

await program.parseAsync();
