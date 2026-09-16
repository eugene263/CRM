// Плани та норми: зворотний калькулятор, факти з контролем якості,
// рампап новачка, календар і ліміти каналів.
//
// Головне правило модуля: у план іде не «створено», а «валідно». Інакше
// норма в 57 лідів на день перетворюється на 57 порожніх карток.
import { all, get, run, insert, update } from './db.js';
import { notify } from './telegram.js';

const today = () => new Date().toISOString().slice(0, 10);
const monthOf = (date) => String(date).slice(0, 7);

export const METRICS = [
  ['leads_found', 'Знайдено лідів', 'шт', 'leading', 10],
  ['leads_qualified', 'Кваліфіковано', 'шт', 'leading', 20],
  ['touches', 'Тачів', 'шт', 'leading', 30],
  ['touches_followup', 'З них фолоу-апів', 'шт', 'leading', 40],
  ['replies', 'Відповідей', 'шт', 'lagging', 50],
  ['meetings', 'Зустрічей', 'шт', 'lagging', 60],
  ['deals', 'Клієнтів', 'шт', 'lagging', 70],
  ['brak_rate', 'Брак', '%', 'quality', 80, 'less'],
];

export async function seedKpi() {
  if (!(await get('SELECT id FROM kpi_metrics LIMIT 1'))) {
    for (const [code, name, unit, kind, order, direction = 'more'] of METRICS) {
      await insert('kpi_metrics', { code, name, unit, kind, sort_order: order, direction });
    }
  }
  if (!(await get('SELECT id FROM bonus_rules LIMIT 1'))) {
    // Сходинки з ТЗ: нижче 70% бонусу немає, вище 120% — підвищений.
    for (const [threshold, coefficient] of [[70, 0.5], [90, 0.8], [100, 1], [120, 1.3]]) {
      await insert('bonus_rules', { role: 'sales', metric_code: 'touches', threshold_percent: threshold, bonus_coefficient: coefficient, quality_gate_percent: 15, base_amount: 200 });
    }
  }
}

// ── Зворотний розрахунок ──────────────────────────────────────────────────
// Ціль по клієнтах розкладається на денні норми. Коефіцієнти беруться з
// вашої ж статистики, щойно її стає достатньо (див. realCoefficients).
export function calculatePlan(input = {}) {
  const c = {
    goal_deals: Number(input.goal_deals ?? 4),
    conv_meeting_to_deal: Number(input.conv_meeting_to_deal ?? 20),
    conv_reply_to_meeting: Number(input.conv_reply_to_meeting ?? 30),
    reply_rate: Number(input.reply_rate ?? 8),
    touches_per_lead: Number(input.touches_per_lead ?? 2.5),
    qualification_rate: Number(input.qualification_rate ?? 70),
    working_days: Math.max(1, Number(input.working_days ?? 21)),
    headcount: Math.max(0.1, Number(input.headcount ?? 1)),
  };
  const pctOf = (value, percent) => (percent > 0 ? value / (percent / 100) : 0);

  const meetings = pctOf(c.goal_deals, c.conv_meeting_to_deal);
  const replies = pctOf(meetings, c.conv_reply_to_meeting);
  const touchedLeads = pctOf(replies, c.reply_rate);
  const touches = touchedLeads * c.touches_per_lead;
  const leads = pctOf(touchedLeads, c.qualification_rate);

  const month = { deals: c.goal_deals, meetings, replies, touched_leads: touchedLeads, touches, leads };
  const perDay = (v) => v / c.working_days;
  const perPerson = (v) => v / c.headcount;

  return {
    input: c,
    month: Object.fromEntries(Object.entries(month).map(([k, v]) => [k, Math.ceil(v)])),
    daily: {
      leads_found: Math.ceil(perPerson(perDay(leads))),
      leads_qualified: Math.ceil(perPerson(perDay(touchedLeads))),
      touches: Math.ceil(perPerson(perDay(touches))),
      replies: Math.ceil(perPerson(perDay(replies)) * 10) / 10,
      meetings: Math.ceil(perPerson(perDay(meetings)) * 10) / 10,
    },
    // Скільки акаунтів/скриньок треба під таку кількість тачів на людину.
    accounts_needed: Math.max(1, Math.ceil(perPerson(perDay(touches)) / 40)),
  };
}

