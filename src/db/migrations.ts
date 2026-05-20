import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DbClient } from "./client.js";
import { nowIso } from "../util/time.js";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(client: DbClient, migrationsDir: string): Promise<MigrationResult> {
  const resolved = path.resolve(migrationsDir);
  const files = (await readdir(resolved))
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  const applied: string[] = [];
  const skipped: string[] = [];

  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const existing = await client.execute({
      sql: "SELECT version FROM schema_migrations WHERE version = ?",
      args: [version],
    });
    if (existing.rows.length > 0) {
      skipped.push(version);
      continue;
    }
    const sql = await readFile(path.join(resolved, file), "utf8");
    const tx = await client.transaction("write");
    try {
      await tx.executeMultiple(sql);
      await tx.execute({
        sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        args: [version, nowIso()],
      });
      await tx.commit();
      applied.push(version);
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
  return { applied, skipped };
}
