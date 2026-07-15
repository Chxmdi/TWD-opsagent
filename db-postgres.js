import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { currentActor } from "./request-context.js";

const { Pool } = pg;
const root = dirname(fileURLToPath(import.meta.url));
export const seedPath = join(root, "data", "seed.json");
const seedState = JSON.parse(readFileSync(seedPath, "utf8"));
export const COLLECTIONS = Object.keys(seedState).filter((key) => Array.isArray(seedState[key]));
const NEWEST_FIRST = new Set(["outreach", "meetings", "documents", "strategies", "campaigns", "commsDrafts", "reports", "activity"]);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Math.max(1, Number(process.env.PG_POOL_MAX || 3)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000
});

const records = new Map();
const kv = new Map();
const history = [];
const sessions = new Map();
const tokens = new Map();
let recordSeq = 0;
let historySeq = 0;
let initialized = false;
let persistentError = null;
let writeTail = Promise.resolve();
let suppressWrites = false;

function collectionMap(collection) {
  if (!records.has(collection)) records.set(collection, new Map());
  return records.get(collection);
}

function queueWrite(operation) {
  if (suppressWrites) return;
  writeTail = writeTail.then(async () => {
    try {
      await operation();
    } catch (error) {
      persistentError ||= error;
      console.error(JSON.stringify({ level: "error", event: "database_write_error", message: error.message }));
    }
  });
}

