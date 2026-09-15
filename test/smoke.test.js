// Інтеграційні перевірки: авторизація, RBAC, постбек-дедуплікація, ЗП, аудит.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbFile = path.join(os.tmpdir(), `crm-test-${Date.now()}.db`);
const PORT = 3400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, CRM_DB: dbFile, CRM_PORT: String(PORT), CRM_POSTBACK_PORT: String(PORT + 1), CRM_SECRET_KEY: 'a'.repeat(64), CRM_TICK_MS: '3600000' };
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
  fs.rmSync(dbFile, { force: true });
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
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
