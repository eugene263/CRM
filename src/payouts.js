// Виплати команді у розрізі «рік → місяць → людина»: до кожної людини в
// місяці чіпляються PDF-звіти, які ШІ читає й пропонує суму, а міні-дашборд
// показує, скільки грошей пішло на команду.
//
// Файл лежить у базі (base64), а не на диску: контейнер на Railway
// ефемерний — після наступного деплою диск чистий, і вкладення б зникли.
import { all, get, run, insert, remove } from './db.js';
import { scopeWhere } from './rbac.js';
import { geminiRequest, hasGeminiKeys } from './ai.js';

const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
  'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const monthName = (n) => MONTHS[n - 1] || String(n);

function isPeriod(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

export function assertPeriod(period) {
  if (!isPeriod(period)) throw Object.assign(new Error('Період має бути у форматі YYYY-MM'), { status: 400 });
  return String(period);
}

// Зсув місяця: shiftPeriod('2026-01', -1) → '2025-12'.
export function shiftPeriod(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export const currentPeriod = () => new Date().toISOString().slice(0, 7);

// Виплати бачить лише той, кому їх видно за скоупом ролі: фінансист —
// усі, рядовий — свої. Один і той самий фільтр і для сум, і для звітів.
function payoutScope(user, alias = 'p') {
  return scopeWhere(user, 'payouts', alias);
}

async function visibleUserIds(user) {
  const scope = payoutScope(user, 'u');
  // users-скоуп тут не годиться: звіти показуємо тим самим людям, чиї
  // виплати видно, тому беремо фільтр із payouts, підставивши users.
  const own = scope.sql.replace(/\bu\.user_id\b/g, 'u.id');
  // Вимкнені співробітники не рахуються ні в «команді», ні в списку місяця —
  // інакше тайл «звіти за місяць» назавжди лишався б недобраним.
  const rows = await all(`SELECT u.id FROM users u WHERE ${own} AND u.status <> 'disabled'`, ...scope.params);
  return rows.map((r) => Number(r.id));
}

// ── Огляд: роки → місяці ────────────────────────────────────────────────
export async function overview(user) {
  const scope = payoutScope(user);
  const months = await all(
    `SELECT p.period AS period,
            COALESCE(SUM(p.total), 0) AS total,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.total ELSE 0 END), 0) AS paid,
            COUNT(DISTINCT p.user_id) AS people
       FROM payouts p
      WHERE ${scope.sql} AND p.status <> 'canceled'
      GROUP BY p.period`, ...scope.params);

  const ids = await visibleUserIds(user);
  const reports = ids.length
    ? await all(`SELECT period, COUNT(*) AS c, COUNT(DISTINCT user_id) AS people
                   FROM payout_reports WHERE user_id IN (${ids.map(() => '?').join(',')})
                  GROUP BY period`, ...ids)
    : [];
  const reportsBy = Object.fromEntries(reports.map((r) => [r.period, r]));

  // Місяць потрапляє в дерево, навіть якщо виплат ще немає, але звіти вже
  // залили — інакше щойно завантажений PDF нікуди було б покласти.
  const periods = new Set([...months.map((m) => m.period), ...reports.map((r) => r.period)]);
  const byPeriod = Object.fromEntries(months.map((m) => [m.period, m]));

  const years = new Map();
  for (const period of [...periods].filter(isPeriod).sort().reverse()) {
    const [y, m] = period.split('-');
    const row = byPeriod[period] || {};
    const month = {
      period,
      month: Number(m),
      month_name: monthName(Number(m)),
      total: Number(row.total || 0),
      paid: Number(row.paid || 0),
      people: Number(row.people || 0),
      reports: Number(reportsBy[period]?.c || 0),
      reported_people: Number(reportsBy[period]?.people || 0),
    };
    if (!years.has(y)) years.set(y, { year: Number(y), total: 0, people: 0, reports: 0, months: [] });
    const year = years.get(y);
    year.months.push(month);
    year.total += month.total;
    year.reports += month.reports;
    year.people = Math.max(year.people, month.people);
  }
  return [...years.values()];
}

// ── Міні-дашборд ────────────────────────────────────────────────────────
export async function summary(user) {
  const scope = payoutScope(user);
  const now = currentPeriod();
  const prev = shiftPeriod(now, -1);
  const threeFrom = shiftPeriod(now, -2);

  const sum = async (extraSql, ...extra) => Number((await get(
    `SELECT COALESCE(SUM(p.total), 0) AS v FROM payouts p
      WHERE ${scope.sql} AND p.status <> 'canceled' ${extraSql}`,
    ...scope.params, ...extra))?.v || 0);

  const month = await sum('AND p.period = ?', now);
  const prevMonth = await sum('AND p.period = ?', prev);
  const quarter = await sum('AND p.period >= ? AND p.period <= ?', threeFrom, now);
  const unpaid = await sum(`AND p.status = 'accrued'`);

  const unpaidCount = Number((await get(
    `SELECT COUNT(*) AS c FROM payouts p WHERE ${scope.sql} AND p.status = 'accrued'`,
    ...scope.params))?.c || 0);
  const people = Number((await get(
    `SELECT COUNT(DISTINCT p.user_id) AS c FROM payouts p
      WHERE ${scope.sql} AND p.status <> 'canceled' AND p.period = ?`,
    ...scope.params, now))?.c || 0);

  const ids = await visibleUserIds(user);
  const reported = ids.length ? Number((await get(
    `SELECT COUNT(DISTINCT user_id) AS c FROM payout_reports
      WHERE period = ? AND user_id IN (${ids.map(() => '?').join(',')})`, now, ...ids))?.c || 0) : 0;

  return {
    period: now,
    prev_period: prev,
    month_total: month,
    prev_month_total: prevMonth,
    // Ділити на нуль немає сенсу: у місяці без виплат «зростання» невизначене.
    month_change_percent: prevMonth > 0 ? ((month - prevMonth) / prevMonth) * 100 : null,
    quarter_total: quarter,
    quarter_from: threeFrom,
    avg_month: quarter / 3,
    unpaid_total: unpaid,
    unpaid_count: unpaidCount,
    people,
    team_size: ids.length,
    reported_people: reported,
  };
}

// ── Місяць: люди, їхні виплати й звіти ──────────────────────────────────
export async function periodRows(user, period) {
  assertPeriod(period);
  const ids = await visibleUserIds(user);
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');

  const users = await all(
    `SELECT id, name, role FROM users WHERE id IN (${marks}) AND status <> 'disabled' ORDER BY name`, ...ids);
  const payouts = await all(
    `SELECT * FROM payouts WHERE period = ? AND user_id IN (${marks})`, period, ...ids);
  const reports = await all(
    `SELECT id, user_id, period, file_name, size_bytes, ai_status, ai_amount, ai_currency, ai_period,
            ai_summary, ai_error, applied_at, created_at
       FROM payout_reports WHERE period = ? AND user_id IN (${marks}) ORDER BY id`, period, ...ids);

  // Людина без виплати й без звіту в списку теж потрібна — саме по ній
  // видно, що звіт ще не здано.
  const byUser = Object.fromEntries(payouts.map((p) => [Number(p.user_id), p]));
  return users.map((u) => ({
    user_id: u.id,
    user_name: u.name,
    role: u.role,
    payout: byUser[Number(u.id)] || null,
    reports: reports.filter((r) => Number(r.user_id) === Number(u.id)),
  }));
}

// ── Звіти ───────────────────────────────────────────────────────────────
export async function addReport(user, { user_id, period, file_name, content, mime }) {
  assertPeriod(period);
  const target = await get('SELECT id, name FROM users WHERE id=?', Number(user_id));
  if (!target) throw Object.assign(new Error('Співробітника не знайдено'), { status: 404 });
  const base64 = String(content || '').replace(/^data:[^,]*,/, '');
  if (!base64) throw Object.assign(new Error('Файл порожній'), { status: 400 });
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_FILE_BYTES) {
    throw Object.assign(new Error(`Файл завеликий: ${(bytes / 1048576).toFixed(1)} МБ, максимум 8 МБ`), { status: 413 });
  }
  const id = await insert('payout_reports', {
    user_id: Number(user_id), period, file_name: String(file_name || 'report.pdf').slice(0, 200),
    mime: String(mime || 'application/pdf'), size_bytes: bytes, content: base64,
    uploaded_by: user.id,
  });
  return getReport(id);
}

export async function getReport(id) {
  const row = await get(
    `SELECT id, user_id, period, file_name, mime, size_bytes, ai_status, ai_amount, ai_currency,
            ai_period, ai_summary, ai_error, applied_at, created_at
       FROM payout_reports WHERE id=?`, Number(id));
  if (!row) throw Object.assign(new Error('Звіт не знайдено'), { status: 404 });
  return row;
}

export async function reportFile(id) {
  const row = await get('SELECT file_name, mime, content FROM payout_reports WHERE id=?', Number(id));
  if (!row) throw Object.assign(new Error('Звіт не знайдено'), { status: 404 });
  return { ...row, buffer: Buffer.from(row.content, 'base64') };
}

export async function deleteReport(id) {
  await getReport(id);
  await remove('payout_reports', Number(id));
  return { ok: true };
}

// Для перевірки прав: чий це звіт і за який місяць.
export async function reportOwner(id) {
  return get('SELECT id, user_id, period FROM payout_reports WHERE id=?', Number(id));
}

// ── Читання PDF через ШІ ────────────────────────────────────────────────
const ANALYZE_PROMPT = `Ти читаєш звіт співробітника за місяць з PDF-файлу.
Поверни СУВОРО JSON-обʼєкт без пояснень і без markdown:
{"amount": число або null, "currency": "USD"|"UAH"|"EUR"|null, "period": "YYYY-MM" або null, "summary": "1-2 речення українською про зміст звіту"}
amount — підсумкова сума до виплати за цей звіт (якщо в документі кілька сум, бери фінальну/підсумкову).
Якщо суми в документі немає — amount: null. Не вигадуй цифр, яких немає в PDF.`;

function parseAnalysis(text) {
  const raw = String(text || '').replace(/```json|```/g, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('ШІ повернув відповідь не у форматі JSON');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const amount = parsed.amount === null || parsed.amount === undefined || parsed.amount === ''
    ? null : Number(parsed.amount);
  return {
    amount: Number.isFinite(amount) ? amount : null,
    currency: parsed.currency ? String(parsed.currency).slice(0, 8) : null,
    period: isPeriod(parsed.period) ? String(parsed.period) : null,
    summary: parsed.summary ? String(parsed.summary).slice(0, 1000) : null,
  };
}

export async function analyzeReport(id) {
  const row = await get('SELECT id, mime, content FROM payout_reports WHERE id=?', Number(id));
  if (!row) throw Object.assign(new Error('Звіт не знайдено'), { status: 404 });
  if (!hasGeminiKeys()) {
    throw Object.assign(new Error('ШІ не налаштовано: додайте GEMINI_API_KEY(S)'), { status: 400 });
  }
  try {
    const data = await geminiRequest({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: row.mime || 'application/pdf', data: row.content } },
          { text: ANALYZE_PROMPT },
        ],
      }],
    });
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const parsed = parseAnalysis(text);
    await run(
      `UPDATE payout_reports SET ai_status='ok', ai_amount=?, ai_currency=?, ai_period=?, ai_summary=?, ai_error=NULL WHERE id=?`,
      parsed.amount, parsed.currency, parsed.period, parsed.summary, Number(id));
  } catch (e) {
    // Збій розбору не втрачає сам файл: він лишається вкладеним, а причина
    // видно в картці, щоб можна було спробувати ще раз або вбити суму руками.
    await run(`UPDATE payout_reports SET ai_status='error', ai_error=? WHERE id=?`,
      String(e.message).slice(0, 500), Number(id));
  }
  return getReport(id);
}

