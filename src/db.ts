import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  account_id        TEXT PRIMARY KEY,
  platform          TEXT NOT NULL,
  account_type      TEXT NOT NULL,
  environment       TEXT NOT NULL,
  owner             TEXT NOT NULL,
  status            TEXT NOT NULL,
  connection_status TEXT NOT NULL,
  connected_assets  TEXT NOT NULL DEFAULT '[]',
  permissions       TEXT NOT NULL DEFAULT '[]',
  last_health_check TEXT,
  notes             TEXT NOT NULL DEFAULT '',
  credential_ref_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS health_checks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  checked_at        TEXT NOT NULL,
  check_day         TEXT NOT NULL,
  account_status    TEXT NOT NULL,
  connection_status TEXT NOT NULL,
  token_valid       INTEGER,
  token_expires_at  TEXT,
  connected_assets  TEXT NOT NULL DEFAULT '[]',
  permissions       TEXT NOT NULL DEFAULT '[]',
  healthy           INTEGER NOT NULL,
  anomalies         TEXT NOT NULL DEFAULT '[]',
  message           TEXT NOT NULL DEFAULT '',
  attempts          INTEGER NOT NULL DEFAULT 1,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  run_mode          TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_hc_account ON health_checks(account_id);
CREATE INDEX IF NOT EXISTS idx_hc_day ON health_checks(check_day);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hc_account_day ON health_checks(account_id, check_day);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  action     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  at         TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log(account_id);
`;

/**
 * Open (or create) the database at the given path and ensure the schema exists.
 * Use ":memory:" for tests.
 */
export function openDb(path: string): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
