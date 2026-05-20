import path from "node:path";
import type { AlophonyConfig } from "./config/schema.js";
import { CodexAppServerClient, generateCodexProtocolTypes } from "./codex/client.js";
import { createDbClient, type DbClient } from "./db/client.js";
import { runMigrations } from "./db/migrations.js";
import { RunRepository } from "./db/repository.js";
import { createLogger } from "./logging/logger.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { createTrackerClient } from "./tracker/factory.js";
import { WorkspaceManager } from "./workspace/manager.js";

export interface AppContext {
  db: DbClient;
  repository: RunRepository;
  scheduler: Scheduler;
}

export async function createApp(config: AlophonyConfig): Promise<AppContext> {
  const db = createDbClient(config.database);
  await runMigrations(db, path.resolve(config.database.migrationsDir));
  if (config.codex.generateProtocolTypes) {
    const ok = await generateCodexProtocolTypes(config.codex.command, ".alophony/generated/codex-protocol");
    if (!ok) {
      throw new Error("Codex protocol type generation failed");
    }
  }
  const repository = new RunRepository(db);
  const logger = createLogger(config.logLevel);
  const scheduler = new Scheduler({
    config,
    repository,
    tracker: createTrackerClient(config),
    codex: new CodexAppServerClient(config.codex),
    workspace: new WorkspaceManager(config.workspace),
    logger,
  });
  return { db, repository, scheduler };
}
