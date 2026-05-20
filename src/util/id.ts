import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function shortHash(value: string, length = 8): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