function addHistory(collection, recordId, action, before, after) {
  const entry = {
    seq: ++historySeq,
    collection,
    record_id: recordId,
    action,
    before: before === null ? null : JSON.stringify(before),
    after: after === null ? null : JSON.stringify(after),
    at: new Date().toISOString(),
    actor: currentActor(),
    reverted: 0
  };
  history.push(entry);
  queueWrite(() => pool.query(
    `INSERT INTO history (seq, collection, record_id, action, before_data, after_data, at, actor, reverted)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
    [entry.seq, collection, recordId, action, entry.before, entry.after, entry.at, entry.actor, false]
  ));
}

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data JSONB NOT NULL,
      seq BIGINT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS records_collection_seq_idx ON records (collection, seq);
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      seq BIGINT PRIMARY KEY,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_data JSONB,
      after_data JSONB,
      at TIMESTAMPTZ NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      reverted BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      messages JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      provider TEXT PRIMARY KEY,
      payload JSONB NOT NULL
    );
  `);
}

async function loadCache() {
  const [recordRows, kvRows, historyRows, sessionRows, tokenRows] = await Promise.all([
    pool.query("SELECT collection, id, data, seq FROM records ORDER BY seq ASC"),
    pool.query("SELECT key, value FROM kv"),
    pool.query("SELECT seq, collection, record_id, action, before_data, after_data, at, actor, reverted FROM history ORDER BY seq ASC"),
    pool.query("SELECT id, messages, updated_at FROM sessions"),
    pool.query("SELECT provider, payload FROM tokens")
  ]);
  for (const row of recordRows.rows) {
    const seq = Number(row.seq);
    recordSeq = Math.max(recordSeq, seq);
    collectionMap(row.collection).set(row.id, { data: row.data, seq });
  }
  for (const row of kvRows.rows) kv.set(row.key, row.value);
  for (const row of historyRows.rows) {
    const entry = {
      seq: Number(row.seq),
      collection: row.collection,
      record_id: row.record_id,
      action: row.action,
      before: row.before_data === null ? null : JSON.stringify(row.before_data),
      after: row.after_data === null ? null : JSON.stringify(row.after_data),
      at: new Date(row.at).toISOString(),
      actor: row.actor,
      reverted: row.reverted ? 1 : 0
    };
    historySeq = Math.max(historySeq, entry.seq);
    history.push(entry);
  }
  for (const row of sessionRows.rows) sessions.set(row.id, row.messages);
  for (const row of tokenRows.rows) tokens.set(row.provider, row.payload);
}

export function allRecords(collection) {
  const values = [...collectionMap(collection).values()].sort((a, b) => a.seq - b.seq);
  if (NEWEST_FIRST.has(collection)) values.reverse();
  return values.map((entry) => entry.data);
}

export function getRecord(collection, id) {
  return collectionMap(collection).get(id)?.data || null;
}

export function insertRecord(collection, record, { history: trackHistory = true } = {}) {
  const target = collectionMap(collection);
  if (target.has(record.id)) throw new Error(`Record already exists: ${collection}/${record.id}`);
  const seq = ++recordSeq;
  target.set(record.id, { data: record, seq });
  queueWrite(() => pool.query(
    "INSERT INTO records (collection, id, data, seq) VALUES ($1, $2, $3::jsonb, $4)",
    [collection, record.id, JSON.stringify(record), seq]
  ));
  if (trackHistory) addHistory(collection, record.id, "create", null, record);
  return record;
}

export function updateRecord(collection, id, record, before, { history: trackHistory = true } = {}) {
  const target = collectionMap(collection);
  const existing = target.get(id);
  if (!existing) return null;
  target.set(id, { data: record, seq: existing.seq });
  queueWrite(() => pool.query(
    "UPDATE records SET data = $1::jsonb WHERE collection = $2 AND id = $3",
    [JSON.stringify(record), collection, id]
  ));
  if (trackHistory) addHistory(collection, id, "update", before, record);
  return record;
}

export function deleteRecord(collection, id, { history: trackHistory = true } = {}) {
  const target = collectionMap(collection);
  const before = target.get(id)?.data || null;
  if (!before) return null;
  target.delete(id);
  queueWrite(() => pool.query("DELETE FROM records WHERE collection = $1 AND id = $2", [collection, id]));
  if (trackHistory) addHistory(collection, id, "delete", before, null);
  return before;
}

export function trimCollection(collection, max) {
  const target = collectionMap(collection);
  const excess = [...target.entries()].sort((a, b) => a[1].seq - b[1].seq).slice(0, Math.max(0, target.size - max));
  if (!excess.length) return;
  for (const [id] of excess) target.delete(id);
  const ids = excess.map(([id]) => id);
  queueWrite(() => pool.query("DELETE FROM records WHERE collection = $1 AND id = ANY($2::text[])", [collection, ids]));
}

export function getKV(key, fallback = null) {
  return kv.has(key) ? kv.get(key) : fallback;
}

export function setKV(key, value) {
  kv.set(key, value);
  queueWrite(() => pool.query(
    `INSERT INTO kv (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  ));
  return value;
}

export function lastUndoableChange() {
  return [...history].reverse().find((entry) => !entry.reverted && entry.collection !== "activity") || null;
}

export function markReverted(seq) {
  const entry = history.find((item) => item.seq === Number(seq));
  if (entry) entry.reverted = 1;
  queueWrite(() => pool.query("UPDATE history SET reverted = TRUE WHERE seq = $1", [seq]));
}

export function getSession(id) {
  return sessions.get(id) || null;
}

export function saveSession(id, messages) {
  sessions.set(id, messages);
  queueWrite(() => pool.query(
    `INSERT INTO sessions (id, messages, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET messages = EXCLUDED.messages, updated_at = NOW()`,
    [id, JSON.stringify(messages)]
  ));
}

export function deleteSession(id) {
  sessions.delete(id);
  queueWrite(() => pool.query("DELETE FROM sessions WHERE id = $1", [id]));
}

// Auth sessions and OAuth tokens store a numeric expiresAt; agent
// conversation histories are arrays and are never expired here.
export function deleteExpiredSessions(now = Date.now()) {
  const expired = [...sessions.entries()].filter(([, messages]) => {
    const expiresAt = Number(messages?.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt < now;
  }).map(([id]) => id);
  for (const id of expired) sessions.delete(id);
  if (expired.length) queueWrite(() => pool.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [expired]));
  return expired.length;
}

export function getToken(provider) {
  return tokens.get(provider) || null;
}

export function saveToken(provider, payload) {
  tokens.set(provider, payload);
  queueWrite(() => pool.query(
    `INSERT INTO tokens (provider, payload) VALUES ($1, $2::jsonb)
     ON CONFLICT (provider) DO UPDATE SET payload = EXCLUDED.payload`,
    [provider, JSON.stringify(payload)]
  ));
}

export function deleteToken(provider) {
  tokens.delete(provider);
  queueWrite(() => pool.query("DELETE FROM tokens WHERE provider = $1", [provider]));
}

export const transaction = (fn) => fn;

export function databaseReady() {
  return initialized && !persistentError;
}

export async function flushDatabase() {
  await writeTail;
  if (persistentError) throw persistentError;
}

export async function backupDatabase(destination) {
  await flushDatabase();
  const payload = {
    format: "wealth-dojo-postgres-backup-v1",
    createdAt: new Date().toISOString(),
    records: [...records.entries()].flatMap(([collection, items]) => [...items.entries()].map(([id, entry]) => ({ collection, id, data: entry.data, seq: entry.seq }))),
    kv: [...kv.entries()].map(([key, value]) => ({ key, value })),
    history
  };
  writeFileSync(destination, JSON.stringify(payload));
  return destination;
}

export async function closeDatabase() {
  await flushDatabase();
  await pool.end();
}

export function importState(state, { replace = false } = {}) {
  if (replace) {
    records.clear();
    queueWrite(() => pool.query("DELETE FROM records"));
  }
  if (state.event) setKV("event", state.event);
  for (const [collection, items] of Object.entries(state)) {
    if (!Array.isArray(items)) continue;
    const ordered = NEWEST_FIRST.has(collection) ? [...items].reverse() : items;
    for (const record of ordered) if (!getRecord(collection, record.id)) insertRecord(collection, record, { history: false });
  }
}

function queueSnapshotReplace({ clearSecurity = false } = {}) {
  const recordSnapshot = [...records.entries()].flatMap(([collection, items]) => [...items.entries()].map(([id, entry]) => ({ collection, id, data: entry.data, seq: entry.seq })));
  const kvSnapshot = [...kv.entries()].map(([key, value]) => ({ key, value }));
  queueWrite(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(clearSecurity
        ? "TRUNCATE records, kv, history, sessions, tokens"
        : "TRUNCATE records, kv, history");
      if (recordSnapshot.length) {
        await client.query(
          `INSERT INTO records (collection, id, data, seq)
           SELECT collection, id, data, seq
           FROM jsonb_to_recordset($1::jsonb)
             AS item(collection TEXT, id TEXT, data JSONB, seq BIGINT)`,
          [JSON.stringify(recordSnapshot)]
        );
      }
      if (kvSnapshot.length) {
        await client.query(
          `INSERT INTO kv (key, value)
           SELECT key, value
           FROM jsonb_to_recordset($1::jsonb)
             AS item(key TEXT, value JSONB)`,
          [JSON.stringify(kvSnapshot)]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export function resetDatabase() {
  suppressWrites = true;
  records.clear();
  kv.clear();
  history.length = 0;
  sessions.clear();
  tokens.clear();
  recordSeq = 0;
  historySeq = 0;
  importState(seedState, { replace: true });
  setKV("seededCollections", COLLECTIONS);
  suppressWrites = false;
  queueSnapshotReplace({ clearSecurity: true });
}

function bootstrapCache() {
  const empty = [...records.values()].every((items) => items.size === 0);
  const seeded = new Set(getKV("seededCollections", []));
  if (empty) {
    suppressWrites = true;
    importState(seedState);
    setKV("seededCollections", COLLECTIONS);
    suppressWrites = false;
    queueSnapshotReplace();
  } else {
    const missing = COLLECTIONS.filter((key) => !seeded.has(key));
    if (missing.length) importState({ event: getKV("event", seedState.event), ...Object.fromEntries(missing.map((key) => [key, seedState[key]])) });
    setKV("seededCollections", COLLECTIONS);
  }
}

await createSchema();
await loadCache();
initialized = true;
bootstrapCache();
await flushDatabase();

export function databaseMode() {
  return "postgres";
}