// Коефіцієнти з реальних даних: беремо, коли вибірка достатня.
export async function realCoefficients({ minLeads = 200 } = {}) {
  const stats = await get(
    `SELECT COUNT(*) AS leads,
            SUM(CASE WHEN qualified_at IS NOT NULL THEN 1 ELSE 0 END) AS qualified,
            SUM(CASE WHEN first_touch_at IS NOT NULL THEN 1 ELSE 0 END) AS touched,
            SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
            SUM(CASE WHEN status_code='meeting' THEN 1 ELSE 0 END) AS meetings,
            SUM(CASE WHEN status_code='won' THEN 1 ELSE 0 END) AS deals
       FROM leads`) || {};
  const touches = Number((await get(`SELECT COUNT(*) AS c FROM touches WHERE direction='out'`))?.c || 0);
  const leads = Number(stats.leads || 0);
  if (leads < minLeads) {
    return { enough: false, leads, need: minLeads, note: 'Поки що норми рахуються за галузевими орієнтирами' };
  }
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    enough: true,
    leads,
    qualification_rate: pct(stats.qualified, leads),
    reply_rate: pct(stats.replied, stats.touched),
    conv_reply_to_meeting: pct(stats.meetings, stats.replied),
    conv_meeting_to_deal: pct(stats.deals, stats.meetings),
    touches_per_lead: stats.touched > 0 ? Math.round((touches / stats.touched) * 10) / 10 : null,
  };
}

