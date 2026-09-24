// Інтеграційні перевірки: авторизація, RBAC, постбек-дедуплікація, ЗП, аудит.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

// Той самий набір ганяється на обох двигунах: без CRM_TEST_DATABASE_URL —
// SQLite, з нею — Postgres (npm run test:pg).
const PG_URL = process.env.CRM_TEST_DATABASE_URL || '';
const dbFile = path.join(os.tmpdir(), `crm-test-${Date.now()}.db`);
const PORT = 3400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  CRM_PORT: String(PORT), CRM_POSTBACK_PORT: String(PORT + 1),
  CRM_SECRET_KEY: 'a'.repeat(64), CRM_TICK_MS: '3600000',
  ...(PG_URL ? { CRM_DATABASE_URL: PG_URL } : { CRM_DB: dbFile }),
};
let server;

const jar = {};
async function call(pathname, { method = 'GET', body, as = 'owner' } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(jar[as] ? { cookie: jar[as] } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function login(as, email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `логін ${email}`);
  jar[as] = res.headers.getSetCookie()[0].split(';')[0];
}

before(async () => {
  await new Promise((resolve, reject) => {
    const seed = spawn(process.execPath, ['src/seed.js'], { env, cwd: path.join(import.meta.dirname, '..') });
    seed.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))));
  });
  server = spawn(process.execPath, ['server.js'], { env, cwd: path.join(import.meta.dirname, '..') });
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${BASE}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  await login('owner', 'owner@gennect.local', 'gennect-admin');
  await login('creator', 'creator1@gennect.local', 'demo1234');
  await login('finance', 'finance@gennect.local', 'demo1234');
});

after(() => {
  server?.kill();
  if (!PG_URL) {
    fs.rmSync(dbFile, { force: true });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  }
});

test('без сесії API закритий', async () => {
  const res = await fetch(`${BASE}/api/accounts`);
  assert.equal(res.status, 401);
});

test('невірний пароль не пускає', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@gennect.local', password: 'wrong' }),
  });
  assert.equal(res.status, 401);
});

test('крієйтор бачить лише свої акаунти', async () => {
  const mine = await call('/api/accounts?limit=200', { as: 'creator' });
  const all = await call('/api/accounts?limit=200', { as: 'owner' });
  assert.ok(mine.data.total > 0);
  assert.ok(mine.data.total < all.data.total);
  const owners = new Set(mine.data.rows.map((r) => r.owner_user_id));
  assert.equal(owners.size, 1);
});

test('крієйтору не видно ставку офера і партнерку', async () => {
  const { data } = await call('/api/offers?limit=1', { as: 'creator' });
  assert.ok(!('payout' in data.rows[0]));
  assert.ok(!('partner_id' in data.rows[0]));
});

test('крієйтор не експортує базу і не читає чужі секрети', async () => {
  assert.equal((await call('/api/accounts/export', { as: 'creator' })).status, 403);
  assert.equal((await call('/api/salary_rules', { as: 'creator' })).status, 403);

  // Акаунт іншого крієйтора: поза скоупом — не існує для нього.
  const me = (await call('/api/auth/me', { as: 'creator' })).data.user;
  const foreign = (await call('/api/accounts?limit=200')).data.rows.find((r) => r.owner_user_id && r.owner_user_id !== me.id);
  assert.equal((await call(`/api/accounts/${foreign.id}/secret/password_enc`, { as: 'creator' })).status, 404);
});

test('добовий ліміт розкриттів зупиняє масовий злив', async () => {
  const own = (await call('/api/accounts?limit=5', { as: 'creator' })).data.rows[0];
  const defaultLimit = (await call('/api/meta', { as: 'creator' })).data.caps.reveal_daily_limit;
  assert.ok(defaultLimit > 0 && defaultLimit <= 20, `крієйтору за замовчуванням малий ліміт (${defaultLimit})`);

  await call('/api/roles/creator', { method: 'PUT', body: { reveal_daily_limit: 3 } });
  let lastStatus = 200;
  for (let i = 0; i < 5; i += 1) {
    lastStatus = (await call(`/api/accounts/${own.id}/secret/password_enc`, { as: 'creator' })).status;
  }
  assert.equal(lastStatus, 429, 'після ліміту розкриття блокується');

  // Піднімаємо межу назад, інакше решта перевірок працює з вичерпаним бюджетом.
  await call('/api/roles/creator', { method: 'PUT', body: { reveal_daily_limit: 100 } });
  assert.equal((await call(`/api/accounts/${own.id}/secret/password_enc`, { as: 'creator' })).status, 200);
});

test('паролі акаунтів не віддаються списком у відкритому вигляді', async () => {
  const { data } = await call('/api/accounts?limit=5');
  assert.equal(data.rows[0].password_enc, '••••••');
  const revealed = await call('/api/accounts/1/secret/password_enc');
  assert.equal(revealed.status, 200);
  assert.match(revealed.data.value, /^acc-/);
});

test('розкриття секрету і експорт пишуться в аудит', async () => {
  await call('/api/accounts/export?limit=5');
  const { data } = await call('/api/audit_log?limit=20');
  const actions = data.rows.map((r) => r.action);
  assert.ok(actions.includes('reveal'));
  assert.ok(actions.includes('export'));
});

test('експорт CSV має водяний знак з email', async () => {
  const res = await fetch(`${BASE}/api/accounts/export?limit=3`, { headers: { cookie: jar.owner } });
  const text = await res.text();
  assert.match(text.split('\n')[0], /owner@gennect\.local/);
});

test('зміна статусу акаунта пише подію і дату бану', async () => {
  const created = await call('/api/accounts', { method: 'POST', body: { platform: 'tiktok', nickname: 'test_ban', status: 'farm' } });
  const id = created.data.id;
  await call(`/api/accounts/${id}`, { method: 'PUT', body: { status: 'ban' } });
  const row = (await call(`/api/accounts/${id}`)).data.row;
  assert.equal(row.status, 'ban');
  assert.ok(row.banned_at);
  const history = (await call(`/api/accounts/${id}/history`)).data.rows;
  assert.ok(history.some((h) => h.to_status === 'ban'));
});

test('зміна ставки офера пише історію', async () => {
  const offer = (await call('/api/offers?limit=1')).data.rows[0];
  const before = (await call(`/api/offer_rates_history?offer_id=${offer.id}`)).data.total;
  await call(`/api/offers/${offer.id}`, { method: 'PUT', body: { payout: Number(offer.payout) + 5 } });
  const after = (await call(`/api/offer_rates_history?offer_id=${offer.id}`)).data.total;
  assert.equal(after, before + 1);
});

test('постбек створює конверсію і дедуплікується', async () => {
  const partner = (await call('/api/partners?limit=1')).data.rows[0];
  const url = `${BASE}/pb/${partner.postback_token}?external_id=dup-1&status=hold&event=dep&payout=40&sub3=5`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url.replace('status=hold', 'status=approved'))).status, 200);
  const { data } = await call('/api/conversions?external_id=dup-1');
  assert.equal(data.total, 1, 'дубль не створюється');
  assert.equal(data.rows[0].status, 'approved', 'статус оновлюється hold → approved');
});

test('постбек з чужим токеном відхиляється', async () => {
  const res = await fetch(`${BASE}/pb/not-a-token?external_id=x`);
  assert.equal(res.status, 403);
});

