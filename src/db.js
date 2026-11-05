// SQLite (node:sqlite) for the intake journal and the local contact index.
import { DatabaseSync } from 'node:sqlite';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS intakes (
      id INTEGER PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE, ghl_contact_id TEXT, status TEXT NOT NULL,
      received_at TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT, lead TEXT, match TEXT, plan TEXT,
      result TEXT, errors TEXT, deliveries INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS steps (
      intake_id INTEGER NOT NULL REFERENCES intakes(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      request TEXT, result_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, note TEXT,
      PRIMARY KEY (intake_id, seq));
    CREATE TABLE IF NOT EXISTS contacts_index (
      contact_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, first TEXT, last TEXT, first_canon TEXT, dob TEXT,
      email TEXT, suffix TEXT, company TEXT, source TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS contact_phones (contact_id INTEGER NOT NULL, phone TEXT NOT NULL, PRIMARY KEY (contact_id, phone));
    CREATE TABLE IF NOT EXISTS contact_lastnames (contact_id INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (contact_id, token));
    CREATE INDEX IF NOT EXISTS ci_dob ON contacts_index(dob);
    CREATE INDEX IF NOT EXISTS ci_email ON contacts_index(email);
    CREATE INDEX IF NOT EXISTS ci_company ON contacts_index(company);
    CREATE INDEX IF NOT EXISTS cp_phone ON contact_phones(phone);
    CREATE INDEX IF NOT EXISTS cl_token ON contact_lastnames(token);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

export const now = () => new Date().toISOString();
export const tx = (db, fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
export const meta = {
  get: (db, k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null,
  set: (db, k, v) => db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)),
};
