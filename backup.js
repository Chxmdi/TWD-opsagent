import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backupDatabase, databaseMode } from "./db.js";

export async function runBackup() {
  const directory = process.env.BACKUP_DIR;
  if (!directory) return null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = databaseMode() === "postgres" ? "json" : "db";
  const destination = join(directory, `operations-${timestamp}.${extension}`);
  await backupDatabase(destination);
  chmodSync(destination, 0o600);
  const retention = Math.max(2, Number(process.env.BACKUP_RETENTION_DAYS || 14));
  const cutoff = Date.now() - retention * 86400000;
  for (const name of readdirSync(directory).filter((item) => /^operations-.*\.(db|json)$/.test(item))) {
    const match = name.match(/^operations-(\d{4}-\d{2}-\d{2})/);
    if (match && new Date(match[1]).getTime() < cutoff) rmSync(join(directory, name), { force: true });
  }
  return destination;
}
