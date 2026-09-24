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
      // звичайний рядок типу overhead усередині кожного пакета, де є з чого
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
  {
    // Над пакетами зʼявився рівень «послуга» (кнопки над плашками). Наявні
    // пакети складаються в одну першу послугу, щоб нічого не зникло з очей.
    id: '2026-09-21-service-groups',
    async up() {
      const cols = await columnsOf('services');
      if (!cols.has('group_id')) await run('ALTER TABLE services ADD COLUMN group_id INTEGER');
      if (!(await all('SELECT id FROM services WHERE group_id IS NOT NULL LIMIT 1')).length
        && (await all('SELECT id FROM services LIMIT 1')).length) {
        await run(`INSERT INTO service_groups (name, sort_order) VALUES ('Трафік ферма', 10)`);
        const group = (await all(`SELECT id FROM service_groups ORDER BY id LIMIT 1`))[0];
        await run('UPDATE services SET group_id=? WHERE group_id IS NULL', group.id);
      }
    },
  },
  {
    // Шаблони повідомлень стали деревом карток: parent_id + заголовок/опис/
    // теги. Наявні шаблони лишаються там, де були, — у корені (parent_id
    // порожній), тож із очей нічого не зникає.
    id: '2026-09-22-template-tree',
    async up() {
      const cols = await columnsOf('message_templates');
      for (const [name, type] of [
        ['parent_id', 'INTEGER'], ['description', 'TEXT'], ['tags', 'TEXT'],
        ['sort_order', 'INTEGER NOT NULL DEFAULT 0'],
      ]) {
        if (!cols.has(name)) await run(`ALTER TABLE message_templates ADD COLUMN ${name} ${type}`);
      }
      await run('CREATE INDEX IF NOT EXISTS ix_templates_parent ON message_templates(parent_id)');
    },
  },
  {
    // payout_reports створює сам schema.sql (CREATE TABLE IF NOT EXISTS) —
    // тут лишається тільки індекс під вибірку «звіти за місяць».
    id: '2026-09-23-payout-reports',
    async up() {
      await run('CREATE INDEX IF NOT EXISTS ix_payout_reports_period ON payout_reports(period, user_id)');
    },
  },
  {
    // Звіти тепер несуть і час, витрачений командою за місяць, — не лише
    // гроші. Окрема колонка в payouts, бо годин — це підтверджене число
    // (як fix_amount), яке живе доти, доки хтось не підставить нове.
    id: '2026-09-24-payout-hours',
    async up() {
      const reportCols = await columnsOf('payout_reports');
      if (!reportCols.has('ai_hours')) await run('ALTER TABLE payout_reports ADD COLUMN ai_hours REAL');
      const payoutCols = await columnsOf('payouts');
      if (!payoutCols.has('hours')) await run('ALTER TABLE payouts ADD COLUMN hours REAL NOT NULL DEFAULT 0');
    },
  },
  {
    // Канбан лідів тепер памʼятає ручну позицію картки в колонці, а не
    // лише сортує за часом оновлення. Наявні картки отримують order у
    // ТОМУ самому порядку, в якому вони й так показувались (updated_at
    // DESC, created_at DESC) — щоб міграція нічого візуально не зрушила.
    id: '2026-09-25-leads-board-order',
    async up() {
      const cols = await columnsOf('leads');
      if (!cols.has('board_order')) await run('ALTER TABLE leads ADD COLUMN board_order REAL NOT NULL DEFAULT 0');

      const rows = await all(
        `SELECT id, status_code FROM leads ORDER BY status_code, updated_at DESC, created_at DESC`);
      let prevStatus = null;
      let order = 0;
      for (const row of rows) {
        if (row.status_code !== prevStatus) { prevStatus = row.status_code; order = 0; }
        await run('UPDATE leads SET board_order=? WHERE id=?', order, row.id);
        order += 1000;
      }
    },
  },
  {
    // Ферми — новий розділ: блок пристроїв (девайси) одного клієнта в
    // одному гео, з акаунтами на кожному пристрої. Сама таблиця farms
    // створюється schema.sql (CREATE TABLE IF NOT EXISTS) на кожному
    // старті — тут лише ALTER наявних devices/accounts, яких schema.sql
    // заднім числом не чіпає.
    id: '2026-09-26-farms',
    async up() {
      const deviceCols = await columnsOf('devices');
      if (!deviceCols.has('farm_id')) await run('ALTER TABLE devices ADD COLUMN farm_id INTEGER');
      await run('CREATE INDEX IF NOT EXISTS idx_devices_farm ON devices(farm_id)');
      const accountCols = await columnsOf('accounts');
      if (!accountCols.has('niche')) await run('ALTER TABLE accounts ADD COLUMN niche TEXT');
    },
  },
  {
    // Дата початку — окремо від дедлайну; task_tags/task_card_tags — нові
    // таблиці, їх ставить сам schema.sql (CREATE TABLE IF NOT EXISTS).
    id: '2026-09-24-task-cards-start-date',
    async up() {
      const cols = await columnsOf('task_cards');
      if (!cols.has('start_date')) await run('ALTER TABLE task_cards ADD COLUMN start_date TEXT');
    },
  },
  {
    // Колонки отримують колір (пігулка в заголовку) і згортання; порядок
    // колонок переїжджає на дробовий board_order (той самий прийом, що
    // leads.board_order) — щоб колонки можна було перетягувати одна повз
    // одну, а не лише індекс+1. Наявні колонки отримують board_order у
    // ТОМУ самому порядку, в якому вони й так стояли (sort_order, id).
    id: '2026-09-25-task-columns-color-order',
    async up() {
      const cols = await columnsOf('task_columns');
      if (!cols.has('color')) await run(`ALTER TABLE task_columns ADD COLUMN color TEXT NOT NULL DEFAULT 'accent'`);
      if (!cols.has('collapsed')) await run('ALTER TABLE task_columns ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0');
      if (!cols.has('board_order')) {
        await run('ALTER TABLE task_columns ADD COLUMN board_order REAL NOT NULL DEFAULT 0');
        const rows = await all('SELECT id, board_id FROM task_columns ORDER BY board_id, sort_order, id');
        let prevBoard = null, order = 0;
        for (const row of rows) {
          if (row.board_id !== prevBoard) { prevBoard = row.board_id; order = 0; }
          await run('UPDATE task_columns SET board_order=? WHERE id=?', order, row.id);
          order += 1000;
        }
      }
      const cardCols = await columnsOf('task_cards');
      if (!cardCols.has('description_blocks')) await run('ALTER TABLE task_cards ADD COLUMN description_blocks TEXT');
    },
  },
  {
    // Закріплені коментарі — виносяться нагору стрічки Activity, можна
    // закріпити скільки завгодно (не лише один).
    id: '2026-09-26-task-comments-pinned',
    async up() {
      const cols = await columnsOf('task_comments');
      if (!cols.has('pinned')) await run('ALTER TABLE task_comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    // Estimate (оцінка часу в хвилинах) — прогрес-бар «скільки вже
    // натрекано з того, що планували» рахується від цього поля.
    id: '2026-09-27-task-cards-estimate',
    async up() {
      const cols = await columnsOf('task_cards');
      if (!cols.has('estimate_minutes')) await run('ALTER TABLE task_cards ADD COLUMN estimate_minutes INTEGER');
    },
  },
  {
    // Іконка дошки й лого простору — для плашок у згорнутому боковому
    // меню сторінки «Задачі» (Space = лого, Board = обрана іконка).
    id: '2026-09-28-task-boards-icon-space-logo',
    async up() {
      const boardCols = await columnsOf('task_boards');
      if (!boardCols.has('icon')) await run('ALTER TABLE task_boards ADD COLUMN icon TEXT');
      const spaceCols = await columnsOf('task_spaces');
      if (!spaceCols.has('logo_data_url')) await run('ALTER TABLE task_spaces ADD COLUMN logo_data_url TEXT');
    },
  },
  {
    // Норма estimate — орієнтир для AI, скільки годин типово ставити на
    // задачі такого типу цієї дошки (список {label, hours}).
    id: '2026-09-29-task-boards-estimate-norms',
    async up() {
      const cols = await columnsOf('task_boards');
      if (!cols.has('estimate_norms')) await run('ALTER TABLE task_boards ADD COLUMN estimate_norms TEXT');
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
