import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentActor } from "./request-context.js";

const root = dirname(fileURLToPath(import.meta.url));
export const seedPath = join(root, "data", "seed.json");
const runtimeJsonPath = join(root, "data", "runtime.json");
const dbPath = process.env.DB_PATH || join(root, "data", "operations.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  );
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    record_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before TEXT,
    after TEXT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    reverted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tokens (provider TEXT PRIMARY KEY, payload TEXT NOT NULL);
`);

if (!db.prepare("PRAGMA table_info(history)").all().some((column) => column.name === "actor")) {
  db.exec("ALTER TABLE history ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'");
}

// Collections whose newest records come first (previously array unshift).
const NEWEST_FIRST = new Set(["outreach", "meetings", "documents", "strategies", "campaigns", "commsDrafts", "reports", "activity"]);

const statements = {
  all: db.prepare("SELECT data FROM records WHERE collection = ? ORDER BY rowid ASC"),
  allDesc: db.prepare("SELECT data FROM records WHERE collection = ? ORDER BY rowid DESC"),
  get: db.prepare("SELECT data FROM records WHERE collection = ? AND id = ?"),
  insert: db.prepare("INSERT INTO records (collection, id, data) VALUES (?, ?, ?)"),
  update: db.prepare("UPDATE records SET data = ? WHERE collection = ? AND id = ?"),
  remove: db.prepare("DELETE FROM records WHERE collection = ? AND id = ?"),
  count: db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection = ?"),
  oldest: db.prepare("SELECT id FROM records WHERE collection = ? ORDER BY rowid ASC LIMIT ?"),
  clear: db.prepare("DELETE FROM records"),
  kvGet: db.prepare("SELECT value FROM kv WHERE key = ?"),
  kvSet: db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  historyAdd: db.prepare("INSERT INTO history (collection, record_id, action, before, after, at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  historyLast: db.prepare("SELECT * FROM history WHERE reverted = 0 AND collection != 'activity' ORDER BY seq DESC LIMIT 1"),
  historyRevert: db.prepare("UPDATE history SET reverted = 1 WHERE seq = ?"),
  sessionGet: db.prepare("SELECT messages FROM sessions WHERE id = ?"),
  sessionSet: db.prepare("INSERT INTO sessions (id, messages, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at"),
  sessionDelete: db.prepare("DELETE FROM sessions WHERE id = ?"),
  tokenGet: db.prepare("SELECT payload FROM tokens WHERE provider = ?"),
  tokenSet: db.prepare("INSERT INTO tokens (provider, payload) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET payload = excluded.payload"),
  tokenDelete: db.prepare("DELETE FROM tokens WHERE provider = ?")
};

export function allRecords(collection) {
  const rows = (NEWEST_FIRST.has(collection) ? statements.allDesc : statements.all).all(collection);
  return rows.map((row) => JSON.parse(row.data));
}

export function getRecord(collection, id) {
  const row = statements.get.get(collection, id);
  return row ? JSON.parse(row.data) : null;
}

export function insertRecord(collection, record, { history = true } = {}) {
  statements.insert.run(collection, record.id, JSON.stringify(record));
  if (history) statements.historyAdd.run(collection, record.id, "create", null, JSON.stringify(record), new Date().toISOString(), currentActor());
  return record;
}

export function updateRecord(collection, id, record, before, { history = true } = {}) {
  statements.update.run(JSON.stringify(record), collection, id);
  if (history) statements.historyAdd.run(collection, id, "update", JSON.stringify(before), JSON.stringify(record), new Date().toISOString(), currentActor());
  return record;
}

export function deleteRecord(collection, id, { history = true } = {}) {
  const before = getRecord(collection, id);
  if (!before) return null;
  statements.remove.run(collection, id);
  if (history) statements.historyAdd.run(collection, id, "delete", JSON.stringify(before), null, new Date().toISOString(), currentActor());
  return before;
}

export function trimCollection(collection, max) {
  const count = statements.count.get(collection).n;
  if (count <= max) return;
  for (const row of statements.oldest.all(collection, count - max)) statements.remove.run(collection, row.id);
}

export function getKV(key, fallback = null) {
  const row = statements.kvGet.get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setKV(key, value) {
  statements.kvSet.run(key, JSON.stringify(value));
  return value;
}

export function lastUndoableChange() {
  return statements.historyLast.get() || null;
}

export function markReverted(seq) {
  statements.historyRevert.run(seq);
}

export function getSession(id) {
  const row = statements.sessionGet.get(id);
  return row ? JSON.parse(row.messages) : null;
}

export function saveSession(id, messages) {
  statements.sessionSet.run(id, JSON.stringify(messages), new Date().toISOString());
}

export function deleteSession(id) {
  statements.sessionDelete.run(id);
}

export function getToken(provider) {
  const row = statements.tokenGet.get(provider);
  return row ? JSON.parse(row.payload) : null;
}

export function saveToken(provider, payload) {
  statements.tokenSet.run(provider, JSON.stringify(payload));
}

export function deleteToken(provider) {
  statements.tokenDelete.run(provider);
}

export const transaction = (fn) => db.transaction(fn);

export function databaseReady() {
  return db.prepare("SELECT 1 AS ok").get().ok === 1;
}

export async function backupDatabase(destination) {
  db.pragma("wal_checkpoint(PASSIVE)");
  return db.backup(destination);
}

export function closeDatabase() {
  if (db.open) db.close();
}

function loadSeedState() {
  return JSON.parse(readFileSync(seedPath, "utf8"));
}

export const importState = db.transaction((state, { replace = false } = {}) => {
  if (replace) statements.clear.run();
  setKV("event", state.event);
  for (const [collection, records] of Object.entries(state)) {
    if (!Array.isArray(records)) continue;
    // Stored newest-first collections arrive newest-first in JSON; insert oldest first so rowid order matches age.
    const ordered = NEWEST_FIRST.has(collection) ? [...records].reverse() : records;
    for (const record of ordered) {
      if (!getRecord(collection, record.id)) insertRecord(collection, record, { history: false });
    }
  }
});

const seedState = loadSeedState();
export const COLLECTIONS = Object.keys(seedState).filter((key) => Array.isArray(seedState[key]));

// First boot: import legacy runtime.json (or the seed). Later boots: seed only
// collections that have never been seeded, so deleted records stay deleted.
function bootstrap() {
  const empty = db.prepare("SELECT COUNT(*) AS n FROM records").get().n === 0;
  const seeded = new Set(getKV("seededCollections", []));
  if (empty) {
    const legacy = existsSync(runtimeJsonPath) ? JSON.parse(readFileSync(runtimeJsonPath, "utf8")) : null;
    importState(legacy || seedState);
    if (legacy) {
      for (const key of COLLECTIONS) if (!(key in legacy)) importState({ event: legacy.event || seedState.event, [key]: seedState[key] });
    }
  } else {
    const missing = COLLECTIONS.filter((key) => !seeded.has(key));
    if (missing.length) importState({ event: getKV("event", seedState.event), ...Object.fromEntries(missing.map((key) => [key, seedState[key]])) });
  }
  setKV("seededCollections", COLLECTIONS);
}
bootstrap();

export function resetDatabase() {
  db.transaction(() => {
    statements.clear.run();
    db.prepare("DELETE FROM history").run();
    db.prepare("DELETE FROM sessions").run();
    importState(seedState, { replace: true });
    setKV("seededCollections", COLLECTIONS);
  })();
}
