// Клієнти: лід виграно → клієнт створюється сам (setStatus у prospecting.js
// реагує на lead_statuses.is_won). Далі клієнт живе окремо від воронки —
// підписки на послуги з costing.js, історія статусів, нотатки.
import { all, get, run, insert, update } from './db.js';
import { notify } from './telegram.js';

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toISOString().slice(0, 10);

const CHURN_REASONS = [
  ['price', 'Дорого'], ['no_result', 'Не влаштував результат'], ['in_house', 'Перейшли на власні ресурси'],
  ['competitor', 'Пішли до конкурента'], ['budget_cut', 'Скоротили бюджет'], ['other', 'Інше'],
];

export async function seedClients() {
  // Довідник причин відтоку доливаємо незалежно від того, чи вже сідились
  // довідники пошуку клієнтів — інакше на наявній базі цей kind не з'явиться.
  if (!(await get(`SELECT id FROM dictionaries WHERE kind='churn_reason' LIMIT 1`))) {
    for (const [i, [code, label]] of CHURN_REASONS.entries()) {
      await insert('dictionaries', { kind: 'churn_reason', code, label, sort_order: (i + 1) * 10 });
    }
  }
}

// Викликається з prospecting.js, коли лід переходить у статус із is_won=1.
// Ідемпотентно: повторний виграш того самого ліда (якщо статус відкотили
// й знову виграли) не плодить дублікатів клієнта.
export async function ensureClientFromLead(lead, actorId) {
  const existing = await get('SELECT id FROM clients WHERE source_lead_id=?', lead.id);
  if (existing) return existing.id;
  return insert('clients', {
    name: lead.company_name,
    source_lead_id: lead.id,
    owner_user_id: lead.owner_user_id ?? actorId,
    team_id: lead.team_id ?? null,
    website: lead.website ?? null,
    geo_city: lead.geo_city ?? null,
    geo_country: lead.geo_country ?? null,
    vertical: lead.vertical ?? null,
    status: 'active',
    started_at: today(),
    created_by: actorId,
  });
}

function lineTotal(row) {
  const price = row.price_override != null ? Number(row.price_override) : Number(row.price ?? 0);
  return Math.round(price * Number(row.quantity) * 100) / 100;
}

export async function clientCard(clientId) {
  const client = await get('SELECT * FROM clients WHERE id=?', clientId);
  if (!client) throw Object.assign(new Error('Клієнта не знайдено'), { status: 404 });

  const services = (await all(
    `SELECT cs.*, s.name AS service_name, s.unit, s.price
       FROM client_services cs JOIN services s ON s.id=cs.service_id
      WHERE cs.client_id=? ORDER BY cs.status='active' DESC, cs.id`, clientId))
    .map((row) => ({ ...row, total: lineTotal(row) }));

  const mrr = services.filter((s) => s.status === 'active').reduce((sum, s) => sum + s.total, 0);

  return {
    client,
    services,
    mrr: Math.round(mrr * 100) / 100,
    notes: await all('SELECT * FROM client_notes WHERE client_id=? ORDER BY created_at DESC', clientId),
    history: await all('SELECT * FROM client_status_history WHERE client_id=? ORDER BY created_at DESC', clientId),
    sourceLead: client.source_lead_id ? await get('SELECT id, company_name, status_code FROM leads WHERE id=?', client.source_lead_id) : null,
  };
}

export async function addService(clientId, payload) {
  const service = await get('SELECT * FROM services WHERE id=?', payload.service_id);
  if (!service) throw Object.assign(new Error('Послугу не знайдено'), { status: 400 });
  const quantity = Number(payload.quantity || 1);
  if (!(quantity > 0)) throw Object.assign(new Error('Кількість має бути більшою за нуль'), { status: 400 });
  await insert('client_services', {
    client_id: clientId, service_id: service.id, quantity,
    price_override: payload.price_override === '' || payload.price_override == null ? null : Number(payload.price_override),
    status: payload.status || 'active', started_at: payload.started_at || today(), note: payload.note ?? null,
  });
  return clientCard(clientId);
}