test('трекінг-лінк рахує клік і проставляє subid', async () => {
  const link = (await call('/api/tracking_links?limit=1')).data.rows[0];
  const before = link.clicks;
  const res = await fetch(`${BASE}/r/${link.slug}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.ok(location.searchParams.get('click_id'));
  assert.equal(location.searchParams.get('sub2'), String(link.creative_id));
  const after = (await call(`/api/tracking_links?slug=${link.slug}`)).data.rows[0];
  assert.equal(after.clicks, before + 1);
});

test('ЗП рахується за формулою фікс + % + бонус', async () => {
  const period = new Date().toISOString().slice(0, 7);
  const { data } = await call(`/api/finance/salary?period=${period}`, { as: 'finance' });
  assert.ok(data.rows.length > 0);
  for (const r of data.rows) {
    assert.equal(Math.round(r.total * 100) / 100, Math.round((r.fix_amount + r.percent_amount + r.bonus_amount) * 100) / 100);
  }
  const commit = await call('/api/finance/salary', { method: 'POST', body: { period, commit: true }, as: 'finance' });
  assert.ok(commit.data.rows.every((r) => r.payout_id || r.skipped));
  const payouts = await call(`/api/payouts?period=${period}`, { as: 'finance' });
  assert.ok(payouts.data.total > 0);
});

test('крієйтор бачить лише свою виплату і не бачить ROI команди', async () => {
  const mine = await call('/api/payouts', { as: 'creator' });
  assert.ok(mine.data.rows.every((r) => r.user_id === mine.data.rows[0].user_id));
  const dash = await call('/api/dashboard', { as: 'creator' });
  assert.equal(dash.data.summary.revenue, null);
  assert.equal(dash.data.summary.roi, null);
  assert.ok(dash.data.summary.posts > 0);
});

test('імпорт конверсій з CSV не дублює external_id', async () => {
  const csv = 'converted_at,event,status,payout,external_id\n2026-01-01 10:00:00,dep,approved,50,imp-1\n2026-01-01 10:00:00,dep,approved,50,imp-1\n';
  const res = await call('/api/import/conversions', { method: 'POST', body: { csv }, as: 'finance' });
  assert.equal(res.data.imported, 1);
  assert.equal(res.data.skipped, 1);
});

// ── Сейф доступів і конструктор ролей ────────────────────────────────────

async function makeCredential(overrides = {}) {
  const res = await call('/api/credentials', {
    method: 'POST',
    body: {
      title: 'Тестовий доступ', kind: 'service', login: 'manager@example.com',
      password_enc: 'super-secret', totp_seed_enc: 'JBSWY3DPEHPK3PXP', sensitivity: 'normal', ...overrides,
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.id;
}

test('секрет сейфа не віддається списком і маскує логін для чужих', async () => {
  const id = await makeCredential();
  const list = await call('/api/credentials?limit=50');
  const row = list.data.rows.find((r) => r.id === id);
  assert.equal(row.password_enc, '••••••');
  assert.equal(row.login, 'manager@example.com', 'власнику/адміну логін видно повністю');

  const creatorView = await call('/api/credentials?limit=50', { as: 'creator' });
  assert.ok(!creatorView.data.rows.some((r) => r.id === id), 'чужий доступ у списку крієйтора не зʼявляється');
});

test('розкриття секрету доступне власнику і пишеться в аудит', async () => {
  const id = await makeCredential();
  const res = await call(`/api/credentials/${id}/reveal/password_enc`);
  assert.equal(res.status, 200);
  assert.equal(res.data.value, 'super-secret');
  assert.ok(res.data.limit > 0 && res.data.used > 0);
  const log = await call('/api/audit_log?limit=10');
  assert.ok(log.data.rows.some((r) => r.action === 'reveal' && r.entity === 'credentials' && r.entity_id === id));
});

test('крієйтор не бачить чужий секрет, але бачить виданий йому', async () => {
  const id = await makeCredential({ title: 'Доступ для крієйтора' });
  const creatorId = (await call('/api/auth/me', { as: 'creator' })).data.user.id;

  const denied = await call(`/api/credentials/${id}/reveal/password_enc`, { as: 'creator' });
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /не виданий/);

  const issued = await call(`/api/credentials/${id}/issue`, { method: 'POST', body: { user_id: creatorId } });
  assert.equal(issued.status, 200);

  const allowed = await call(`/api/credentials/${id}/reveal/password_enc`, { as: 'creator' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.value, 'super-secret');
});

test('чутлива категорія вимагає апруву', async () => {
  const id = await makeCredential({ title: 'Картка', kind: 'card', sensitivity: 'sensitive' });
  const creatorId = (await call('/api/auth/me', { as: 'creator' })).data.user.id;
  await call(`/api/credentials/${id}/issue`, { method: 'POST', body: { user_id: creatorId } });

  const denied = await call(`/api/credentials/${id}/reveal/password_enc`, { as: 'creator' });
  assert.equal(denied.status, 403);
  assert.ok(denied.data.needApproval);

  const request = await call('/api/access_requests', { method: 'POST', body: { credential_id: id, reason: 'треба поповнити' }, as: 'creator' });
  assert.equal(request.status, 200);
  const decided = await call(`/api/access_requests/${request.data.id}/decide`, { method: 'POST', body: { approve: true } });
  assert.equal(decided.status, 200);

  const allowed = await call(`/api/credentials/${id}/reveal/password_enc`, { as: 'creator' });
  assert.equal(allowed.status, 200);
});

test('повернення доступу ставить прапорець ротації', async () => {
  const id = await makeCredential({ title: 'Ротація' });
  const creatorId = (await call('/api/auth/me', { as: 'creator' })).data.user.id;
  await call(`/api/credentials/${id}/issue`, { method: 'POST', body: { user_id: creatorId } });
  const back = await call(`/api/credentials/${id}/return`, { method: 'POST', body: { state_in: 'ок' } });
  assert.equal(back.status, 200);
  const row = (await call(`/api/credentials/${id}`)).data.row;
  assert.equal(row.rotate_required, 1);
  assert.equal(row.holder_user_id, null);
});

test('2FA-код видається без розкриття сіда', async () => {
  const id = await makeCredential({ title: '2FA' });
  const res = await call(`/api/credentials/${id}/totp`);
  assert.equal(res.status, 200);
  assert.match(res.data.code, /^\d{6}$/);
});

test('офбординг відкликає доступи, вбиває сесії й вимикає акаунт', async () => {
  const id = await makeCredential({ title: 'Офбординг' });
  const victim = (await call('/api/users?email=editor@gennect.local')).data.rows[0];
  await call(`/api/credentials/${id}/issue`, { method: 'POST', body: { user_id: victim.id } });

  const res = await call(`/api/users/${victim.id}/offboard`, { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.ok(res.data.revoked >= 1);

  const cred = (await call(`/api/credentials/${id}`)).data.row;
  assert.equal(cred.status, 'compromised');
  assert.equal(cred.rotate_required, 1);
  const user = (await call(`/api/users/${victim.id}`)).data.row;
  assert.equal(user.status, 'disabled');
});

test('ролі редагуються без деплою і одразу діють', async () => {
  const before = await call('/api/creatives?limit=1', { as: 'creator' });
  assert.equal(before.status, 200);

  await call('/api/roles/creator', {
    method: 'PUT',
    body: { permissions: [{ entity: 'creatives', level: 'none', scope: 'own', hidden_fields: [] }] },
  });
  const denied = await call('/api/creatives?limit=1', { as: 'creator' });
  assert.equal(denied.status, 403, 'нове право діє одразу');

  await call('/api/roles/creator', {
    method: 'PUT',
    body: { permissions: [{ entity: 'creatives', level: 'write', scope: 'own', hidden_fields: [] }] },
  });
  assert.equal((await call('/api/creatives?limit=1', { as: 'creator' })).status, 200);
});

test('кастомна роль створюється порожньою і не має доступу', async () => {
  const res = await call('/api/roles', { method: 'POST', body: { key: 'buyer', label: 'Баєр' } });
  assert.equal(res.status, 200);
  const roles = await call('/api/roles');
  assert.ok(roles.data.roles.some((r) => r.key === 'buyer'));
  assert.ok(roles.data.permissions.filter((p) => p.role_key === 'buyer').every((p) => p.level === 'none'));
});

test('крієйтор не може редагувати ролі', async () => {
  const res = await call('/api/roles/creator', { method: 'PUT', body: { permissions: [] }, as: 'creator' });
  assert.equal(res.status, 403);
});

test('сесію можна завершити примусово', async () => {
  const sessions = await call('/api/auth/sessions', { as: 'finance' });
  const token = sessions.data.rows[0].token;
  const res = await call(`/api/auth/sessions/${encodeURIComponent(token)}`, { method: 'DELETE', as: 'finance' });
  assert.equal(res.data.killed, 1);
  assert.equal((await call('/api/payouts', { as: 'finance' })).status, 401, 'сесія більше не діє');
});

// ── Списки пошуку ────────────────────────────────────────────────────────

async function createLead(body, { force = false, as = 'owner' } = {}) {
  return call(`/api/prospecting/leads${force ? '?force=1' : ''}`, { method: 'POST', body, as });
}

const baseSource = { channel: 'google_maps', query: 'кавʼярні Львів' };

test('лід не створюється без джерела — інакше не порахувати канали', async () => {
  const res = await createLead({ company_name: 'Без джерела' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /де знайшли/);
});

test('лід створюється з джерелом, соцмережами і рахує дні без контенту', async () => {
  const res = await createLead({
    company_name: 'Тестова кавʼярня Ранок', geo_city: 'Тернопіль', website: 'https://ranok-test.example',
    socials: [{ platform: 'instagram', handle: 'ranok_test_cafe', followers: 12000, last_post_at: '2026-06-01' }],
    source: { ...baseSource, signals: ['мертвий акаунт'] },
  });
  assert.equal(res.status, 200);
  const card = await call(`/api/prospecting/leads/${res.data.id}`);
  assert.equal(card.data.lead.company_name, 'Тестова кавʼярня Ранок');
  assert.equal(card.data.sources[0].channel, 'google_maps');
  assert.ok(card.data.socials[0].days_without_content > 30, 'рахує тишу в акаунті');
});

test('дубль по домену блокується, але створюється з підтвердженням', async () => {
  await createLead({ company_name: 'Пекарня А', website: 'https://pekarnya.example', source: baseSource });
  const dupe = await createLead({ company_name: 'Пекарня Б', website: 'https://pekarnya.example/about', source: baseSource });
  assert.equal(dupe.status, 409);
  assert.ok(dupe.data.duplicate);

  const forced = await createLead({ company_name: 'Пекарня Б', website: 'https://pekarnya.example/about', source: baseSource }, { force: true });
  assert.equal(forced.status, 200);
  const dups = await call('/api/prospecting/duplicates');
  assert.ok(dups.data.rows.length > 0, 'потрапляє в чергу на розбір');
});

test('чорний список не пускає лід у роботу', async () => {
  await call('/api/suppression_list', { method: 'POST', body: { kind: 'domain', value: 'stop.example', reason: 'відписались' } });
  const res = await createLead({ company_name: 'Стоп', website: 'https://stop.example', source: baseSource });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /чорн/i);
});

test('тач без тексту не зараховується', async () => {
  const lead = await createLead({ company_name: 'Порожній тач', source: baseSource });
  const res = await call(`/api/prospecting/leads/${lead.data.id}/touch`, {
    method: 'POST', body: { channel: 'instagram_dm', message_text: '  ' },
  });
  assert.equal(res.status, 400);
});

test('тач рухає статус, нумерується і ставить фолоу-ап', async () => {
  const lead = await createLead({ company_name: 'Тач-флоу', source: baseSource });
  const id = lead.data.id;

  const first = await call(`/api/prospecting/leads/${id}/touch`, {
    method: 'POST', body: { channel: 'instagram_dm', from_account: 'ig_manager_1', message_text: 'Привіт! Зробили вам приклад ролика' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.touch_number, 1);
  assert.ok(first.data.next_contact_at, 'наступний контакт проставлений автоматично');

  const card = await call(`/api/prospecting/leads/${id}`);
  assert.equal(card.data.lead.status_code, 'contacted');
  assert.equal(card.data.lead.touches_count, 1);
  assert.ok(card.data.tasks.some((t) => t.status === 'open'), 'створено задачу на фолоу-ап');
});

test('подвійний тач попереджає, доки не підтвердиш', async () => {
  const lead = await createLead({ company_name: 'Подвійний тач', source: baseSource });
  const id = lead.data.id;
  await call(`/api/prospecting/leads/${id}/touch`, { method: 'POST', body: { channel: 'telegram', message_text: 'перший' } });

  const second = await call(`/api/prospecting/leads/${id}/touch`, { method: 'POST', body: { channel: 'telegram', message_text: 'другий' } });
  assert.equal(second.status, 409);
  assert.ok(second.data.needForce);

  const forced = await call(`/api/prospecting/leads/${id}/touch?force=1`, { method: 'POST', body: { channel: 'telegram', message_text: 'другий' } });
  assert.equal(forced.data.touch_number, 2);
});

test('вхідний тач переводить лід у «Відповіли»', async () => {
  const lead = await createLead({ company_name: 'Відповідь', source: baseSource });
  const id = lead.data.id;
  await call(`/api/prospecting/leads/${id}/touch`, { method: 'POST', body: { channel: 'email', message_text: 'перший дотик' } });
  await call(`/api/prospecting/leads/${id}/touch`, { method: 'POST', body: { channel: 'email', direction: 'in', message_text: 'цікаво, розкажіть' } });
  const card = await call(`/api/prospecting/leads/${id}`);
  assert.equal(card.data.lead.status_code, 'replied');
  assert.ok(card.data.lead.replied_at);
});

test('дискваліфікація вимагає причини', async () => {
  const lead = await createLead({ company_name: 'Без причини', source: baseSource });
  const bad = await call(`/api/prospecting/leads/${lead.data.id}/status`, { method: 'POST', body: { status_code: 'disqualified' } });
  assert.equal(bad.status, 400);

  const good = await call(`/api/prospecting/leads/${lead.data.id}/status`, {
    method: 'POST', body: { status_code: 'disqualified', disqualify_reason: 'wrong_geo' },
  });
  assert.equal(good.status, 200);
  const card = await call(`/api/prospecting/leads/${lead.data.id}`);
  assert.equal(card.data.lead.disqualify_reason, 'wrong_geo');
  assert.equal(card.data.lead.next_contact_at, null, 'кінцевий статус прибирає з черги');
});

test('масова вставка створює лідів із посилань', async () => {
  const res = await call('/api/prospecting/bulk', {
    method: 'POST',
    body: {
      text: 'https://instagram.com/coffee_one\n@coffee_two\nhttps://bakery-three.example',
      source: { channel: 'instagram_search', query: '#lvivcoffee' },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.created, 3);
});

test('черга на сьогодні показує прострочене і відповіді', async () => {
  const res = await call('/api/prospecting/queue');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.overdue) && Array.isArray(res.data.replies) && Array.isArray(res.data.fresh));
});

test('воронка рахує джерела й номери тачів', async () => {
  const f = await call('/api/prospecting/funnel');
  assert.equal(f.status, 200);
  const maps = f.data.bySource.find((r) => r.channel === 'google_maps');
  assert.ok(maps.leads > 0);
  assert.ok(f.data.byTouchNumber.some((r) => r.touch_number === 1));
});

test('обʼєднання дублів зберігає історію тачів', async () => {
  const a = await createLead({ company_name: 'Мердж А', website: 'https://merge.example', source: baseSource });
  const b = await createLead({ company_name: 'Мердж Б', website: 'https://merge.example/x', source: baseSource }, { force: true });
  await call(`/api/prospecting/leads/${b.data.id}/touch`, { method: 'POST', body: { channel: 'email', message_text: 'писали на Б' } });

  const dup = (await call('/api/prospecting/duplicates')).data.rows
    .find((r) => [r.lead_a_id, r.lead_b_id].includes(b.data.id));
  const res = await call(`/api/prospecting/duplicates/${dup.id}/resolve`, { method: 'POST', body: { action: 'merge' } });
  assert.equal(res.status, 200);

  const card = await call(`/api/prospecting/leads/${res.data.kept}`);
  assert.ok(card.data.touches.some((t) => t.message_text === 'писали на Б'), 'тач переїхав, а не зник');
  assert.equal((await call(`/api/prospecting/leads/${res.data.merged}`)).status, 404);
});

test('менеджер з пошуку бачить лише своїх лідів і не лізе в ресурси', async () => {
  const created = await call('/api/users', {
    method: 'POST',
    body: { name: 'Менеджер Сергій', email: 'sales@gennect.local', role: 'sales', password: 'demo1234', status: 'active' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  await login('sales', 'sales@gennect.local', 'demo1234');

  assert.equal((await call('/api/accounts', { as: 'sales' })).status, 403, 'до ресурсів УБТ доступу немає');
  const mine = await call('/api/leads?limit=100', { as: 'sales' });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.total, 0, 'чужі ліди не видно');

  const own = await createLead({ company_name: 'Власний лід менеджера', source: baseSource }, { as: 'sales' });
  assert.equal(own.status, 200);
  assert.equal((await call('/api/leads?limit=100', { as: 'sales' })).data.total, 1);
});

// ── Канбан воронки лідів ─────────────────────────────────────────────────

test('очікувана сума ліда зберігається і потрапляє в канбан воронки', async () => {
  const lead = await createLead({ company_name: 'Канбан Тест', source: baseSource, expected_amount: 15000 });
  assert.equal(lead.status, 200, JSON.stringify(lead.data));

  const card = await call(`/api/prospecting/leads/${lead.data.id}`);
  assert.equal(Number(card.data.lead.expected_amount), 15000);

  const kanban = await call('/api/prospecting/kanban');
  const col = kanban.data.columns.find((c) => c.code === 'new');
  assert.ok(col, 'колонка «Новий» є серед активних статусів');
  const cardInColumn = col.leads.find((l) => l.id === lead.data.id);
  assert.ok(cardInColumn, 'новий лід потрапив у свою колонку');
  assert.equal(Number(cardInColumn.expected_amount), 15000);
  assert.ok(col.sum >= 15000, 'сума колонки враховує очікувану суму ліда');
});

test('канбан воронки враховує скоуп ролі', async () => {
  const own = await createLead({ company_name: 'Канбан свій лід', source: baseSource, expected_amount: 500 }, { as: 'sales' });
  assert.equal(own.status, 200);

  const kanbanAsSales = await call('/api/prospecting/kanban', { as: 'sales' });
  const newColSales = kanbanAsSales.data.columns.find((c) => c.code === 'new');
  assert.ok(newColSales.leads.some((l) => l.id === own.data.id), 'менеджер бачить власний лід у канбані');

  assert.equal((await call('/api/prospecting/kanban', { as: 'creator' })).status, 403, 'крієйтор не має доступу до модуля пошуку взагалі');
});

test('канбан використовує той самий ендпоїнт статусу — виграш так само заводить клієнта', async () => {
  const lead = await createLead({ company_name: 'Канбан переможець', source: baseSource, expected_amount: 900 });
  const win = await call(`/api/prospecting/leads/${lead.data.id}/status`, { method: 'POST', body: { status_code: 'won' } });
  assert.equal(win.status, 200);
  assert.ok(win.data.client_id, 'клієнт заводиться автоматично, як і при звичайній зміні статусу');

  const kanban = await call('/api/prospecting/kanban');
  const wonCol = kanban.data.columns.find((c) => c.code === 'won');
  assert.ok(wonCol.is_won, 'колонка позначена як виграшна');
  assert.ok(wonCol.leads.some((l) => l.id === lead.data.id));
});

// ── Ручна позиція карток у канбані (перетягування між конкретні картки) ──
test('новий лід зʼявляється вгорі своєї колонки', async () => {
  const first = await createLead({ company_name: 'Порядок А', source: baseSource });
  const second = await createLead({ company_name: 'Порядок Б', source: baseSource });

  const { columns } = (await call('/api/prospecting/kanban')).data;
  const col = columns.find((c) => c.code === 'new');
  const ids = col.leads.map((l) => l.id);
  assert.ok(ids.indexOf(second.data.id) < ids.indexOf(first.data.id), 'останній створений лід — найвищий у колонці');
});

test('перетягування задає точну позицію картки — між двома конкретними картками', async () => {
  const a = await createLead({ company_name: 'Плашка A', source: baseSource });
  const b = await createLead({ company_name: 'Плашка B', source: baseSource });
  const c = await createLead({ company_name: 'Плашка C', source: baseSource });

  const before = (await call('/api/prospecting/kanban')).data.columns.find((col) => col.code === 'new');
  const orderOf = (id) => before.leads.find((l) => l.id === id).board_order;
  // Кладемо найстаршу картку (A) точно між B і C — так, як це порахував би
  // фронтенд за сусідніми board_order при drop між ними.
  const midOrder = (Number(orderOf(b.data.id)) + Number(orderOf(c.data.id))) / 2;

  const moved = await call(`/api/prospecting/leads/${a.data.id}/status`, {
    method: 'POST', body: { status_code: 'new', board_order: midOrder },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));

  const after = (await call('/api/prospecting/kanban')).data.columns.find((col) => col.code === 'new');
  const ids = after.leads.map((l) => l.id);
  const bi = ids.indexOf(b.data.id), ai = ids.indexOf(a.data.id), ci = ids.indexOf(c.data.id);
  // B і C створені пізніше за A, тож обидва спливли вище за неї (нове —
  // завжди вгорі колонки): видимий порядок був C, B, A. Поклали A рівно
  // між їхніми board_order — вона й опиняється між ними: C, A, B.
  assert.ok(ci < ai && ai < bi, `A має опинитись рівно між C і B, отримали порядок: ${JSON.stringify(ids)}`);
});

test('перехід в іншу колонку без явної позиції стає першим у ній, як і раніше', async () => {
  const a = await createLead({ company_name: 'Автопозиція A', source: baseSource });
  await createLead({ company_name: 'Автопозиція B', source: baseSource });

  const moved = await call(`/api/prospecting/leads/${a.data.id}/status`, {
    method: 'POST', body: { status_code: 'qualified' },
  });
  assert.equal(moved.status, 200);

  const col = (await call('/api/prospecting/kanban')).data.columns.find((c) => c.code === 'qualified');
  assert.equal(col.leads[0]?.id, a.data.id, 'без явної позиції картка лягає першою в новій колонці');
});

test('некоректна позиція картки відхиляється', async () => {
  const a = await createLead({ company_name: 'Крива позиція', source: baseSource });
  const res = await call(`/api/prospecting/leads/${a.data.id}/status`, {
    method: 'POST', body: { status_code: 'new', board_order: 'не число' },
  });
  assert.equal(res.status, 400);
});

// ── Картки списків пошуку ────────────────────────────────────────────────

test('список пошуку: «Організації» — це його ліди, «Особи» зводить контакти по людині', async () => {
  const list = await call('/api/prospect_lists', { method: 'POST', body: { name: 'Тест-список карток', kind: 'manual' } });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  const listId = list.data.id;

  const lead = await createLead({
    company_name: 'Контакт-Лід', source: baseSource, list_id: listId,
    contacts: [
      { kind: 'email', value: 'ivan@example.com', person_name: 'Іван Петренко' },
      { kind: 'phone', value: '+380001112233', person_name: 'Іван Петренко' },
    ],
  });
  assert.equal(lead.status, 200, JSON.stringify(lead.data));

  const orgs = await call(`/api/leads?list_id=${listId}&limit=50`);
  assert.equal(orgs.data.total, 1, 'лід списку видно як «організацію»');
  assert.equal(orgs.data.rows[0].company_name, 'Контакт-Лід');

  const people = await call(`/api/prospecting/lists/${listId}/contacts`);
  assert.equal(people.status, 200);
  assert.equal(people.data.rows.length, 1, 'email і телефон однієї людини звелись в один рядок, а не два');
  const row = people.data.rows[0];
  assert.equal(row.name, 'Іван Петренко');
  assert.equal(row.email, 'ivan@example.com');
  assert.equal(row.phone, '+380001112233');
  assert.equal(row.company_name, 'Контакт-Лід');
});

test('AI-пошук без налаштованого ключа повертає зрозумілу помилку, а не тихий збій', async () => {
  const list = await call('/api/prospect_lists', { method: 'POST', body: { name: 'Тест AI-пошуку', kind: 'manual' } });
  assert.equal(list.status, 200);

  // У тестовому середовищі жоден ключ не заданий — саме так і на проді,
  // доки власник не додасть його в змінні середовища сервісу.
  const res = await call(`/api/prospecting/lists/${list.data.id}/ai-search`, {
    method: 'POST', body: { channel: 'google_maps', niche: 'кавʼярні', geo: 'Львів', count: 5 },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /GEMINI_API_KEY/);
  assert.match(res.data.error, /ANTHROPIC_API_KEY/);

  assert.equal((await call(`/api/prospecting/lists/${list.data.id}/ai-search`, {
    method: 'POST', as: 'creator', body: { channel: 'google_maps' },
  })).status, 403, 'крієйтор не має прав додавати лідів — і до AI-пошуку теж');
});

test('AI-чат без налаштованого ключа повертає зрозумілу помилку, а не тихий збій', async () => {
  const empty = await call('/api/ai/chat', { method: 'POST', body: { messages: [] } });
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /Порожнє/);

  const res = await call('/api/ai/chat', { method: 'POST', body: { messages: [{ role: 'user', text: 'Створи ліда Тест' }] } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /GEMINI_API_KEY/);
});

// ── Плани та норми ───────────────────────────────────────────────────────

test('калькулятор розкладає ціль по клієнтах на денні норми', async () => {
  const res = await call('/api/kpi/calculator', {
    method: 'POST',
    body: {
      goal_deals: 4, conv_meeting_to_deal: 20, conv_reply_to_meeting: 30,
      reply_rate: 8, touches_per_lead: 2.5, qualification_rate: 70, working_days: 21, headcount: 1,
    },
  });
  assert.equal(res.status, 200);
  // 4 клієнти → 20 зустрічей → 67 відповідей → ~840 опрацьованих лідів
  assert.equal(res.data.month.meetings, 20);
  assert.equal(res.data.month.replies, 67);
  assert.ok(res.data.month.touched_leads >= 830 && res.data.month.touched_leads <= 845);
  assert.ok(res.data.month.touches >= 2080 && res.data.month.touches <= 2110);
  assert.ok(res.data.daily.touches >= 99 && res.data.daily.touches <= 101);
  assert.ok(res.data.accounts_needed >= 2, 'нагадує, що 100 тачів = кілька акаунтів');
});

test('калькулятор ділить норму на людей і не вигадує коефіцієнти', async () => {
  const solo = await call('/api/kpi/calculator?goal_deals=4&headcount=1');
  const duo = await call('/api/kpi/calculator?goal_deals=4&headcount=2');
  assert.ok(duo.data.daily.touches < solo.data.daily.touches);
  assert.equal(solo.data.real.enough, false, 'поки мало історії — чесно каже, що це орієнтири');
});

test('у план іде валідний лід, а не порожня картка', async () => {
  const me = (await call('/api/auth/me')).data.user;
  const today = new Date().toISOString().slice(0, 10);

  await createLead({ company_name: 'Повна картка', website: 'https://full-card.example', source: baseSource });
  await createLead({ company_name: 'Порожня картка без контактів', source: baseSource });

  const facts = await call('/api/kpi/recompute', { method: 'POST', body: { user_id: me.id, date: today } });
  assert.equal(facts.status, 200);
  assert.ok(facts.data.leads_found.value >= 2);
  assert.ok(facts.data.leads_found.valid < facts.data.leads_found.value, 'неповна картка не зараховується');
});

test('дискваліфікований як брак знімається з плану заднім числом', async () => {
  const me = (await call('/api/auth/me')).data.user;
  const today = new Date().toISOString().slice(0, 10);
  const lead = await createLead({ company_name: 'Брак гео', website: 'https://brak-geo.example', source: baseSource });

  const before = (await call('/api/kpi/recompute', { method: 'POST', body: { user_id: me.id, date: today } })).data;
  await call(`/api/prospecting/leads/${lead.data.id}/status`, {
    method: 'POST', body: { status_code: 'disqualified', disqualify_reason: 'wrong_geo' },
  });
  const after = (await call('/api/kpi/recompute', { method: 'POST', body: { user_id: me.id, date: today } })).data;

  assert.equal(after.leads_found.valid, before.leads_found.valid - 1);
  assert.ok(after.brak_rate.value > 0, 'показник браку росте');
});

test('норма множиться на рампап і завантаженість дня', async () => {
  const me = (await call('/api/auth/me')).data.user;
  const today = new Date().toISOString().slice(0, 10);
  await call('/api/kpi_plans', {
    method: 'POST',
    body: { user_id: me.id, metric_code: 'touches', period_type: 'day', period_start: '2020-01-01', target_value: 100 },
  });

  const full = await call('/api/kpi/my-day');
  const touches = full.data.progress.find((p) => p.metric === 'touches');
  assert.ok(touches, 'норма підтягнулась');

  await call('/api/work_calendar', {
    method: 'POST', body: { user_id: me.id, date: today, kind: 'sick', capacity_percent: 0 },
  });
  const sick = await call('/api/kpi/my-day');
  const sickTouches = sick.data.progress.find((p) => p.metric === 'touches');
  assert.equal(sickTouches.target, 0, 'лікарняний не перетворюється на невиконану норму');
  assert.equal(sick.data.calendar_kind, 'sick');
});

test('ліміт акаунта зупиняє тач до підтвердження', async () => {
  await call('/api/channel_limits', {
    method: 'POST', body: { account_name: 'ig_limit_test', channel: 'instagram_dm', daily_limit: 1, is_active: 1 },
  });
  const a = await createLead({ company_name: 'Ліміт А', website: 'https://limit-a.example', source: baseSource });
  const b = await createLead({ company_name: 'Ліміт Б', website: 'https://limit-b.example', source: baseSource });

  const first = await call(`/api/prospecting/leads/${a.data.id}/touch`, {
    method: 'POST', body: { channel: 'instagram_dm', from_account: 'ig_limit_test', message_text: 'перший' },
  });
  assert.equal(first.status, 200);

  const second = await call(`/api/prospecting/leads/${b.data.id}/touch`, {
    method: 'POST', body: { channel: 'instagram_dm', from_account: 'ig_limit_test', message_text: 'другий' },
  });
  assert.equal(second.status, 429);
  assert.match(second.data.error, /Ліміт акаунта/);

  const forced = await call(`/api/prospecting/leads/${b.data.id}/touch?force=1`, {
    method: 'POST', body: { channel: 'instagram_dm', from_account: 'ig_limit_test', message_text: 'другий' },
  });
  assert.equal(forced.status, 200, 'свідоме перевищення можливе, але лишає слід');
});

test('план застосовується на команду денними й місячними нормами', async () => {
  const salesUser = (await call('/api/users?email=sales@gennect.local')).data.rows[0];
  const calc = (await call('/api/kpi/calculator?goal_deals=2&working_days=20')).data;
  const res = await call('/api/kpi/apply', {
    method: 'POST', body: { calculation: calc, user_ids: [salesUser.id], period_start: '2026-09-01' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.applied >= 8, 'денні й місячні плани по кожній метриці');

  const plans = await call(`/api/kpi_plans?user_id=${salesUser.id}&limit=50`);
  assert.ok(plans.data.rows.some((p) => p.period_type === 'day'));
  assert.ok(plans.data.rows.some((p) => p.period_type === 'month'));
});

test('менеджер бачить свою норму, але не ставить її і не бачить команду', async () => {
  const mine = await call('/api/kpi/my-day', { as: 'sales' });
  assert.equal(mine.status, 200);
  assert.ok(Array.isArray(mine.data.progress));

  assert.equal((await call('/api/kpi/team', { as: 'sales' })).status, 403);
  const write = await call('/api/kpi_plans', {
    method: 'POST', as: 'sales',
    body: { user_id: 1, metric_code: 'touches', period_type: 'day', period_start: '2026-09-01', target_value: 5 },
  });
  assert.equal(write.status, 403, 'свою норму менеджер не переписує');
});

test('екран команди показує факт, брак і застояні ліди', async () => {
  const team = await call('/api/kpi/team');
  assert.equal(team.status, 200);
  const sales = team.data.rows.find((r) => r.role === 'sales');
  assert.ok(sales, 'менеджер у зведенні є');
  assert.ok('brak_rate' in sales && 'stale_leads' in sales);
});

test('бонус за норму не виплачується при перевищенні браку', async () => {
  const salesUser = (await call('/api/users?email=sales@gennect.local')).data.rows[0];
  const period = new Date().toISOString().slice(0, 7);

  await call('/api/bonus_rules', {
    method: 'POST',
    body: {
      role: 'sales', metric_code: 'touches', threshold_percent: 70,
      bonus_coefficient: 1, base_amount: 300, quality_gate_percent: 15, is_active: 1,
    },
  });
  await call('/api/kpi_plans', {
    method: 'POST',
    body: { user_id: salesUser.id, metric_code: 'touches', period_type: 'month', period_start: `${period}-01`, target_value: 1 },
  });
  await call('/api/salary_rules', { method: 'POST', body: { user_id: salesUser.id, fix_amount: 500, percent_of_profit: 0, active_from: '2020-01-01' } });

  const salary = await call(`/api/finance/salary?period=${period}`);
  const row = salary.data.rows.find((r) => r.user_id === salesUser.id);
  assert.ok(row, 'менеджер потрапляє в розрахунок ЗП');
  assert.ok(row.kpi_bonus, 'бонус за нормою рахується окремим блоком');
  assert.equal(row.total, row.fix_amount + row.percent_amount + row.bonus_amount);
});

// ── Собівартість ─────────────────────────────────────────────────────────

test('собівартість рахується зі ставок і накладних', async () => {
  const list = await call('/api/costing/services');
  assert.equal(list.status, 200);
  assert.ok(list.data.rows.length >= 3, 'демо-послуги на місці');

  const row = list.data.rows[0];
  // Рядок «Накладні» — це відсоток від решти, тож у прямі він не входить.
  const sumOfLines = row.lines.filter((l) => l.kind !== 'overhead').reduce((s, l) => s + l.total, 0);
  assert.equal(Math.round(sumOfLines * 100) / 100, row.direct, 'прямі = сума рядків, крім накладних');
  assert.equal(row.overhead, Math.round(row.direct * (row.overhead_percent / 100) * 100) / 100);
  assert.equal(row.cost, Math.round((row.direct + row.overhead) * 100) / 100);
});

test('рекомендована ціна виводить на цільову маржу', async () => {
  const { rows } = (await call('/api/costing/services')).data;
  const row = rows[0];
  const margin = Number(row.service.target_margin);
  assert.equal(row.recommended_price, Math.round((row.cost / (1 - margin / 100)) * 100) / 100);

  const applied = await call(`/api/costing/services/${row.service.id}/apply-price`, { method: 'POST', body: {} });
  assert.equal(applied.status, 200);
  assert.ok(Math.abs(applied.data.margin_percent - margin) < 0.5, 'після підстановки маржа дорівнює цільовій');
});

test('ставка живе у своїй послузі: зміна не чіпає інші послуги', async () => {
  const before = (await call('/api/costing/services')).data.rows;
  const mine = before.find((r) => r.lines.some((l) => l.rate_code === 'editor_hour'));
  const other = before.find((r) => r.service.id !== mine.service.id);
  const line = mine.lines.find((l) => l.rate_code === 'editor_hour');

  const res = await call(`/api/costing/services/${mine.service.id}/items`, {
    method: 'POST', body: { ...line, unit_cost: Number(line.unit_cost) + 10 },
  });
  assert.equal(res.status, 200);
  assert.ok(res.data.cost > mine.cost, 'собівартість своєї послуги зросла');

  const after = (await call('/api/costing/services')).data.rows;
  const otherAfter = after.find((r) => r.service.id === other.service.id);
  assert.equal(otherAfter.cost, other.cost, 'сусідня послуга зі своєю ставкою не змінилась');

  await call(`/api/costing/services/${mine.service.id}/items`, { method: 'POST', body: line });
});

test('послуги-групи: пакети належать послузі, порожню можна видалити, непорожню — ні', async () => {
  const groups = await call('/api/costing/groups');
  assert.equal(groups.status, 200);
  const first = groups.data.rows[0];
  assert.ok(first, 'демо-послуга на місці');
  assert.ok(Number(first.packages) >= 3, 'демо-пакети складені в цю послугу');

  // Непорожню не віддаємо — інакше один клік зніс би всі пакети з витратами.
  const busy = await call(`/api/costing/groups/${first.id}`, { method: 'DELETE' });
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /Спершу видаліть пакети/);

  // Порожню — можна.
  const made = await call('/api/costing/groups', { method: 'POST', body: { name: 'Порожня послуга' } });
  assert.equal(made.status, 200);
  assert.equal((await call(`/api/costing/groups/${made.data.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await call('/api/costing/groups')).data.rows.some((g) => g.id === made.data.id));

  // Новий пакет лягає саме в ту послугу, яку передали.
  const group2 = await call('/api/costing/groups', { method: 'POST', body: { name: 'Друга послуга' } });
  const pkg = await call('/api/services', {
    method: 'POST', body: { name: 'Пакет другої послуги', group_id: group2.data.id, unit: 'шт' },
  });
  assert.equal(pkg.status, 200);
  const rows = (await call('/api/costing/services')).data.rows;
  const mine = rows.find((r) => r.service.id === pkg.data.id);
  assert.equal(Number(mine.service.group_id), group2.data.id, 'пакет прив’язаний до своєї послуги');
});