// ── Факти з контролем якості ──────────────────────────────────────────────
// Лід зараховується при кваліфікації, а не при створенні; неповна картка,
// дубль і згодом дискваліфікований як брак — не рахуються.
export async function computeFacts(userId, date = today()) {
  const dayStart = `${date} 00:00:00`;
  const dayEnd = `${date} 23:59:59`;

  const found = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN (l.website IS NOT NULL OR l.phone IS NOT NULL OR l.email IS NOT NULL
                           OR EXISTS (SELECT 1 FROM lead_socials s WHERE s.lead_id=l.id))
                     THEN 1 ELSE 0 END) AS complete
       FROM leads l WHERE l.created_by=? AND l.created_at BETWEEN ? AND ?`, userId, dayStart, dayEnd);

  const qualified = Number((await get(
    `SELECT COUNT(*) AS c FROM leads WHERE created_by=? AND qualified_at BETWEEN ? AND ?`,
    userId, dayStart, dayEnd))?.c || 0);

  // Брак: те, що людина додала, а потім довелось викинути.
  const brak = Number((await get(
    `SELECT COUNT(*) AS c FROM leads
      WHERE created_by=? AND created_at BETWEEN ? AND ?
        AND disqualify_reason IN ('wrong_geo','closed','no_site','too_small')`,
    userId, dayStart, dayEnd))?.c || 0);

  const touches = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN delivery_status NOT IN ('failed','blocked') AND message_text IS NOT NULL
                          AND length(trim(message_text)) > 0 THEN 1 ELSE 0 END) AS valid,
            SUM(CASE WHEN touch_number > 1 THEN 1 ELSE 0 END) AS followups
       FROM touches WHERE user_id=? AND direction='out' AND sent_at BETWEEN ? AND ?`, userId, dayStart, dayEnd);

  const replies = Number((await get(
    `SELECT COUNT(*) AS c FROM touches t JOIN leads l ON l.id=t.lead_id
      WHERE t.direction='in' AND l.owner_user_id=? AND t.sent_at BETWEEN ? AND ?`,
    userId, dayStart, dayEnd))?.c || 0);

  const meetings = Number((await get(
    `SELECT COUNT(*) AS c FROM lead_status_history h JOIN leads l ON l.id=h.lead_id
      WHERE h.to_status='meeting' AND l.owner_user_id=? AND h.created_at BETWEEN ? AND ?`,
    userId, dayStart, dayEnd))?.c || 0);

  const deals = Number((await get(
    `SELECT COUNT(*) AS c FROM lead_status_history h JOIN leads l ON l.id=h.lead_id
      WHERE h.to_status='won' AND l.owner_user_id=? AND h.created_at BETWEEN ? AND ?`,
    userId, dayStart, dayEnd))?.c || 0);

  const foundTotal = Number(found?.total || 0);
  const foundValid = Math.max(0, Number(found?.complete || 0) - brak);
  const touchTotal = Number(touches?.total || 0);
  const touchValid = Number(touches?.valid || 0);

  const rows = [
    ['leads_found', foundTotal, foundValid, foundTotal - foundValid],
    ['leads_qualified', qualified, qualified, 0],
    ['touches', touchTotal, touchValid, touchTotal - touchValid],
    ['touches_followup', Number(touches?.followups || 0), Number(touches?.followups || 0), 0],
    ['replies', replies, replies, 0],
    ['meetings', meetings, meetings, 0],
    ['deals', deals, deals, 0],
    ['brak_rate', foundTotal > 0 ? Math.round(((foundTotal - foundValid) / foundTotal) * 1000) / 10 : 0, 0, brak],
  ];

  for (const [code, value, valid, rejected] of rows) {
    await run(
      `INSERT INTO kpi_facts (user_id, metric_code, date, value, valid_value, rejected_value, calculated_at)
       VALUES (?,?,?,?,?,?, datetime('now'))
       ON CONFLICT(user_id, metric_code, date) DO UPDATE SET
         value=excluded.value, valid_value=excluded.valid_value,
         rejected_value=excluded.rejected_value, calculated_at=excluded.calculated_at`,
      userId, code, date, value, valid, rejected);
  }
  return Object.fromEntries(rows.map(([code, value, valid, rejected]) => [code, { value, valid, rejected }]));
}

// ── Норма на конкретний день ──────────────────────────────────────────────
// План × рампап × завантаженість дня. Відпустка або лікарняний не мають
// перетворюватись на «не виконав норму».
export async function dailyNorm(userId, date = today()) {
  const user = await get('SELECT * FROM users WHERE id=?', userId);
  if (!user) return {};

  const calendar = await get('SELECT * FROM work_calendar WHERE user_id=? AND date=?', userId, date);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const capacity = calendar
    ? Number(calendar.capacity_percent) / 100
    : (weekday === 0 || weekday === 6 ? 0 : 1);

  const ramp = await rampFactor(user, date);
  const plans = await all(
    `SELECT * FROM kpi_plans
      WHERE period_type='day' AND date(period_start) <= date(?)
        AND (period_end IS NULL OR date(period_end) >= date(?))
        AND (user_id = ? OR (user_id IS NULL AND role = ?))
      ORDER BY user_id DESC`, date, date, userId, user.role);

  const norms = {};
  for (const plan of plans) {
    if (norms[plan.metric_code] !== undefined) continue;   // персональний план має пріоритет
    norms[plan.metric_code] = Math.round(Number(plan.target_value) * capacity * ramp * 10) / 10;
  }
  return { norms, capacity, ramp, calendar_kind: calendar?.kind || (capacity ? 'work' : 'weekend') };
}

