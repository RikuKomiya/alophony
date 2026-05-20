import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "success";
const rl = createInterface({ input: process.stdin });

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { thread_id: "thread_fake" }, type: "session_started" });
  }
  if (message.method === "turn.create") {
    write({ type: "turn_started", turn_id: "turn_fake" });
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
    write({ type: "turn_finished", status: "succeeded", thread_id: "thread_fake", turn_id: "turn_fake" });
    setTimeout(() => process.exit(0), 10);
  }
});