test('неактивний рядок не йде в собівартість, накладні — відсоток від решти', async () => {
  const { rows } = (await call('/api/costing/services')).data;
  const row = rows.find((r) => r.lines.some((l) => l.kind === 'overhead'));
  const overhead = row.lines.find((l) => l.kind === 'overhead');
  assert.equal(row.overhead_percent, Number(overhead.unit_cost), 'відсоток накладних береться з рядка послуги');
  assert.equal(row.overhead, Math.round(row.direct * (row.overhead_percent / 100) * 100) / 100);

  const off = await call(`/api/costing/services/${row.service.id}/items`, {
    method: 'POST', body: { ...overhead, is_active: 0 },
  });
  assert.equal(off.data.overhead, 0, 'вимкнений рядок накладних не додає нічого');
  assert.equal(off.data.cost, off.data.direct);

  await call(`/api/costing/services/${row.service.id}/items`, { method: 'POST', body: overhead });
});

test('рядок собівартості додається і видаляється', async () => {
  const { rows } = (await call('/api/costing/services')).data;
  const id = rows[0].service.id;
  const added = await call(`/api/costing/services/${id}/items`, {
    method: 'POST', body: { name: 'Оренда студії', kind: 'resource', quantity: 2, unit_cost: 25 },
  });
  assert.equal(added.status, 200);
  const line = added.data.lines.find((l) => l.name === 'Оренда студії');
  assert.equal(line.total, 50);

  const removed = await call(`/api/costing/services/${id}/items/${line.id}`, { method: 'DELETE' });
  assert.ok(!removed.data.lines.some((l) => l.name === 'Оренда студії'));
});

