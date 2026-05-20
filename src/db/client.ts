import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AlophonyConfig } from "../config/schema.js";

export type DbClient = Client;

export function createDbClient(config: AlophonyConfig["database"]): DbClient {
  ensureLocalFileParent(config.url);
  return createClient({
    url: config.url,
    ...(config.authToken ? { authToken: config.authToken } : {}),
  });
}

function ensureLocalFileParent(url: string): void {
  if (!url.startsWith("file:") || url === "file::memory:") {
    return;
  }
  const filePath = url.slice("file:".length);
  const dir = path.dirname(filePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
}
