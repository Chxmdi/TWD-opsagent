import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backupDatabase } from "./db.js";

export async function runBackup() {
  const directory = process.env.BACKUP_DIR;
  if (!directory) return null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(directory, `operations-${timestamp}.db`);
  await backupDatabase(destination);
  chmodSync(destination, 0o600);
  const retention = Math.max(2, Number(process.env.BACKUP_RETENTION_DAYS || 14));
  const cutoff = Date.now() - retention * 86400000;
  for (const name of readdirSync(directory).filter((item) => /^operations-.*\.db$/.test(item))) {
    const match = name.match(/^operations-(\d{4}-\d{2}-\d{2})/);
    if (match && new Date(match[1]).getTime() < cutoff) rmSync(join(directory, name), { force: true });
  }
  return destination;
}