test('точка беззбитковості рахується від постійних витрат', async () => {
  const { summary } = (await call('/api/costing/services')).data;
  assert.ok('fixed' in summary && 'breakeven_units' in summary);
  if (summary.breakeven_units != null) assert.ok(summary.breakeven_units > 0);
});

test('крієйтор не бачить собівартості, фінансист бачить', async () => {
  // Сесію фінансиста раніше завершили примусово — заходимо заново.
  await login('finance', 'finance@gennect.local', 'demo1234');
  assert.equal((await call('/api/costing/services', { as: 'creator' })).status, 403);
  assert.equal((await call('/api/services', { as: 'creator' })).status, 403);
  assert.equal((await call('/api/costing/services', { as: 'finance' })).status, 200);
});

// ── Пакети послуг ────────────────────────────────────────────────────────

async function createService(name, price) {
  const res = await call('/api/services', { method: 'POST', body: { name, price } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.row;
}

test('пакет: ціна рахується сумою вкладених послуг, тип автоматично стає «пакет»', async () => {
  const a = await createService('Компонент А', 100);
  const b = await createService('Компонент Б', 50);
  const pack = await createService('Пакет тест 1', 999);

  const added1 = await call(`/api/costing/services/${pack.id}/package/items`, { method: 'POST', body: { component_service_id: a.id, quantity: 2 } });
  assert.equal(added1.status, 200, JSON.stringify(added1.data));
  assert.equal(Number(added1.data.service.is_package), 1);
  assert.equal(Number(added1.data.service.price), 200, '2 × 100');

  const added2 = await call(`/api/costing/services/${pack.id}/package/items`, { method: 'POST', body: { component_service_id: b.id, quantity: 1 } });
  assert.equal(Number(added2.data.service.price), 250, '2×100 + 1×50 = 250');
  assert.equal(added2.data.items.length, 2);
});

test('зміна ціни компонента перераховує всі пакети, куди він вкладений', async () => {
  const a = await createService('Компонент для рекалку', 10);
  const pack = await createService('Пакет тест 2', 0);
  await call(`/api/costing/services/${pack.id}/package/items`, { method: 'POST', body: { component_service_id: a.id, quantity: 3 } });

  await call(`/api/services/${a.id}`, { method: 'PUT', body: { price: 20 } });
  const card = await call(`/api/costing/services/${pack.id}/package`);
  assert.equal(Number(card.data.service.price), 60, '3 × 20 після зміни ціни компонента');
});

test('пакет не можна вкласти в інший пакет', async () => {
  const a = await createService('Компонент для вкладеного пакету', 10);
  const inner = await createService('Внутрішній пакет', 0);
  await call(`/api/costing/services/${inner.id}/package/items`, { method: 'POST', body: { component_service_id: a.id, quantity: 1 } });

  const outer = await createService('Зовнішній пакет', 0);
  const res = await call(`/api/costing/services/${outer.id}/package/items`, { method: 'POST', body: { component_service_id: inner.id, quantity: 1 } });
  assert.equal(res.status, 400);
});

test('послугу, яка входить у пакет, не можна видалити', async () => {
  const a = await createService('Захищений компонент', 5);
  const pack = await createService('Пакет-власник', 0);
  await call(`/api/costing/services/${pack.id}/package/items`, { method: 'POST', body: { component_service_id: a.id, quantity: 1 } });

  const del = await call(`/api/services/${a.id}`, { method: 'DELETE' });
  assert.equal(del.status, 409);
});

test('прибрати останній компонент — пакет повертається до звичайної послуги з нульовою ціною', async () => {
  const a = await createService('Одинокий компонент', 40);
  const pack = await createService('Пакет тест 3', 0);
  const added = await call(`/api/costing/services/${pack.id}/package/items`, { method: 'POST', body: { component_service_id: a.id, quantity: 1 } });
  const itemId = added.data.items[0].id;

  const removed = await call(`/api/costing/services/${pack.id}/package/items/${itemId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(Number(removed.data.service.is_package), 0);
  assert.equal(Number(removed.data.service.price), 0);
});

test('ручне редагування ціни пакета ігнорується — вона лишається розрахунковою', async () => {
  const a = await createService('Компонент для ручного тесту', 30);
  const pack = await createService('Пакет тест 4', 0);
  await call(`/api/costing/services/${pack.id}/package/items`, { method: 'POST', body: { component_service_id: a.id, quantity: 2 } });

  const manual = await call(`/api/services/${pack.id}`, { method: 'PUT', body: { price: 9999 } });
  assert.equal(manual.status, 200);
  assert.equal(Number(manual.data.row.price), 60, 'ручний ввід ціни пакета не застосувався');
});

// ── Шаблони скриптів ─────────────────────────────────────────────────────

test('демо-скрипти сідяться з кроками й запереченнями', async () => {
  const { rows } = (await call('/api/scripts?limit=10')).data;
  assert.ok(rows.length >= 2, 'демо-скрипти на місці');
  const cold = rows.find((s) => s.category === 'cold_call');
  assert.ok(cold);
  const full = (await call(`/api/scripts/${cold.id}/full`)).data;
  assert.ok(full.steps.length >= 3, 'кроки розмови на місці');
  assert.ok(full.objections.length >= 2, 'заперечення на місці');
  assert.ok(full.steps.every((s) => s.kind === 'step'));
  assert.ok(full.objections.every((s) => s.kind === 'objection'));
});

test('новий скрипт створюється порожнім і наповнюється кроками', async () => {
  const created = await call('/api/scripts', {
    method: 'POST', body: { name: 'Тестовий скрипт', channel: 'call', category: 'test' },
  });
  assert.equal(created.status, 200);
  const id = created.data.id;

  const step = await call(`/api/scripts/${id}/steps`, {
    method: 'POST', body: { kind: 'step', title: 'Привітання', body: 'Добрий день', sort_order: 10 },
  });
  assert.equal(step.status, 200);
  assert.equal(step.data.steps.length, 1);

  const objection = await call(`/api/scripts/${id}/steps`, {
    method: 'POST', body: { kind: 'objection', title: 'Дорого', body: 'Порахуймо разом', sort_order: 10 },
  });
  assert.equal(objection.data.objections.length, 1);

  const full = (await call(`/api/scripts/${id}/full`)).data;
  assert.equal(full.steps[0].title, 'Привітання');
  assert.equal(full.objections[0].title, 'Дорого');
});

test('крок без заголовка не створюється', async () => {
  const created = await call('/api/scripts', { method: 'POST', body: { name: 'Без кроків', channel: 'call' } });
  const res = await call(`/api/scripts/${created.data.id}/steps`, { method: 'POST', body: { kind: 'step', title: '  ' } });
  assert.equal(res.status, 400);
});

test('редагування кроку зберігає інші поля рядка', async () => {
  const created = await call('/api/scripts', { method: 'POST', body: { name: 'Правка кроку', channel: 'call' } });
  const id = created.data.id;
  const step = await call(`/api/scripts/${id}/steps`, {
    method: 'POST', body: { kind: 'step', title: 'Крок 1', body: 'Текст кроку', sort_order: 10 },
  });
  const stepId = step.data.steps[0].id;

  // Патчимо лише sort_order, як це робить інлайн-редагування на фронті —
  // title і body мають лишитись, бо клієнт надсилає їх назад повністю.
  const patched = await call(`/api/scripts/${id}/steps`, {
    method: 'POST', body: { id: stepId, kind: 'step', title: 'Крок 1', body: 'Текст кроку', sort_order: 20 },
  });
  assert.equal(patched.data.steps[0].sort_order, 20);
  assert.equal(patched.data.steps[0].title, 'Крок 1');
  assert.equal(patched.data.steps[0].body, 'Текст кроку');
});

test('крок видаляється, скрипт лишається', async () => {
  const created = await call('/api/scripts', { method: 'POST', body: { name: 'Видалення кроку', channel: 'call' } });
  const id = created.data.id;
  const step = await call(`/api/scripts/${id}/steps`, { method: 'POST', body: { kind: 'step', title: 'Тимчасовий крок' } });
  const stepId = step.data.steps[0].id;

  const removed = await call(`/api/scripts/${id}/steps/${stepId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.steps.length, 0);
  assert.equal((await call(`/api/scripts/${id}`)).status, 200, 'сам скрипт нікуди не подівся');
});

test('дублювання скрипта копіює кроки й заперечення', async () => {
  const created = await call('/api/scripts', { method: 'POST', body: { name: 'Оригінал', channel: 'call' } });
  const id = created.data.id;
  await call(`/api/scripts/${id}/steps`, { method: 'POST', body: { kind: 'step', title: 'Крок А' } });
  await call(`/api/scripts/${id}/steps`, { method: 'POST', body: { kind: 'objection', title: 'Заперечення А' } });

  const dup = await call(`/api/scripts/${id}/duplicate`, { method: 'POST', body: {} });
  assert.equal(dup.status, 200);
  assert.match(dup.data.script.name, /копія/);
  assert.equal(dup.data.script.is_active, 0, 'копія неактивна, щоб не плутати з оригіналом');
  assert.equal(dup.data.steps.length, 1);
  assert.equal(dup.data.objections.length, 1);
  assert.equal(dup.data.steps[0].title, 'Крок А');
});

test('тач можна привʼязати до скрипту, і це видно в картці ліда', async () => {
  const script = (await call('/api/scripts?category=cold_call&limit=1')).data.rows[0];
  const lead = await createLead({ company_name: 'Лід зі скриптом', source: baseSource });
  const touch = await call(`/api/prospecting/leads/${lead.data.id}/touch`, {
    method: 'POST', body: { channel: 'call', message_text: 'дзвонили за скриптом', script_id: script.id },
  });
  assert.equal(touch.status, 200);
  const card = await call(`/api/prospecting/leads/${lead.data.id}`);
  assert.equal(card.data.touches[0].script_id, script.id);
});

test('менеджер з пошуку читає скрипти, але не редагує їх', async () => {
  const list = await call('/api/scripts?limit=10', { as: 'sales' });
  assert.equal(list.status, 200);
  assert.ok(list.data.rows.length > 0);

  const created = await call('/api/scripts', { method: 'POST', as: 'sales', body: { name: 'Спроба менеджера', channel: 'call' } });
  assert.equal(created.status, 403);

  const anyScript = list.data.rows[0];
  assert.equal((await call(`/api/scripts/${anyScript.id}/steps`, { method: 'POST', as: 'sales', body: { kind: 'step', title: 'x' } })).status, 403);
});

test('крієйтор і монтажер не бачать розділ скриптів', async () => {
  assert.equal((await call('/api/scripts', { as: 'creator' })).status, 403);
});

test('дозволений набір повідомлень пошуку клієнтів містить активні скрипти', async () => {
  const res = await call('/api/prospecting/dictionaries', { as: 'sales' });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.scripts));
  assert.ok(res.data.scripts.every((s) => 'name' in s && 'channel' in s));
});

// ── Клієнти ──────────────────────────────────────────────────────────────

test('лід виграно → клієнт створюється сам, повторний виграш не дублює', async () => {
  const lead = await createLead({ company_name: 'Переможний клієнт', source: baseSource }, { as: 'sales' });
  const win = await call(`/api/prospecting/leads/${lead.data.id}/status`, { method: 'POST', as: 'sales', body: { status_code: 'won' } });
  assert.equal(win.status, 200, JSON.stringify(win.data));
  assert.ok(win.data.client_id, 'клієнт створився одразу');

  const list = await call(`/api/clients?source_lead_id=${lead.data.id}`, { as: 'sales' });
  assert.equal(list.data.total, 1);
  assert.equal(list.data.rows[0].status, 'active');
  assert.equal(list.data.rows[0].id, win.data.client_id);

  const again = await call(`/api/prospecting/leads/${lead.data.id}/status`, { method: 'POST', as: 'sales', body: { status_code: 'won' } });
  assert.equal(again.data.client_id, win.data.client_id, 'повторний виграш не створює другого клієнта');
  assert.equal((await call(`/api/clients?source_lead_id=${lead.data.id}`, { as: 'sales' })).data.total, 1);
});

test('клієнтів видно за скоупом ролі: свій менеджер бачить, чужа роль без доступу, фінансист лише читає', async () => {
  const mine = await call('/api/clients?limit=100', { as: 'sales' });
  assert.equal(mine.status, 200);
  assert.ok(mine.data.total >= 1, 'менеджер бачить свого щойно виграного клієнта');

  assert.equal((await call('/api/clients', { as: 'creator' })).status, 403, 'у крієйтора немає модуля клієнтів');

  const financeList = await call('/api/clients?limit=100', { as: 'finance' });
  assert.equal(financeList.status, 200, 'фінансист бачить усіх клієнтів для звітності');
  assert.ok(financeList.data.total >= mine.data.total);
  const someClient = financeList.data.rows[0];
  assert.equal(
    (await call(`/api/clients/${someClient.id}`, { method: 'PUT', as: 'finance', body: { note: 'спроба фінансиста' } })).status,
    403, 'фінансист лише читає, не редагує',
  );
});

test('підписка на послугу рахує MRR — зі своєю ціною і без', async () => {
  const service = (await call('/api/services?limit=1')).data.rows[0];
  const client = (await call('/api/clients?limit=1', { as: 'sales' })).data.rows[0];

  const added = await call(`/api/clients/${client.id}/services`, { method: 'POST', as: 'sales', body: { service_id: service.id, quantity: 2 } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const row = added.data.services.find((s) => s.service_id === service.id);
  const expected = Math.round(Number(service.price) * 2 * 100) / 100;
  assert.equal(row.total, expected);
  assert.equal(added.data.mrr, expected);

  const overridden = await call(`/api/clients/${client.id}/services/${row.id}`, { method: 'PUT', as: 'sales', body: { price_override: 5 } });
  assert.equal(overridden.status, 200);
  const row2 = overridden.data.services.find((s) => s.id === row.id);
  assert.equal(row2.total, 10, 'своя ціна × кількість');
  assert.equal(overridden.data.mrr, 10);

  const canceled = await call(`/api/clients/${client.id}/services/${row.id}`, { method: 'PUT', as: 'sales', body: { status: 'canceled' } });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.data.mrr, 0, 'скасована підписка не рахується в MRR');
  assert.ok(canceled.data.services.find((s) => s.id === row.id).ended_at, 'скасування проставляє дату завершення');
});

test('відтік вимагає причини, скасовує активні підписки; повернення в актив чистить поля', async () => {
  const client = (await call('/api/clients?limit=1', { as: 'sales' })).data.rows[0];
  const service = (await call('/api/services?limit=1')).data.rows[0];
  await call(`/api/clients/${client.id}/services`, { method: 'POST', as: 'sales', body: { service_id: service.id, quantity: 1 } });

  const noReason = await call(`/api/clients/${client.id}/status`, { method: 'POST', as: 'sales', body: { status: 'churned' } });
  assert.equal(noReason.status, 400, 'без причини відтоку — відмова');

  const churned = await call(`/api/clients/${client.id}/status`, { method: 'POST', as: 'sales', body: { status: 'churned', reason: 'price' } });
  assert.equal(churned.status, 200);

  const card = await call(`/api/clients/${client.id}/full`, { as: 'sales' });
  assert.equal(card.data.client.status, 'churned');
  assert.equal(card.data.client.churn_reason, 'price');
  assert.ok(card.data.client.churned_at, 'дата відтоку проставлена');
  assert.ok(card.data.services.every((s) => s.status !== 'active'), 'активні підписки скасувались разом із клієнтом');

  const summaryAfterChurn = await call('/api/clients/summary', { as: 'finance' });
  assert.ok(summaryAfterChurn.data.churned >= 1, 'відтеклий клієнт зʼявився у зведенні');
  assert.ok(summaryAfterChurn.data.churned_30d >= 1);

  const reactivated = await call(`/api/clients/${client.id}/status`, { method: 'POST', as: 'sales', body: { status: 'active' } });
  assert.equal(reactivated.status, 200);
  const card2 = await call(`/api/clients/${client.id}/full`, { as: 'sales' });
  assert.equal(card2.data.client.status, 'active');
  assert.equal(card2.data.client.churned_at, null, 'повернення в актив чистить дату відтоку');
  assert.equal(card2.data.client.churn_reason, null, 'і причину відтоку');
});

test('зведення по клієнтах рахує лічильники й MRR узгоджено', async () => {
  const summary = await call('/api/clients/summary', { as: 'finance' });
  assert.equal(summary.status, 200);
  assert.ok(summary.data.total >= 1);
  assert.equal(summary.data.total, summary.data.active + summary.data.paused + summary.data.churned);
  assert.ok('mrr' in summary.data && 'churn_rate_30d' in summary.data);
  assert.equal((await call('/api/clients/summary', { as: 'creator' })).status, 403);
});

// ── RBAC: бекфіл прав при оновленні ─────────────────────────────────────

async function deleteRolePermissionRows(roleKey, entityKeys) {
  if (PG_URL) {
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    await client.query('DELETE FROM role_permissions WHERE role_key=$1 AND entity = ANY($2)', [roleKey, entityKeys]);
    await client.end();
  } else {
    const db = new DatabaseSync(dbFile);
    const placeholders = entityKeys.map(() => '?').join(',');
    db.prepare(`DELETE FROM role_permissions WHERE role_key=? AND entity IN (${placeholders})`).run(roleKey, ...entityKeys);
    db.close();
  }
}

test('перезапуск сам дозаповнює права ролі, які випали через гонку «нова роль + нова сутність в одному релізі»', async () => {
  // Відтворює реальний прод-баг: коли «Пошук клієнтів» додав одразу і нову
  // роль (sales), і нові сутності (leads, prospect_lists, touches…),
  // syncNewRoles() встиг дати sales рядки на всі сутності раніше, ніж
  // syncNewEntities() перевіряв, чи сутність уже «відома». Стара перевірка
  // дивилась лише на сам факт існування хоч одного рядка для сутності —
  // тому власник (і будь-яка інша давня роль) лишався без бекфілу назавжди,
  // хоча дефолтна матриця в коді каже, що власник має full/all на все.
  await deleteRolePermissionRows('owner', ['leads', 'prospect_lists', 'touches']);

  const port2 = PORT + 700;
  const env2 = { ...env, CRM_PORT: String(port2), CRM_POSTBACK_PORT: String(port2 + 1) };
  const server2 = spawn(process.execPath, ['server.js'], { env: env2, cwd: path.join(import.meta.dirname, '..') });
  try {
    for (let i = 0; i < 50; i += 1) {
      try { await fetch(`http://127.0.0.1:${port2}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const login2 = await fetch(`http://127.0.0.1:${port2}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@gennect.local', password: 'gennect-admin' }),
    });
    assert.equal(login2.status, 200);
    const cookie2 = login2.headers.getSetCookie()[0].split(';')[0];

    for (const p of ['/api/leads?limit=1', '/api/prospect_lists?limit=1', '/api/touches?limit=1']) {
      const res = await fetch(`http://127.0.0.1:${port2}${p}`, { headers: { cookie: cookie2 } });
      assert.equal(res.status, 200, `перезапуск сам відновлює доступ власника до ${p}`);
    }
  } finally {
    server2.kill();
  }
});

test('/api/meta повертає недоступні розділи окремим списком, без полів', async () => {
  const meta = await call('/api/meta', { as: 'creator' });
  assert.equal(meta.status, 200);
  assert.ok(!meta.data.entities.clients, 'крієйтор не має доступу до клієнтів — у entities його нема');
  const locked = meta.data.locked.find((l) => l.key === 'clients');
  assert.ok(locked, 'закритий розділ лишається видимим — фронт малює його замочком');
  assert.equal(locked.label, 'Поточні клієнти');
  assert.ok(!('fields' in locked) && !('can' in locked), 'у замкненому пункті немає полів чи прав — лише назва, група й іконка');
});

test('генерик-імпорт CSV створює записи за підписами полів і пропускає биті рядки', async () => {
  const csv = 'Назва,Вертикаль,Гео\n"Офер А","nutra","US"\n"Офер Б","dating","DE"\n,,\n';
  const res = await call('/api/offers/import', { method: 'POST', body: { csv } });
  assert.equal(res.status, 200);
  assert.equal(res.data.imported, 2);
  assert.equal(res.data.skipped, 1, 'порожній рядок пропущено, а не впав як помилка');
  assert.equal(res.data.errors.length, 0);

  const list = await call('/api/offers?q=Офер');
  const names = list.data.rows.map((r) => r.name);
  assert.ok(names.includes('Офер А') && names.includes('Офер Б'));

  const badCsv = 'Назва\n\n'; // немає жодного заповненого рядка окрім заголовка
  const empty = await call('/api/offers/import', { method: 'POST', body: { csv: badCsv } });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.imported, 0);

  assert.equal((await call('/api/leads/import', {
    method: 'POST', as: 'finance', body: { csv: 'Бізнес\nТест\n' },
  })).status, 403, 'фінансист не має прав створювати лідів — і імпортувати теж');
});

// ── Шаблони повідомлень як дерево карток ──────────────────────────────────
async function makeTemplateCard(name, parentId = null) {
  const res = await call('/api/message_templates', {
    method: 'POST',
    body: { name, description: `опис ${name}`, tags: 'тег-а, тег-б', parent_id: parentId ?? '' },
  });
  assert.equal(res.status, 200, `картка ${name}: ${JSON.stringify(res.data)}`);
  return res.data.row;
}

test('картка шаблону створюється без тексту — вона може бути просто розділом', async () => {
  const card = await makeTemplateCard('Розділ без тексту');
  assert.equal(card.body, '', 'текст порожній, а не NULL');
  assert.equal(card.description, 'опис Розділ без тексту');
  assert.equal(card.tags, 'тег-а, тег-б');
  assert.equal(card.parent_id, null, 'картка верхнього рівня');
});

test('картку можна вкласти в картку, і вкладеність видно в списку', async () => {
  const parent = await makeTemplateCard('Батьківська картка');
  const child = await makeTemplateCard('Вкладена картка', parent.id);
  const grand = await makeTemplateCard('Вкладена в другий рівень', child.id);
  assert.equal(Number(child.parent_id), parent.id);
  assert.equal(Number(grand.parent_id), child.id);

  const { rows } = (await call('/api/message_templates?limit=500')).data;
  const kids = rows.filter((r) => Number(r.parent_id) === parent.id);
  assert.equal(kids.length, 1, 'у батька рівно одна безпосередня дитина');
  assert.ok(rows.some((r) => Number(r.parent_id) === child.id), 'третій рівень теж зберігся');
});

test('картку з вкладеннями не видалити, порожню — можна', async () => {
  const parent = await makeTemplateCard('Картка з дитиною');
  const child = await makeTemplateCard('Дитина', parent.id);

  const busy = await call(`/api/message_templates/${parent.id}`, { method: 'DELETE' });
  assert.equal(busy.status, 409, 'видалення забрало б із собою всю гілку');
  assert.match(busy.data.error, /вкладені картки \(1\)/);

  assert.equal((await call(`/api/message_templates/${child.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/message_templates/${parent.id}`, { method: 'DELETE' })).status, 200);
});

test('картку не можна вкласти саму в себе чи у власну підкартку', async () => {
  const parent = await makeTemplateCard('Корінь кільця');
  const child = await makeTemplateCard('Гілка кільця', parent.id);

  const self = await call(`/api/message_templates/${parent.id}`, { method: 'PUT', body: { parent_id: parent.id } });
  assert.equal(self.status, 400);
  const cycle = await call(`/api/message_templates/${parent.id}`, { method: 'PUT', body: { parent_id: child.id } });
  assert.equal(cycle.status, 400, 'інакше гілка зникла б із дерева');
});

// ── Виплати команді: роки → місяці → PDF-звіти ────────────────────────────
const PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString('base64');
const thisPeriod = () => new Date().toISOString().slice(0, 7);

test('огляд виплат групує місяці по роках і рахує суми', async () => {
  const res = await call('/api/payouts/overview');
  assert.equal(res.status, 200);
  const { years, summary } = res.data;
  assert.ok(years.length >= 1, 'демо-виплати дали хоча б один рік');
  const months = years.flatMap((y) => y.months);
  const current = months.find((m) => m.period === thisPeriod());
  assert.ok(current, 'поточний місяць у дереві');
  assert.equal(current.total, current.total, 'сума місяця — число');
  assert.equal(summary.period, thisPeriod());
  assert.equal(summary.month_total, current.total, 'тайл «поточний місяць» = сума цього місяця');
  assert.ok(summary.quarter_total >= summary.month_total, 'три місяці не менші за один');
});

test('місяць віддає всіх видимих людей — навіть тих, у кого ще немає нарахування', async () => {
  const res = await call(`/api/payouts/period/${thisPeriod()}`);
  assert.equal(res.status, 200);
  assert.ok(res.data.rows.length > 2, 'у списку вся команда, а не лише ті, кому нарахували');
  assert.ok(res.data.rows.some((r) => r.payout === null), 'людина без виплати теж видно — по ній і зрозуміло, що звіту немає');
  assert.equal((await call('/api/payouts/period/2026-13')).status, 400, 'кривий період відхиляється');
});

test('PDF-звіт вкладається до людини в місяці, віддається файлом і видаляється', async () => {
  const period = thisPeriod();
  const target = (await call(`/api/payouts/period/${period}`)).data.rows[0];

  const created = await call('/api/payouts/reports', {
    method: 'POST',
    body: { user_id: target.user_id, period, file_name: 'звіт.pdf', content: PDF_BASE64 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const report = created.data.row;
  assert.equal(report.ai_status, 'none', 'щойно завантажений звіт ще не читали');
  assert.ok(report.size_bytes > 0);
  assert.ok(!('content' in report), 'base64 файла не їздить у списках');

  const inPeriod = (await call(`/api/payouts/period/${period}`)).data.rows
    .find((r) => Number(r.user_id) === Number(target.user_id));
  assert.equal(inPeriod.reports.length, 1);

  const file = await fetch(`${BASE}/api/payouts/reports/${report.id}/file`, { headers: { cookie: jar.owner } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), PDF_BASE64, 'віддається той самий файл');

  assert.equal((await call(`/api/payouts/reports/${report.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/payouts/reports/${report.id}/file`)).status, 404);
});

test('сума зі звіту підставляється у виплату: рядок створюється або оновлюється, разом перераховується', async () => {
  const period = thisPeriod();
  const rows = (await call(`/api/payouts/period/${period}`)).data.rows;
  const withPayout = rows.find((r) => r.payout);
  const withoutPayout = rows.find((r) => !r.payout);

  // Людина, якій уже нарахували: фікс заміняється, відсоток і бонус лишаються.
  const repA = (await call('/api/payouts/reports', {
    method: 'POST', body: { user_id: withPayout.user_id, period, file_name: 'a.pdf', content: PDF_BASE64 },
  })).data.row;
  const applied = await call(`/api/payouts/reports/${repA.id}/apply`, { method: 'POST', body: { amount: 1234.5 } });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));

  const after = (await call(`/api/payouts/period/${period}`)).data.rows
    .find((r) => Number(r.user_id) === Number(withPayout.user_id));
  assert.equal(Number(after.payout.fix_amount), 1234.5);
  assert.equal(Number(after.payout.percent_amount), Number(withPayout.payout.percent_amount), 'відсоток не затерто');
  assert.equal(Number(after.payout.total),
    1234.5 + Number(withPayout.payout.percent_amount) + Number(withPayout.payout.bonus_amount),
    'разом перераховано');
  assert.ok(after.reports[0].applied_at, 'звіт позначений як підставлений');

  // Людина без нарахування: рядок виплати створюється з нуля.
  const repB = (await call('/api/payouts/reports', {
    method: 'POST', body: { user_id: withoutPayout.user_id, period, file_name: 'b.pdf', content: PDF_BASE64 },
  })).data.row;
  assert.equal((await call(`/api/payouts/reports/${repB.id}/apply`, { method: 'POST', body: { amount: 500 } })).status, 200);
  const createdRow = (await call(`/api/payouts/period/${period}`)).data.rows
    .find((r) => Number(r.user_id) === Number(withoutPayout.user_id));
  assert.equal(Number(createdRow.payout.total), 500);
  assert.equal(createdRow.payout.status, 'accrued');
});

test('звіт без прочитаної суми не підставляється мовчки', async () => {
  const period = thisPeriod();
  const target = (await call(`/api/payouts/period/${period}`)).data.rows[0];
  const rep = (await call('/api/payouts/reports', {
    method: 'POST', body: { user_id: target.user_id, period, file_name: 'порожній.pdf', content: PDF_BASE64 },
  })).data.row;
  const res = await call(`/api/payouts/reports/${rep.id}/apply`, { method: 'POST', body: {} });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /немає суми/i);
});

test('крієйтор бачить у виплатах лише себе і не лізе в чужі звіти', async () => {
  const period = thisPeriod();
  const mine = await call(`/api/payouts/period/${period}`, { as: 'creator' });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.rows.length, 1, 'у власному скоупі видно тільки себе');

  const foreign = (await call(`/api/payouts/period/${period}`)).data.rows
    .find((r) => Number(r.user_id) !== Number(mine.data.rows[0].user_id));
  const denied = await call('/api/payouts/reports', {
    method: 'POST', as: 'creator',
    body: { user_id: foreign.user_id, period, file_name: 'чужий.pdf', content: PDF_BASE64 },
  });
  assert.ok(denied.status === 403 || denied.status === 404, `чужий звіт відхилено (${denied.status})`);
});

test('завеликий файл не приймається', async () => {
  const period = thisPeriod();
  const target = (await call(`/api/payouts/period/${period}`)).data.rows[0];
  const huge = 'A'.repeat(9 * 1024 * 1024 * 4 / 3);
  const res = await call('/api/payouts/reports', {
    method: 'POST', body: { user_id: target.user_id, period, file_name: 'товстий.pdf', content: huge },
  });
  assert.equal(res.status, 413, 'база не місце для стомегабайтних вкладень');
});

// ── Час команди у виплатах: години зі звіту й пошук за людиною/періодом ──
test('огляд і зведення виплат несуть години поряд із грошима', async () => {
  const overview = (await call('/api/payouts/overview')).data;
  const current = overview.years.flatMap((y) => y.months).find((m) => m.period === thisPeriod());
  assert.ok(current.hours > 0, 'демо-виплати цього місяця мають години');
  assert.equal(overview.summary.month_hours, current.hours);
  assert.ok(overview.summary.quarter_hours >= overview.summary.month_hours, 'три місяці не менші за один');
});

test('підстановка звіту може нести і суму, і години одночасно', async () => {
  const period = thisPeriod();
  const target = (await call(`/api/payouts/period/${period}`)).data.rows.find((r) => !r.payout);
  const rep = (await call('/api/payouts/reports', {
    method: 'POST', body: { user_id: target.user_id, period, file_name: 'час.pdf', content: PDF_BASE64 },
  })).data.row;

  const applied = await call(`/api/payouts/reports/${rep.id}/apply`, {
    method: 'POST', body: { amount: 400, hours: 96 },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.hours, 96);

  const row = (await call(`/api/payouts/period/${period}`)).data.rows
    .find((r) => Number(r.user_id) === Number(target.user_id));
  assert.equal(Number(row.payout.hours), 96);
  assert.equal(Number(row.payout.total), 400, 'години не впливають на грошове «разом»');
});

test('підстановка без годин лишає вже наявні години недоторканими', async () => {
  const period = thisPeriod();
  const target = (await call(`/api/payouts/period/${period}`)).data.rows.find((r) => Number(r.payout?.hours) > 0);
  const before = Number(target.payout.hours);

  const rep = (await call('/api/payouts/reports', {
    method: 'POST', body: { user_id: target.user_id, period, file_name: 'без-годин.pdf', content: PDF_BASE64 },
  })).data.row;
  await call(`/api/payouts/reports/${rep.id}/apply`, { method: 'POST', body: { amount: 111 } });

  const after = (await call(`/api/payouts/period/${period}`)).data.rows
    .find((r) => Number(r.user_id) === Number(target.user_id));
  assert.equal(Number(after.payout.hours), before, 'години не затерто нулем');
  assert.equal(Number(after.payout.fix_amount), 111);
});

test('список людей для пошуку відповідає скоупу ролі', async () => {
  const owner = await call('/api/payouts/people');
  assert.equal(owner.status, 200);
  assert.ok(owner.data.rows.length >= 3, 'власник бачить усю команду');

  const creator = await call('/api/payouts/people', { as: 'creator' });
  assert.equal(creator.status, 200);
  assert.equal(creator.data.rows.length, 1, 'крієйтор бачить лише себе');
});

test('час і гроші однієї людини рахуються за довільний проміжок місяців', async () => {
  const period = thisPeriod();
  const months = (await call('/api/payouts/overview')).data.years[0].months.map((m) => m.period).sort();
  const from = months[0];
  const to = months[months.length - 1];
  const withHours = (await call(`/api/payouts/period/${period}`)).data.rows.find((r) => Number(r.payout?.hours) > 0);

  const range = await call(`/api/payouts/range?user_id=${withHours.user_id}&from=${from}&to=${to}`);
  assert.equal(range.status, 200, JSON.stringify(range.data));
  assert.ok(range.data.money > 0);
  assert.ok(range.data.hours > 0);
  assert.equal(range.data.rows.length, range.data.months);

  assert.equal((await call('/api/payouts/range')).status, 400, 'бракує параметрів');
  const denied = await call(`/api/payouts/range?user_id=${withHours.user_id}&from=${from}&to=${to}`, { as: 'creator' });
  assert.equal(denied.status, 404, 'чужа людина недоступна за скоупом');
});

// ── Ферми: блок пристроїв клієнта в конкретному гео ───────────────────────
async function makeFarm(overrides = {}) {
  const clientRes = await call('/api/clients', { method: 'POST', body: { name: `Клієнт ферми ${Date.now()}` } });
  assert.equal(clientRes.status, 200, JSON.stringify(clientRes.data));
  const client = clientRes.data.row;
  const farm = await call('/api/farms', {
    method: 'POST',
    body: { name: `Ферма ${Date.now()}`, client_id: client.id, geo: 'UA', target_devices: 5, ...overrides },
  });
  assert.equal(farm.status, 200, JSON.stringify(farm.data));
  return { client, farm: farm.data.row };
}

test('ферма створюється з клієнтом і гео, генерик-CRUD віддає її назад', async () => {
  const { farm, client } = await makeFarm({ name: 'Ферма тест-1' });
  assert.equal(farm.name, 'Ферма тест-1');
  assert.equal(Number(farm.client_id), client.id);
  assert.equal(farm.geo, 'UA');
  assert.equal(Number(farm.target_devices), 5);
  assert.equal(farm.status, 'active', 'статус за замовчуванням');

  const fetched = await call(`/api/farms/${farm.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.data.row.name, 'Ферма тест-1');
});

test('огляд ферм рахує кількість пристроїв і акаунтів на ній', async () => {
  const { farm } = await makeFarm();
  const device = await call('/api/devices', { method: 'POST', body: { model: 'Test Phone', farm_id: farm.id } });
  assert.equal(device.status, 200, JSON.stringify(device.data));

  const account = await call('/api/accounts', {
    method: 'POST',
    body: { platform: 'tiktok', nickname: `farmacc_${Date.now()}`, device_id: device.data.id, niche: 'crypto' },
  });
  assert.equal(account.status, 200, JSON.stringify(account.data));

  const overview = await call('/api/farms/overview');
  assert.equal(overview.status, 200);
  const row = overview.data.rows.find((r) => r.id === farm.id);
  assert.ok(row, 'нова ферма є в огляді');
  assert.equal(Number(row.device_count), 1);
  assert.equal(Number(row.account_count), 1);
});

test('фільтрований список акаунтів ферм повертає ферму/клієнта/телефон і рахує відео з posts', async () => {
  const { farm, client } = await makeFarm({ geo: 'PL' });
  const device = await call('/api/devices', { method: 'POST', body: { model: 'Redmi Farm', farm_id: farm.id } });
  const account = await call('/api/accounts', {
    method: 'POST',
    body: { platform: 'instagram', nickname: `placc_${Date.now()}`, device_id: device.data.id, niche: 'beauty' },
  });

  const before = await call(`/api/farms/accounts?farm_id=${farm.id}`);
  assert.equal(before.status, 200);
  assert.equal(before.data.rows.length, 1);
  const row = before.data.rows[0];
  assert.equal(row.farm_name, farm.name);
  assert.equal(row.client_name, client.name);
  assert.equal(row.device_model, 'Redmi Farm');
  assert.equal(row.niche, 'beauty');
  assert.equal(Number(row.videos_count), 0, 'постів ще немає');

  await call('/api/posts', { method: 'POST', body: { account_id: account.data.id, posted_at: new Date().toISOString() } });
  await call('/api/posts', { method: 'POST', body: { account_id: account.data.id, posted_at: new Date().toISOString() } });
  const after = await call(`/api/farms/accounts?farm_id=${farm.id}`);
  assert.equal(Number(after.data.rows[0].videos_count), 2, 'два запости — два відео в лічильнику');

  // Фільтри звужують вибірку.
  assert.equal((await call(`/api/farms/accounts?geo=PL`)).data.rows.some((r) => r.id === row.id), true);
  assert.equal((await call(`/api/farms/accounts?geo=DE`)).data.rows.some((r) => r.id === row.id), false);
  assert.equal((await call(`/api/farms/accounts?platform=tiktok`)).data.rows.some((r) => r.id === row.id), false);
  assert.equal((await call(`/api/farms/accounts?niche=beau`)).data.rows.some((r) => r.id === row.id), true, 'niche фільтрує частковим збігом');
  assert.equal((await call(`/api/farms/accounts?q=${encodeURIComponent('Redmi Farm')}`)).data.rows.some((r) => r.id === row.id), true, 'пошук знаходить за моделлю телефону');
});

test('картка ферми показує дерево пристрій → акаунти', async () => {
  const { farm } = await makeFarm();
  const deviceA = await call('/api/devices', { method: 'POST', body: { model: 'Phone A', farm_id: farm.id } });
  const deviceB = await call('/api/devices', { method: 'POST', body: { model: 'Phone B', farm_id: farm.id } });
  await call('/api/accounts', { method: 'POST', body: { platform: 'tiktok', nickname: `a1_${Date.now()}`, device_id: deviceA.data.id } });
  await call('/api/accounts', { method: 'POST', body: { platform: 'youtube', nickname: `a2_${Date.now()}`, device_id: deviceA.data.id } });

  const detail = await call(`/api/farms/${farm.id}/detail`);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.farm.id, farm.id);
  assert.equal(detail.data.devices.length, 2);
  const devA = detail.data.devices.find((d) => d.id === deviceA.data.id);
  const devB = detail.data.devices.find((d) => d.id === deviceB.data.id);
  assert.equal(devA.accounts.length, 2);
  assert.equal(devB.accounts.length, 0);
});

test('видалення ферми відвʼязує її пристрої, а не лишає їх висіти на неіснуючій фермі', async () => {
  const { farm } = await makeFarm();
  const device = await call('/api/devices', { method: 'POST', body: { model: 'Orphan Phone', farm_id: farm.id } });

  assert.equal((await call(`/api/farms/${farm.id}`, { method: 'DELETE' })).status, 200);
  const after = await call(`/api/devices/${device.data.id}`);
  assert.equal(after.data.row.farm_id, null, 'farm_id очищено, а не лишився висіти');
});

test('довідники фільтрів віддають лише те, що реально є в даних', async () => {
  const { farm } = await makeFarm({ geo: 'IT' });
  const device = await call('/api/devices', { method: 'POST', body: { model: 'Filter Phone', farm_id: farm.id } });
  await call('/api/accounts', {
    method: 'POST', body: { platform: 'youtube', nickname: `filt_${Date.now()}`, device_id: device.data.id, niche: 'travel-unique' },
  });

  const filters = await call('/api/farms/filters');
  assert.equal(filters.status, 200);
  assert.ok(filters.data.geos.includes('IT'));
  assert.ok(filters.data.platforms.includes('youtube'));
  assert.ok(filters.data.niches.includes('travel-unique'));
  assert.ok(filters.data.clients.some((c) => Number(c.id) === Number(farm.client_id)));
});

test('крієйтор не має доступу до розділу ферм', async () => {
  assert.equal((await call('/api/farms', { as: 'creator' })).status, 403);
  assert.equal((await call('/api/farms/overview', { as: 'creator' })).status, 403);
});

test('фармер бачить і клієнтів (щоб було з чого обрати), і повний доступ до ферм', async () => {
  if (!jar.farmer) await login('farmer', 'farmer@gennect.local', 'demo1234');
  const asFarmer = await call('/api/farms', { as: 'farmer' });
  assert.equal(asFarmer.status, 200);
  const clientsAsFarmer = await call('/api/clients', { as: 'farmer' });
  assert.equal(clientsAsFarmer.status, 200, 'без цього форма ферми лишилась би без клієнтів у списку');
});

// ── «Підключення клієнта»: дерево канв (папка в папці) ────────────────────
async function makeClientForMaps() {
  const res = await call('/api/clients', { method: 'POST', body: { name: `Клієнт для мап ${Date.now()}` } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.row;
}

test('корінь дерева створюється сам при першому відкритті клієнта', async () => {
  const client = await makeClientForMaps();
  const first = await call(`/api/client_maps/root?client_id=${client.id}`);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.ok(first.data.id);

  // Повторний виклик не плодить другий корінь.
  const second = await call(`/api/client_maps/root?client_id=${client.id}`);
  assert.equal(second.data.id, first.data.id);

  const scene = await call(`/api/client_maps/${first.data.id}/scene`);
  assert.equal(scene.status, 200);
  assert.equal(Number(scene.data.node.client_id), client.id);
  assert.equal(scene.data.node.parent_id, null);
  assert.deepEqual(scene.data.scene, { elements: [], appState: {} }, 'нова мапа стартує порожньою канвою');
});

test('сцена зберігається і читається назад такою, якою її прислали', async () => {
  const client = await makeClientForMaps();
  const { id } = (await call(`/api/client_maps/root?client_id=${client.id}`)).data;

  const myScene = { elements: [{ id: 'a1', type: 'rectangle', x: 10, y: 20 }], appState: { viewBackgroundColor: '#fff' } };
  const saved = await call(`/api/client_maps/${id}/scene`, { method: 'PUT', body: { scene: myScene } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const back = await call(`/api/client_maps/${id}/scene`);
  assert.deepEqual(back.data.scene, myScene);
});

test('дочірня мапа отримує клієнта від батька і порядковий індекс серед сиблінгів', async () => {
  const client = await makeClientForMaps();
  const { id: rootId } = (await call(`/api/client_maps/root?client_id=${client.id}`)).data;

  const childA = await call(`/api/client_maps/${rootId}/children`, { method: 'POST', body: { name: 'Ферма UA-1' } });
  assert.equal(childA.status, 200, JSON.stringify(childA.data));
  assert.equal(childA.data.index, 0);
  const childB = await call(`/api/client_maps/${rootId}/children`, { method: 'POST', body: { name: 'Ферма PL-1' } });
  assert.equal(childB.data.index, 1, 'другий сиблінг отримує наступний індекс');

  const tree = await call(`/api/client_maps/tree?client_id=${client.id}`);
  assert.equal(tree.status, 200);
  const names = tree.data.rows.map((r) => r.name).sort();
  assert.deepEqual(names, ['Ферма PL-1', 'Ферма UA-1', `Підключення: ${client.name}`].sort());
  assert.equal(Number(tree.data.rows.find((r) => r.id === childA.data.id).client_id ?? client.id), client.id);

  // Онук — третій рівень вкладеності.
  const grandchild = await call(`/api/client_maps/${childA.data.id}/children`, { method: 'POST', body: { name: 'Телефон #3' } });
  assert.equal(grandchild.status, 200);
  const treeAfter = await call(`/api/client_maps/tree?client_id=${client.id}`);
  assert.equal(treeAfter.data.rows.length, 4, 'корінь + 2 ферми + онук');
});

test('без назви дочірню мапу не створити', async () => {
  const client = await makeClientForMaps();
  const { id: rootId } = (await call(`/api/client_maps/root?client_id=${client.id}`)).data;
  const res = await call(`/api/client_maps/${rootId}/children`, { method: 'POST', body: { name: '  ' } });
  assert.equal(res.status, 400);
});

test('мапу з вкладеннями не видалити, порожню — можна', async () => {
  const client = await makeClientForMaps();
  const { id: rootId } = (await call(`/api/client_maps/root?client_id=${client.id}`)).data;
  const child = await call(`/api/client_maps/${rootId}/children`, { method: 'POST', body: { name: 'Дитина' } });

  const busy = await call(`/api/client_maps/${rootId}`, { method: 'DELETE' });
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /вкладені мапи \(1\)/);

  assert.equal((await call(`/api/client_maps/${child.data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/client_maps/${rootId}`, { method: 'DELETE' })).status, 200);
});

test('перейменування йде через звичайний generic-PUT', async () => {
  const client = await makeClientForMaps();
  const { id: rootId } = (await call(`/api/client_maps/root?client_id=${client.id}`)).data;
  const renamed = await call(`/api/client_maps/${rootId}`, { method: 'PUT', body: { name: 'Нова назва' } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  assert.equal(renamed.data.row.name, 'Нова назва');
});

test('завелика сцена відхиляється', async () => {
  const client = await makeClientForMaps();
  const { id: rootId } = (await call(`/api/client_maps/root?client_id=${client.id}`)).data;
  const huge = { elements: [{ id: 'x', text: 'A'.repeat(7 * 1024 * 1024) }], appState: {} };
  const res = await call(`/api/client_maps/${rootId}/scene`, { method: 'PUT', body: { scene: huge } });
  assert.equal(res.status, 413);
});

test('крієйтор не бачить «Підключення клієнта», фінансист лише читає', async () => {
  const client = await makeClientForMaps();
  const { id: rootId } = (await call(`/api/client_maps/root?client_id=${client.id}`)).data;

  assert.equal((await call(`/api/client_maps/tree?client_id=${client.id}`, { as: 'creator' })).status, 403);

  const finRead = await call(`/api/client_maps/${rootId}/scene`, { as: 'finance' });
  assert.equal(finRead.status, 200, 'фінансист читає');
  const finWrite = await call(`/api/client_maps/${rootId}/scene`, {
    method: 'PUT', as: 'finance', body: { scene: { elements: [], appState: {} } },
  });
  assert.equal(finWrite.status, 403, 'фінансист не редагує');
  const finCreate = await call(`/api/client_maps/${rootId}/children`, { method: 'POST', as: 'finance', body: { name: 'x' } });
  assert.equal(finCreate.status, 403);
});

// ── «Задачі»: простори → дошки → колонки → картки ──────────────────────────
async function makeSpace(name = `Простір ${Date.now()}`) {
  const res = await call('/api/task_spaces', { method: 'POST', body: { name } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.id;
}
async function makeBoard(spaceId, name = 'Дошка') {
  const res = await call(`/api/task_spaces/${spaceId}/boards`, { method: 'POST', body: { name } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.id;
}
const dataUrl = (text, mime = 'text/plain') => `data:${mime};base64,${Buffer.from(text).toString('base64')}`;

test('простір створюється зі своїм списком учасників — творець одразу учасник', async () => {
  const spaceId = await makeSpace();
  const space = await call(`/api/task_spaces/${spaceId}`);
  assert.equal(space.status, 200, JSON.stringify(space.data));
  assert.equal(space.data.members.length, 1);
  const list = await call('/api/task_spaces');
  assert.ok(list.data.rows.some((s) => s.id === spaceId));
});

test('поза списком учасників простір недоступний, після додавання — доступний', async () => {
  const spaceId = await makeSpace();
  const denied = await call(`/api/task_spaces/${spaceId}`, { as: 'creator' });
  assert.equal(denied.status, 403, JSON.stringify(denied.data));

  const creatorId = (await call('/api/refs')).data.users.find((u) => u.label.includes('Ліза')).id;
  const added = await call(`/api/task_spaces/${spaceId}/members`, { method: 'POST', body: { user_id: creatorId } });
  assert.equal(added.status, 200, JSON.stringify(added.data));

  const allowed = await call(`/api/task_spaces/${spaceId}`, { as: 'creator' });
  assert.equal(allowed.status, 200, 'після додавання в учасники доступ є');

  const removed = await call(`/api/task_spaces/${spaceId}/members/${creatorId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const deniedAgain = await call(`/api/task_spaces/${spaceId}`, { as: 'creator' });
  assert.equal(deniedAgain.status, 403, 'після видалення з учасників доступу знову нема');
});

test('фінансист узагалі не бачить розділ «Задачі»', async () => {
  const spaceId = await makeSpace();
  assert.equal((await call('/api/task_spaces', { as: 'finance' })).status, 403);
  assert.equal((await call(`/api/task_spaces/${spaceId}`, { as: 'finance' })).status, 403);
});

test('нова дошка отримує три дефолтні колонки', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const board = await call(`/api/task_boards/${boardId}`);
  assert.equal(board.status, 200, JSON.stringify(board.data));
  assert.deepEqual(board.data.columns.map((c) => c.name), ['До виконання', 'В роботі', 'Готово']);
});

test('видалення простору й дошки блокується, поки в них є вкладене', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const busySpace = await call(`/api/task_spaces/${spaceId}`, { method: 'DELETE' });
  assert.equal(busySpace.status, 409);

  const board = await call(`/api/task_boards/${boardId}`);
  const colId = board.data.columns[0].id;
  const busyBoard = await call(`/api/task_boards/${boardId}`, { method: 'DELETE' });
  assert.equal(busyBoard.status, 409);

  // Спорожняємо: видаляємо всі колонки, тоді дошку, тоді простір.
  for (const c of board.data.columns) assert.equal((await call(`/api/task_columns/${c.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/task_boards/${boardId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/task_spaces/${spaceId}`, { method: 'DELETE' })).status, 200);
  void colId;
});

test('колонку з картками не видалити, порожню — можна', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const board = await call(`/api/task_boards/${boardId}`);
  const colId = board.data.columns[0].id;
  const card = await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } });
  assert.equal(card.status, 200, JSON.stringify(card.data));

  const busy = await call(`/api/task_columns/${colId}`, { method: 'DELETE' });
  assert.equal(busy.status, 409);
  assert.equal((await call(`/api/task_cards/${card.data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/task_columns/${colId}`, { method: 'DELETE' })).status, 200);
});

