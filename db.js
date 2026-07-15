const backend = process.env.DATABASE_URL
  ? await import("./db-postgres.js")
  : await import("./db-sqlite.js");

export const seedPath = backend.seedPath;
export const COLLECTIONS = backend.COLLECTIONS;
export const allRecords = (...args) => backend.allRecords(...args);
export const getRecord = (...args) => backend.getRecord(...args);
export const insertRecord = (...args) => backend.insertRecord(...args);
export const updateRecord = (...args) => backend.updateRecord(...args);
export const deleteRecord = (...args) => backend.deleteRecord(...args);
export const trimCollection = (...args) => backend.trimCollection(...args);
export const getKV = (...args) => backend.getKV(...args);
export const setKV = (...args) => backend.setKV(...args);
export const lastUndoableChange = (...args) => backend.lastUndoableChange(...args);
export const markReverted = (...args) => backend.markReverted(...args);
export const getSession = (...args) => backend.getSession(...args);
export const saveSession = (...args) => backend.saveSession(...args);
export const deleteSession = (...args) => backend.deleteSession(...args);
export const getToken = (...args) => backend.getToken(...args);
export const saveToken = (...args) => backend.saveToken(...args);
export const deleteToken = (...args) => backend.deleteToken(...args);
export const transaction = (...args) => backend.transaction(...args);
export const databaseReady = (...args) => backend.databaseReady(...args);
export const backupDatabase = (...args) => backend.backupDatabase(...args);
export const closeDatabase = (...args) => backend.closeDatabase(...args);
export const flushDatabase = (...args) => backend.flushDatabase(...args);
export const databaseMode = (...args) => backend.databaseMode(...args);
export const importState = (...args) => backend.importState(...args);
export const resetDatabase = (...args) => backend.resetDatabase(...args);
