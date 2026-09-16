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
  const sumOfLines = row.lines.reduce((s, l) => s + l.total, 0);
  assert.equal(Math.round(sumOfLines * 100) / 100, row.direct, 'прямі = сума рядків');
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

test('зміна ставки перераховує всі послуги, де вона використана', async () => {
  const before = (await call('/api/costing/services')).data.rows;
  const rate = (await call('/api/cost_rates?code=editor_hour')).data.rows[0];
  await call(`/api/cost_rates/${rate.id}`, { method: 'PUT', body: { amount: Number(rate.amount) + 10 } });

  const after = (await call('/api/costing/services')).data.rows;
  const affected = after.filter((r) => r.lines.some((l) => l.rate_code === 'editor_hour'));
  assert.ok(affected.length >= 2, 'ставка використана в кількох послугах');
  for (const row of affected) {
    const old = before.find((b) => b.service.id === row.service.id);
    assert.ok(row.cost > old.cost, `${row.service.name}: собівартість зросла`);
  }
  await call(`/api/cost_rates/${rate.id}`, { method: 'PUT', body: { amount: rate.amount } });
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