test('картка переноситься між колонками — активність фіксує переміщення', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const board = await call(`/api/task_boards/${boardId}`);
  // Навмисно НЕ «В роботі» (columns[1]) — та колонка сама смикає трекер
  // часу (окремі тести нижче), тут перевіряємо лише сам факт переміщення.
  const [colA, , colB] = board.data.columns;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colA.id, title: 'Задача' } })).data;

  const moved = await call(`/api/task_cards/${card.id}/move`, { method: 'POST', body: { column_id: colB.id, board_order: 500 } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));

  const got = await call(`/api/task_cards/${card.id}`);
  assert.equal(got.data.card.column_id, colB.id);
  const kinds = got.data.activity.map((a) => a.kind);
  assert.deepEqual(kinds, ['created', 'moved']);
  const movedPayload = JSON.parse(got.data.activity[1].payload);
  assert.equal(movedPayload.from, colA.name);
  assert.equal(movedPayload.to, colB.name);
});

test('редагування картки логує кожну змінену властивість окремо', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  const upd = await call(`/api/task_cards/${card.id}`, {
    method: 'PUT', body: { title: 'Нова назва', priority: 'high', description: 'опис' },
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));

  const got = await call(`/api/task_cards/${card.id}`);
  assert.equal(got.data.card.title, 'Нова назва');
  assert.equal(got.data.card.priority, 'high');
  const kinds = got.data.activity.map((a) => a.kind);
  // created + 3 окремі field_changed (title/priority/опис).
  assert.equal(kinds.filter((k) => k === 'field_changed').length, 3);

  // Повторний PUT з тими самими значеннями нічого не додає в лог.
  await call(`/api/task_cards/${card.id}`, { method: 'PUT', body: { title: 'Нова назва' } });
  const gotAgain = await call(`/api/task_cards/${card.id}`);
  assert.equal(gotAgain.data.activity.length, got.data.activity.length, 'без реальної зміни новий запис не додається');
});

