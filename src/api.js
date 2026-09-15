// REST API. Один генерик-CRUD на всі сутності з entities.js + кастомні
// ендпоїнти (дашборд, ЗП, трекінг, постбеки, експорт).
import { all, get, insert, update, remove, run, audit, setting } from './db.js';
import { entities } from './entities.js';
import {
  can, capable, scopeWhere, scopeOf, ownsRow, sanitize, visibleFields,
  invalidateRbacCache, roleRow, revealLimit,
} from './rbac.js';
import * as vault from './vault.js';
import { encrypt, decrypt, token, hashIp } from './crypto.js';
import { hashPassword } from './crypto.js';
import * as auth from './auth.js';
import * as analytics from './analytics.js';
import * as finance from './finance.js';
import { notify, flushQueue } from './telegram.js';
import { ok, fail, send, readBody, clientIp, rateLimit } from './http.js';

const MAX_LIMIT = 500;

// ── Валідація та приведення типів ─────────────────────────────────────────
function coerce(field, value) {
  if (value === '' || value === null || value === undefined) return null;
  switch (field.type) {
    case 'number': case 'money': {
      const n = Number(value);
      if (Number.isNaN(n)) throw Object.assign(new Error(`Поле «${field.label}» має бути числом`), { status: 400 });
      return n;
    }
    case 'ref': {
      const n = Number(value);
      if (Number.isNaN(n)) throw Object.assign(new Error(`Поле «${field.label}» має бути ID`), { status: 400 });
      return n;
    }
    case 'select': {
      const allowed = (field.options || []).map((o) => o.value);
      if (allowed.length && !allowed.includes(String(value))) {
        throw Object.assign(new Error(`Поле «${field.label}»: недопустиме значення`), { status: 400 });
      }
      return String(value);
    }
    default:
      return String(value);
  }
}

function buildPayload(user, entKey, body, { isCreate }) {
  const ent = entities[entKey];
  const out = {};
  const hidden = new Set(visibleFields(user, entKey).map((f) => f.name));
  for (const f of ent.fields) {
    if (f.readOnly || f.virtual) continue;
    if (!(f.name in body)) continue;
    if (!hidden.has(f.name)) continue;                       // роль не бачить поле — не може його і писати
    let v = coerce(f, body[f.name]);
    if (f.type === 'secret') v = v === null ? null : encrypt(v);
    out[f.name] = v;
  }
  if (isCreate) {
    for (const f of ent.fields) {
      if (f.required && !f.readOnly && !f.virtual && (out[f.name] === undefined || out[f.name] === null)) {
        throw Object.assign(new Error(`Поле «${f.label}» обовʼязкове`), { status: 400 });
      }
    }
  }
  return out;
}

// Скоуп на запис: крієйтор не може створити чужий пост, тімлід — чужій команді.
function enforceScopeOnWrite(user, entKey, data, { isCreate }) {
  const ent = entities[entKey];
  const scope = scopeOf(user, entKey);
  if (scope === 'own' && ent.ownField) data[ent.ownField] = user.id;
  if (scope === 'team' && ent.teamField && isCreate && data[ent.teamField] == null) data[ent.teamField] = user.team_id ?? null;
  if (scope === 'team' && ent.teamField && data[ent.teamField] != null && data[ent.teamField] !== user.team_id) {
    throw Object.assign(new Error('Немає доступу до чужої команди'), { status: 403 });
  }
  if (isCreate && ent.ownField && data[ent.ownField] == null && ['posts', 'creatives', 'tracking_links'].includes(entKey)) {
    data[ent.ownField] = user.id;
  }
  if (isCreate && ent.teamField && data[ent.teamField] == null) data[ent.teamField] = user.team_id ?? null;
  return data;
}

