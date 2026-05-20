import { spawn } from "node:child_process";

export function firstCommandToken(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.split(/\s+/)[0] ?? "";
}

export async function commandExists(command: string): Promise<boolean> {
  const token = firstCommandToken(command);
  if (!token) {
    return false;
  }
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${JSON.stringify(token)}`], {
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export function redactSecret(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
