import { Database } from "bun:sqlite";
import { config } from "../config";
import { migrations } from "./migrations";

export type DB = Database;

function open(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Database) {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  let version = row?.user_version ?? 0;
  for (let i = version; i < migrations.length; i++) {
    const step = migrations[i]!;
    db.transaction(() => {
      db.exec(step);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
    version = i + 1;
  }
}

export const db = open(config.dbPath);

export function now(): number {
  return Date.now();
}