// ── Побічні ефекти конкретних сутностей ───────────────────────────────────
const hooks = {
  users: {
    beforeWrite(user, data, body, { isCreate, current }) {
      if (body.password) {
        if (!capable(user, 'settings') && user.id !== current?.id) {
          throw Object.assign(new Error('Змінювати чужий пароль може лише власник/хед'), { status: 403 });
        }
        data.password_hash = hashPassword(body.password);
      } else if (isCreate) {
        throw Object.assign(new Error('Пароль обовʼязковий'), { status: 400 });
      }
      if (data.role === 'owner' && user.role !== 'owner') {
        throw Object.assign(new Error('Призначити власника може лише власник'), { status: 403 });
      }
      return data;
    },
  },
  accounts: {
    afterWrite(user, id, data, { isCreate, current }) {
      const to = data.status;
      const from = current?.status ?? null;
      if (isCreate || (to && to !== from)) {
        insert('account_events', { account_id: id, from_status: from, to_status: to || 'farm', user_id: user.id });
        if (to === 'ban') {
          run(`UPDATE accounts SET banned_at=COALESCE(banned_at, date('now')) WHERE id=?`, id);
          const acc = get('SELECT nickname, platform, owner_user_id FROM accounts WHERE id=?', id);
          notify('ban', `🚫 Бан: ${acc.platform} @${acc.nickname} (акаунт #${id})`, acc.owner_user_id);
        }
        if (to === 'active') run(`UPDATE accounts SET live_started_at=COALESCE(live_started_at, date('now')) WHERE id=?`, id);
        if (to === 'farm') run(`UPDATE accounts SET farm_started_at=COALESCE(farm_started_at, date('now')) WHERE id=?`, id);
      }
      if (isCreate && data.owner_user_id) {
        insert('resource_assignments', { resource_type: 'account', resource_id: id, user_id: data.owner_user_id, action: 'issued' });
      }
    },
  },
  offers: {
    afterWrite(user, id, data, { isCreate, current }) {
      if (data.payout != null && (isCreate || Number(data.payout) !== Number(current?.payout))) {
        insert('offer_rates_history', { offer_id: id, payout: data.payout, user_id: user.id });
      }
    },
  },
  partners: {
    beforeWrite(user, data, body, { isCreate }) {
      if (isCreate) data.postback_token = token(12);
      return data;
    },
  },
  devices: {
    afterWrite(user, id, data, { isCreate, current }) {
      if (data.holder_user_id != null && data.holder_user_id !== current?.holder_user_id) {
        insert('resource_assignments', { resource_type: 'device', resource_id: id, user_id: data.holder_user_id, action: 'issued' });
      }
    },
  },
  tracking_links: {
    beforeWrite(user, data, body, { isCreate }) {
      if (isCreate) data.slug = token(6);
      return data;
    },
  },
  access_requests: {
    beforeWrite(user, data, body, { isCreate }) {
      if (isCreate) {
        data.user_id = user.id;
        data.status = 'pending';
        data.expires_at = new Date(Date.now() + Math.min(Number(body.hours) || 8, 72) * 3600e3)
          .toISOString().slice(0, 19).replace('T', ' ');
      }
      return data;
    },
    afterWrite(user, id, data, { isCreate }) {
      if (!isCreate) return;
      const cred = get('SELECT title FROM credentials WHERE id=?', data.credential_id);
      for (const a of all(`SELECT id FROM users WHERE role IN ('owner','head','teamlead') AND status='active'`)) {
        notify('access', `🙋 ${user.name} просить доступ «${cred?.title ?? data.credential_id}»`, a.id);
      }
    },
  },
  conversions: {
    beforeWrite(user, data, body, { isCreate }) {
      if (isCreate && !data.converted_at) data.converted_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
      if (isCreate && data.payout == null && data.offer_id) {
        data.payout = get('SELECT payout FROM offers WHERE id=?', data.offer_id)?.payout ?? 0;
      }
      return data;
    },
  },
};

