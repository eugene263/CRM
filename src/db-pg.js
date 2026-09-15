// Драйвер PostgreSQL. Запити в коді написані діалектом SQLite — тут вони
// перекладаються, щоб не тримати дві копії кожного SQL.
import pg from 'pg';

// COUNT/SUM у PG приїжджають рядками; повертаємо числа, як у SQLite.
pg.types.setTypeParser(20, Number);    // int8
pg.types.setTypeParser(1700, Number);  // numeric

const connectionString = process.env.CRM_DATABASE_URL;
const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.CRM_PG_POOL || 10),
  ssl: /sslmode=require/.test(connectionString || '') ? { rejectUnauthorized: false } : undefined,
});

export const engine = 'postgres';
export const location = String(connectionString || '').replace(/:[^:@/]+@/, ':***@');

const UTC = "(now() AT TIME ZONE 'UTC')";
const FMT = "'YYYY-MM-DD HH24:MI:SS'";

// Часові мітки зберігаємо текстом у тому ж форматі, що й SQLite: тоді всі
// порівняння, BETWEEN і сортування працюють однаково на обох двигунах.
export function translate(sql) {
  let out = sql
    // datetime('now', '-7 days') / date('now', '+3 days')
    .replace(/\b(datetime|date)\('now'\s*,\s*'([+-]?\d+)\s+(\w+)'\)/gi,
      (_, fn, n, unit) => `to_char(${UTC} + interval '${n} ${unit}', ${fn.toLowerCase() === 'date' ? "'YYYY-MM-DD'" : FMT})`)
    // datetime('now') / date('now')
    .replace(/\bdatetime\('now'\)/gi, `to_char(${UTC}, ${FMT})`)
    .replace(/\bdate\('now'\)/gi, `to_char(${UTC}, 'YYYY-MM-DD')`)
    // strftime('%Y-%m','now') і strftime('%Y-%m', column)
    .replace(/\bstrftime\('%Y-%m'\s*,\s*'now'\)/gi, `to_char(${UTC}, 'YYYY-MM')`)
    .replace(/\bstrftime\('%Y-%m'\s*,\s*([^)]+)\)/gi, 'substr($1, 1, 7)')
    // date(column) → перші 10 символів текстової мітки
    .replace(/\bdate\(((?!'now')[^()]*(?:\([^()]*\))?[^()]*)\)/gi, 'substr($1, 1, 10)')
    // datetime(column) → сам стовпець (уже текст у потрібному форматі)
    .replace(/\bdatetime\(((?!'now')[^()]*(?:\([^()]*\))?[^()]*)\)/gi, '($1)')
    // julianday(x) → дні від епохи, щоб різниця двох значень лишалась у днях
    .replace(/\bjulianday\(([^()]*(?:\([^()]*\))?[^()]*)\)/gi, '(EXTRACT(EPOCH FROM ($1)::timestamp) / 86400.0)');

  // SQLite дозволяє null-safe порівняння «IS ?», Postgres — ні.
  out = out.replace(/\bIS\s+\?/gi, 'IS NOT DISTINCT FROM ?');

  // ? → $1, $2, ...
  let i = 0;
  out = out.replace(/\?/g, () => `$${++i}`);
  return out;
}

// Помилку супроводжуємо вже перекладеним SQL: без цього діагностика
// різниці діалектів перетворюється на вгадування.
async function query(sql, params) {
  const translated = translate(sql);
  try {
    return await pool.query(translated, params);
  } catch (e) {
    e.message = `${e.message}\n  SQL: ${translated.replace(/\s+/g, ' ').slice(0, 400)}`;
    throw e;
  }
}

export async function exec(sql) { await query(sql, undefined); }

export async function all(sql, ...params) {
  return (await query(sql, params)).rows;
}

export async function get(sql, ...params) {
  return (await query(sql, params)).rows[0] ?? null;
}

export async function run(sql, ...params) {
  const res = await query(sql, params);
  return {
    changes: res.rowCount ?? 0,
    lastInsertRowid: res.rows?.[0]?.id ?? null,
  };
}

export async function close() { await pool.end(); }
