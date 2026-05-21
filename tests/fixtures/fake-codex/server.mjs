import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "success";
const rl = createInterface({ input: process.stdin });

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { userAgent: "fake-codex", platformFamily: "unix", platformOs: "test" } });
  }
  if (message.method === "thread/start") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        thread: { id: "thread_fake" },
        model: "fake",
        modelProvider: "fake",
        serviceTier: null,
        cwd: process.cwd(),
      },
    });
    write({ method: "thread/started", params: { thread: { id: "thread_fake" } } });
  }
  if (message.method === "turn/start" || message.method === "turn.create") {
    write({ method: "turn/started", params: { threadId: "thread_fake", turn: { id: "turn_fake" } } });
    write({ type: "assistant_message", message: "working" });
    if (mode === "needs-input") {
      write({ type: "user_input_requested", message: "input required" });
      setTimeout(() => process.exit(0), 10);
      return;
    }
    if (mode === "fail") {
      write({ type: "session_failed", error_code: "codex_process_crash", message: "failed intentionally" });
      setTimeout(() => process.exit(1), 10);
      return;
    }
    if (mode === "slow") {
      setTimeout(() => {
        write({ method: "turn/completed", params: { threadId: "thread_fake", turn: { id: "turn_fake", status: "completed" } } });
        setTimeout(() => process.exit(0), 10);
      }, 500);
      return;
    }
    write({ method: "turn/completed", params: { threadId: "thread_fake", turn: { id: "turn_fake", status: "completed" } } });
    setTimeout(() => process.exit(0), 10);
  }
});
