// Версіоновані міграції поверх schema.sql: колонки, додані після першого
// релізу, накочуються тут, щоб не робити ручних ALTER на проді.
import { all, run, setting, isPostgres } from './db.js';

async function columnsOf(table) {
  const rows = isPostgres
    ? await all('SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?', table)
    : await all(`SELECT name FROM pragma_table_info('${table}')`);
  return new Set(rows.map((r) => r.name));
}

const migrations = [
  {
    id: '2026-09-16-clicks-context',
    async up() {
      const cols = await columnsOf('clicks');
      for (const [name, type] of [['geo', 'TEXT'], ['device', 'TEXT'], ['referer', 'TEXT']]) {
        if (!cols.has(name)) await run(`ALTER TABLE clicks ADD COLUMN ${name} ${type}`);
      }
    },
  },
  {
    // Таблиці scripts/script_steps створює сам schema.sql (CREATE TABLE IF
    // NOT EXISTS), а от нову колонку в наявній touches треба докотити ALTER'ом.
    id: '2026-09-17-touches-script',
    async up() {
      const cols = await columnsOf('touches');
      if (!cols.has('script_id')) await run('ALTER TABLE touches ADD COLUMN script_id INTEGER');
    },
  },
  {
    // service_package_items — нова таблиця, її створює сам schema.sql; а от
    // is_package у наявній services треба докотити ALTER'ом.
    id: '2026-09-18-services-is-package',
    async up() {
      const cols = await columnsOf('services');
      if (!cols.has('is_package')) await run('ALTER TABLE services ADD COLUMN is_package INTEGER NOT NULL DEFAULT 0');
    },
  },
];

export async function migrate() {
  const applied = new Set(String((await setting('migrations')) || '').split(',').filter(Boolean));
  const done = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await m.up();
    applied.add(m.id);
    done.push(m.id);
  }
  if (done.length) await setting('migrations', [...applied].join(','));
  return done;
}
