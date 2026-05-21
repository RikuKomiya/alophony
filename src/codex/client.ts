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
  signal?: AbortSignal | undefined;
}

export interface CodexNormalizedEvent {
  type: string;
  message?: string;
  payload: unknown;
  codexThreadId?: string;
  codexTurnId?: string;
}

export interface CodexRunResult {
  status: "succeeded" | "failed" | "timed_out" | "needs_input" | "canceled";
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
  return String(raw).replace(/[./-]/g, "_");
}

function normalizedEvent(value: Record<string, unknown>): CodexNormalizedEvent {
  const type = eventType(value);
  const result = typeof value.result === "object" && value.result !== null ? (value.result as Record<string, unknown>) : {};
  const params = typeof value.params === "object" && value.params !== null ? (value.params as Record<string, unknown>) : {};
  const threadObject = typeof result.thread === "object" && result.thread !== null
    ? result.thread as Record<string, unknown>
    : typeof params.thread === "object" && params.thread !== null
      ? params.thread as Record<string, unknown>
      : {};
  const turnObject = typeof result.turn === "object" && result.turn !== null
    ? result.turn as Record<string, unknown>
    : typeof params.turn === "object" && params.turn !== null
      ? params.turn as Record<string, unknown>
      : {};
  const payload = { ...value };
  const thread = value.thread_id ?? value.threadId ?? result.thread_id ?? result.threadId ?? params.thread_id ?? params.threadId ?? threadObject.id;
  const turn = value.turn_id ?? value.turnId ?? result.turn_id ?? result.turnId ?? params.turn_id ?? params.turnId ?? turnObject.id;
  return {
    type,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    payload,
    ...(typeof thread === "string" ? { codexThreadId: thread } : {}),
    ...(typeof turn === "string" ? { codexTurnId: turn } : {}),
  };
}

function isTerminalSuccess(type: string, payload: Record<string, unknown>): boolean {
  const status = payload.status ?? turnStatus(payload);
  return ["turn_finished", "turn_completed", "session_finished", "completed", "done", "succeeded"].includes(type)
    || status === "succeeded"
    || status === "completed";
}

function isTerminalFailure(type: string, payload: Record<string, unknown>): boolean {
  const status = payload.status ?? turnStatus(payload);
  return ["session_failed", "turn_failed", "failed", "error"].includes(type) || Boolean(payload.error) || status === "failed";
}

function isNeedsInput(type: string): boolean {
  return type === "user_input_requested" || type === "input_required" || type === "needs_input";
}

function turnStatus(payload: Record<string, unknown>): unknown {
  const params = typeof payload.params === "object" && payload.params !== null ? payload.params as Record<string, unknown> : {};
  const turn = typeof params.turn === "object" && params.turn !== null ? params.turn as Record<string, unknown> : {};
  return turn.status;
}

function errorMessage(payload: Record<string, unknown>): string {
  const error = typeof payload.error === "object" && payload.error !== null ? payload.error as Record<string, unknown> : {};
  return String(payload.error_message ?? payload.message ?? error.message ?? "Codex app-server reported failure");
}

function errorCode(payload: Record<string, unknown>): string {
  const error = typeof payload.error === "object" && payload.error !== null ? payload.error as Record<string, unknown> : {};
  return String(payload.error_code ?? payload.code ?? error.code ?? "codex_failure");
}

export class CodexAppServerClient {
  constructor(private readonly config: AlophonyConfig["codex"]) {}

  async run(input: CodexRunInput, sink: CodexEventSink): Promise<CodexRunResult> {
    await mkdir(input.workspacePath, { recursive: true });
    if (input.signal?.aborted) {
      return {
        status: "canceled",
        errorCode: "canceled",
        errorMessage: "Codex run canceled before start",
      };
    }
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
    let turnStarted = false;

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
      let abort: (() => void) | undefined;
      const finish = (result: CodexRunResult) => {
        if (settled && result.status !== "timed_out") {
          return;
        }
        settled = true;
        clearTimeout(startupTimer);
        clearTimeout(turnTimer);
        clearInterval(idleTimer);
        if (abort) {
          input.signal?.removeEventListener("abort", abort);
        }
        resolve({
          ...result,
          ...(processPid ? { processPid } : {}),
          ...(codexThreadId ? { codexThreadId } : {}),
          ...(codexTurnId ? { codexTurnId } : {}),
        });
      };
      abort = () => {
        finish({
          status: "canceled",
          errorCode: "canceled",
          errorMessage: "Codex run canceled",
        });
        killChild(child);
      };

      input.signal?.addEventListener("abort", abort, { once: true });

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
            if (Number(parsed.id) === 1 && !codexThreadId) {
              send({ jsonrpc: "2.0", method: "initialized", params: {} });
              send({
                jsonrpc: "2.0",
                id: 2,
                method: "thread/start",
                params: {
                  cwd: input.workspacePath,
                  model: this.config.model ?? null,
                  approvalPolicy: this.config.approvalPolicy,
                  sandbox: this.config.sandboxPolicy,
                  ephemeral: true,
                  sessionStartSource: "startup",
                },
              });
            }
            if (codexThreadId && !turnStarted && (Number(parsed.id) === 2 || event.type === "thread_started")) {
              turnStarted = true;
              send({
                jsonrpc: "2.0",
                id: 3,
                method: "turn/start",
                params: {
                  threadId: codexThreadId,
                  input: [{ type: "text", text: input.prompt }],
                  cwd: input.workspacePath,
                  approvalPolicy: this.config.approvalPolicy,
                  model: this.config.model ?? null,
                },
              });
            }
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
                errorCode: errorCode(parsed),
                errorMessage: errorMessage(parsed),
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
        clientInfo: {
          name: "alophony",
          title: "Alophony",
          version: "0.1.0",
        },
        capabilities: null,
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