// ── Список із фільтрами ───────────────────────────────────────────────────
function listRows(user, entKey, query) {
  const ent = entities[entKey];
  const where = ['1=1'];
  const params = [];
  const scope = scopeWhere(user, entKey, 't');
  where.push(scope.sql); params.push(...scope.params);

  const visible = new Set(visibleFields(user, entKey).map((f) => f.name));
  for (const [key, value] of Object.entries(query)) {
    if (['limit', 'offset', 'sort', 'q', 'from', 'to', 'format'].includes(key)) continue;
    if (!visible.has(key)) continue;
    where.push(`t.${key} = ?`);
    params.push(value);
  }
  if (query.q) {
    const textFields = ent.fields.filter((f) => ['text', 'textarea', 'url'].includes(f.type) && visible.has(f.name));
    if (textFields.length) {
      where.push(`(${textFields.map((f) => `t.${f.name} LIKE ?`).join(' OR ')})`);
      params.push(...textFields.map(() => `%${query.q}%`));
    }
  }
  const dateField = ent.fields.find((f) => ['date', 'datetime'].includes(f.type) && f.list);
  if (dateField && (query.from || query.to)) {
    if (query.from) { where.push(`t.${dateField.name} >= ?`); params.push(query.from); }
    if (query.to) { where.push(`t.${dateField.name} <= ?`); params.push(`${query.to} 23:59:59`); }
  }

  const sortRaw = String(query.sort || ent.defaultSort);
  const sort = /^[a-z_]+ (ASC|DESC)$/i.test(sortRaw) && ent.fields.some((f) => sortRaw.startsWith(f.name))
    ? sortRaw : ent.defaultSort;
  const limit = Math.min(Number(query.limit) || 100, MAX_LIMIT);
  const offset = Number(query.offset) || 0;

  const rows = all(
    `SELECT t.* FROM ${ent.table} t WHERE ${where.join(' AND ')} ORDER BY t.${sort} LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  ).map((r) => sanitize(user, entKey, r));
  const total = Number(get(`SELECT COUNT(*) AS c FROM ${ent.table} t WHERE ${where.join(' AND ')}`, ...params)?.c || 0);
  return { rows, total, limit, offset };
}

// Довідники для випадаючих списків (id → підпис).
function refOptions(user) {
  const out = {};
  const titles = {
    users: 'name', teams: 'name', accounts: 'nickname', devices: 'model', sims: 'number',
    proxies: 'host', mail_accounts: 'login', offers: 'name', partners: 'name', creatives: 'title', posts: 'url',
  };
  for (const [key, col] of Object.entries(titles)) {
    if (!can(user, key, 'read')) continue;
    const scope = scopeWhere(user, key, 't');
    out[key] = all(
      `SELECT t.id, COALESCE(t.${col}, 'ID ' || t.id) AS label FROM ${key} t WHERE ${scope.sql} ORDER BY t.id DESC LIMIT 500`,
      ...scope.params,
    );
  }
  return out;
}

function csv(rows, fields, user) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = fields.map((f) => esc(f.label)).join(',');
  // Водяний знак: видно, хто саме вивантажив цей файл.
  const mark = `# export: ${user.email} (#${user.id}) @ ${new Date().toISOString()}`;
  const body = rows.map((r) => fields.map((f) => esc(r[f.name])).join(',')).join('\n');
  return `${mark}\n${header}\n${body}\n`;
}

// ── Роутер ────────────────────────────────────────────────────────────────
export async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const query = Object.fromEntries(url.searchParams);
  const ip = clientIp(req);

  // --- публічні ендпоїнти ---
  if (seg[0] === 'auth' && seg[1] === 'login' && req.method === 'POST') {
    if (!rateLimit(`login:${ip}`, 10, 60_000)) return fail(res, 429, 'Забагато спроб, спробуйте за хвилину');
    const body = await readBody(req);
    const result = auth.login({ ...body, ip, userAgent: req.headers['user-agent'] });
    if (result.error) return fail(res, 401, result.error, { need2fa: !!result.need2fa });
    return send(res, 200, { user: result.user }, { 'set-cookie': auth.sessionCookie(result.token) });
  }

  const user = auth.userFromRequest(req);
  if (!user) return fail(res, 401, 'Потрібна авторизація');

  if (seg[0] === 'auth') {
    if (seg[1] === 'me') return ok(res, { user: auth.publicUser(user), permissions: permissionsFor(user) });
    if (seg[1] === 'logout' && req.method === 'POST') {
      auth.logout(user.session_token, user.id, ip);
      return send(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() });
    }
    if (seg[1] === 'password' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.password || String(body.password).length < 8) return fail(res, 400, 'Мінімум 8 символів');
      auth.setPassword(user.id, body.password);
      audit({ user_id: user.id, action: 'password_change', entity: 'users', entity_id: user.id, ip });
      return ok(res, { ok: true });
    }
    if (seg[1] === '2fa' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.disable) { auth.disable2fa(user.id); audit({ user_id: user.id, action: '2fa_disable', ip }); return ok(res, { ok: true }); }
      const enabled = auth.enable2fa(user.id);
      audit({ user_id: user.id, action: '2fa_enable', ip });
      return ok(res, enabled);
    }
    if (seg[1] === 'sessions' && req.method === 'DELETE' && seg[2]) {
      const killed = auth.killSession(user.id, seg[2]);
      audit({ user_id: user.id, action: 'session_kill', entity: 'sessions', payload: { killed }, ip });
      return ok(res, { killed });
    }
    if (seg[1] === 'sessions') return ok(res, { rows: auth.sessionsOf(user.id) });
    return fail(res, 404, 'Немає такого ендпоїнта');
  }

  // --- метадані для інтерфейсу ---
  if (seg[0] === 'meta') {
    const meta = {};
    for (const [key, ent] of Object.entries(entities)) {
      if (!can(user, key, 'read')) continue;
      meta[key] = {
        key, label: ent.label, group: ent.group, icon: ent.icon, title: ent.title,
        fields: visibleFields(user, key),
        can: {
          read: true, create: can(user, key, 'create'), update: can(user, key, 'update'), delete: can(user, key, 'delete'),
        },
        scope: scopeOf(user, key),
      };
    }
    return ok(res, { entities: meta, refs: refOptions(user), user: auth.publicUser(user), caps: capsOf(user) });
  }

  if (seg[0] === 'refs') return ok(res, refOptions(user));

  // --- аналітика ---
  if (seg[0] === 'dashboard') {
    return ok(res, {
      summary: analytics.summary(user, query),
      timeline: analytics.timeline(user, query),
      topCreatives: analytics.breakdown(user, { ...query, dim: 'creative' }).slice(0, 10),
      topUsers: can(user, 'users', 'read') ? analytics.breakdown(user, { ...query, dim: 'user' }).slice(0, 10) : [],
      alerts: can(user, 'accounts', 'read') ? analytics.alerts(user) : { proxyExpiring: [], bans24: [], planToday: [] },
    });
  }
  if (seg[0] === 'analytics') {
    if (seg[1] === 'breakdown') return ok(res, { rows: analytics.breakdown(user, query) });
    if (seg[1] === 'lifetime') return ok(res, { rows: analytics.accountLifetime() });
    if (seg[1] === 'burnout') return ok(res, { rows: analytics.burnout(user) });
    return fail(res, 404, 'Немає такого звіту');
  }

  // --- фінанси ---
  if (seg[0] === 'finance') {
    if (!capable(user, 'salary_calc') && !can(user, 'payouts', 'read')) return fail(res, 403, 'Немає доступу');
    if (seg[1] === 'salary' && req.method === 'POST') {
      if (!capable(user, 'salary_calc')) return fail(res, 403, 'Немає доступу до розрахунку ЗП');
      const body = await readBody(req);
      return ok(res, finance.calcSalary(body.period, { commit: !!body.commit, actorId: user.id }));
    }
    if (seg[1] === 'salary') {
      if (!capable(user, 'salary_calc')) return fail(res, 403, 'Немає доступу до розрахунку ЗП');
      return ok(res, finance.calcSalary(query.period || new Date().toISOString().slice(0, 7), { commit: false }));
    }
    if (seg[1] === 'pnl') {
      if (!can(user, 'expenses', 'read')) return fail(res, 403, 'Немає доступу');
      return ok(res, finance.pnl(query.period || new Date().toISOString().slice(0, 7)));
    }
    if (seg[1] === 'my') {
      const p = query.period || new Date().toISOString().slice(0, 7);
      return ok(res, { period: p, stats: finance.userStats(user.id, p), payout: get('SELECT * FROM payouts WHERE user_id=? AND period=?', user.id, p) });
    }
    return fail(res, 404, 'Немає такого ендпоїнта');
  }

  if (seg[0] === 'notifications' && seg[1] === 'flush' && req.method === 'POST') {
    if (!capable(user, 'settings')) return fail(res, 403, 'Немає доступу');
    return ok(res, await flushQueue());
  }

  // --- імпорт конверсій CSV ---
  if (seg[0] === 'import' && seg[1] === 'conversions' && req.method === 'POST') {
    if (!can(user, 'conversions', 'create')) return fail(res, 403, 'Немає доступу');
    const body = await readBody(req);
    const result = importConversions(String(body.csv || ''), user, ip);
    return ok(res, result);
  }

  // --- сейф доступів ---
  if (seg[0] === 'credentials' && seg[1] && seg[2]) {
    const credId = Number(seg[1]);
    if (!can(user, 'credentials', 'read')) return fail(res, 403, 'Немає доступу до сейфа');
    if (seg[2] === 'reveal' && seg[3]) return ok(res, vault.reveal(user, credId, seg[3], ip));
    if (seg[2] === 'totp') return ok(res, vault.totp(user, credId, ip));
    if (seg[2] === 'issue' && req.method === 'POST') {
      if (!can(user, 'credentials', 'update')) return fail(res, 403, 'Немає прав видавати доступи');
      return ok(res, vault.issue(user, credId, await readBody(req), ip));
    }
    if (seg[2] === 'return' && req.method === 'POST') return ok(res, vault.returnBack(user, credId, await readBody(req), ip));
    if (seg[2] === 'revoke' && req.method === 'POST') {
      if (!can(user, 'credentials', 'update')) return fail(res, 403, 'Немає прав відкликати доступи');
      return ok(res, vault.revoke(user, credId, (await readBody(req)).reason, ip));
    }
    if (seg[2] === 'grants') {
      return ok(res, { rows: all('SELECT * FROM credential_grants WHERE credential_id=? ORDER BY granted_at DESC', credId) });
    }
  }

  if (seg[0] === 'access_requests' && seg[1] && seg[2] === 'decide' && req.method === 'POST') {
    if (!capable(user, 'settings') && user.role !== 'teamlead') return fail(res, 403, 'Апрувити доступи може тімлід або вище');
    const body = await readBody(req);
    return ok(res, vault.decideAccess(user, Number(seg[1]), !!body.approve, ip));
  }

  if (seg[0] === 'users' && seg[1] && seg[2] === 'offboard' && req.method === 'POST') {
    if (!capable(user, 'settings')) return fail(res, 403, 'Офбординг доступний лише власнику/хеду');
    return ok(res, vault.offboard(user, Number(seg[1]), ip));
  }

  // --- конструктор ролей ---
  if (seg[0] === 'roles') {
    if (req.method === 'GET') {
      if (!can(user, 'users', 'read')) return fail(res, 403, 'Немає доступу');
      return ok(res, {
        roles: all('SELECT * FROM roles ORDER BY key'),
        permissions: all('SELECT * FROM role_permissions ORDER BY role_key, entity'),
        entities: Object.fromEntries(Object.entries(entities).map(([k, e]) => [k, { label: e.label, group: e.group, fields: e.fields.map((f) => f.name) }])),
      });
    }
    if (!capable(user, 'settings')) return fail(res, 403, 'Редагувати ролі може лише власник/хед');
    const body = await readBody(req);
    if (req.method === 'POST' && !seg[1]) {
      if (!/^[a-z_]{3,20}$/.test(String(body.key || ''))) return fail(res, 400, 'Ключ ролі: латиниця і підкреслення, 3–20 символів');
      if (get('SELECT key FROM roles WHERE key=?', body.key)) return fail(res, 409, 'Така роль уже існує');
      insert('roles', {
        key: body.key, label: body.label || body.key, is_system: 0,
        can_export: body.can_export ? 1 : 0, can_reveal: body.can_reveal ? 1 : 0,
        can_salary_calc: body.can_salary_calc ? 1 : 0, can_settings: body.can_settings ? 1 : 0,
        reveal_daily_limit: Number(body.reveal_daily_limit ?? 20),
      });
      // Нова роль стартує без прав: адміністратор відкриває їх свідомо.
      for (const entityKey of Object.keys(entities)) {
        insert('role_permissions', { role_key: body.key, entity: entityKey, level: 'none', scope: 'own', hidden_fields: null });
      }
      invalidateRbacCache();
      audit({ user_id: user.id, action: 'role_create', entity: 'roles', payload: { key: body.key }, ip });
      return ok(res, { ok: true });
    }
    if ((req.method === 'PUT' || req.method === 'PATCH') && seg[1]) {
      const roleKey = seg[1];
      if (!get('SELECT key FROM roles WHERE key=?', roleKey)) return fail(res, 404, 'Роль не знайдено');
      if (roleKey === 'owner') return fail(res, 403, 'Права власника змінювати не можна');
      const caps = {};
      for (const c of ['can_export', 'can_reveal', 'can_salary_calc', 'can_settings']) {
        if (c in body) caps[c] = body[c] ? 1 : 0;
      }
      if ('label' in body) caps.label = String(body.label);
      if ('reveal_daily_limit' in body) caps.reveal_daily_limit = Number(body.reveal_daily_limit);
      if (Object.keys(caps).length) {
        run(`UPDATE roles SET ${Object.keys(caps).map((k) => `${k}=?`).join(',')} WHERE key=?`,
          ...Object.values(caps), roleKey);
      }
      for (const p of body.permissions || []) {
        if (!entities[p.entity]) continue;
        if (!['none', 'read', 'write', 'full'].includes(p.level) || !['all', 'team', 'own'].includes(p.scope)) {
          return fail(res, 400, 'Некоректний рівень або скоуп');
        }
        run(`INSERT INTO role_permissions (role_key, entity, level, scope, hidden_fields) VALUES (?,?,?,?,?)
             ON CONFLICT(role_key, entity) DO UPDATE SET level=excluded.level, scope=excluded.scope, hidden_fields=excluded.hidden_fields`,
          roleKey, p.entity, p.level, p.scope, (p.hidden_fields || []).join(',') || null);
      }
      invalidateRbacCache();
      audit({ user_id: user.id, action: 'role_update', entity: 'roles', payload: { role: roleKey, changed: (body.permissions || []).length }, ip });
      return ok(res, { ok: true });
    }
    if (req.method === 'DELETE' && seg[1]) {
      const role = get('SELECT * FROM roles WHERE key=?', seg[1]);
      if (!role) return fail(res, 404, 'Роль не знайдено');
      if (role.is_system) return fail(res, 403, 'Системну роль видалити не можна');
      if (get('SELECT id FROM users WHERE role=? LIMIT 1', seg[1])) return fail(res, 409, 'Роль призначена користувачам');
      run('DELETE FROM role_permissions WHERE role_key=?', seg[1]);
      run('DELETE FROM roles WHERE key=?', seg[1]);
      invalidateRbacCache();
      audit({ user_id: user.id, action: 'role_delete', entity: 'roles', payload: { key: seg[1] }, ip });
      return ok(res, { ok: true });
    }
  }

  // --- генерик CRUD ---
  const entKey = seg[0];
  const ent = entities[entKey];
  if (!ent) return fail(res, 404, 'Невідома сутність');
  if (!can(user, entKey, 'read')) {
    audit({ user_id: user.id, action: 'denied', entity: entKey, ip });
    return fail(res, 403, 'Немає доступу до цього розділу');
  }

  // /api/:entity/export
  if (seg[1] === 'export') {
    if (!capable(user, 'export')) {
      audit({ user_id: user.id, action: 'denied_export', entity: entKey, ip });
      return fail(res, 403, 'Експорт заборонений для вашої ролі');
    }
    const { rows } = listRows(user, entKey, { ...query, limit: MAX_LIMIT });
    audit({ user_id: user.id, action: 'export', entity: entKey, payload: { rows: rows.length, query }, ip });
    return send(res, 200, csv(rows, visibleFields(user, entKey), user), {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${entKey}-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }

  const id = Number(seg[1]);

  // /api/:entity/:id/secret/:field — розкриття зашифрованого поля
  if (seg[2] === 'secret' && seg[3]) {
    if (!capable(user, 'secrets')) {
      audit({ user_id: user.id, action: 'denied_reveal', entity: entKey, entity_id: id, ip });
      return fail(res, 403, 'Немає доступу до секретів');
    }
    const field = ent.fields.find((f) => f.name === seg[3] && f.type === 'secret');
    if (!field) return fail(res, 404, 'Поле не знайдено');
    const row = get(`SELECT * FROM ${ent.table} WHERE id=?`, id);
    if (!row || !ownsRow(user, entKey, row)) return fail(res, 404, 'Запис не знайдено');
    const budget = vault.checkRevealBudget(user);
    audit({ user_id: user.id, action: 'reveal', entity: entKey, entity_id: id, payload: { field: field.name }, ip });
    vault.noteReveal(user);
    return ok(res, { value: decrypt(row[field.name]), used: budget.used + 1, limit: budget.limit });
  }

  // /api/:entity/:id/history — журнал для акаунта
  if (seg[2] === 'history') {
    const rows = entKey === 'accounts'
      ? all('SELECT * FROM account_events WHERE account_id=? ORDER BY created_at DESC', id)
      : all('SELECT * FROM resource_assignments WHERE resource_type=? AND resource_id=? ORDER BY created_at DESC', entKey.replace(/s$/, ''), id);
    return ok(res, { rows });
  }

  if (req.method === 'GET' && !seg[1]) return ok(res, listRows(user, entKey, query));

  if (req.method === 'GET' && id) {
    const row = get(`SELECT * FROM ${ent.table} WHERE id=?`, id);
    if (!row || !ownsRow(user, entKey, row)) return fail(res, 404, 'Запис не знайдено');
    return ok(res, { row: sanitize(user, entKey, row) });
  }

  if (req.method === 'POST' && !seg[1]) {
    if (!can(user, entKey, 'create')) return fail(res, 403, 'Немає прав на створення');
    const body = await readBody(req);
    let data = buildPayload(user, entKey, body, { isCreate: true });
    data = enforceScopeOnWrite(user, entKey, data, { isCreate: true });
    if (hooks[entKey]?.beforeWrite) data = hooks[entKey].beforeWrite(user, data, body, { isCreate: true, current: null });
    const newId = insert(ent.table, data);
    hooks[entKey]?.afterWrite?.(user, newId, data, { isCreate: true, current: null });
    audit({ user_id: user.id, action: 'create', entity: entKey, entity_id: newId, payload: redact(ent, data), ip });
    return ok(res, { id: newId, row: sanitize(user, entKey, get(`SELECT * FROM ${ent.table} WHERE id=?`, newId)) });
  }

  if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
    if (!can(user, entKey, 'update')) return fail(res, 403, 'Немає прав на редагування');
    const current = get(`SELECT * FROM ${ent.table} WHERE id=?`, id);
    if (!current || !ownsRow(user, entKey, current)) return fail(res, 404, 'Запис не знайдено');
    const body = await readBody(req);
    let data = buildPayload(user, entKey, body, { isCreate: false });
    data = enforceScopeOnWrite(user, entKey, data, { isCreate: false });
    if (hooks[entKey]?.beforeWrite) data = hooks[entKey].beforeWrite(user, data, body, { isCreate: false, current });
    update(ent.table, id, data);
    hooks[entKey]?.afterWrite?.(user, id, data, { isCreate: false, current });
    audit({ user_id: user.id, action: 'update', entity: entKey, entity_id: id, payload: redact(ent, data), ip });
    return ok(res, { row: sanitize(user, entKey, get(`SELECT * FROM ${ent.table} WHERE id=?`, id)) });
  }

  if (req.method === 'DELETE' && id) {
    if (!can(user, entKey, 'delete')) return fail(res, 403, 'Немає прав на видалення');
    const current = get(`SELECT * FROM ${ent.table} WHERE id=?`, id);
    if (!current || !ownsRow(user, entKey, current)) return fail(res, 404, 'Запис не знайдено');
    remove(ent.table, id);
    audit({ user_id: user.id, action: 'delete', entity: entKey, entity_id: id, payload: redact(ent, current), ip });
    return ok(res, { ok: true });
  }

  return fail(res, 405, 'Метод не підтримується');
}