test('estimate_minutes редагується, логується й видно і в картці, і на дошці', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  const upd = await call(`/api/task_cards/${card.id}`, { method: 'PUT', body: { estimate_minutes: 120 } });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));

  const got = await call(`/api/task_cards/${card.id}`);
  assert.equal(got.data.card.estimate_minutes, 120);
  assert.ok(got.data.activity.some((a) => a.kind === 'field_changed' && JSON.parse(a.payload).field === 'оцінку часу'));

  const board = await call(`/api/task_boards/${boardId}`);
  const boardCard = board.data.columns.find((c) => c.id === colId).cards.find((c) => c.id === card.id);
  assert.equal(boardCard.estimate_minutes, 120, 'estimate_minutes має бути й у списку карток дошки (для прогрес-бару)');

  // Скидання назад у null теж працює й логується.
  await call(`/api/task_cards/${card.id}`, { method: 'PUT', body: { estimate_minutes: null } });
  const cleared = await call(`/api/task_cards/${card.id}`);
  assert.equal(cleared.data.card.estimate_minutes, null);
});

test('призначення виконавця обмежене учасниками простору й логується окремо', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  const got = await call(`/api/task_cards/${card.id}`);
  const me = got.data.members[0];
  const assign = await call(`/api/task_cards/${card.id}`, { method: 'PUT', body: { assignee_user_id: me.user_id } });
  assert.equal(assign.status, 200, JSON.stringify(assign.data));

  const after = await call(`/api/task_cards/${card.id}`);
  assert.equal(after.data.card.assignee_user_id, me.user_id);
  assert.ok(after.data.activity.some((a) => a.kind === 'assigned'));
});