export async function updateService(clientId, rowId, payload) {
  const data = {};
  for (const key of ['quantity', 'price_override', 'status', 'note', 'ended_at']) {
    if (!(key in payload)) continue;
    if (key === 'quantity') data.quantity = Number(payload.quantity || 0);
    else if (key === 'price_override') data.price_override = payload.price_override === '' || payload.price_override == null ? null : Number(payload.price_override);
    else data[key] = payload[key] || null;
  }
  if (data.status === 'canceled' && !data.ended_at) data.ended_at = today();
  await update('client_services', rowId, data);
  return clientCard(clientId);
}

export async function removeService(clientId, rowId) {
  await run('DELETE FROM client_services WHERE id=? AND client_id=?', rowId, clientId);
  return clientCard(clientId);
}

const TERMINAL_TO_FIELD = { paused: 'paused_at', churned: 'churned_at' };

export async function setClientStatus(user, clientId, statusTo, { reason = null, note = null } = {}) {
  const client = await get('SELECT * FROM clients WHERE id=?', clientId);
  if (!client) throw Object.assign(new Error('Клієнта не знайдено'), { status: 404 });
  if (!['active', 'paused', 'churned'].includes(statusTo)) {
    throw Object.assign(new Error('Невідомий статус'), { status: 400 });
  }
  if (statusTo === 'churned' && !reason) {
    throw Object.assign(new Error('Вкажіть причину відтоку'), { status: 400 });
  }

  const patch = { status: statusTo, updated_at: now() };
  if (statusTo === 'active') { patch.paused_at = null; patch.churned_at = null; patch.churn_reason = null; }
  if (TERMINAL_TO_FIELD[statusTo]) patch[TERMINAL_TO_FIELD[statusTo]] = today();
  if (statusTo === 'churned') {
    patch.churn_reason = reason;
    // Активні підписки самі не скасовуються — рахунок за них більше не
    // виставляють, тому знімаємо їх з MRR разом зі статусом клієнта.
    await run(`UPDATE client_services SET status='canceled', ended_at=? WHERE client_id=? AND status='active'`, today(), clientId);
  }

  await update('clients', clientId, patch);
  await insert('client_status_history', { client_id: clientId, from_status: client.status, to_status: statusTo, reason, user_id: user.id, note });
  if (statusTo === 'churned') {
    await notify('client', `⚠️ Клієнт «${client.name}» пішов у відтік: ${reason}`, client.owner_user_id);
  }
  return { ok: true, status: statusTo };
}

export async function summary(scopeSql, scopeParams) {
  const counts = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) AS paused,
            SUM(CASE WHEN status='churned' THEN 1 ELSE 0 END) AS churned
       FROM clients c WHERE ${scopeSql}`, ...scopeParams);

  const mrrRow = await get(
    `SELECT COALESCE(SUM(
              CASE WHEN cs.price_override IS NOT NULL THEN cs.price_override ELSE s.price END * cs.quantity
            ), 0) AS mrr
       FROM client_services cs
       JOIN services s ON s.id=cs.service_id
       JOIN clients c ON c.id=cs.client_id
      WHERE cs.status='active' AND ${scopeSql}`, ...scopeParams);

  const churnedRecently = await get(
    `SELECT COUNT(*) AS c FROM clients c
      WHERE status='churned' AND churned_at >= date('now','-30 days') AND ${scopeSql}`, ...scopeParams);

  const activeAtStart = Number(counts?.active || 0) + Number(churnedRecently?.c || 0);
  return {
    total: Number(counts?.total || 0),
    active: Number(counts?.active || 0),
    paused: Number(counts?.paused || 0),
    churned: Number(counts?.churned || 0),
    mrr: Math.round(Number(mrrRow?.mrr || 0) * 100) / 100,
    churned_30d: Number(churnedRecently?.c || 0),
    churn_rate_30d: activeAtStart > 0 ? Math.round((Number(churnedRecently?.c || 0) / activeAtStart) * 1000) / 10 : null,
  };
}
