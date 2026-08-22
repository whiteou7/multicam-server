import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env";

const dbDir = path.dirname(env.dbPath);
fs.mkdirSync(dbDir, { recursive: true });

export const db = new Database(env.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

// CREATE TABLE IF NOT EXISTS above won't add columns to a devices table that
// already existed from before these columns were introduced (e.g. a local dev
// sqlite file created by an earlier version of this schema).
const DEVICE_COLUMN_MIGRATIONS: Array<{ name: string; ddl: string }> = [
  { name: "push_token", ddl: "ALTER TABLE devices ADD COLUMN push_token TEXT" },
  { name: "push_devtype", ddl: "ALTER TABLE devices ADD COLUMN push_devtype INTEGER" },
  {
    name: "session_revoked",
    ddl: "ALTER TABLE devices ADD COLUMN session_revoked INTEGER NOT NULL DEFAULT 0",
  },
];
const existingColumns = new Set(
  (db.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name)
);
for (const migration of DEVICE_COLUMN_MIGRATIONS) {
  if (!existingColumns.has(migration.name)) {
    db.exec(migration.ddl);
  }
}