// Підставити вичитану суму у виплату: створює рядок виплати, якщо його ще
// немає. Сума лягає у фікс — це та частина, яку підтверджує звіт; відсоток
// і бонус рахуються окремо розрахунком ЗП і не затираються.
export async function applyReport(id, override) {
  const row = await getReport(id);
  // override — виправлена людиною сума: ШІ міг прочитати не ту цифру, і
  // тоді правильніше вбити свою, ніж лишати виплату порожньою.
  const raw = override === undefined || override === null || override === '' ? row.ai_amount : override;
  if (raw === null || raw === undefined) {
    throw Object.assign(new Error('У звіті немає суми, яку можна підставити'), { status: 400 });
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount)) throw Object.assign(new Error('Сума має бути числом'), { status: 400 });
  const existing = await get('SELECT * FROM payouts WHERE user_id=? AND period=?', row.user_id, row.period);
  if (existing) {
    const total = amount + Number(existing.percent_amount || 0) + Number(existing.bonus_amount || 0);
    await run('UPDATE payouts SET fix_amount=?, total=? WHERE id=?', amount, total, existing.id);
  } else {
    await insert('payouts', {
      user_id: row.user_id, period: row.period, fix_amount: amount,
      percent_amount: 0, bonus_amount: 0, total: amount, status: 'accrued',
      note: `Із звіту: ${row.file_name}`,
    });
  }
  await run(`UPDATE payout_reports SET applied_at=datetime('now') WHERE id=?`, Number(id));
  return { ok: true, amount, period: row.period, user_id: row.user_id };
}