async function rampFactor(user, date) {
  const rows = await all(
    `SELECT * FROM ramp_up_plans WHERE (user_id=? OR (user_id IS NULL AND role=?)) ORDER BY week_number`,
    user.id, user.role);
  if (!rows.length) return 1;
  const started = rows.find((r) => r.started_at)?.started_at || user.created_at;
  const weeks = Math.floor((new Date(`${date}T12:00:00Z`) - new Date(String(started).replace(' ', 'T'))) / (7 * 864e5)) + 1;
  const row = rows.filter((r) => r.week_number <= weeks).pop();
  if (!row) return Number(rows[0].target_percent) / 100;
  return Number(row.target_percent) / 100;
}

// ── Мій день ──────────────────────────────────────────────────────────────
export async function myDay(user, date = today()) {
  const facts = await computeFacts(user.id, date);
  const { norms, capacity, ramp, calendar_kind } = await dailyNorm(user.id, date);

  const progress = Object.entries(norms).map(([code, target]) => {
    const fact = facts[code]?.valid ?? facts[code]?.value ?? 0;
    return {
      metric: code,
      name: METRICS.find((m) => m[0] === code)?.[1] || code,
      target,
      fact,
      rejected: facts[code]?.rejected ?? 0,
      percent: target > 0 ? Math.round((fact / target) * 100) : null,
    };
  });

  const month = await monthProgress(user.id, monthOf(date));
  const limits = await channelUsage(user, date);
  return { date, capacity, ramp, calendar_kind, progress, month, limits, facts };
}

export async function monthProgress(userId, period = monthOf(today())) {
  const from = `${period}-01`;
  const to = `${period}-31`;
  const facts = await all(
    `SELECT metric_code, SUM(valid_value) AS fact FROM kpi_facts
      WHERE user_id=? AND date BETWEEN ? AND ? GROUP BY metric_code`, userId, from, to);
  const plans = await all(
    `SELECT metric_code, target_value FROM kpi_plans
      WHERE user_id=? AND period_type='month' AND period_start=?`, userId, from);

  const passed = Number((await get(
    `SELECT COUNT(*) AS c FROM kpi_facts WHERE user_id=? AND date BETWEEN ? AND ? AND metric_code='touches'`,
    userId, from, to))?.c || 0);
  const total = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0).getDate();

  return plans.map((p) => {
    const fact = Number(facts.find((f) => f.metric_code === p.metric_code)?.fact || 0);
    const pace = passed > 0 ? (fact / passed) * total : 0;
    return {
      metric: p.metric_code,
      name: METRICS.find((m) => m[0] === p.metric_code)?.[1] || p.metric_code,
      target: Number(p.target_value),
      fact,
      percent: p.target_value > 0 ? Math.round((fact / Number(p.target_value)) * 100) : null,
      forecast_percent: p.target_value > 0 ? Math.round((pace / Number(p.target_value)) * 100) : null,
    };
  });
}

// ── Ліміти каналів ────────────────────────────────────────────────────────
// Платформа ріже акаунт швидше, ніж людина втомлюється, тому ліміт — на
// акаунт, а не на менеджера.
export async function channelUsage(user, date = today()) {
  const limits = await all(
    `SELECT * FROM channel_limits WHERE is_active=1 AND (user_id IS NULL OR user_id=?) ORDER BY channel, account_name`, user.id);
  const used = await all(
    `SELECT from_account, channel, COUNT(*) AS c FROM touches
      WHERE direction='out' AND from_account IS NOT NULL AND sent_at BETWEEN ? AND ?
      GROUP BY from_account, channel`, `${date} 00:00:00`, `${date} 23:59:59`);
  return limits.map((l) => {
    const usedToday = Number(used.find((u) => u.from_account === l.account_name && u.channel === l.channel)?.c || 0);
    return { ...l, used_today: usedToday, left: Math.max(0, l.daily_limit - usedToday) };
  });
}

