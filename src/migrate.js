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
  {
    id: '2026-09-19-leads-expected-amount',
    async up() {
      const cols = await columnsOf('leads');
      if (!cols.has('expected_amount')) await run('ALTER TABLE leads ADD COLUMN expected_amount REAL');
    },
  },
  {
    // Ставки переїжджають зі спільного довідника всередину своєї послуги.
    // Наявні рядки отримують власні одиницю й ставку — ті самі числа, що
    // досі підтягувались із cost_rates, щоб собівартість і маржа не
    // стрибнули. Накладні, які були глобальним відсотком, стають окремим
    // рядком у кожній послузі.
    id: '2026-09-20-cost-rates-into-services',
    async up() {
      const cols = await columnsOf('service_cost_items');
      if (!cols.has('unit')) await run(`ALTER TABLE service_cost_items ADD COLUMN unit TEXT NOT NULL DEFAULT 'шт'`);
      if (!cols.has('is_active')) await run('ALTER TABLE service_cost_items ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');

      const rates = await all('SELECT code, name, kind, unit, amount FROM cost_rates');
      const byCode = Object.fromEntries(rates.map((r) => [r.code, r]));
      for (const item of await all('SELECT id, rate_code, unit_cost FROM service_cost_items')) {
        const rate = item.rate_code ? byCode[item.rate_code] : null;
        const unitCost = item.unit_cost != null ? Number(item.unit_cost) : Number(rate?.amount || 0);
        await run('UPDATE service_cost_items SET unit=?, unit_cost=? WHERE id=?',
          rate?.unit || 'шт', unitCost, item.id);
      }

      // Глобальні накладні були відсотком від прямих витрат — тепер це
      // звичайний рядок типу overhead усередині кожної послуги, де є з чого
      // їх рахувати.
      const overhead = byCode.overhead;
      if (overhead && Number(overhead.amount) > 0) {
        const services = await all(
          `SELECT DISTINCT service_id AS id FROM service_cost_items WHERE kind <> 'overhead'`);
        for (const s of services) {
          const has = await all(
            `SELECT id FROM service_cost_items WHERE service_id=? AND kind='overhead'`, s.id);
          if (has.length) continue;
          await run(
            `INSERT INTO service_cost_items (service_id, rate_code, name, kind, unit, quantity, unit_cost, sort_order)
             VALUES (?, 'overhead', ?, 'overhead', '%', 1, ?, 900)`,
            s.id, overhead.name || 'Накладні витрати', Number(overhead.amount));
        }
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
