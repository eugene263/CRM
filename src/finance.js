// Фінанси: формула ЗП (фікс + % від профіту + бонус за KPI) та P&L.
import { all, get, run, insert, audit } from './db.js';

const bounds = (period) => {
  const from = `${period}-01`;
  const [y, m] = period.split('-').map(Number);
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from, to, toEnd: `${to} 23:59:59` };
};

export function ruleFor(user, period) {
  const { to } = bounds(period);
  return get(
    `SELECT * FROM salary_rules WHERE user_id=? AND date(active_from)<=date(?)
      ORDER BY date(active_from) DESC LIMIT 1`, user.id, to)
    || get(
    `SELECT * FROM salary_rules WHERE user_id IS NULL AND role=? AND date(active_from)<=date(?)
      ORDER BY date(active_from) DESC LIMIT 1`, user.role, to)
    || null;
}

// Профіт співробітника = апрувнутий дохід мінус витрати, повішані на нього.
// Тімлід рахується по своїй команді, хед/власник — по всій компанії: інакше
// «% від профіту» для керівних ролей завжди виходить нулем.
function scopeSql(user) {
  if (!user || user.role === 'creator' || user.role === 'editor' || user.role === 'farmer') {
    return { conv: 'c.user_id = ?', exp: 'e.user_id = ?', post: 'p.user_id = ?', params: [user?.id] };
  }
  if (user.role === 'teamlead') {
    const team = user.team_id ?? null;
    return {
      conv: 'c.user_id IN (SELECT id FROM users WHERE team_id IS ?)',
      exp: '(e.team_id IS ? OR e.user_id IN (SELECT id FROM users WHERE team_id IS ?))',
      post: 'p.team_id IS ?',
      params: [team], expParams: [team, team], postParams: [team],
    };
  }
  return { conv: '1=1', exp: '1=1', post: '1=1', params: [], expParams: [], postParams: [] };
}

export function userStats(userId, period) {
  const { from, to, toEnd } = bounds(period);
  const user = get('SELECT id, role, team_id FROM users WHERE id=?', userId);
  const sc = scopeSql(user);
  const convParams = sc.params.filter((v) => v !== undefined);
  const expParams = (sc.expParams ?? sc.params).filter((v) => v !== undefined);
  const postParams = (sc.postParams ?? sc.params).filter((v) => v !== undefined);
  const rev = get(
    `SELECT COALESCE(SUM(c.payout),0) AS revenue,
            SUM(CASE WHEN c.event='dep' THEN 1 ELSE 0 END) AS deps
       FROM conversions c
      WHERE ${sc.conv} AND c.status IN ('approved','paid') AND c.converted_at BETWEEN ? AND ?`,
    ...convParams, from, toEnd) || { revenue: 0, deps: 0 };
  const exp = get(
    `SELECT COALESCE(SUM(e.amount),0) AS expenses FROM expenses e
      WHERE ${sc.exp} AND e.category<>'salary' AND e.spent_at BETWEEN ? AND ?`, ...expParams, from, to) || { expenses: 0 };
  const posts = get(
    `SELECT COUNT(*) AS posts FROM posts p WHERE ${sc.post} AND p.posted_at BETWEEN ? AND ?`, ...postParams, from, toEnd) || { posts: 0 };
  const revenue = Number(rev.revenue || 0);
  const expenses = Number(exp.expenses || 0);
  return { revenue, expenses, profit: revenue - expenses, deps: Number(rev.deps || 0), posts: Number(posts.posts || 0) };
}

export function calcSalary(period, { commit = false, actorId = null } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw Object.assign(new Error('period має бути YYYY-MM'), { status: 400 });
  const users = all(`SELECT * FROM users WHERE status='active'`);
  const rows = [];
  for (const u of users) {
    const rule = ruleFor(u, period);
    if (!rule) continue;
    const stats = userStats(u.id, period);
    const fix = Number(rule.fix_amount || 0);
    const percent = Math.max(0, stats.profit) * (Number(rule.percent_of_profit || 0) / 100);
    let bonus = 0;
    if (rule.bonus_metric && Number(rule.bonus_target || 0) > 0) {
      const fact = { posts: stats.posts, deps: stats.deps, profit: stats.profit }[rule.bonus_metric] ?? 0;
      if (fact >= Number(rule.bonus_target)) bonus = Number(rule.bonus_amount || 0);
    }
    const total = Math.round((fix + percent + bonus) * 100) / 100;
    const row = {
      user_id: u.id, user: u.name, role: u.role, period,
      fix_amount: fix, percent_amount: Math.round(percent * 100) / 100, bonus_amount: bonus, total,
      rule_id: rule.id, ...stats,
    };
    rows.push(row);

    if (commit) {
      const existing = get('SELECT * FROM payouts WHERE user_id=? AND period=?', u.id, period);
      if (existing && existing.status === 'paid') { row.skipped = 'вже виплачено'; continue; }
      if (existing) {
        run(`UPDATE payouts SET fix_amount=?, percent_amount=?, bonus_amount=?, total=?, status='accrued' WHERE id=?`,
          fix, row.percent_amount, bonus, total, existing.id);
        row.payout_id = existing.id;
      } else {
        row.payout_id = insert('payouts', {
          user_id: u.id, period, fix_amount: fix, percent_amount: row.percent_amount,
          bonus_amount: bonus, total, status: 'accrued',
        });
      }
    }
  }
  if (commit) audit({ user_id: actorId, action: 'salary_calc', entity: 'payouts', payload: { period, users: rows.length } });
  return { period, rows, total: Math.round(rows.reduce((s, r) => s + r.total, 0) * 100) / 100, committed: commit };
}

export function pnl(period) {
  const { from, to, toEnd } = bounds(period);
  const revenue = Number(get(
    `SELECT COALESCE(SUM(payout),0) AS v FROM conversions
      WHERE status IN ('approved','paid') AND converted_at BETWEEN ? AND ?`, from, toEnd)?.v || 0);
  const hold = Number(get(
    `SELECT COALESCE(SUM(payout),0) AS v FROM conversions
      WHERE status='hold' AND converted_at BETWEEN ? AND ?`, from, toEnd)?.v || 0);
  const byCategory = all(
    `SELECT category, COALESCE(SUM(amount),0) AS amount FROM expenses
      WHERE spent_at BETWEEN ? AND ? GROUP BY category ORDER BY amount DESC`, from, to);
  const salary = Number(get(
    `SELECT COALESCE(SUM(total),0) AS v FROM payouts WHERE period=? AND status<>'canceled'`, period)?.v || 0);
  const expenses = byCategory.reduce((s, r) => s + Number(r.amount), 0);
  const profit = revenue - expenses - salary;
  return {
    period, revenue, hold, expenses, salary, profit,
    margin: revenue > 0 ? (profit / revenue) * 100 : null,
    roi: expenses + salary > 0 ? (profit / (expenses + salary)) * 100 : null,
    byCategory,
  };
}