export async function checkChannelLimit(accountName, channel, date = today()) {
  if (!accountName) return { ok: true };
  const limit = await get(
    'SELECT * FROM channel_limits WHERE account_name=? AND channel=? AND is_active=1', accountName, channel);
  if (!limit) return { ok: true };
  const used = Number((await get(
    `SELECT COUNT(*) AS c FROM touches WHERE from_account=? AND channel=? AND direction='out' AND sent_at BETWEEN ? AND ?`,
    accountName, channel, `${date} 00:00:00`, `${date} 23:59:59`))?.c || 0);
  if (used >= limit.daily_limit) {
    return { ok: false, used, limit: limit.daily_limit, message: `Ліміт акаунта «${accountName}» на сьогодні вичерпано (${used}/${limit.daily_limit}) — далі росте ризик бану` };
  }
  return { ok: true, used, limit: limit.daily_limit, left: limit.daily_limit - used };
}

// ── Екран тімліда ─────────────────────────────────────────────────────────
export async function teamOverview(user, date = today()) {
  const scope = user.role === 'teamlead'
    ? { sql: 'team_id IS ?', params: [user.team_id ?? null] }
    : { sql: '1=1', params: [] };
  const members = await all(
    `SELECT id, name, role FROM users WHERE status='active' AND ${scope.sql} AND role IN ('sales','teamlead')`,
    ...scope.params);

  const rows = [];
  for (const m of members) {
    const facts = await computeFacts(m.id, date);
    const { norms } = await dailyNorm(m.id, date);
    const metrics = Object.keys(norms).length ? norms : { touches: 0, leads_found: 0 };
    rows.push({
      user_id: m.id, name: m.name, role: m.role,
      metrics: Object.entries(metrics).map(([code, target]) => ({
        metric: code, target,
        fact: facts[code]?.valid ?? 0,
        percent: target > 0 ? Math.round(((facts[code]?.valid ?? 0) / target) * 100) : null,
      })),
      brak_rate: facts.brak_rate?.value ?? 0,
      last_touch: (await get(
        `SELECT MAX(sent_at) AS last FROM touches WHERE user_id=? AND date(sent_at)=?`, m.id, date))?.last || null,
      stale_leads: Number((await get(
        `SELECT COUNT(*) AS c FROM leads WHERE owner_user_id=? AND status_code IN ('contacted','followup')
           AND last_touch_at <= datetime('now','-7 days')`, m.id))?.c || 0),
    });
  }
  return { date, rows };
}

// ── Фонові нагадування ────────────────────────────────────────────────────
export async function kpiChecks({ hour = new Date().getUTCHours() } = {}) {
  const date = today();
  const managers = await all(`SELECT id, name, role FROM users WHERE status='active' AND role IN ('sales','teamlead')`);
  let sent = 0;
  for (const m of managers) {
    const { norms, capacity } = await dailyNorm(m.id, date);
    if (!capacity || !Object.keys(norms).length) continue;
    const facts = await computeFacts(m.id, date);

    if (hour === 7) {
      const parts = Object.entries(norms).map(([code, target]) => `${METRICS.find((x) => x[0] === code)?.[1] || code}: ${target}`);
      const overdue = Number((await get(
        `SELECT COUNT(*) AS c FROM leads WHERE owner_user_id=? AND next_contact_at IS NOT NULL
           AND datetime(next_contact_at) <= datetime('now')`, m.id))?.c || 0);
      await notify('kpi', `☀️ План на сьогодні — ${parts.join(', ')}. Прострочених фолоу-апів: ${overdue}`, m.id);
      sent += 1;
    }
    if (hour === 14) {
      const touchNorm = Number(norms.touches || 0);
      const done = facts.touches?.valid ?? 0;
      if (touchNorm > 0 && done < touchNorm * 0.3) {
        await notify('kpi', `⏳ До 14:00 зроблено ${done} із ${touchNorm} тачів — менше третини норми`, m.id);
        sent += 1;
      }
    }
    if (hour === 19) {
      const summary = Object.entries(norms)
        .map(([code, target]) => `${METRICS.find((x) => x[0] === code)?.[1] || code} ${facts[code]?.valid ?? 0}/${target}`)
        .join(' · ');
      await notify('kpi', `🌙 Підсумок дня: ${summary}. Брак: ${facts.brak_rate?.value ?? 0}%`, m.id);
      sent += 1;
    }
  }
  return { sent };
}