function redact(ent, data) {
  const out = { ...data };
  for (const f of ent.fields) if (f.type === 'secret' || f.type === 'password') delete out[f.name];
  delete out.password_hash;
  return out;
}

function permissionsFor(user) {
  const out = {};
  for (const key of Object.keys(entities)) {
    if (!can(user, key, 'read')) continue;
    out[key] = { read: true, create: can(user, key, 'create'), update: can(user, key, 'update'), delete: can(user, key, 'delete'), scope: scopeOf(user, key) };
  }
  return out;
}

const capsOf = (user) => ({
  secrets: capable(user, 'secrets'), export: capable(user, 'export'),
  salary_calc: capable(user, 'salary_calc'), settings: capable(user, 'settings'),
  reveal_daily_limit: revealLimit(user),
});

// CSV: converted_at,event,status,payout,offer_id,account_id,creative_id,user_id,external_id
function importConversions(text, user, ip) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return { imported: 0, skipped: 0, errors: ['порожній файл'] };
  const header = lines[0].split(',').map((h) => h.trim());
  const errors = [];
  let imported = 0, skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    if (!row.converted_at && !row.external_id) { skipped += 1; continue; }
    try {
      if (row.external_id && get('SELECT id FROM conversions WHERE external_id=?', row.external_id)) { skipped += 1; continue; }
      insert('conversions', {
        converted_at: row.converted_at || new Date().toISOString().slice(0, 19).replace('T', ' '),
        event: row.event || 'dep',
        status: row.status || 'hold',
        payout: Number(row.payout || 0),
        offer_id: row.offer_id ? Number(row.offer_id) : null,
        account_id: row.account_id ? Number(row.account_id) : null,
        creative_id: row.creative_id ? Number(row.creative_id) : null,
        user_id: row.user_id ? Number(row.user_id) : null,
        external_id: row.external_id || null,
        source: 'import',
      });
      imported += 1;
    } catch (e) {
      errors.push(`${line.slice(0, 60)}: ${e.message}`);
    }
  }
  audit({ user_id: user.id, action: 'import', entity: 'conversions', payload: { imported, skipped }, ip });
  return { imported, skipped, errors: errors.slice(0, 20) };
}

