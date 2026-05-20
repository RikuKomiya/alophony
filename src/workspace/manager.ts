import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AlophonyConfig } from "../config/schema.js";
import type { NormalizedIssue } from "../types.js";
import { shortHash } from "../util/id.js";

export class WorkspaceSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSafetyError";
  }
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "issue";
}

export class WorkspaceManager {
  private readonly root: string;

  constructor(private readonly config: AlophonyConfig["workspace"]) {
    this.root = path.resolve(config.root);
  }

  workspacePathFor(issue: NormalizedIssue): string {
    const issueSegment = `${sanitizeSegment(issue.identifier)}-${shortHash(issue.trackerIssueId)}`;
    return this.assertInsideRoot(path.resolve(this.root, sanitizeSegment(issue.trackerKind), issueSegment));
  }

  async create(issue: NormalizedIssue): Promise<string> {
    const workspacePath = this.workspacePathFor(issue);
    await this.runHook("beforeCreate", workspacePath);
    await mkdir(workspacePath, { recursive: true });
    await this.runHook("afterCreate", workspacePath);
    return workspacePath;
  }

  async beforeRun(workspacePath: string): Promise<void> {
    await this.runHook("beforeRun", this.assertInsideRoot(path.resolve(workspacePath)));
  }

  async afterRun(workspacePath: string): Promise<void> {
    await this.runHook("afterRun", this.assertInsideRoot(path.resolve(workspacePath)));
  }

  async cleanup(workspacePath: string): Promise<void> {
    const safe = this.assertInsideRoot(path.resolve(workspacePath));
    await this.runHook("beforeCleanup", safe);
    await rm(safe, { recursive: true, force: true });
  }

  assertInsideRoot(candidate: string): string {
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
      throw new WorkspaceSafetyError(`workspace path must stay inside root: ${candidate}`);
    }
    return candidate;
  }

  private async runHook(name: keyof NonNullable<AlophonyConfig["workspace"]["hooks"]>, workspacePath: string): Promise<void> {
    const hooks = this.config.hooks;
    const command = hooks[name];
    if (typeof command !== "string" || command.trim() === "") {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        cwd: workspacePath,
        shell: true,
        env: { ...process.env, ALOPHONY_WORKSPACE: workspacePath },
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        const error = new Error(`workspace hook timed out: ${String(name)}`);
        if (hooks.required) {
          reject(error);
        } else {
          resolve();
        }
      }, hooks.timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 || !hooks.required) {
          resolve();
        } else {
          reject(new Error(`workspace hook failed: ${String(name)} exit ${code}`));
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (hooks.required) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}