test('трекер часу стартує й зупиняється, рахує секунди, редагування змінює тривалість', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  const start = await call(`/api/task_cards/${card.id}/timer/start`, { method: 'POST' });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const mid = await call(`/api/task_cards/${card.id}`);
  assert.ok(mid.data.runningTimer, 'таймер видно як запущений для того ж користувача');

  const stop = await call(`/api/task_cards/${card.id}/timer/stop`, { method: 'POST' });
  assert.equal(stop.status, 200, JSON.stringify(stop.data));
  assert.ok(stop.data.seconds >= 0);

  const after = await call(`/api/task_cards/${card.id}`);
  assert.equal(after.data.runningTimer, null);
  assert.equal(after.data.timeEntries.length, 1);
  assert.ok(after.data.activity.some((a) => a.kind === 'time_started'));
  assert.ok(after.data.activity.some((a) => a.kind === 'time_stopped'));

  const entryId = after.data.timeEntries[0].id;
  const edited = await call(`/api/task_time_entries/${entryId}`, { method: 'PUT', body: { seconds: 1800 } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const final = await call(`/api/task_cards/${card.id}`);
  assert.equal(final.data.timeEntries[0].seconds, 1800);
  assert.equal(final.data.totalSeconds, 1800);
});

test('коментар із файлом додається, активність фіксує коментар', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  const commented = await call(`/api/task_cards/${card.id}/comments`, {
    method: 'POST',
    body: { body: 'Готово, дивись файл', attachments: [{ file_name: 'звіт.txt', mime: 'text/plain', content: dataUrl('привіт') }] },
  });
  assert.equal(commented.status, 200, JSON.stringify(commented.data));

  const got = await call(`/api/task_cards/${card.id}`);
  assert.equal(got.data.comments.length, 1);
  assert.equal(got.data.comments[0].body, 'Готово, дивись файл');
  assert.equal(got.data.comments[0].attachments.length, 1);
  assert.equal(got.data.comments[0].attachments[0].file_name, 'звіт.txt');
  assert.ok(got.data.activity.some((a) => a.kind === 'commented'));

  const fileId = got.data.comments[0].attachments[0].id;
  const file = await call(`/api/task_attachments/${fileId}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.data, 'привіт');
});

test('завеликий файл у коментарі відхиляється', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  const huge = await call(`/api/task_cards/${card.id}/comments`, {
    method: 'POST',
    body: { body: 'x', attachments: [{ file_name: 'великий.bin', content: dataUrl('A'.repeat(9 * 1024 * 1024)) }] },
  });
  assert.equal(huge.status, 413, JSON.stringify(huge.data));
});

test('видалення картки прибирає її з дошки; на видалену картку — 404', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  assert.equal((await call(`/api/task_cards/${card.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/task_cards/${card.id}`)).status, 404);
  const board = await call(`/api/task_boards/${boardId}`);
  assert.ok(!board.data.columns.some((c) => c.cards.some((x) => x.id === card.id)));
});

test('перетягнути картку в «В роботі» — таймер стартує сам; в іншу колонку — сам зупиняється', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const cols = (await call(`/api/task_boards/${boardId}`)).data.columns;
  const [todo, inProgress, done] = cols; // дефолт: До виконання / В роботі / Готово
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: todo.id, title: 'Задача' } })).data;

  const intoProgress = await call(`/api/task_cards/${card.id}/move`, { method: 'POST', body: { column_id: inProgress.id } });
  assert.equal(intoProgress.status, 200, JSON.stringify(intoProgress.data));

  const running = await call(`/api/task_cards/${card.id}`);
  assert.ok(running.data.runningTimer, 'перенесення в «В роботі» само запустило таймер');
  const startedAuto = running.data.activity.find((a) => a.kind === 'time_started');
  assert.ok(JSON.parse(startedAuto.payload).auto, 'запуск позначено як автоматичний');

  const outOfProgress = await call(`/api/task_cards/${card.id}/move`, { method: 'POST', body: { column_id: done.id } });
  assert.equal(outOfProgress.status, 200);

  const stopped = await call(`/api/task_cards/${card.id}`);
  assert.equal(stopped.data.runningTimer, null, 'перенесення з «В роботі» само зупинило таймер');
  assert.equal(stopped.data.timeEntries.length, 1);
  assert.ok(stopped.data.timeEntries[0].seconds >= 0);
  const stoppedAuto = stopped.data.activity.find((a) => a.kind === 'time_stopped');
  assert.ok(JSON.parse(stoppedAuto.payload).auto, 'зупинку позначено як автоматичну');
});

test('переміщення між двома звичайними колонками не чіпає таймер', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const [todo, , done] = (await call(`/api/task_boards/${boardId}`)).data.columns;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: todo.id, title: 'Задача' } })).data;

  await call(`/api/task_cards/${card.id}/move`, { method: 'POST', body: { column_id: done.id } });
  const got = await call(`/api/task_cards/${card.id}`);
  assert.equal(got.data.runningTimer, null);
  assert.equal(got.data.timeEntries.length, 0);
  assert.ok(!got.data.activity.some((a) => a.kind === 'time_started'));
});

test('якщо таймер уже запущено вручну, повторне перенесення в «В роботі» не плодить другий запис', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const [todo, inProgress] = (await call(`/api/task_boards/${boardId}`)).data.columns;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: todo.id, title: 'Задача' } })).data;

  await call(`/api/task_cards/${card.id}/timer/start`, { method: 'POST' });
  await call(`/api/task_cards/${card.id}/move`, { method: 'POST', body: { column_id: inProgress.id } });
  const got = await call(`/api/task_cards/${card.id}`);
  assert.ok(got.data.runningTimer);
  assert.equal(got.data.timeEntries.length, 1, 'другий запис не завівся — трекер і так уже йшов');
  const startedEvents = got.data.activity.filter((a) => a.kind === 'time_started');
  assert.equal(startedEvents.length, 1, 'друге «запущено» в активність не додалось');
});

test('теги — керовані записи на дошку: створення, призначення картці, перефарбування, видалення', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  const tagA = await call(`/api/task_boards/${boardId}/tags`, { method: 'POST', body: { name: 'Терміново', color: 'orange' } });
  assert.equal(tagA.status, 200, JSON.stringify(tagA.data));
  const tagB = await call(`/api/task_boards/${boardId}/tags`, { method: 'POST', body: { name: 'Важливо', color: 'yellow' } });

  const list = await call(`/api/task_boards/${boardId}/tags`);
  assert.equal(list.data.rows.length, 2);

  const assign = await call(`/api/task_cards/${card.id}/tags`, { method: 'PUT', body: { tag_ids: [tagA.data.id, tagB.data.id] } });
  assert.equal(assign.status, 200, JSON.stringify(assign.data));

  const got = await call(`/api/task_cards/${card.id}`);
  assert.equal(got.data.tags.length, 2);
  assert.deepEqual(got.data.tags.map((t) => t.name).sort(), ['Важливо', 'Терміново']);
  assert.equal(got.data.boardTags.length, 2, 'boardTags — весь довідник дошки, не лише призначені');
  assert.ok(got.data.activity.some((a) => a.kind === 'tags_changed'));

  // Перефарбувати й перейменувати наявний тег.
  const recolor = await call(`/api/task_tags/${tagA.data.id}`, { method: 'PUT', body: { name: 'Гаряче', color: 'pink' } });
  assert.equal(recolor.status, 200);
  const afterRecolor = await call(`/api/task_cards/${card.id}`);
  const renamed = afterRecolor.data.tags.find((t) => t.id === tagA.data.id);
  assert.equal(renamed.name, 'Гаряче');
  assert.equal(renamed.color, 'pink');

  // Зняти один тег — лишається тільки другий.
  const unassign = await call(`/api/task_cards/${card.id}/tags`, { method: 'PUT', body: { tag_ids: [tagB.data.id] } });
  assert.equal(unassign.status, 200);
  const afterUnassign = await call(`/api/task_cards/${card.id}`);
  assert.equal(afterUnassign.data.tags.length, 1);
  assert.equal(afterUnassign.data.tags[0].id, tagB.data.id);

  // Видалити тег зовсім — з довідника дошки й з картки він теж зникає
  // (tagA/«Гаряче» лишається — видаляємо тільки tagB).
  assert.equal((await call(`/api/task_tags/${tagB.data.id}`, { method: 'DELETE' })).status, 200);
  const afterDelete = await call(`/api/task_cards/${card.id}`);
  assert.equal(afterDelete.data.tags.length, 0);
  assert.deepEqual(afterDelete.data.boardTags.map((t) => t.id), [tagA.data.id]);
});

test('тег з чужої дошки не можна призначити картці', async () => {
  const spaceId = await makeSpace();
  const boardA = await makeBoard(spaceId);
  const boardB = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardA}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardA}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;
  const foreignTag = await call(`/api/task_boards/${boardB}/tags`, { method: 'POST', body: { name: 'Чужий', color: 'accent' } });

  const res = await call(`/api/task_cards/${card.id}/tags`, { method: 'PUT', body: { tag_ids: [foreignTag.data.id] } });
  assert.equal(res.status, 400, JSON.stringify(res.data));
});

test('дата початку на картці в беклозі автоматично переносить її в «До виконання»', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const board = await call(`/api/task_boards/${boardId}`);
  const todo = board.data.columns[0];
  // Своя колонка-«беклог» перед стандартними трьома.
  const backlog = await call(`/api/task_boards/${boardId}/columns`, { method: 'POST', body: { name: 'Беклог' } });
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: backlog.data.id, title: 'Задача' } })).data;

  const upd = await call(`/api/task_cards/${card.id}`, { method: 'PUT', body: { start_date: '2026-10-01' } });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));

  const got = await call(`/api/task_cards/${card.id}`);
  assert.equal(got.data.card.column_id, todo.id, 'картка сама переїхала в «До виконання»');
  const movedAuto = got.data.activity.find((a) => a.kind === 'moved');
  assert.ok(movedAuto);
  assert.ok(JSON.parse(movedAuto.payload).auto);
});

test('дата початку не чіпає картку, яка вже в «В роботі»/«Готово»', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const [, inProgress] = (await call(`/api/task_boards/${boardId}`)).data.columns;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: inProgress.id, title: 'Задача' } })).data;

  await call(`/api/task_cards/${card.id}`, { method: 'PUT', body: { start_date: '2026-10-01' } });
  const got = await call(`/api/task_cards/${card.id}`);
  assert.equal(got.data.card.column_id, inProgress.id, 'уже в «В роботі» — авто-перенесення не спрацьовує');
  assert.ok(!got.data.activity.some((a) => a.kind === 'moved'));
});

test('редагування запису часу точними межами «з — до» рахує секунди самостійно', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  await call(`/api/task_cards/${card.id}/timer/start`, { method: 'POST' });
  await call(`/api/task_cards/${card.id}/timer/stop`, { method: 'POST' });
  const entryId = (await call(`/api/task_cards/${card.id}`)).data.timeEntries[0].id;

  const edited = await call(`/api/task_time_entries/${entryId}`, {
    method: 'PUT', body: { started_at: '2026-09-24T09:00:00.000Z', ended_at: '2026-09-24T11:30:00.000Z' },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));

  const got = await call(`/api/task_cards/${card.id}`);
  assert.equal(got.data.timeEntries[0].seconds, 2.5 * 3600);
  assert.equal(got.data.totalSeconds, 2.5 * 3600);
  const editedEvent = got.data.activity.find((a) => a.kind === 'time_edited');
  assert.equal(JSON.parse(editedEvent.payload).entry_id, entryId);
});

test('кінець раніше початку в редагуванні запису часу відхиляється', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;
  await call(`/api/task_cards/${card.id}/timer/start`, { method: 'POST' });
  await call(`/api/task_cards/${card.id}/timer/stop`, { method: 'POST' });
  const entryId = (await call(`/api/task_cards/${card.id}`)).data.timeEntries[0].id;

  const res = await call(`/api/task_time_entries/${entryId}`, {
    method: 'PUT', body: { started_at: '2026-09-24T11:00:00.000Z', ended_at: '2026-09-24T09:00:00.000Z' },
  });
  assert.equal(res.status, 400);
});

test('колонка створюється з кольором, редагується (назва/колір/згорнутість/позиція)', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);

  const created = await call(`/api/task_boards/${boardId}/columns`, { method: 'POST', body: { name: 'Огляд', color: 'purple' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const colId = created.data.id;

  let board = (await call(`/api/task_boards/${boardId}`)).data;
  let col = board.columns.find((c) => c.id === colId);
  assert.equal(col.color, 'purple');
  assert.equal(col.collapsed, 0);

  const badColor = await call(`/api/task_boards/${boardId}/columns`, { method: 'POST', body: { name: 'Х', color: 'not-a-color' } });
  const badColorCol = (await call(`/api/task_boards/${boardId}`)).data.columns.find((c) => c.id === badColor.data.id);
  assert.equal(badColorCol.color, 'accent', 'невідомий колір мовчки падає на дефолтний');

  const upd = await call(`/api/task_columns/${colId}`, { method: 'PUT', body: { name: 'Огляд PR', color: 'green', collapsed: true } });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  board = (await call(`/api/task_boards/${boardId}`)).data;
  col = board.columns.find((c) => c.id === colId);
  assert.equal(col.name, 'Огляд PR');
  assert.equal(col.color, 'green');
  assert.equal(col.collapsed, 1);

  // Перетягування колонки — та сама дробова позиція (board_order), що й у
  // карток: переставляємо нову колонку між двома дефолтними.
  const [first, second] = board.columns;
  await call(`/api/task_columns/${colId}`, { method: 'PUT', body: { board_order: (first.board_order + second.board_order) / 2 } });
  board = (await call(`/api/task_boards/${boardId}`)).data;
  assert.equal(board.columns[1].id, colId);
});

test('швидке створення картки одразу з виконавцем/датою/пріоритетом/тегами', async () => {
  const ownerId = (await call('/api/auth/me')).data.user.id;
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const tag = await call(`/api/task_boards/${boardId}/tags`, { method: 'POST', body: { name: 'Швидкий', color: 'pink' } });

  const created = await call(`/api/task_boards/${boardId}/cards`, {
    method: 'POST',
    body: {
      column_id: colId, title: 'Швидка задача', assignee_user_id: ownerId, due_date: '2026-11-01',
      priority: 'urgent', tag_ids: [tag.data.id],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  const got = (await call(`/api/task_cards/${created.data.id}`)).data;
  assert.equal(got.card.assignee_user_id, ownerId);
  assert.equal(got.card.due_date, '2026-11-01');
  assert.equal(got.card.priority, 'urgent');
  assert.deepEqual(got.tags.map((t) => t.id), [tag.data.id]);
  // Швидке створення не засмічує Activity полем-за-полем (жодного окремого
  // field_changed на assignee/due_date/priority) — лише факт створення й
  // те, що теги виставились (той самий запис, що й на призначенні тегів
  // з повної картки).
  assert.deepEqual(got.activity.map((a) => a.kind), ['created', 'tags_changed']);
});

test('блоки опису (Notion-подібний редактор) зберігаються як є й логуються одним записом', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  const blocks = [
    { id: 'b1', type: 'paragraph', text: 'Опис задачі' },
    { id: 'b2', type: 'checklist', items: [{ id: 'i1', text: 'Крок 1', checked: false }] },
    { id: 'b3', type: 'table', rows: [['A', 'B'], ['1', '2']] },
    { id: 'b4', type: 'toggle', title: 'Деталі', text: 'Прихований текст', open: false },
  ];
  const upd = await call(`/api/task_cards/${card.id}`, { method: 'PUT', body: { description_blocks: blocks } });
  assert.equal(upd.status, 200, JSON.stringify(upd.data));

  const got = (await call(`/api/task_cards/${card.id}`)).data;
  assert.deepEqual(got.card.description_blocks, blocks);
  const changed = got.activity.filter((a) => a.kind === 'description_changed');
  assert.equal(changed.length, 1);

  // Той самий вміст ще раз — жодного нового запису в Activity.
  await call(`/api/task_cards/${card.id}`, { method: 'PUT', body: { description_blocks: blocks } });
  const again = (await call(`/api/task_cards/${card.id}`)).data;
  assert.equal(again.activity.filter((a) => a.kind === 'description_changed').length, 1);
});

test('коментарі можна закріпити — кілька одразу, з можливістю відкріпити', async () => {
  const spaceId = await makeSpace();
  const boardId = await makeBoard(spaceId);
  const colId = (await call(`/api/task_boards/${boardId}`)).data.columns[0].id;
  const card = (await call(`/api/task_boards/${boardId}/cards`, { method: 'POST', body: { column_id: colId, title: 'Задача' } })).data;

  const c1 = (await call(`/api/task_cards/${card.id}/comments`, { method: 'POST', body: { body: 'Перший' } })).data;
  const c2 = (await call(`/api/task_cards/${card.id}/comments`, { method: 'POST', body: { body: 'Другий' } })).data;
  const c3 = (await call(`/api/task_cards/${card.id}/comments`, { method: 'POST', body: { body: 'Третій' } })).data;

  let got = (await call(`/api/task_cards/${card.id}`)).data;
  assert.ok(got.comments.every((c) => c.pinned === 0));

  const pin1 = await call(`/api/task_comments/${c1.id}/pin`, { method: 'PUT', body: { pinned: true } });
  assert.equal(pin1.status, 200, JSON.stringify(pin1.data));
  await call(`/api/task_comments/${c3.id}/pin`, { method: 'PUT', body: { pinned: true } });

  got = (await call(`/api/task_cards/${card.id}`)).data;
  const pinned = got.comments.filter((c) => c.pinned);
  assert.deepEqual(pinned.map((c) => c.id).sort(), [c1.id, c3.id].sort());
  assert.equal(got.comments.find((c) => c.id === c2.id).pinned, 0);

  // Відкріпити — так само доступно.
  await call(`/api/task_comments/${c1.id}/pin`, { method: 'PUT', body: { pinned: false } });
  got = (await call(`/api/task_cards/${card.id}`)).data;
  assert.deepEqual(got.comments.filter((c) => c.pinned).map((c) => c.id), [c3.id]);
});
