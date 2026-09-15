// Обгортка над node:sqlite. Дані фінансів/ресурсів — тут; кліки та конверсії
// винесені в окремі таблиці, щоб при рості обсягів їх можна було перевезти
// в ClickHouse без зміни решти коду (див. README, розділ «Масштабування»).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.CRM_DB || path.join(here, '..', 'data', 'crm.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

export const all = (sql, ...params) => db.prepare(sql).all(...params).map((r) => ({ ...r }));
export const get = (sql, ...params) => {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : null;
};
export const run = (sql, ...params) => db.prepare(sql).run(...params);
export const dbFile = dbPath;

export function insert(table, data) {
  const keys = Object.keys(data);
  if (!keys.length) throw new Error('empty insert');
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  const res = run(sql, ...keys.map((k) => data[k]));
  return Number(res.lastInsertRowid);
}

export function update(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`;
  return Number(run(sql, ...keys.map((k) => data[k]), id).changes);
}

export function remove(table, id) {
  return Number(run(`DELETE FROM ${table} WHERE id=?`, id).changes);
}

export function audit({ user_id = null, action, entity = null, entity_id = null, payload = null, ip = null }) {
  insert('audit_log', {
    user_id, action, entity, entity_id,
    payload: payload ? JSON.stringify(payload).slice(0, 4000) : null,
    ip,
  });
}

export function setting(key, value) {
  if (value === undefined) return get('SELECT value FROM settings WHERE key=?', key)?.value ?? null;
  run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
  return value;
}
