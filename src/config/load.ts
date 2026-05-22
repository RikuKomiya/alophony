import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigSchema, DEFAULT_CONFIG, type AlophonyConfig, type PartialAlophonyConfig } from "./schema.js";
import {
  buildWorkflowConfig,
  deepMerge,
  defaultWorkflowPath,
  loadWorkflowFile,
  WorkflowLoaderError,
} from "./workflow.js";

export interface CliConfigOverrides {
  configPath?: string | undefined;
  workflowPath?: string | undefined;
  databaseUrl?: string | undefined;
  databaseAuthToken?: string | undefined;
  trackerKind?: "linear" | "fake" | undefined;
  trackerProjectSlug?: string | undefined;
  trackerApiToken?: string | undefined;
  fakeIssuesPath?: string | undefined;
  workspaceRoot?: string | undefined;
  codexCommand?: string | undefined;
  maxConcurrency?: number | undefined;
  pollIntervalMs?: number | undefined;
  apiEnabled?: boolean | undefined;
  apiPort?: number | undefined;
  logLevel?: string | undefined;
}

async function loadConfigFile(configPath?: string): Promise<PartialAlophonyConfig> {
  const candidates = configPath
    ? [configPath]
    : ["alophony.config.ts", "alophony.config.js", "alophony.config.mjs", "alophony.config.json"];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    return {};
  }
  const resolved = path.resolve(found);
  if (resolved.endsWith(".json")) {
    return JSON.parse(await readFile(resolved, "utf8")) as PartialAlophonyConfig;
  }
  const imported = (await import(pathToFileURL(resolved).href)) as { default?: PartialAlophonyConfig };
  return imported.default ?? {};
}

function envConfig(env: NodeJS.ProcessEnv): PartialAlophonyConfig {
  const partial: PartialAlophonyConfig = {};
  if (env.TURSO_DATABASE_URL || env.TURSO_AUTH_TOKEN) {
    partial.database = {
      ...(env.TURSO_DATABASE_URL ? { url: env.TURSO_DATABASE_URL } : {}),
      ...(env.TURSO_AUTH_TOKEN ? { authToken: env.TURSO_AUTH_TOKEN } : {}),
    };
  }
  if (env.LINEAR_API_TOKEN || env.TRACKER_PROJECT_SLUG || env.TRACKER_KIND || env.FAKE_ISSUES_PATH) {
    partial.tracker = {
      ...(env.TRACKER_KIND === "fake" || env.TRACKER_KIND === "linear" ? { kind: env.TRACKER_KIND } : {}),
      ...(env.TRACKER_PROJECT_SLUG ? { projectSlug: env.TRACKER_PROJECT_SLUG } : {}),
      ...(env.LINEAR_API_TOKEN ? { apiToken: env.LINEAR_API_TOKEN } : {}),
      ...(env.FAKE_ISSUES_PATH ? { fakeIssuesPath: env.FAKE_ISSUES_PATH } : {}),
    };
  }
  if (env.WORKSPACE_ROOT) {
    partial.workspace = { root: env.WORKSPACE_ROOT };
  }
  if (env.CODEX_COMMAND || env.CODEX_MODEL) {
    partial.codex = {
      ...(env.CODEX_COMMAND ? { command: env.CODEX_COMMAND } : {}),
      ...(env.CODEX_MODEL ? { model: env.CODEX_MODEL } : {}),
    };
  }
  if (env.LOG_LEVEL) {
    partial.logLevel = env.LOG_LEVEL;
  }
  return partial;
}

function cliConfig(overrides: CliConfigOverrides): PartialAlophonyConfig {
  return {
    ...(overrides.logLevel ? { logLevel: overrides.logLevel } : {}),
    ...(overrides.databaseUrl || overrides.databaseAuthToken
      ? {
          database: {
            ...(overrides.databaseUrl ? { url: overrides.databaseUrl } : {}),
            ...(overrides.databaseAuthToken ? { authToken: overrides.databaseAuthToken } : {}),
          },
        }
      : {}),
    ...(overrides.trackerKind ||
    overrides.trackerProjectSlug ||
    overrides.trackerApiToken ||
    overrides.fakeIssuesPath
      ? {
          tracker: {
            ...(overrides.trackerKind ? { kind: overrides.trackerKind } : {}),
            ...(overrides.trackerProjectSlug ? { projectSlug: overrides.trackerProjectSlug } : {}),
            ...(overrides.trackerApiToken ? { apiToken: overrides.trackerApiToken } : {}),
            ...(overrides.fakeIssuesPath ? { fakeIssuesPath: overrides.fakeIssuesPath } : {}),
          },
        }
      : {}),
    ...(overrides.workspaceRoot ? { workspace: { root: overrides.workspaceRoot } } : {}),
    ...(overrides.codexCommand ? { codex: { command: overrides.codexCommand } } : {}),
    ...(overrides.maxConcurrency || overrides.pollIntervalMs
      ? {
          scheduler: {
            ...(overrides.maxConcurrency ? { maxConcurrency: overrides.maxConcurrency } : {}),
            ...(overrides.pollIntervalMs ? { pollIntervalMs: overrides.pollIntervalMs } : {}),
          },
        }
      : {}),
    ...(overrides.apiEnabled !== undefined || overrides.apiPort
      ? {
          api: {
            ...(overrides.apiEnabled !== undefined ? { enabled: overrides.apiEnabled } : {}),
            ...(overrides.apiPort ? { port: overrides.apiPort } : {}),
          },
        }
      : {}),
  };
}

export async function loadConfig(overrides: CliConfigOverrides = {}): Promise<AlophonyConfig> {
  const workflowPath = overrides.workflowPath ? path.resolve(overrides.workflowPath) : defaultWorkflowPath();
  if (overrides.workflowPath || existsSync(workflowPath)) {
    const workflow = await loadWorkflowFile(workflowPath);
    return buildWorkflowConfig(workflow, cliConfig(overrides));
  }
  if (!overrides.configPath && !existsSync(workflowPath)) {
    // Keep the legacy config path functional while making explicit workflow
    // paths fail with the typed missing_workflow_file error.
  } else if (overrides.workflowPath) {
    throw new WorkflowLoaderError("missing_workflow_file", `workflow file not found: ${workflowPath}`, workflowPath);
  }
  const fromFile = await loadConfigFile(overrides.configPath);
  const merged1 = deepMerge(DEFAULT_CONFIG, fromFile);
  const merged2 = deepMerge(merged1, envConfig(process.env));
  const merged3 = deepMerge(merged2, cliConfig(overrides));
  return ConfigSchema.parse(merged3);
}