// Бонус за нормою: ступінчастий коефіцієнт із гейтом за якістю.
export async function bonusFor(user, period) {
  const from = `${period}-01`;
  const to = `${period}-31`;
  const rules = await all(
    `SELECT * FROM bonus_rules WHERE is_active=1 AND (user_id=? OR (user_id IS NULL AND role=?))
      ORDER BY threshold_percent DESC`, user.id, user.role);
  if (!rules.length) return { amount: 0, reason: 'правил бонусу немає' };

  const metric = rules[0].metric_code;
  const fact = Number((await get(
    `SELECT COALESCE(SUM(valid_value),0) AS v FROM kpi_facts WHERE user_id=? AND metric_code=? AND date BETWEEN ? AND ?`,
    user.id, metric, from, to))?.v || 0);
  const plan = Number((await get(
    `SELECT COALESCE(SUM(target_value),0) AS v FROM kpi_plans
      WHERE user_id=? AND metric_code=? AND period_type='month' AND period_start=?`,
    user.id, metric, from))?.v || 0);
  if (!plan) return { amount: 0, reason: 'місячний план не заданий' };

  const percent = (fact / plan) * 100;
  const brak = Number((await get(
    `SELECT COALESCE(AVG(value),0) AS v FROM kpi_facts WHERE user_id=? AND metric_code='brak_rate' AND date BETWEEN ? AND ?`,
    user.id, from, to))?.v || 0);

  const rule = rules.find((r) => percent >= Number(r.threshold_percent));
  if (!rule) return { amount: 0, percent, brak, reason: 'виконання нижче мінімального порога' };
  if (brak > Number(rule.quality_gate_percent)) {
    return { amount: 0, percent, brak, reason: `брак ${brak}% вище гейта ${rule.quality_gate_percent}% — бонус за кількість не виплачується` };
  }
  return {
    amount: Math.round(Number(rule.base_amount) * Number(rule.bonus_coefficient) * 100) / 100,
    percent: Math.round(percent), brak, coefficient: Number(rule.bonus_coefficient), metric,
  };
}

// Застосувати розрахунок як плани: денні норми на місяць уперед плюс
// місячні цілі, щоб бонус мав від чого рахуватись.
export async function applyPlan(user, { calculation, user_ids = [], period_start, months = 1 }) {
  const calc = calculation || calculatePlan({});
  const start = period_start || `${monthOf(today())}-01`;
  const end = new Date(new Date(start).getFullYear(), new Date(start).getMonth() + Number(months || 1), 0)
    .toISOString().slice(0, 10);
  const targets = calc.daily || {};
  const applied = [];

  for (const userId of user_ids.length ? user_ids : [user.id]) {
    for (const [metric, value] of Object.entries(targets)) {
      await run('DELETE FROM kpi_plans WHERE user_id=? AND metric_code=? AND period_type=? AND period_start=?',
        userId, metric, 'day', start);
      await insert('kpi_plans', {
        user_id: userId, metric_code: metric, period_type: 'day',
        period_start: start, period_end: end, target_value: value, created_by: user.id,
      });
      const monthly = Math.ceil(Number(value) * Number(calc.input?.working_days || 21));
      await run('DELETE FROM kpi_plans WHERE user_id=? AND metric_code=? AND period_type=? AND period_start=?',
        userId, metric, 'month', start);
      await insert('kpi_plans', {
        user_id: userId, metric_code: metric, period_type: 'month',
        period_start: start, period_end: end, target_value: monthly, created_by: user.id,
      });
      applied.push({ userId, metric, period_type: 'day', target: value });
      applied.push({ userId, metric, period_type: 'month', target: monthly });
    }
  }
  return { applied: applied.length, period: { start, end }, rows: applied };
}
