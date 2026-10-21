// Banco SQLite (node:sqlite, sem dependência nativa). Guarda contas, sessões e a lista de cofres.
// O conteúdo dos cofres fica em arquivos comuns em DATA_DIR/vaults/<id>/ (backup = copiar a pasta).
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
  `create table users (
     id text primary key,
     email text not null unique,
     name text not null,
     pass_hash text not null,
     created_at integer not null
   );
   create table sessions (
     token_hash text primary key,
     user_id text not null references users(id) on delete cascade,
     created_at integer not null,
     expires_at integer not null
   );
   create index sessions_user on sessions(user_id);
   create table vaults (
     id text primary key,
     owner_id text not null references users(id) on delete cascade,
     name text not null,
     created_at integer not null,
     updated_at integer not null,
     snapshot_at integer not null default 0
   );
   create index vaults_owner on vaults(owner_id);`,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "mathsidian.db"));
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec("create table if not exists schema_version (version integer not null)");
  const row = db.prepare("select version from schema_version").get();
  let version = row ? row.version : 0;
  if (!row) db.prepare("insert into schema_version (version) values (0)").run();
  for (; version < MIGRATIONS.length; version++) {
    db.exec("begin");
    try {
      db.exec(MIGRATIONS[version]);
      db.prepare("update schema_version set version = ?").run(version + 1);
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  }
  return db;
}
