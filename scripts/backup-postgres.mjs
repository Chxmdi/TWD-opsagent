import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const directory = process.env.BACKUP_OUTPUT_DIR || "backups";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = join(directory, `operations-${timestamp}.json`);

try {
  const [records, kv, history] = await Promise.all([
    pool.query("SELECT collection, id, data, seq FROM records ORDER BY seq ASC"),
    pool.query("SELECT key, value FROM kv ORDER BY key ASC"),
    pool.query("SELECT seq, collection, record_id, action, before_data, after_data, at, actor, reverted FROM history ORDER BY seq ASC")
  ]);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(destination, JSON.stringify({
    format: "wealth-dojo-postgres-backup-v1",
    createdAt: new Date().toISOString(),
    records: records.rows,
    kv: kv.rows,
    history: history.rows
  }));
  chmodSync(destination, 0o600);
  console.log(`Backup completed: ${destination}`);
} finally {
  await pool.end();
}
