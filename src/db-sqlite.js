// Драйвер SQLite: локальний запуск і малі команди. Синхронний під капотом,
// але назовні дає ту саму async-сигнатуру, що й Postgres.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.CRM_DB || path.join(here, '..', 'data', 'crm.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

export const engine = 'sqlite';
export const location = file;
export const raw = new DatabaseSync(file);

export async function exec(sql) { raw.exec(sql); }
export async function all(sql, ...params) { return raw.prepare(sql).all(...params).map((r) => ({ ...r })); }
export async function get(sql, ...params) {
  const row = raw.prepare(sql).get(...params);
  return row ? { ...row } : null;
}
export async function run(sql, ...params) {
  const res = raw.prepare(sql).run(...params);
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}
export async function close() { raw.close(); }
