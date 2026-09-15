// Аналітика: зведення та розрізи. Витрати й доходи рахуються з однієї точки,
// щоб «профіт» у дашборді, ЗП і P&L не розʼїжджались.
import { all, get } from './db.js';
import { scopeWhere, can, hiddenFields, scopeOf } from './rbac.js';

const REVENUE_STATUSES = "('approved','paid')";

export function period(query = {}) {
  const to = query.to || new Date().toISOString().slice(0, 10);
  const from = query.from || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  return { from, to, toEnd: `${to} 23:59:59` };
}

function scoped(user, entity, alias) {
  // Роль без доступу до сутності не має «протікати» через агрегати.
  if (!can(user, entity, 'read')) return { sql: '1=0', params: [] };
  const { sql, params } = scopeWhere(user, entity, alias);
  return { sql, params };
}

// Чи бачить роль гроші: ставки (payout конверсій) і витрати.
const seesRevenue = (user) => can(user, 'conversions', 'read') && !hiddenFields(user, 'conversions').includes('payout');
const seesExpenses = (user) => can(user, 'expenses', 'read');

export async function summary(user, query = {}) {
  const { from, to, toEnd } = period(query);
  const cs = scoped(user, 'conversions', 'c');
  const ps = scoped(user, 'posts', 'p');
  const es = scoped(user, 'expenses', 'e');

  const rev = await get(
    `SELECT COALESCE(SUM(c.payout),0) AS revenue,
            SUM(CASE WHEN c.event='dep' THEN 1 ELSE 0 END) AS deps,
            SUM(CASE WHEN c.event='reg' THEN 1 ELSE 0 END) AS regs,
            SUM(CASE WHEN c.status='hold' THEN c.payout ELSE 0 END) AS hold_amount,
            COUNT(*) AS conversions
       FROM conversions c
      WHERE c.converted_at BETWEEN ? AND ? AND c.status IN ${REVENUE_STATUSES} AND ${cs.sql}`,
    from, toEnd, ...cs.params,
  ) || {};

  const holdRow = await get(
    `SELECT COALESCE(SUM(c.payout),0) AS hold_amount FROM conversions c
      WHERE c.converted_at BETWEEN ? AND ? AND c.status='hold' AND ${cs.sql}`,
    from, toEnd, ...cs.params,
  ) || { hold_amount: 0 };

  const posts = await get(
    `SELECT COUNT(*) AS posts, COALESCE(SUM(p.views),0) AS views, COALESCE(SUM(p.clicks),0) AS clicks
       FROM posts p WHERE p.posted_at BETWEEN ? AND ? AND ${ps.sql}`,
    from, toEnd, ...ps.params,
  ) || {};

  const exp = await get(
    `SELECT COALESCE(SUM(e.amount),0) AS expenses FROM expenses e
      WHERE e.spent_at BETWEEN ? AND ? AND ${es.sql}`,
    from, to, ...es.params,
  ) || { expenses: 0 };

  const as_ = scoped(user, 'accounts', 'a');
  const acc = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN a.status='active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN a.status='farm' THEN 1 ELSE 0 END) AS farm,
            SUM(CASE WHEN a.status='ban' THEN 1 ELSE 0 END) AS banned,
            SUM(CASE WHEN a.status='shadowban' THEN 1 ELSE 0 END) AS shadowban
       FROM accounts a WHERE ${as_.sql}`, ...as_.params,
  ) || {};

  const money = seesRevenue(user);
  const costs = seesExpenses(user);
  const revenue = Number(rev.revenue || 0);
  const expenses = Number(exp.expenses || 0);
  const profit = revenue - expenses;

  return {
    from, to,
    revenue: money ? revenue : null,
    expenses: costs ? expenses : null,
    profit: money && costs ? profit : null,
    roi: money && costs && expenses > 0 ? (profit / expenses) * 100 : null,
    hold_amount: money ? Number(holdRow.hold_amount || 0) : null,
    conversions: Number(rev.conversions || 0),
    deps: Number(rev.deps || 0),
    regs: Number(rev.regs || 0),
    posts: Number(posts.posts || 0),
    views: Number(posts.views || 0),
    clicks: Number(posts.clicks || 0),
    ctr: posts.views > 0 ? (posts.clicks / posts.views) * 100 : null,
    cr_click_reg: posts.clicks > 0 ? (Number(rev.regs || 0) / posts.clicks) * 100 : null,
    cr_reg_dep: rev.regs > 0 ? (Number(rev.deps || 0) / Number(rev.regs)) * 100 : null,
    epm: money && posts.views > 0 ? (revenue / posts.views) * 1000 : null,
    accounts: {
      total: Number(acc.total || 0), active: Number(acc.active || 0), farm: Number(acc.farm || 0),
      banned: Number(acc.banned || 0), shadowban: Number(acc.shadowban || 0),
    },
  };
}

// Динаміка по днях: дохід, витрати, публікації, бани.
export async function timeline(user, query = {}) {
  const { from, to, toEnd } = period(query);
  const cs = scoped(user, 'conversions', 'c');
  const ps = scoped(user, 'posts', 'p');
  const es = scoped(user, 'expenses', 'e');

  const rows = new Map();
  const touch = (d) => {
    if (!rows.has(d)) rows.set(d, { date: d, revenue: 0, expenses: 0, posts: 0, deps: 0, bans: 0 });
    return rows.get(d);
  };
  for (let t = new Date(from); t <= new Date(to); t = new Date(t.getTime() + 864e5)) touch(t.toISOString().slice(0, 10));

  for (const r of await all(
    `SELECT date(c.converted_at) AS d, COALESCE(SUM(c.payout),0) AS revenue,
            SUM(CASE WHEN c.event='dep' THEN 1 ELSE 0 END) AS deps
       FROM conversions c WHERE c.converted_at BETWEEN ? AND ? AND c.status IN ${REVENUE_STATUSES} AND ${cs.sql}
      GROUP BY d`, from, toEnd, ...cs.params)) {
    Object.assign(touch(r.d), { revenue: Number(r.revenue), deps: Number(r.deps) });
  }
  for (const r of await all(
    `SELECT date(p.posted_at) AS d, COUNT(*) AS posts FROM posts p
      WHERE p.posted_at BETWEEN ? AND ? AND ${ps.sql} GROUP BY d`, from, toEnd, ...ps.params)) {
    touch(r.d).posts = Number(r.posts);
  }
  for (const r of await all(
    `SELECT e.spent_at AS d, COALESCE(SUM(e.amount),0) AS expenses FROM expenses e
      WHERE e.spent_at BETWEEN ? AND ? AND ${es.sql} GROUP BY d`, from, to, ...es.params)) {
    touch(r.d).expenses = Number(r.expenses);
  }
  const as2 = scoped(user, 'accounts', 'a');
  for (const r of await all(
    `SELECT date(e.created_at) AS d, COUNT(*) AS bans FROM account_events e
       JOIN accounts a ON a.id = e.account_id
      WHERE e.to_status='ban' AND e.created_at BETWEEN ? AND ? AND ${as2.sql} GROUP BY d`, from, toEnd, ...as2.params)) {
    touch(r.d).bans = Number(r.bans);
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const DIMS = {
  offer: { postKey: 'p.offer_id', convKey: 'c.offer_id', label: 'SELECT id, name FROM offers' },
  user: { postKey: 'p.user_id', convKey: 'c.user_id', label: 'SELECT id, name FROM users' },
  account: { postKey: 'p.account_id', convKey: 'c.account_id', label: 'SELECT id, nickname AS name FROM accounts' },
  creative: { postKey: 'p.creative_id', convKey: 'c.creative_id', label: 'SELECT id, title AS name FROM creatives' },
  geo: { postJoin: 'JOIN accounts a ON a.id=p.account_id', postKey: 'a.geo', convJoin: 'LEFT JOIN accounts a ON a.id=c.account_id', convKey: 'a.geo' },
  platform: { postJoin: 'JOIN accounts a ON a.id=p.account_id', postKey: 'a.platform', convJoin: 'LEFT JOIN accounts a ON a.id=c.account_id', convKey: 'a.platform' },
  team: { postKey: 'p.team_id', convKey: '(SELECT team_id FROM users u WHERE u.id=c.user_id)', label: 'SELECT id, name FROM teams' },
};

export async function breakdown(user, query = {}) {
  const dim = DIMS[query.dim] ? query.dim : 'offer';
  const d = DIMS[dim];
  const { from, to, toEnd } = period(query);
  const cs = scoped(user, 'conversions', 'c');
  const ps = scoped(user, 'posts', 'p');

  const map = new Map();
  const touch = (k) => {
    const key = k === null || k === undefined ? '—' : String(k);
    if (!map.has(key)) map.set(key, { key, label: key, posts: 0, views: 0, clicks: 0, regs: 0, deps: 0, revenue: 0, cost: 0 });
    return map.get(key);
  };

  for (const r of await all(
    `SELECT ${d.postKey} AS k, COUNT(*) AS posts, COALESCE(SUM(p.views),0) AS views, COALESCE(SUM(p.clicks),0) AS clicks
       FROM posts p ${d.postJoin || ''}
      WHERE p.posted_at BETWEEN ? AND ? AND ${ps.sql} GROUP BY k`, from, toEnd, ...ps.params)) {
    Object.assign(touch(r.k), { posts: Number(r.posts), views: Number(r.views), clicks: Number(r.clicks) });
  }
  for (const r of await all(
    `SELECT ${d.convKey} AS k, COALESCE(SUM(c.payout),0) AS revenue,
            SUM(CASE WHEN c.event='dep' THEN 1 ELSE 0 END) AS deps,
            SUM(CASE WHEN c.event='reg' THEN 1 ELSE 0 END) AS regs
       FROM conversions c ${d.convJoin || ''}
      WHERE c.converted_at BETWEEN ? AND ? AND c.status IN ${REVENUE_STATUSES} AND ${cs.sql} GROUP BY k`, from, toEnd, ...cs.params)) {
    const row = touch(r.k);
    row.revenue = Number(r.revenue); row.deps = Number(r.deps); row.regs = Number(r.regs);
  }

  // Собівартість ресурсу для розрізів, де вона однозначна.
  if (dim === 'account' || dim === 'geo' || dim === 'platform') {
    const col = dim === 'account' ? 'id' : dim;
    for (const r of await all(`SELECT ${col} AS k, COALESCE(SUM(cost),0) AS cost FROM accounts GROUP BY k`)) {
      touch(r.k).cost = Number(r.cost);
    }
  }
  if (dim === 'user' || dim === 'team') {
    const col = dim === 'user' ? 'user_id' : 'team_id';
    for (const r of await all(
      `SELECT ${col} AS k, COALESCE(SUM(amount),0) AS cost FROM expenses
        WHERE spent_at BETWEEN ? AND ? GROUP BY k`, from, to)) {
      touch(r.k).cost = Number(r.cost);
    }
  }

  const labels = new Map();
  if (d.label) for (const r of await all(d.label)) labels.set(String(r.id), r.name);

  const money = seesRevenue(user);
  const costs = seesExpenses(user);
  return [...map.values()].map((r) => {
    const profit = r.revenue - r.cost;
    return {
      ...r,
      label: labels.get(r.key) || r.label,
      revenue: money ? r.revenue : null,
      cost: costs ? r.cost : null,
      profit: money && costs ? profit : null,
      roi: money && costs && r.cost > 0 ? (profit / r.cost) * 100 : null,
      cr: r.clicks > 0 ? (r.deps / r.clicks) * 100 : null,
      epm: money && r.views > 0 ? (r.revenue / r.views) * 1000 : null,
    };
  }).sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0) || b.deps - a.deps || b.posts - a.posts);
}

// Середній час життя акаунта по гео/платформі + топ причин згорання.
export async function accountLifetime() {
  return await all(
    `SELECT a.platform, COALESCE(a.geo,'—') AS geo, COUNT(*) AS banned_accounts,
            ROUND(AVG(julianday(a.banned_at) - julianday(COALESCE(a.live_started_at, a.farm_started_at, a.created_at))), 1) AS avg_days,
            ROUND(AVG(a.cost), 2) AS avg_cost
       FROM accounts a
      WHERE a.status='ban' AND a.banned_at IS NOT NULL
      GROUP BY a.platform, geo
      ORDER BY banned_accounts DESC`,
  );
}

// Вигорання звʼязок: креативи, у яких CR за останні 7 днів впав відносно попередніх 7.
export async function burnout(user) {
  const rows = await all(
    `WITH win AS (
       SELECT p.creative_id AS cid,
              CASE WHEN p.posted_at >= datetime('now','-7 days') THEN 'recent' ELSE 'prev' END AS bucket,
              COUNT(*) AS posts, COALESCE(SUM(p.views),0) AS views
         FROM posts p
        WHERE p.posted_at >= datetime('now','-14 days') AND p.creative_id IS NOT NULL
        GROUP BY cid, bucket),
     conv AS (
       SELECT c.creative_id AS cid,
              CASE WHEN c.converted_at >= datetime('now','-7 days') THEN 'recent' ELSE 'prev' END AS bucket,
              COUNT(*) AS deps, COALESCE(SUM(c.payout),0) AS revenue
         FROM conversions c
        WHERE c.converted_at >= datetime('now','-14 days') AND c.event='dep' AND c.status IN ${REVENUE_STATUSES}
        GROUP BY cid, bucket)
     SELECT cr.id, cr.title, cr.status,
            COALESCE(MAX(CASE WHEN win.bucket='recent' THEN win.views END),0) AS views_recent,
            COALESCE(MAX(CASE WHEN win.bucket='prev' THEN win.views END),0) AS views_prev,
            COALESCE(MAX(CASE WHEN conv.bucket='recent' THEN conv.deps END),0) AS deps_recent,
            COALESCE(MAX(CASE WHEN conv.bucket='prev' THEN conv.deps END),0) AS deps_prev,
            COALESCE(MAX(CASE WHEN conv.bucket='recent' THEN conv.revenue END),0) AS revenue_recent
       FROM creatives cr
       LEFT JOIN win ON win.cid=cr.id
       LEFT JOIN conv ON conv.cid=cr.id
      GROUP BY cr.id
     HAVING views_recent > 0 OR views_prev > 0`,
  );
  return rows.map((r) => {
    const crRecent = r.views_recent > 0 ? r.deps_recent / r.views_recent : 0;
    const crPrev = r.views_prev > 0 ? r.deps_prev / r.views_prev : 0;
    const drop = crPrev > 0 ? ((crPrev - crRecent) / crPrev) * 100 : null;
    return { ...r, cr_recent: crRecent * 100, cr_prev: crPrev * 100, drop_pct: drop, burning: drop !== null && drop >= 40 && r.views_recent >= r.views_prev * 0.7 };
  }).sort((a, b) => (b.drop_pct ?? -1) - (a.drop_pct ?? -1));
}

// Що горить просто зараз: протермінована проксі, бани за добу, невиконаний план.
export async function alerts(user) {
  const acc = scoped(user, 'accounts', 'a');
  const proxyExpiring = can(user, 'proxies', 'read') ? await all(
    `SELECT id, provider, geo, paid_until FROM proxies
      WHERE status='active' AND paid_until IS NOT NULL AND date(paid_until) <= date('now','+3 days')
      ORDER BY paid_until`) : [];
  const bans24 = await all(
    `SELECT a.id, a.nickname, a.platform, e.created_at FROM account_events e
       JOIN accounts a ON a.id=e.account_id
      WHERE e.to_status='ban' AND e.created_at >= datetime('now','-1 day') AND ${acc.sql}
      ORDER BY e.created_at DESC`, ...acc.params);
  const kpi = scoped(user, 'kpi_targets', 'k');
  const planToday = await all(
    `SELECT u.id, u.name, k.target,
            (SELECT COUNT(*) FROM posts p WHERE p.user_id=u.id AND date(p.posted_at)=date('now')) AS fact
       FROM kpi_targets k JOIN users u ON u.id=k.user_id
      WHERE k.metric='posts' AND k.period IN (date('now'), strftime('%Y-%m','now')) AND ${kpi.sql}`, ...kpi.params);
  return { proxyExpiring, bans24, planToday: planToday.filter((p) => p.fact < p.target) };
}
