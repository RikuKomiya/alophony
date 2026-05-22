import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AlophonyConfig } from "../config/schema.js";
import type { NormalizedIssue } from "../types.js";

export class WorkspaceSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSafetyError";
  }
}

function sanitizeSegment(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "issue";
}

export class WorkspaceManager {
  private readonly root: string;

  constructor(private readonly config: AlophonyConfig["workspace"]) {
    this.root = path.resolve(config.root);
  }

  workspacePathFor(issue: NormalizedIssue): string {
    return this.assertInsideRoot(path.resolve(this.root, sanitizeSegment(issue.identifier)));
  }

  async create(issue: NormalizedIssue): Promise<string> {
    const workspacePath = this.workspacePathFor(issue);
    await this.runHook("beforeCreate", workspacePath, "fatal");
    await mkdir(this.root, { recursive: true });
    let created = false;
    try {
      await mkdir(workspacePath);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    if (created) {
      await this.runHook("afterCreate", workspacePath, "fatal");
    }
    return workspacePath;
  }

  async beforeRun(workspacePath: string): Promise<void> {
    await this.runHook("beforeRun", this.assertInsideRoot(path.resolve(workspacePath)), "fatal");
  }

  async afterRun(workspacePath: string): Promise<void> {
    await this.runHook("afterRun", this.assertInsideRoot(path.resolve(workspacePath)), "ignore");
  }

  async cleanup(workspacePath: string): Promise<void> {
    const safe = this.assertInsideRoot(path.resolve(workspacePath));
    await this.runHook("beforeRemove", safe, "ignore");
    await rm(safe, { recursive: true, force: true });
  }

  assertInsideRoot(candidate: string): string {
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
      throw new WorkspaceSafetyError(`workspace path must stay inside root: ${candidate}`);
    }
    return candidate;
  }

  private async runHook(
    name: keyof NonNullable<AlophonyConfig["workspace"]["hooks"]>,
    workspacePath: string,
    failureMode: "fatal" | "ignore",
  ): Promise<void> {
    const hooks = this.config.hooks;
    const command = hooks[name] ?? (name === "beforeRemove" ? hooks.beforeCleanup : undefined);
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
        if (failureMode === "fatal") {
          reject(error);
        } else {
          resolve();
        }
      }, hooks.timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 || failureMode === "ignore") {
          resolve();
        } else {
          reject(new Error(`workspace hook failed: ${String(name)} exit ${code}`));
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (failureMode === "fatal") {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}
