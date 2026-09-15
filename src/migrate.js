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