// ── Трекінг: редірект по лінку ────────────────────────────────────────────
export function handleRedirect(req, res, url) {
  const slug = url.pathname.split('/')[2];
  const link = get('SELECT * FROM tracking_links WHERE slug=?', slug);
  if (!link) return fail(res, 404, 'Лінк не знайдено');
  const clickId = token(10);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  insert('clicks', {
    tracking_link_id: link.id, click_id: clickId,
    ip_hash: hashIp(clientIp(req)), user_agent: ua,
    // Гео дає CDN/проксі (Cloudflare, Railway); девайс і реферер — з заголовків.
    geo: String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || '').slice(0, 2) || null,
    device: /iPhone|iPad|Android|Mobile/i.test(ua) ? 'mobile' : 'desktop',
    referer: String(req.headers.referer || '').slice(0, 300) || null,
  });
  run('UPDATE tracking_links SET clicks = clicks + 1 WHERE id=?', link.id);
  if (link.post_id) run('UPDATE posts SET clicks = clicks + 1 WHERE id=?', link.post_id);
  const target = new URL(link.target_url);
  const subs = { sub1: link.account_id, sub2: link.creative_id, sub3: link.user_id, sub4: link.post_id };
  for (const [k, v] of Object.entries(subs)) if (v != null) target.searchParams.set(k, String(v));
  target.searchParams.set('click_id', clickId);
  res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
  res.end();
}

