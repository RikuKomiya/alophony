import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AlophonyConfig } from "../config/schema.js";

export interface CodexRunInput {
  workspacePath: string;
  prompt: string;
  runId: string;
  attemptId: string;
}

export interface CodexNormalizedEvent {
  type: string;
  message?: string;
  payload: unknown;
  codexThreadId?: string;
  codexTurnId?: string;
}

export interface CodexRunResult {
  status: "succeeded" | "failed" | "timed_out" | "needs_input";
  errorCode?: string;
  errorMessage?: string;
  exitCode?: number;
  processPid?: number;
  codexThreadId?: string;
  codexTurnId?: string;
}

export type CodexEventSink = (event: CodexNormalizedEvent) => Promise<void>;

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function eventType(value: Record<string, unknown>): string {
  const raw = value.type ?? value.event ?? value.method ?? "message";
  return String(raw).replace(/[.-]/g, "_");
}

function normalizedEvent(value: Record<string, unknown>): CodexNormalizedEvent {
  const type = eventType(value);
  const result = typeof value.result === "object" && value.result !== null ? (value.result as Record<string, unknown>) : {};
  const params = typeof value.params === "object" && value.params !== null ? (value.params as Record<string, unknown>) : {};
  const payload = { ...value };
  const thread = value.thread_id ?? value.threadId ?? result.thread_id ?? result.threadId ?? params.thread_id ?? params.threadId;
  const turn = value.turn_id ?? value.turnId ?? result.turn_id ?? result.turnId ?? params.turn_id ?? params.turnId;
  return {
    type,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    payload,
    ...(typeof thread === "string" ? { codexThreadId: thread } : {}),
    ...(typeof turn === "string" ? { codexTurnId: turn } : {}),
  };
}

function isTerminalSuccess(type: string, payload: Record<string, unknown>): boolean {
  const status = payload.status;
  return ["turn_finished", "session_finished", "completed", "done", "succeeded"].includes(type) || status === "succeeded";
}

function isTerminalFailure(type: string, payload: Record<string, unknown>): boolean {
  const status = payload.status;
  return ["session_failed", "turn_failed", "failed", "error"].includes(type) || status === "failed";
}

function isNeedsInput(type: string): boolean {
  return type === "user_input_requested" || type === "input_required" || type === "needs_input";
}

export class CodexAppServerClient {
  constructor(private readonly config: AlophonyConfig["codex"]) {}

  async run(input: CodexRunInput, sink: CodexEventSink): Promise<CodexRunResult> {
    await mkdir(input.workspacePath, { recursive: true });
    const child = spawn(this.config.command, {
      cwd: input.workspacePath,
      shell: true,
      env: {
        ...process.env,
        ...(this.config.model ? { CODEX_MODEL: this.config.model } : {}),
      },
    });
    let processPid = child.pid;
    let codexThreadId: string | undefined;
    let codexTurnId: string | undefined;
    let settled = false;
    let timeoutResult: CodexRunResult | undefined;
    let lastStdoutAt = Date.now();
    const stderr: string[] = [];

    const startupTimer = setTimeout(() => {
      if (!settled && Date.now() - lastStdoutAt >= this.config.startupTimeoutMs) {
        timeoutResult = {
          status: "failed",
          errorCode: "codex_startup_failure",
          errorMessage: "Codex app-server did not produce startup output before timeout",
        };
        killChild(child);
      }
    }, this.config.startupTimeoutMs);

    const idleTimer = setInterval(() => {
      if (!settled && Date.now() - lastStdoutAt >= this.config.idleTimeoutMs) {
        timeoutResult = {
          status: "timed_out",
          errorCode: "idle_timeout",
          errorMessage: "Codex app-server idle timeout",
        };
        killChild(child);
      }
    }, Math.min(this.config.idleTimeoutMs, 1_000));

    const turnTimer = setTimeout(() => {
      if (!settled) {
        timeoutResult = {
          status: "timed_out",
          errorCode: "turn_timeout",
          errorMessage: "Codex app-server turn timeout",
        };
        killChild(child);
      }
    }, this.config.turnTimeoutMs);

    const final = new Promise<CodexRunResult>((resolve) => {
      const finish = (result: CodexRunResult) => {
        if (settled && result.status !== "timed_out") {
          return;
        }
        settled = true;
        clearTimeout(startupTimer);
        clearTimeout(turnTimer);
        clearInterval(idleTimer);
        resolve({
          ...result,
          ...(processPid ? { processPid } : {}),
          ...(codexThreadId ? { codexThreadId } : {}),
          ...(codexTurnId ? { codexTurnId } : {}),
        });
      };

      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk.toString("utf8"));
      });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        lastStdoutAt = Date.now();
        if (!line.trim()) {
          return;
        }
        void (async () => {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const event = normalizedEvent(parsed);
            codexThreadId = event.codexThreadId ?? codexThreadId;
            codexTurnId = event.codexTurnId ?? codexTurnId;
            await sink(event);
            if (isNeedsInput(event.type)) {
              finish({
                status: "needs_input",
                errorCode: "needs_input_unsupported",
                errorMessage: "Codex requested interactive user input, which is unsupported in v1",
              });
              killChild(child);
              return;
            }
            if (isTerminalSuccess(event.type, parsed)) {
              finish({ status: "succeeded" });
              killChild(child);
              return;
            }
            if (isTerminalFailure(event.type, parsed)) {
              finish({
                status: "failed",
                errorCode: String(parsed.error_code ?? parsed.code ?? "codex_failure"),
                errorMessage: String(parsed.error_message ?? parsed.message ?? "Codex app-server reported failure"),
              });
              killChild(child);
            }
          } catch (error) {
            finish({
              status: "failed",
              errorCode: "invalid_codex_json",
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            killChild(child);
          }
        })();
      });

      child.on("error", (error) => {
        finish({ status: "failed", errorCode: "codex_startup_failure", errorMessage: error.message });
      });

      child.on("exit", (code) => {
        if (!settled) {
          const err = stderr.join("").trim();
          finish(timeoutResult ?? {
            status: code === 0 ? "succeeded" : "failed",
            ...(code !== null ? { exitCode: code } : {}),
            ...(code === 0 ? {} : { errorCode: "codex_process_crash", errorMessage: err || `codex exited with ${code}` }),
          });
        }
      });
    });

    const send = (message: unknown) => child.stdin.write(jsonLine(message));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        model: this.config.model,
        approvalPolicy: this.config.approvalPolicy,
        sandboxPolicy: this.config.sandboxPolicy,
      },
    });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "turn.create",
      params: {
        prompt: input.prompt,
        runId: input.runId,
        attemptId: input.attemptId,
      },
    });

    const result = await final;
    return result;
  }
}

function killChild(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) {
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 1_000).unref();
}

export async function generateCodexProtocolTypes(command: string, outDir: string): Promise<boolean> {
  await mkdir(outDir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(`${command} generate-ts --out ${JSON.stringify(path.resolve(outDir))}`, {
      shell: true,
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
