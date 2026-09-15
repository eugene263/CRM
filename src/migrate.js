// Версіоновані міграції поверх schema.sql: колонки, додані після першого
// релізу, накочуються тут, щоб не робити ручних ALTER на проді.
import { db, all, run, setting } from './db.js';

const migrations = [
  {
    id: '2026-09-16-clicks-context',
    up() {
      const cols = new Set(all("SELECT name FROM pragma_table_info('clicks')").map((c) => c.name));
      for (const [name, type] of [['geo', 'TEXT'], ['device', 'TEXT'], ['referer', 'TEXT']]) {
        if (!cols.has(name)) run(`ALTER TABLE clicks ADD COLUMN ${name} ${type}`);
      }
    },
  },
];

export function migrate() {
  const applied = new Set(String(setting('migrations') || '').split(',').filter(Boolean));
  const done = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    m.up(db);
    applied.add(m.id);
    done.push(m.id);
  }
  if (done.length) setting('migrations', [...applied].join(','));
  return done;
}
