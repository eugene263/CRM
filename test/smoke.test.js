// Інтеграційні перевірки: авторизація, RBAC, постбек-дедуплікація, ЗП, аудит.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
