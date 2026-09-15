// Перенесення даних із SQLite у Postgres: схема створюється тим самим кодом,
// що й у застосунку, далі таблиці в порядку залежностей і оновлення лічильників.
//
//   CRM_DB=./data/crm.db CRM_DATABASE_URL=postgres://... node scripts/migrate-sqlite-to-pg.js
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = process.env.CRM_DB || path.join(here, '..', 'data', 'crm.db');
if (!process.env.CRM_DATABASE_URL) throw new Error('Задайте CRM_DATABASE_URL (куди переносимо)');

// db.js сам обере драйвер Postgres, бо CRM_DATABASE_URL заданий.
const { initSchema, run, close, isPostgres } = await import('../src/db.js');
if (!isPostgres) throw new Error('Ціль не Postgres — перевірте CRM_DATABASE_URL');

const ORDER = [
  'teams', 'users', 'sessions', 'devices', 'sims', 'proxies', 'mail_accounts', 'accounts',
  'account_events', 'resource_assignments', 'partners', 'offers', 'offer_rates_history',
  'creatives', 'creative_versions', 'tasks', 'posts', 'tracking_links', 'clicks', 'conversions',
  'expenses', 'salary_rules', 'payouts', 'kpi_targets', 'credentials', 'credential_grants',
  'access_requests', 'roles', 'role_permissions', 'audit_log', 'notifications', 'settings',
];

const sqlite = new DatabaseSync(source, { readOnly: true });
await initSchema();

let total = 0;
for (const table of ORDER) {
  let rows;
  try { rows = sqlite.prepare(`SELECT * FROM ${table}`).all(); } catch { continue; }
  if (!rows.length) continue;
  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(() => '?').join(',');
  for (const row of rows) {
    await run(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      ...cols.map((c) => row[c]),
    );
  }
  // Лічильник identity не знає про перенесені id — підтягуємо вручну.
  if (cols.includes('id')) {
    await run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`)
      .catch(() => {});
  }
  console.log(`${table}: ${rows.length}`);
  total += rows.length;
}

console.log(`Перенесено рядків: ${total}`);
sqlite.close();
await close();
