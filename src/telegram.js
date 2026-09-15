// Сповіщення: черга в БД + відправка через Telegram Bot API.
// Без токена CRM_TELEGRAM_TOKEN усе просто накопичується в notifications.
import { all, get, insert, run } from './db.js';

const TOKEN = () => process.env.CRM_TELEGRAM_TOKEN || '';
const CHAT = () => process.env.CRM_TELEGRAM_CHAT_ID || '';

export async function notify(kind, text, userId = null) {
  return await insert('notifications', { kind, text: String(text).slice(0, 2000), user_id: userId });
}

async function sendOne(n) {
  const chat = n.user_id ? await get('SELECT telegram_id FROM users WHERE id=?', n.user_id)?.telegram_id || CHAT() : CHAT();
  if (!TOKEN() || !chat) return { skipped: true };
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: n.text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { sent: true };
}

export async function flushQueue(limit = 20) {
  const pending = await all(`SELECT * FROM notifications WHERE status='pending' ORDER BY id LIMIT ?`, limit);
  let sent = 0;
  for (const n of pending) {
    try {
      const r = await sendOne(n);
      if (r.skipped) continue;                       // залишаємо в черзі до налаштування бота
      await run(`UPDATE notifications SET status='sent', sent_at=datetime('now') WHERE id=?`, n.id);
      sent += 1;
    } catch (e) {
      await run(`UPDATE notifications SET status='failed', error=? WHERE id=?`, String(e.message).slice(0, 300), n.id);
    }
  }
  return { pending: pending.length, sent };
}

// Періодичні перевірки: проксі, план на день, бани.
export async function runChecks() {
  for (const p of await all(
    `SELECT id, provider, geo, paid_until FROM proxies
      WHERE status='active' AND paid_until IS NOT NULL AND date(paid_until) <= date('now','+2 days')`)) {
    const key = `notified:proxy:${p.id}:${p.paid_until}`;
    if (await get('SELECT value FROM settings WHERE key=?', key)) continue;
    await notify('proxy_expiry', `⚠️ Проксі #${p.id} (${p.provider || '—'}, ${p.geo || '—'}) оплачено до ${p.paid_until}`);
    await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, '1');
  }
  for (const k of await all(
    `SELECT k.id, u.name, u.id AS user_id, k.target,
            (SELECT COUNT(*) FROM posts p WHERE p.user_id=u.id AND date(p.posted_at)=date('now')) AS fact
       FROM kpi_targets k JOIN users u ON u.id=k.user_id
      WHERE k.metric='posts' AND k.period=date('now')`)) {
    if (k.fact >= k.target) continue;
    const key = `notified:plan:${k.id}:${new Date().toISOString().slice(0, 10)}`;
    if (await get('SELECT value FROM settings WHERE key=?', key)) continue;
    await notify('plan', `📉 ${k.name}: план ${k.target} відео, факт ${k.fact}`, k.user_id);
    await run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, '1');
  }
}