// ── Постбек від партнерки: /pb/:token?click_id=..&status=..&payout=.. ─────
export function handlePostback(req, res, url) {
  const tok = url.pathname.split('/')[2];
  const q = Object.fromEntries(url.searchParams);
  const partner = get('SELECT * FROM partners WHERE postback_token=?', tok);
  if (!partner) return fail(res, 403, 'invalid token');
  if (!rateLimit(`pb:${tok}`, 600, 60_000)) return fail(res, 429, 'rate limited');

  const status = ({ approved: 'approved', confirmed: 'approved', lead: 'hold', hold: 'hold', pending: 'hold', rejected: 'rejected', trash: 'rejected', paid: 'paid' })[String(q.status || 'hold').toLowerCase()] || 'hold';
  const event = ({ reg: 'reg', registration: 'reg', dep: 'dep', deposit: 'dep', sale: 'sale', click: 'click' })[String(q.event || q.goal || 'dep').toLowerCase()] || 'dep';

  const click = q.click_id ? get('SELECT * FROM clicks WHERE click_id=?', q.click_id) : null;
  const link = click ? get('SELECT * FROM tracking_links WHERE id=?', click.tracking_link_id) : null;

  const data = {
    external_id: q.external_id || q.conversion_id || null,
    partner_id: partner.id,
    offer_id: Number(q.offer_id || link?.offer_id) || null,
    account_id: Number(q.sub1 || link?.account_id) || null,
    creative_id: Number(q.sub2 || link?.creative_id) || null,
    user_id: Number(q.sub3 || link?.user_id) || null,
    post_id: Number(q.sub4 || link?.post_id) || null,
    click_id: q.click_id || null,
    event, status,
    payout: Number(q.payout || q.sum || 0),
    currency: q.currency || 'USD',
    source: 'postback',
    converted_at: q.date || new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
  if (!data.payout && data.offer_id) data.payout = get('SELECT payout FROM offers WHERE id=?', data.offer_id)?.payout ?? 0;

  // Дедуплікація + оновлення статусу hold → approved → paid.
  const existing = data.external_id ? get('SELECT * FROM conversions WHERE partner_id=? AND external_id=?', partner.id, data.external_id) : null;
  if (existing) {
    update('conversions', existing.id, { status, payout: data.payout, event });
    return send(res, 200, 'ok');
  }
  const newId = insert('conversions', data);
  if (event === 'dep' && data.user_id) {
    notify('conversion', `💰 Деп: офер #${data.offer_id ?? '—'}, ${data.payout} ${data.currency}`, data.user_id);
  }
  audit({ action: 'postback', entity: 'conversions', entity_id: newId, payload: { partner: partner.name, status, event }, ip: clientIp(req) });
  return send(res, 200, 'ok');
}
