import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type pino from "pino";
import { ConfigSchema, DEFAULT_CONFIG, type AlophonyConfig, type PartialAlophonyConfig } from "./schema.js";

export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map";

export class WorkflowLoaderError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
    readonly workflowPath?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorkflowLoaderError";
  }
}

export interface LoadedWorkflow {
  path: string;
  config: PartialAlophonyConfig;
  promptBody: string;
}

export interface WorkflowReloadHandle {
  readonly config: AlophonyConfig;
  close(): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return merged as T;
}

export function defaultWorkflowPath(cwd = process.cwd()): string {
  return path.resolve(cwd, "WORKFLOW.md");
}

export async function loadWorkflowFile(workflowPath: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedWorkflow> {
  const resolved = path.resolve(workflowPath);
  if (!existsSync(resolved)) {
    throw new WorkflowLoaderError("missing_workflow_file", `workflow file not found: ${resolved}`, resolved);
  }
  const raw = await readFile(resolved, "utf8");
  const { frontMatter, body } = splitFrontMatter(raw);
  const config = frontMatter === undefined ? {} : parseYamlMap(frontMatter, resolved);
  const resolvedConfig = normalizeWorkflowConfig(resolveEnvReferences(config, env), path.dirname(resolved)) as Record<string, unknown>;
  return {
    path: resolved,
    config: {
      ...resolvedConfig,
      prompt: {
        ...(isPlainObject(resolvedConfig.prompt) ? resolvedConfig.prompt : {}),
        inlineTemplate: body.trim(),
      },
    } as PartialAlophonyConfig,
    promptBody: body.trim(),
  };
}

export function buildWorkflowConfig(
  workflow: LoadedWorkflow,
  overrides: PartialAlophonyConfig = {},
): AlophonyConfig {
  return ConfigSchema.parse(deepMerge(deepMerge(DEFAULT_CONFIG, workflow.config), overrides));
}

export function watchWorkflowConfig(input: {
  workflowPath: string;
  config: AlophonyConfig;
  overrides?: PartialAlophonyConfig | undefined;
  logger?: pino.Logger | undefined;
}): WorkflowReloadHandle {
  let watcher: FSWatcher | undefined;
  let reloadInFlight = false;
  const reload = async () => {
    if (reloadInFlight) {
      return;
    }
    reloadInFlight = true;
    try {
      const workflow = await loadWorkflowFile(input.workflowPath);
      const next = buildWorkflowConfig(workflow, input.overrides ?? {});
      replaceObject(input.config as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
      input.logger?.info({ workflow_path: workflow.path }, "workflow reloaded");
    } catch (error) {
      const code = error instanceof WorkflowLoaderError ? error.code : "workflow_parse_error";
      input.logger?.error({ err: error, error_code: code, workflow_path: input.workflowPath }, "workflow reload failed; keeping last known good config");
    } finally {
      reloadInFlight = false;
    }
  };
  watcher = watch(path.resolve(input.workflowPath), { persistent: false }, () => {
    setTimeout(() => void reload(), 25).unref();
  });
  return {
    config: input.config,
    close() {
      watcher?.close();
    },
  };
}

function splitFrontMatter(raw: string): { frontMatter?: string; body: string } {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { body: raw };
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new WorkflowLoaderError("workflow_parse_error", "workflow front matter is not closed");
  }
  return { frontMatter: match[1] ?? "", body: match[2] ?? "" };
}

function parseYamlMap(source: string, workflowPath: string): Record<string, unknown> {
  try {
    const root: Record<string, unknown> = {};
    const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];
    for (const rawLine of source.split(/\r?\n/)) {
      if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
        continue;
      }
      const indent = rawLine.match(/^ */)?.[0].length ?? 0;
      const trimmed = rawLine.trim();
      if (trimmed.startsWith("- ")) {
        throw new WorkflowLoaderError("workflow_front_matter_not_a_map", "workflow front matter root must be a map", workflowPath);
      }
      const index = trimmed.indexOf(":");
      if (index <= 0) {
        throw new WorkflowLoaderError("workflow_parse_error", `invalid workflow front matter line: ${trimmed}`, workflowPath);
      }
      while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1]!.value;
      const key = trimmed.slice(0, index).trim();
      const rawValue = trimmed.slice(index + 1).trim();
      if (!rawValue) {
        const nested: Record<string, unknown> = {};
        parent[key] = nested;
        stack.push({ indent, value: nested });
      } else {
        parent[key] = parseYamlScalar(rawValue);
      }
    }
    return root;
  } catch (error) {
    if (error instanceof WorkflowLoaderError) {
      throw error;
    }
    throw new WorkflowLoaderError("workflow_parse_error", "failed to parse workflow front matter", workflowPath, error);
  }
}

function parseYamlScalar(value: string): unknown {
  const lower = value.toLowerCase();
  if (lower === "true") {
    return true;
  }
  if (lower === "false") {
    return false;
  }
  if (lower === "null" || value === "~") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? splitInlineArray(inner).map(parseYamlScalar) : [];
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function splitInlineArray(value: string): string[] {
  const result: string[] = [];
  let quote: string | undefined;
  let current = "";
  for (const char of value) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? undefined : char;
      current += char;
      continue;
    }
    if (char === "," && !quote) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    result.push(current.trim());
  }
  return result;
}

function resolveEnvReferences(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    const match = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    return match?.[1] ? env[match[1]] : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveEnvReferences(entry, env));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveEnvReferences(entry, env)]));
  }
  return value;
}

function normalizeWorkflowConfig(value: unknown, baseDir: string): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  const copy: Record<string, unknown> = { ...value };
  normalizePath(copy, ["workspace", "root"], baseDir);
  normalizePath(copy, ["database", "migrationsDir"], baseDir);
  normalizePath(copy, ["tracker", "fakeIssuesPath"], baseDir);
  normalizePath(copy, ["prompt", "templatePath"], baseDir);
  return copy;
}

function normalizePath(root: Record<string, unknown>, keys: string[], baseDir: string): void {
  let parent: Record<string, unknown> = root;
  for (const key of keys.slice(0, -1)) {
    const next = parent[key];
    if (!isPlainObject(next)) {
      return;
    }
    parent = next;
  }
  const leaf = keys[keys.length - 1];
  if (!leaf) {
    return;
  }
  const value = parent[leaf];
  if (typeof value === "string" && value && !path.isAbsolute(value) && !value.startsWith("file:") && !value.includes("://")) {
    parent[leaf] = path.resolve(baseDir, value);
  }
}

function replaceObject(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}
