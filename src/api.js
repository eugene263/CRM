// REST API. Один генерик-CRUD на всі сутності з entities.js + кастомні
// ендпоїнти (дашборд, ЗП, трекінг, постбеки, експорт).
import { all, get, insert, update, remove, run, audit, setting } from './db.js';
import { entities } from './entities.js';
import {
  can, capable, scopeWhere, scopeOf, ownsRow, sanitize, visibleFields,
  invalidateRbacCache, roleRow, revealLimit,
} from './rbac.js';
import * as vault from './vault.js';
import * as prospecting from './prospecting.js';
import * as aiAssistant from './aiAssistant.js';
import * as kpi from './kpi.js';
import * as costing from './costing.js';
import * as payouts from './payouts.js';
import * as farms from './farms.js';
import * as clientMaps from './clientMaps.js';
import * as taskBoards from './taskBoards.js';
import * as scripts from './scripts.js';
import * as clients from './clients.js';
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
  message_templates: {
    // Картка-шаблон може лежати всередині іншої картки. Перевіряємо дві
    // речі: батько існує і ми не заганяємо гілку саму в себе (інакше
    // вкладення замкнулось би в кільце й картка зникла б з дерева).
    async beforeWrite(user, data, body, { isCreate, current }) {
      if (data.body === null || data.body === undefined) {
        if (isCreate) data.body = '';                       // текст необовʼязковий: картка може бути просто папкою
        else delete data.body;
      }
      if (isCreate && data.sort_order == null) data.sort_order = 0;
      if (data.parent_id != null) {
        const parentId = Number(data.parent_id);
        if (current && parentId === Number(current.id)) {
          throw Object.assign(new Error('Картку не можна покласти саму в себе'), { status: 400 });
        }
        if (!await get('SELECT id FROM message_templates WHERE id=?', parentId)) {
          throw Object.assign(new Error('Батьківської картки не існує'), { status: 400 });
        }
        if (current) {
          for (let id = parentId, hops = 0; id && hops < 50; hops += 1) {
            if (Number(id) === Number(current.id)) {
              throw Object.assign(new Error('Картку не можна вкласти у власну підкартку'), { status: 400 });
            }
            id = (await get('SELECT parent_id FROM message_templates WHERE id=?', id))?.parent_id;
          }
        }
      }
      return data;
    },
  },
  users: {
    async beforeWrite(user, data, body, { isCreate, current }) {
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
    async afterWrite(user, id, data, { isCreate, current }) {
      const to = data.status;
      const from = current?.status ?? null;
      if (isCreate || (to && to !== from)) {
        await insert('account_events', { account_id: id, from_status: from, to_status: to || 'farm', user_id: user.id });
        if (to === 'ban') {
          await run(`UPDATE accounts SET banned_at=COALESCE(banned_at, date('now')) WHERE id=?`, id);
          const acc = await get('SELECT nickname, platform, owner_user_id FROM accounts WHERE id=?', id);
          await notify('ban', `🚫 Бан: ${acc.platform} @${acc.nickname} (акаунт #${id})`, acc.owner_user_id);
        }
        if (to === 'active') await run(`UPDATE accounts SET live_started_at=COALESCE(live_started_at, date('now')) WHERE id=?`, id);
        if (to === 'farm') await run(`UPDATE accounts SET farm_started_at=COALESCE(farm_started_at, date('now')) WHERE id=?`, id);
      }
      if (isCreate && data.owner_user_id) {
        await insert('resource_assignments', { resource_type: 'account', resource_id: id, user_id: data.owner_user_id, action: 'issued' });
      }
    },
  },
  offers: {
    async afterWrite(user, id, data, { isCreate, current }) {
      if (data.payout != null && (isCreate || Number(data.payout) !== Number(current?.payout))) {
        await insert('offer_rates_history', { offer_id: id, payout: data.payout, user_id: user.id });
      }
    },
  },
  partners: {
    async beforeWrite(user, data, body, { isCreate }) {
      if (isCreate) data.postback_token = token(12);
      return data;
    },
  },
  devices: {
    async afterWrite(user, id, data, { isCreate, current }) {
      if (data.holder_user_id != null && data.holder_user_id !== current?.holder_user_id) {
        await insert('resource_assignments', { resource_type: 'device', resource_id: id, user_id: data.holder_user_id, action: 'issued' });
      }
    },
  },
  tracking_links: {
    async beforeWrite(user, data, body, { isCreate }) {
      if (isCreate) data.slug = token(6);
      return data;
    },
  },
  access_requests: {
    async beforeWrite(user, data, body, { isCreate }) {
      if (isCreate) {
        data.user_id = user.id;
        data.status = 'pending';
        data.expires_at = new Date(Date.now() + Math.min(Number(body.hours) || 8, 72) * 3600e3)
          .toISOString().slice(0, 19).replace('T', ' ');
      }
      return data;
    },
    async afterWrite(user, id, data, { isCreate }) {
      if (!isCreate) return;
      const cred = await get('SELECT title FROM credentials WHERE id=?', data.credential_id);
      for (const a of await all(`SELECT id FROM users WHERE role IN ('owner','head','teamlead') AND status='active'`)) {
        await notify('access', `🙋 ${user.name} просить доступ «${cred?.title ?? data.credential_id}»`, a.id);
      }
    },
  },
  conversions: {
    async beforeWrite(user, data, body, { isCreate }) {
      if (isCreate && !data.converted_at) data.converted_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
      if (isCreate && data.payout == null && data.offer_id) {
        data.payout = await get('SELECT payout FROM offers WHERE id=?', data.offer_id)?.payout ?? 0;
      }
      return data;
    },
  },
  services: {
    async beforeWrite(user, data, body, { isCreate, current }) {
      // Ціна пакета рахується сумою вкладених послуг (costing.js) — ручний
      // ввід через форму чи інлайн-редагування її не змінює.
      if (!isCreate && current?.is_package && 'price' in data) delete data.price;
      return data;
    },
    async afterWrite(user, id, data, { isCreate, current }) {
      // Ціна цієї послуги змінилась — перерахувати всі пакети, куди вона
      // вкладена компонентом, як і при зміні ставки в собівартості.
      if (!isCreate && data.price != null && Number(data.price) !== Number(current?.price)) {
        await costing.recomputePackagesUsingComponent(id);
      }
    },
  },
};

// ── Список із фільтрами ───────────────────────────────────────────────────
async function listRows(user, entKey, query) {
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

  const rows = (await all(
    `SELECT t.* FROM ${ent.table} t WHERE ${where.join(' AND ')} ORDER BY t.${sort} LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  )).map((r) => sanitize(user, entKey, r));
  const totalRow = await get(`SELECT COUNT(*) AS c FROM ${ent.table} t WHERE ${where.join(' AND ')}`, ...params);
  const total = Number(totalRow?.c || 0);
  return { rows, total, limit, offset };
}

// Ці три функції — та сама логіка, що й генерик-CRUD нижче в handleApi,
// винесена окремо, щоб AI-асистент (aiAssistant.js) міг створювати й
// оновлювати записи через ті самі перевірки прав/скоупу й хуки, без HTTP.
export async function listEntityRows(user, entKey, query) {
  const ent = entities[entKey];
  if (!ent) throw Object.assign(new Error('Невідома сутність'), { status: 404 });
  if (!can(user, entKey, 'read')) throw Object.assign(new Error('Немає доступу до цього розділу'), { status: 403 });
  return listRows(user, entKey, query);
}

export async function createEntityRecord(user, entKey, body, ip) {
  const ent = entities[entKey];
  if (!ent) throw Object.assign(new Error('Невідома сутність'), { status: 404 });
  if (!can(user, entKey, 'create')) throw Object.assign(new Error('Немає прав на створення'), { status: 403 });
  let data = buildPayload(user, entKey, body, { isCreate: true });
  data = enforceScopeOnWrite(user, entKey, data, { isCreate: true });
  if (hooks[entKey]?.beforeWrite) data = await hooks[entKey].beforeWrite(user, data, body, { isCreate: true, current: null });
  const newId = await insert(ent.table, data);
  await hooks[entKey]?.afterWrite?.(user, newId, data, { isCreate: true, current: null });
  await audit({ user_id: user.id, action: 'create', entity: entKey, entity_id: newId, payload: redact(ent, data), ip });
  return sanitize(user, entKey, await get(`SELECT * FROM ${ent.table} WHERE id=?`, newId));
}

export async function updateEntityRecord(user, entKey, id, body, ip) {
  const ent = entities[entKey];
  if (!ent) throw Object.assign(new Error('Невідома сутність'), { status: 404 });
  if (!can(user, entKey, 'update')) throw Object.assign(new Error('Немає прав на редагування'), { status: 403 });
  const current = await get(`SELECT * FROM ${ent.table} WHERE id=?`, id);
  if (!current || !ownsRow(user, entKey, current)) throw Object.assign(new Error('Запис не знайдено'), { status: 404 });
  let data = buildPayload(user, entKey, body, { isCreate: false });
  data = enforceScopeOnWrite(user, entKey, data, { isCreate: false });
  if (hooks[entKey]?.beforeWrite) data = await hooks[entKey].beforeWrite(user, data, body, { isCreate: false, current });
  await update(ent.table, id, data);
  await hooks[entKey]?.afterWrite?.(user, id, data, { isCreate: false, current });
  await audit({ user_id: user.id, action: 'update', entity: entKey, entity_id: id, payload: redact(ent, data), ip });
  return sanitize(user, entKey, await get(`SELECT * FROM ${ent.table} WHERE id=?`, id));
}

// Довідники для випадаючих списків (id → підпис).
async function refOptions(user) {
  const out = {};
  const titles = {
    users: 'name', teams: 'name', accounts: 'nickname', devices: 'model', sims: 'number',
    proxies: 'host', mail_accounts: 'login', offers: 'name', partners: 'name', creatives: 'title', posts: 'url',
    prospect_lists: 'name', clients: 'name', farms: 'name',
  };
  for (const [key, col] of Object.entries(titles)) {
    if (!can(user, key, 'read')) continue;
    const scope = scopeWhere(user, key, 't');
    out[key] = await all(
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

// Розбирає один рядок CSV із підтримкою лапок і "" як екранованої лапки
// всередині поля — сумісно з форматом, який видає csv() вище.
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuotes = false; }
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      cells.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

// Генерик-імпорт CSV для будь-якої сутності: заголовки — підписи полів (як
// у власному export) або технічні назви полів; кожен рядок іде через
// createEntityRecord, тож ті самі права/скоуп/валідація/хуки, що й ручне
// створення через форму. Помилка одного рядка не зупиняє решту — так само,
// як уже було зроблено для importConversions.
async function importRows(user, entKey, text, ip) {
  const ent = entities[entKey];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return { imported: 0, skipped: 0, errors: ['Порожній файл'] };

  const writable = ent.fields.filter((f) => !f.readOnly && !f.virtual && f.type !== 'secret');
  const byLabel = new Map(writable.map((f) => [f.label, f.name]));
  const byName = new Map(writable.map((f) => [f.name, f.name]));
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const columns = header.map((h) => byLabel.get(h) || byName.get(h) || null);
  if (!columns.some(Boolean)) {
    return { imported: 0, skipped: 0, errors: ['Жоден заголовок CSV не збігається з полями цієї сутності'] };
  }

  let imported = 0, skipped = 0;
  const errors = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const data = {};
    columns.forEach((name, i) => { if (name && cells[i]) data[name] = cells[i]; });
    if (!Object.keys(data).length) { skipped += 1; continue; }
    try {
      await createEntityRecord(user, entKey, data, ip);
      imported += 1;
    } catch (e) {
      errors.push(`${line.slice(0, 80)}: ${e.message}`);
    }
  }
  await audit({ user_id: user.id, action: 'import', entity: entKey, payload: { imported, skipped }, ip });
  return { imported, skipped, errors: errors.slice(0, 20) };
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
    const result = await auth.login({ ...body, ip, userAgent: req.headers['user-agent'] });
    if (result.error) return fail(res, 401, result.error, { need2fa: !!result.need2fa });
    return send(res, 200, { user: result.user }, { 'set-cookie': auth.sessionCookie(result.token) });
  }

  const user = await auth.userFromRequest(req);
  if (!user) return fail(res, 401, 'Потрібна авторизація');

  if (seg[0] === 'auth') {
    if (seg[1] === 'me') return ok(res, { user: auth.publicUser(user), permissions: permissionsFor(user) });
    if (seg[1] === 'logout' && req.method === 'POST') {
      await auth.logout(user.session_token, user.id, ip);
      return send(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() });
    }
    if (seg[1] === 'password' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.password || String(body.password).length < 8) return fail(res, 400, 'Мінімум 8 символів');
      await auth.setPassword(user.id, body.password);
      await audit({ user_id: user.id, action: 'password_change', entity: 'users', entity_id: user.id, ip });
      return ok(res, { ok: true });
    }
    if (seg[1] === '2fa' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.disable) { await auth.disable2fa(user.id); await audit({ user_id: user.id, action: '2fa_disable', ip }); return ok(res, { ok: true }); }
      const enabled = await auth.enable2fa(user.id);
      await audit({ user_id: user.id, action: '2fa_enable', ip });
      return ok(res, enabled);
    }
    if (seg[1] === 'sessions' && req.method === 'DELETE' && seg[2]) {
      const killed = await auth.killSession(user.id, seg[2]);
      await audit({ user_id: user.id, action: 'session_kill', entity: 'sessions', payload: { killed }, ip });
      return ok(res, { killed });
    }
    if (seg[1] === 'sessions') return ok(res, { rows: await auth.sessionsOf(user.id) });
    return fail(res, 404, 'Немає такого ендпоїнта');
  }

  // --- AI-чат (плаваюча кнопка «AI») ---
  if (seg[0] === 'ai' && seg[1] === 'chat' && req.method === 'POST') {
    // Один запит може смикнути Gemini до MAX_STEPS разів — обмежуємо, щоб
    // одна людина не вижерла спільний безкоштовний ліміт усіх ключів.
    if (!rateLimit(`ai-chat:${user.id}`, 20, 5 * 60_000)) {
      return fail(res, 429, 'Забагато запитів до AI-чату, спробуйте за кілька хвилин');
    }
    const body = await readBody(req);
    return ok(res, await aiAssistant.runAiChat(user, body.messages));
  }

  // --- метадані для інтерфейсу ---
  if (seg[0] === 'meta') {
    const meta = {};
    const locked = [];
    for (const [key, ent] of Object.entries(entities)) {
      if (!can(user, key, 'read')) {
        // Пункт лишається видимим у меню із замочком — так людина розуміє,
        // що розділ існує, а не губиться, і знає, що просити в адміна.
        locked.push({ key, label: ent.label, group: ent.group, icon: ent.icon });
        continue;
      }
      meta[key] = {
        key, label: ent.label, group: ent.group, icon: ent.icon, title: ent.title,
        fields: visibleFields(user, key),
        can: {
          read: true, create: can(user, key, 'create'), update: can(user, key, 'update'), delete: can(user, key, 'delete'),
        },
        scope: scopeOf(user, key),
      };
    }
    return ok(res, { entities: meta, locked, refs: await refOptions(user), user: auth.publicUser(user), caps: capsOf(user) });
  }

  if (seg[0] === 'refs') return ok(res, await refOptions(user));

  // --- аналітика ---
  if (seg[0] === 'dashboard') {
    return ok(res, {
      summary: await analytics.summary(user, query),
      timeline: await analytics.timeline(user, query),
      topCreatives: (await analytics.breakdown(user, { ...query, dim: 'creative' })).slice(0, 10),
      topUsers: can(user, 'users', 'read') ? (await analytics.breakdown(user, { ...query, dim: 'user' })).slice(0, 10) : [],
      alerts: can(user, 'accounts', 'read') ? await analytics.alerts(user) : { proxyExpiring: [], bans24: [], planToday: [] },
    });
  }
  if (seg[0] === 'analytics') {
    if (seg[1] === 'breakdown') return ok(res, { rows: await analytics.breakdown(user, query) });
    if (seg[1] === 'lifetime') return ok(res, { rows: await analytics.accountLifetime() });
    if (seg[1] === 'burnout') return ok(res, { rows: await analytics.burnout(user) });
    return fail(res, 404, 'Немає такого звіту');
  }

  // --- фінанси ---
  if (seg[0] === 'finance') {
    if (!capable(user, 'salary_calc') && !can(user, 'payouts', 'read')) return fail(res, 403, 'Немає доступу');
    if (seg[1] === 'salary' && req.method === 'POST') {
      if (!capable(user, 'salary_calc')) return fail(res, 403, 'Немає доступу до розрахунку ЗП');
      const body = await readBody(req);
      return ok(res, await finance.calcSalary(body.period, { commit: !!body.commit, actorId: user.id }));
    }
    if (seg[1] === 'salary') {
      if (!capable(user, 'salary_calc')) return fail(res, 403, 'Немає доступу до розрахунку ЗП');
      return ok(res, await finance.calcSalary(query.period || new Date().toISOString().slice(0, 7), { commit: false }));
    }
    if (seg[1] === 'pnl') {
      if (!can(user, 'expenses', 'read')) return fail(res, 403, 'Немає доступу');
      return ok(res, await finance.pnl(query.period || new Date().toISOString().slice(0, 7)));
    }
    if (seg[1] === 'my') {
      const p = query.period || new Date().toISOString().slice(0, 7);
      return ok(res, { period: p, stats: await finance.userStats(user.id, p), payout: await get('SELECT * FROM payouts WHERE user_id=? AND period=?', user.id, p) });
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
    const result = await importConversions(String(body.csv || ''), user, ip);
    return ok(res, result);
  }

  // --- собівартість ---
  if (seg[0] === 'costing') {
    if (!can(user, 'services', 'read')) return fail(res, 403, 'Немає доступу до собівартості');
    const canEdit = can(user, 'services', 'update');

    if (seg[1] === 'services' && !seg[2]) return ok(res, await costing.listServices(query));

    // Послуги верхнього рівня — кнопки над плашками пакетів.
    if (seg[1] === 'groups') {
      if (req.method === 'GET' && !seg[2]) return ok(res, { rows: await costing.listGroups() });
      if (!canEdit) return fail(res, 403, 'Немає прав редагувати собівартість');
      if (req.method === 'POST' && !seg[2]) return ok(res, await costing.createGroup((await readBody(req)).name));
      if (req.method === 'PUT' && seg[2]) return ok(res, await costing.renameGroup(Number(seg[2]), (await readBody(req)).name));
      if (req.method === 'DELETE' && seg[2]) return ok(res, await costing.deleteGroup(Number(seg[2])));
    }
    if (seg[1] === 'suggest') {
      return ok(res, { rates: await costing.suggestedRates(), fixed: await costing.fixedMonthlyCosts() });
    }
    if (seg[1] === 'services' && seg[2]) {
      const serviceId = Number(seg[2]);
      if (req.method === 'GET' && !seg[3]) return ok(res, await costing.serviceCost(serviceId));
      if (seg[3] === 'package' && !seg[4] && req.method === 'GET') return ok(res, await costing.packageCard(serviceId));
      if (!canEdit) return fail(res, 403, 'Немає прав редагувати собівартість');
      if (seg[3] === 'items' && req.method === 'POST') {
        return ok(res, await costing.saveItem(serviceId, await readBody(req)));
      }
      if (seg[3] === 'items' && seg[4] && req.method === 'DELETE') {
        return ok(res, await costing.deleteItem(serviceId, Number(seg[4])));
      }
      if (seg[3] === 'apply-price' && req.method === 'POST') {
        return ok(res, await costing.applyRecommendedPrice(serviceId));
      }
      if (seg[3] === 'package' && seg[4] === 'items' && !seg[5] && req.method === 'POST') {
        const body = await readBody(req);
        return ok(res, await costing.addPackageItem(serviceId, Number(body.component_service_id), body.quantity));
      }
      if (seg[3] === 'package' && seg[4] === 'items' && seg[5] && req.method === 'PUT') {
        const body = await readBody(req);
        return ok(res, await costing.updatePackageItem(serviceId, Number(seg[5]), body.quantity));
      }
      if (seg[3] === 'package' && seg[4] === 'items' && seg[5] && req.method === 'DELETE') {
        return ok(res, await costing.removePackageItem(serviceId, Number(seg[5])));
      }
    }
    return fail(res, 404, 'Немає такого ендпоїнта');
  }

  // --- шаблони скриптів ---
  // Сам /api/scripts (список/створення/редагування назви, категорії, каналу)
  // іде через генерик-CRUD нижче — тут лише вкладені кроки, яких у генеричній
  // сутності немає.
  // ── Виплати команді: роки → місяці → люди → PDF-звіти ─────────────────
  // Іменовані підшляхи мусять стояти перед генерик-CRUD: там seg[1] —
  // це id запису, і /payouts/overview інакше пішло б у нього як «запис #NaN».
  if (seg[0] === 'payouts' && ['overview', 'summary', 'period', 'reports', 'people', 'range'].includes(seg[1])) {
    if (!can(user, 'payouts', 'read')) return fail(res, 403, 'Немає доступу до виплат');

    if (seg[1] === 'overview' && req.method === 'GET') {
      return ok(res, { years: await payouts.overview(user), summary: await payouts.summary(user) });
    }
    if (seg[1] === 'summary' && req.method === 'GET') return ok(res, await payouts.summary(user));
    if (seg[1] === 'period' && seg[2] && req.method === 'GET') {
      return ok(res, { period: seg[2], rows: await payouts.periodRows(user, seg[2]) });
    }
    if (seg[1] === 'people' && req.method === 'GET') {
      return ok(res, { rows: await payouts.visiblePeople(user) });
    }
    // /api/payouts/range?user_id=&from=YYYY-MM&to=YYYY-MM — час і гроші
    // однієї людини за довільний проміжок.
    if (seg[1] === 'range' && req.method === 'GET') {
      if (!query.user_id || !query.from || !query.to) {
        return fail(res, 400, 'Потрібні user_id, from і to');
      }
      return ok(res, await payouts.personRange(user, { userId: query.user_id, from: query.from, to: query.to }));
    }

    if (seg[1] === 'reports') {
      // Видимість звіту = видимість виплат тієї людини: свої бачить кожен,
      // чужі — лише роль зі скоупом на команду чи на всіх.
      const guard = async (reportId) => {
        const row = await payouts.reportOwner(reportId);
        if (!row) throw Object.assign(new Error('Звіт не знайдено'), { status: 404 });
        const mine = await payouts.periodRows(user, row.period);
        if (!mine.some((r) => Number(r.user_id) === Number(row.user_id))) {
          throw Object.assign(new Error('Звіт не знайдено'), { status: 404 });
        }
        return row;
      };

      if (req.method === 'POST' && !seg[2]) {
        if (!can(user, 'payouts', 'create')) return fail(res, 403, 'Немає прав додавати звіти');
        // Ліміт більший за типові 2 МБ: PDF у base64 важить на третину більше.
        const body = await readBody(req, 12 * 1024 * 1024);
        const mine = await payouts.periodRows(user, String(body.period || ''));
        if (!mine.some((r) => Number(r.user_id) === Number(body.user_id))) {
          return fail(res, 403, 'Цьому співробітнику ви не можете додати звіт');
        }
        const row = await payouts.addReport(user, body);
        await audit({ user_id: user.id, action: 'payout_report_add', entity: 'payouts', entity_id: row.id,
          payload: { user_id: row.user_id, period: row.period, file: row.file_name }, ip });
        return ok(res, { row });
      }

      const reportId = Number(seg[2]);
      if (seg[2] && seg[3] === 'file' && req.method === 'GET') {
        await guard(reportId);
        const file = await payouts.reportFile(reportId);
        await audit({ user_id: user.id, action: 'payout_report_download', entity: 'payouts', entity_id: reportId, ip });
        return send(res, 200, file.buffer, {
          'content-type': file.mime || 'application/pdf',
          'content-disposition': `inline; filename="${encodeURIComponent(file.file_name)}"`,
        });
      }
      if (seg[2] && seg[3] === 'analyze' && req.method === 'POST') {
        if (!can(user, 'payouts', 'update')) return fail(res, 403, 'Немає прав редагувати виплати');
        await guard(reportId);
        return ok(res, { row: await payouts.analyzeReport(reportId) });
      }
      if (seg[2] && seg[3] === 'apply' && req.method === 'POST') {
        if (!can(user, 'payouts', 'update')) return fail(res, 403, 'Немає прав редагувати виплати');
        await guard(reportId);
        const applyBody = await readBody(req);
        const applied = await payouts.applyReport(reportId, { amount: applyBody.amount, hours: applyBody.hours });
        await audit({ user_id: user.id, action: 'payout_report_apply', entity: 'payouts', entity_id: reportId,
          payload: applied, ip });
        return ok(res, applied);
      }
      if (seg[2] && !seg[3] && req.method === 'DELETE') {
        if (!can(user, 'payouts', 'delete')) return fail(res, 403, 'Немає прав видаляти звіти');
        await guard(reportId);
        await audit({ user_id: user.id, action: 'payout_report_delete', entity: 'payouts', entity_id: reportId, ip });
        return ok(res, await payouts.deleteReport(reportId));
      }
      return fail(res, 405, 'Метод не підтримується');
    }
    return fail(res, 405, 'Метод не підтримується');
  }

  if (seg[0] === 'scripts' && seg[1] && (seg[2] === 'full' || seg[2] === 'steps' || seg[2] === 'duplicate')) {
    if (!can(user, 'scripts', 'read')) return fail(res, 403, 'Немає доступу до скриптів');
    const scriptId = Number(seg[1]);
    const canEdit = can(user, 'scripts', 'update');

    if (seg[2] === 'full') return ok(res, await scripts.scriptWithSteps(scriptId));
    if (seg[2] === 'duplicate' && req.method === 'POST') {
      if (!can(user, 'scripts', 'create')) return fail(res, 403, 'Немає прав створювати скрипти');
      return ok(res, await scripts.duplicateScript(scriptId, user.id));
    }
    if (seg[2] === 'steps') {
      if (!canEdit) return fail(res, 403, 'Немає прав редагувати скрипт');
      if (req.method === 'POST' && !seg[3]) return ok(res, await scripts.saveStep(scriptId, await readBody(req)));
      if (req.method === 'DELETE' && seg[3]) return ok(res, await scripts.deleteStep(scriptId, Number(seg[3])));
    }
    return fail(res, 404, 'Немає такого ендпоїнта');
  }

  // --- плани та норми ---
  if (seg[0] === 'kpi') {
    if (seg[1] === 'my-day') return ok(res, await kpi.myDay(user, query.date));
    if (seg[1] === 'month') return ok(res, { rows: await kpi.monthProgress(user.id, query.period) });
    if (seg[1] === 'limits') return ok(res, { rows: await kpi.channelUsage(user, query.date) });
    if (seg[1] === 'coefficients') return ok(res, await kpi.realCoefficients());
    if (seg[1] === 'calculator') {
      const input = req.method === 'POST' ? await readBody(req) : query;
      return ok(res, { ...kpi.calculatePlan(input), real: await kpi.realCoefficients() });
    }
    if (seg[1] === 'team') {
      if (!can(user, 'kpi_plans', 'read') || scopeOf(user, 'kpi_plans') === 'own') {
        return fail(res, 403, 'Екран команди доступний тімліду й вище');
      }
      return ok(res, await kpi.teamOverview(user, query.date));
    }
    if (seg[1] === 'apply' && req.method === 'POST') {
      if (!can(user, 'kpi_plans', 'create')) return fail(res, 403, 'Немає прав ставити плани');
      const body = await readBody(req);
      return ok(res, await kpi.applyPlan(user, body));
    }
    if (seg[1] === 'recompute' && req.method === 'POST') {
      const body = await readBody(req);
      const target = Number(body.user_id) || user.id;
      if (target !== user.id && scopeOf(user, 'kpi_plans') === 'own') return fail(res, 403, 'Немає доступу');
      return ok(res, await kpi.computeFacts(target, body.date));
    }
    return fail(res, 404, 'Немає такого ендпоїнта');
  }

  // --- пошук клієнтів ---
  if (seg[0] === 'prospecting') {
    if (!can(user, 'leads', 'read')) return fail(res, 403, 'Немає доступу до модуля пошуку');
    const force = query.force === '1' || query.force === 'true';

    if (seg[1] === 'queue') return ok(res, await prospecting.todayQueue(user));
    if (seg[1] === 'funnel') return ok(res, await prospecting.funnel(user, query));
    if (seg[1] === 'kanban') {
      const scope = scopeWhere(user, 'leads', 'l');
      return ok(res, await prospecting.kanban(scope.sql, scope.params));
    }
    if (seg[1] === 'lists' && seg[2] && seg[3] === 'contacts') {
      const scope = scopeWhere(user, 'leads', 'l');
      return ok(res, { rows: await prospecting.listContacts(Number(seg[2]), scope.sql, scope.params) });
    }
    if (seg[1] === 'lists' && seg[2] && seg[3] === 'ai-search' && req.method === 'POST') {
      if (!can(user, 'leads', 'create')) return fail(res, 403, 'Немає прав додавати лідів');
      const body = await readBody(req);
      return ok(res, { candidates: await prospecting.aiSearchCandidates(body) });
    }
    if (seg[1] === 'dictionaries') {
      return ok(res, {
        statuses: await all('SELECT * FROM lead_statuses WHERE is_active=1 ORDER BY sort_order'),
        dictionaries: await all('SELECT * FROM dictionaries WHERE is_active=1 ORDER BY kind, sort_order'),
        templates: await all('SELECT id, name, channel, subject, body FROM message_templates WHERE is_active=1 ORDER BY name'),
        scripts: can(user, 'scripts', 'read')
          ? await all('SELECT id, name, category, channel FROM scripts WHERE is_active=1 ORDER BY name')
          : [],
      });
    }
    if (seg[1] === 'duplicates') {
      if (seg[2] && seg[3] === 'resolve' && req.method === 'POST') {
        if (!can(user, 'leads', 'update')) return fail(res, 403, 'Немає прав');
        const body = await readBody(req);
        return ok(res, await prospecting.resolveDuplicate(user, Number(seg[2]), body));
      }
      return ok(res, { rows: await all(
        `SELECT d.*, a.company_name AS a_name, b.company_name AS b_name
           FROM duplicates_queue d
           JOIN leads a ON a.id=d.lead_a_id JOIN leads b ON b.id=d.lead_b_id
          WHERE d.resolved=0 ORDER BY d.match_score DESC LIMIT 200`) });
    }

    if (seg[1] === 'leads' && req.method === 'POST' && !seg[2]) {
      if (!can(user, 'leads', 'create')) return fail(res, 403, 'Немає прав додавати лідів');
      const body = await readBody(req);
      try {
        return ok(res, await prospecting.createLead(user, body, { force }));
      } catch (e) {
        if (e.duplicate) return fail(res, 409, e.message, { duplicate: e.duplicate });
        throw e;
      }
    }
    if (seg[1] === 'bulk' && req.method === 'POST') {
      if (!can(user, 'leads', 'create')) return fail(res, 403, 'Немає прав додавати лідів');
      return ok(res, await prospecting.bulkAdd(user, await readBody(req)));
    }

    if (seg[1] === 'leads' && seg[2]) {
      const leadId = Number(seg[2]);
      if (req.method === 'GET' && !seg[3]) return ok(res, await prospecting.leadCard(leadId));
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (seg[3] === 'status' && req.method === 'POST') {
        return ok(res, await prospecting.setStatus(user, leadId, body.status_code, body));
      }
      if (seg[3] === 'touch' && req.method === 'POST') {
        try {
          return ok(res, await prospecting.logTouch(user, leadId, body, { force }));
        } catch (e) {
          // needForce приходить і від захисту від подвійного дотику (409),
          // і від ліміту акаунта (429) — статус беремо з самої помилки.
          if (e.needForce) return fail(res, e.status || 409, e.message, { needForce: true });
          throw e;
        }
      }
      if (seg[3] === 'note' && req.method === 'POST') {
        const id = await insert('lead_notes', { lead_id: leadId, text: String(body.text || '').slice(0, 4000), user_id: user.id });
        return ok(res, { id });
      }
      if (seg[3] === 'contacts' && req.method === 'POST') {
        const id = await insert('lead_contacts', {
          lead_id: leadId, kind: body.kind, value: body.value, person_name: body.person_name ?? null,
          position: body.position ?? null, is_primary: body.is_primary ? 1 : 0,
        });
        return ok(res, { id });
      }
    }
    return fail(res, 404, 'Немає такого ендпоїнта');
  }

  // --- сейф доступів ---
  if (seg[0] === 'credentials' && seg[1] && seg[2]) {
    const credId = Number(seg[1]);
    if (!can(user, 'credentials', 'read')) return fail(res, 403, 'Немає доступу до сейфа');
    if (seg[2] === 'reveal' && seg[3]) return ok(res, await vault.reveal(user, credId, seg[3], ip));
    if (seg[2] === 'totp') return ok(res, await vault.totp(user, credId, ip));
    if (seg[2] === 'issue' && req.method === 'POST') {
      if (!can(user, 'credentials', 'update')) return fail(res, 403, 'Немає прав видавати доступи');
      return ok(res, await vault.issue(user, credId, await readBody(req), ip));
    }
    if (seg[2] === 'return' && req.method === 'POST') return ok(res, await vault.returnBack(user, credId, await readBody(req), ip));
    if (seg[2] === 'revoke' && req.method === 'POST') {
      if (!can(user, 'credentials', 'update')) return fail(res, 403, 'Немає прав відкликати доступи');
      return ok(res, await vault.revoke(user, credId, (await readBody(req)).reason, ip));
    }
    if (seg[2] === 'grants') {
      return ok(res, { rows: await all('SELECT * FROM credential_grants WHERE credential_id=? ORDER BY granted_at DESC', credId) });
    }
  }

  if (seg[0] === 'access_requests' && seg[1] && seg[2] === 'decide' && req.method === 'POST') {
    if (!capable(user, 'settings') && user.role !== 'teamlead') return fail(res, 403, 'Апрувити доступи може тімлід або вище');
    const body = await readBody(req);
    return ok(res, await vault.decideAccess(user, Number(seg[1]), !!body.approve, ip));
  }

  if (seg[0] === 'users' && seg[1] && seg[2] === 'offboard' && req.method === 'POST') {
    if (!capable(user, 'settings')) return fail(res, 403, 'Офбординг доступний лише власнику/хеду');
    return ok(res, await vault.offboard(user, Number(seg[1]), ip));
  }

  // --- конструктор ролей ---
  if (seg[0] === 'roles') {
    if (req.method === 'GET') {
      if (!can(user, 'users', 'read')) return fail(res, 403, 'Немає доступу');
      return ok(res, {
        roles: await all('SELECT * FROM roles ORDER BY key'),
        permissions: await all('SELECT * FROM role_permissions ORDER BY role_key, entity'),
        entities: Object.fromEntries(Object.entries(entities).map(([k, e]) => [k, { label: e.label, group: e.group, fields: e.fields.map((f) => f.name) }])),
      });
    }
    if (!capable(user, 'settings')) return fail(res, 403, 'Редагувати ролі може лише власник/хед');
    const body = await readBody(req);
    if (req.method === 'POST' && !seg[1]) {
      if (!/^[a-z_]{3,20}$/.test(String(body.key || ''))) return fail(res, 400, 'Ключ ролі: латиниця і підкреслення, 3–20 символів');
      if (await get('SELECT key FROM roles WHERE key=?', body.key)) return fail(res, 409, 'Така роль уже існує');
      await insert('roles', {
        key: body.key, label: body.label || body.key, is_system: 0,
        can_export: body.can_export ? 1 : 0, can_reveal: body.can_reveal ? 1 : 0,
        can_salary_calc: body.can_salary_calc ? 1 : 0, can_settings: body.can_settings ? 1 : 0,
        reveal_daily_limit: Number(body.reveal_daily_limit ?? 20),
      });
      // Нова роль стартує без прав: адміністратор відкриває їх свідомо.
      for (const entityKey of Object.keys(entities)) {
        await insert('role_permissions', { role_key: body.key, entity: entityKey, level: 'none', scope: 'own', hidden_fields: null });
      }
      await invalidateRbacCache();
      await audit({ user_id: user.id, action: 'role_create', entity: 'roles', payload: { key: body.key }, ip });
      return ok(res, { ok: true });
    }
    if ((req.method === 'PUT' || req.method === 'PATCH') && seg[1]) {
      const roleKey = seg[1];
      if (!await get('SELECT key FROM roles WHERE key=?', roleKey)) return fail(res, 404, 'Роль не знайдено');
      if (roleKey === 'owner') return fail(res, 403, 'Права власника змінювати не можна');
      const caps = {};
      for (const c of ['can_export', 'can_reveal', 'can_salary_calc', 'can_settings']) {
        if (c in body) caps[c] = body[c] ? 1 : 0;
      }
      if ('label' in body) caps.label = String(body.label);
      if ('reveal_daily_limit' in body) caps.reveal_daily_limit = Number(body.reveal_daily_limit);
      if (Object.keys(caps).length) {
        await run(`UPDATE roles SET ${Object.keys(caps).map((k) => `${k}=?`).join(',')} WHERE key=?`,
          ...Object.values(caps), roleKey);
      }
      for (const p of body.permissions || []) {
        if (!entities[p.entity]) continue;
        if (!['none', 'read', 'write', 'full'].includes(p.level) || !['all', 'team', 'own'].includes(p.scope)) {
          return fail(res, 400, 'Некоректний рівень або скоуп');
        }
        await run(`INSERT INTO role_permissions (role_key, entity, level, scope, hidden_fields) VALUES (?,?,?,?,?)
             ON CONFLICT(role_key, entity) DO UPDATE SET level=excluded.level, scope=excluded.scope, hidden_fields=excluded.hidden_fields`,
          roleKey, p.entity, p.level, p.scope, (p.hidden_fields || []).join(',') || null);
      }
      await invalidateRbacCache();
      await audit({ user_id: user.id, action: 'role_update', entity: 'roles', payload: { role: roleKey, changed: (body.permissions || []).length }, ip });
      return ok(res, { ok: true });
    }
    if (req.method === 'DELETE' && seg[1]) {
      const role = await get('SELECT * FROM roles WHERE key=?', seg[1]);
      if (!role) return fail(res, 404, 'Роль не знайдено');
      if (role.is_system) return fail(res, 403, 'Системну роль видалити не можна');
      if (await get('SELECT id FROM users WHERE role=? LIMIT 1', seg[1])) return fail(res, 409, 'Роль призначена користувачам');
      await run('DELETE FROM role_permissions WHERE role_key=?', seg[1]);
      await run('DELETE FROM roles WHERE key=?', seg[1]);
      await invalidateRbacCache();
      await audit({ user_id: user.id, action: 'role_delete', entity: 'roles', payload: { key: seg[1] }, ip });
      return ok(res, { ok: true });
    }
  }

  // ── Ферми: агреговані вибірки поверх generic-CRUD /api/farms ──────────
  // /api/farms і /api/farms/:id (список/створення/редагування самої
  // ферми) ідуть через генерик-CRUD нижче — тут лише агрегації для
  // структурованого огляду: плашки ферм, фільтрований список акаунтів,
  // дерево «ферма → телефон → акаунти» однієї ферми.
  if (seg[0] === 'farms' && ['overview', 'accounts', 'filters'].includes(seg[1])) {
    if (!can(user, 'farms', 'read')) return fail(res, 403, 'Немає доступу до ферм');
    if (seg[1] === 'overview' && req.method === 'GET') return ok(res, { rows: await farms.listFarms(user) });
    if (seg[1] === 'filters' && req.method === 'GET') return ok(res, await farms.filterOptions(user));
    if (seg[1] === 'accounts' && req.method === 'GET') return ok(res, { rows: await farms.listFarmAccounts(user, query) });
    return fail(res, 405, 'Метод не підтримується');
  }
  if (seg[0] === 'farms' && seg[1] && !Number.isNaN(Number(seg[1])) && seg[2] === 'detail') {
    if (!can(user, 'farms', 'read')) return fail(res, 403, 'Немає доступу до ферм');
    return ok(res, await farms.farmDetail(user, Number(seg[1])));
  }

  // ── Мапи «Підключення клієнта»: дерево канв Excalidraw ─────────────────
  // /api/client_maps і /api/client_maps/:id (перейменування, sort_order,
  // видалення) ідуть через генерик-CRUD нижче — тут лише дерево, корінь
  // клієнта, сцена й додавання дочірньої мапи.
  if (seg[0] === 'client_maps' && ['tree', 'root'].includes(seg[1])) {
    if (!can(user, 'client_maps', 'read')) return fail(res, 403, 'Немає доступу до мап клієнта');
    if (!query.client_id) return fail(res, 400, 'Потрібен client_id');
    if (seg[1] === 'tree') return ok(res, { rows: await clientMaps.tree(user, query.client_id) });
    if (seg[1] === 'root') return ok(res, { id: await clientMaps.ensureRoot(user, query.client_id) });
  }
  if (seg[0] === 'client_maps' && seg[1] && !Number.isNaN(Number(seg[1])) && seg[2]) {
    if (!can(user, 'client_maps', 'read')) return fail(res, 403, 'Немає доступу до мап клієнта');
    const mapId = Number(seg[1]);
    if (seg[2] === 'scene' && req.method === 'GET') {
      const { node, scene } = await clientMaps.getScene(user, mapId);
      return ok(res, { node, scene });
    }
    if (seg[2] === 'scene' && req.method === 'PUT') {
      if (!can(user, 'client_maps', 'update')) return fail(res, 403, 'Немає прав редагувати мапу');
      const body = await readBody(req, clientMaps.MAX_SCENE_BYTES + 1024);
      return ok(res, await clientMaps.saveScene(user, mapId, body.scene));
    }
    if (seg[2] === 'children' && req.method === 'POST') {
      if (!can(user, 'client_maps', 'create')) return fail(res, 403, 'Немає прав створювати мапи');
      const body = await readBody(req);
      return ok(res, await clientMaps.createChild(user, mapId, body.name));
    }
    return fail(res, 405, 'Метод не підтримується');
  }

  // ── «Задачі»: простори → дошки → колонки → картки ──────────────────────
  // Усе гейтиться через право на 'task_spaces' (єдина зареєстрована
  // сутність) — сам доступ до КОНКРЕТНОГО простору перевіряє taskBoards.js
  // за членством, а не generic scopeWhere. Помилки з .status від
  // taskBoards.js (403/404/409) прокидаються як є.
  if (seg[0] === 'task_spaces' && !seg[1]) {
    if (!can(user, 'task_spaces', 'read')) return fail(res, 403, 'Немає доступу до задач');
    if (req.method === 'GET') return ok(res, { rows: await taskBoards.listSpaces(user) });
    if (req.method === 'POST') {
      if (!can(user, 'task_spaces', 'create')) return fail(res, 403, 'Немає прав створювати простори');
      const body = await readBody(req);
      return ok(res, await taskBoards.createSpace(user, body.name));
    }
    return fail(res, 405, 'Метод не підтримується');
  }
  if (seg[0] === 'task_spaces' && seg[1] && !Number.isNaN(Number(seg[1]))) {
    if (!can(user, 'task_spaces', 'read')) return fail(res, 403, 'Немає доступу до задач');
    const spaceId = Number(seg[1]);
    if (!seg[2] && req.method === 'GET') return ok(res, await taskBoards.getSpace(user, spaceId));
    if (!seg[2] && req.method === 'PUT') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав редагувати простір');
      return ok(res, await taskBoards.renameSpace(user, spaceId, (await readBody(req)).name));
    }
    if (!seg[2] && req.method === 'DELETE') {
      if (!can(user, 'task_spaces', 'delete')) return fail(res, 403, 'Немає прав видаляти простори');
      return ok(res, await taskBoards.deleteSpace(user, spaceId));
    }
    if (seg[2] === 'members' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав редагувати учасників');
      return ok(res, await taskBoards.addMember(user, spaceId, (await readBody(req)).user_id));
    }
    if (seg[2] === 'members' && seg[3] && req.method === 'DELETE') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав редагувати учасників');
      return ok(res, await taskBoards.removeMember(user, spaceId, seg[3]));
    }
    if (seg[2] === 'boards' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'create')) return fail(res, 403, 'Немає прав створювати дошки');
      return ok(res, await taskBoards.createBoard(user, spaceId, (await readBody(req)).name));
    }
    return fail(res, 405, 'Метод не підтримується');
  }
  if (seg[0] === 'task_boards' && seg[1] && !Number.isNaN(Number(seg[1]))) {
    if (!can(user, 'task_spaces', 'read')) return fail(res, 403, 'Немає доступу до задач');
    const boardId = Number(seg[1]);
    if (!seg[2] && req.method === 'GET') return ok(res, await taskBoards.getBoard(user, boardId));
    if (!seg[2] && req.method === 'PUT') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав редагувати дошку');
      return ok(res, await taskBoards.renameBoard(user, boardId, (await readBody(req)).name));
    }
    if (!seg[2] && req.method === 'DELETE') {
      if (!can(user, 'task_spaces', 'delete')) return fail(res, 403, 'Немає прав видаляти дошки');
      return ok(res, await taskBoards.deleteBoard(user, boardId));
    }
    if (seg[2] === 'columns' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'create')) return fail(res, 403, 'Немає прав створювати колонки');
      const body = await readBody(req);
      return ok(res, await taskBoards.createColumn(user, boardId, body.name, body.color));
    }
    if (seg[2] === 'cards' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'create')) return fail(res, 403, 'Немає прав створювати картки');
      const body = await readBody(req);
      return ok(res, await taskBoards.createCard(user, boardId, body.column_id, body.title, {
        assignee_user_id: body.assignee_user_id, due_date: body.due_date, start_date: body.start_date,
        priority: body.priority, tag_ids: body.tag_ids,
      }));
    }
    if (seg[2] === 'tags' && req.method === 'GET') return ok(res, { rows: await taskBoards.listTags(user, boardId) });
    if (seg[2] === 'tags' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'create')) return fail(res, 403, 'Немає прав створювати теги');
      const body = await readBody(req);
      return ok(res, await taskBoards.createTag(user, boardId, body.name, body.color));
    }
    return fail(res, 405, 'Метод не підтримується');
  }
  if (seg[0] === 'task_tags' && seg[1] && !Number.isNaN(Number(seg[1]))) {
    const tagId = Number(seg[1]);
    if (req.method === 'PUT') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав редагувати теги');
      return ok(res, await taskBoards.updateTag(user, tagId, await readBody(req)));
    }
    if (req.method === 'DELETE') {
      if (!can(user, 'task_spaces', 'delete')) return fail(res, 403, 'Немає прав видаляти теги');
      return ok(res, await taskBoards.deleteTag(user, tagId));
    }
    return fail(res, 405, 'Метод не підтримується');
  }
  if (seg[0] === 'task_columns' && seg[1] && !Number.isNaN(Number(seg[1]))) {
    const columnId = Number(seg[1]);
    if (req.method === 'PUT') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав редагувати колонку');
      return ok(res, await taskBoards.updateColumn(user, columnId, await readBody(req)));
    }
    if (req.method === 'DELETE') {
      if (!can(user, 'task_spaces', 'delete')) return fail(res, 403, 'Немає прав видаляти колонки');
      return ok(res, await taskBoards.deleteColumn(user, columnId));
    }
    return fail(res, 405, 'Метод не підтримується');
  }
  if (seg[0] === 'task_cards' && seg[1] && !Number.isNaN(Number(seg[1]))) {
    if (!can(user, 'task_spaces', 'read')) return fail(res, 403, 'Немає доступу до задач');
    const cardId = Number(seg[1]);
    if (!seg[2] && req.method === 'GET') return ok(res, await taskBoards.getCard(user, cardId));
    if (!seg[2] && req.method === 'PUT') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав редагувати картку');
      return ok(res, await taskBoards.updateCard(user, cardId, await readBody(req)));
    }
    if (!seg[2] && req.method === 'DELETE') {
      if (!can(user, 'task_spaces', 'delete')) return fail(res, 403, 'Немає прав видаляти картки');
      return ok(res, await taskBoards.deleteCard(user, cardId));
    }
    if (seg[2] === 'move' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав переміщувати картки');
      const body = await readBody(req);
      return ok(res, await taskBoards.moveCard(user, cardId, body.column_id, body.board_order));
    }
    if (seg[2] === 'comments' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'create')) return fail(res, 403, 'Немає прав коментувати');
      const body = await readBody(req, 12 * 1024 * 1024);
      return ok(res, await taskBoards.addComment(user, cardId, body.body, body.attachments));
    }
    if (seg[2] === 'attachments' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'create')) return fail(res, 403, 'Немає прав додавати файли');
      const body = await readBody(req, 12 * 1024 * 1024);
      return ok(res, await taskBoards.addAttachment(user, cardId, body));
    }
    if (seg[2] === 'timer' && seg[3] === 'start' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав вести таймер');
      return ok(res, await taskBoards.startTimer(user, cardId));
    }
    if (seg[2] === 'timer' && seg[3] === 'stop' && req.method === 'POST') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав вести таймер');
      return ok(res, await taskBoards.stopTimer(user, cardId));
    }
    if (seg[2] === 'tags' && req.method === 'PUT') {
      if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав редагувати теги картки');
      const body = await readBody(req);
      return ok(res, await taskBoards.setCardTags(user, cardId, body.tag_ids));
    }
    return fail(res, 405, 'Метод не підтримується');
  }
  if (seg[0] === 'task_comments' && seg[1] && req.method === 'DELETE') {
    if (!can(user, 'task_spaces', 'delete')) return fail(res, 403, 'Немає прав видаляти коментарі');
    return ok(res, await taskBoards.deleteComment(user, Number(seg[1])));
  }
  if (seg[0] === 'task_attachments' && seg[1] && !Number.isNaN(Number(seg[1]))) {
    if (!can(user, 'task_spaces', 'read')) return fail(res, 403, 'Немає доступу до задач');
    const attachmentId = Number(seg[1]);
    if (seg[2] === 'file' && req.method === 'GET') {
      const file = await taskBoards.getAttachmentFile(user, attachmentId);
      return send(res, 200, file.buffer, {
        'content-type': file.mime || 'application/octet-stream',
        'content-disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
      });
    }
    if (!seg[2] && req.method === 'DELETE') {
      if (!can(user, 'task_spaces', 'delete')) return fail(res, 403, 'Немає прав видаляти файли');
      return ok(res, await taskBoards.deleteAttachment(user, attachmentId));
    }
    return fail(res, 405, 'Метод не підтримується');
  }
  if (seg[0] === 'task_time_entries' && seg[1] && req.method === 'PUT') {
    if (!can(user, 'task_spaces', 'update')) return fail(res, 403, 'Немає прав редагувати трекер часу');
    return ok(res, await taskBoards.editTimeEntry(user, Number(seg[1]), await readBody(req)));
  }

  // --- клієнти ---
  // Плоскі /api/clients і /api/clients/:id (список/створення/редагування
  // картки) ідуть через генерик-CRUD нижче — тут лише вкладені дії
  // (summary і все, що під /:id/...): підписки на послуги, нотатки, зміна
  // статусу з бухгалтерією paused_at/churned_at, яких у генеричній сутності
  // немає.
  if (seg[0] === 'clients' && seg[1] === 'summary') {
    if (!can(user, 'clients', 'read')) return fail(res, 403, 'Немає доступу до клієнтів');
    const scope = scopeWhere(user, 'clients', 'c');
    return ok(res, await clients.summary(scope.sql, scope.params));
  }
  if (seg[0] === 'clients' && seg[1] && seg[2]) {
    if (!can(user, 'clients', 'read')) return fail(res, 403, 'Немає доступу до клієнтів');
    const clientId = Number(seg[1]);
    const canEdit = can(user, 'clients', 'update');

    if (seg[2] === 'full' && req.method === 'GET') return ok(res, await clients.clientCard(clientId));
    if (seg[2] === 'status' && req.method === 'POST') {
      if (!canEdit) return fail(res, 403, 'Немає прав редагувати клієнта');
      const body = await readBody(req);
      return ok(res, await clients.setClientStatus(user, clientId, body.status, body));
    }
    if (seg[2] === 'notes' && req.method === 'POST') {
      if (!canEdit) return fail(res, 403, 'Немає прав редагувати клієнта');
      const body = await readBody(req);
      const id = await insert('client_notes', { client_id: clientId, text: String(body.text || '').slice(0, 4000), user_id: user.id });
      return ok(res, { id });
    }
    if (seg[2] === 'services') {
      if (req.method === 'POST' && !seg[3]) {
        if (!canEdit) return fail(res, 403, 'Немає прав редагувати клієнта');
        return ok(res, await clients.addService(clientId, await readBody(req)));
      }
      if (seg[3] && req.method === 'PUT') {
        if (!canEdit) return fail(res, 403, 'Немає прав редагувати клієнта');
        return ok(res, await clients.updateService(clientId, Number(seg[3]), await readBody(req)));
      }
      if (seg[3] && req.method === 'DELETE') {
        if (!canEdit) return fail(res, 403, 'Немає прав редагувати клієнта');
        return ok(res, await clients.removeService(clientId, Number(seg[3])));
      }
    }
    return fail(res, 404, 'Немає такого ендпоїнта');
  }

  // --- генерик CRUD ---
  const entKey = seg[0];
  const ent = entities[entKey];
  if (!ent) return fail(res, 404, 'Невідома сутність');
  if (!can(user, entKey, 'read')) {
    await audit({ user_id: user.id, action: 'denied', entity: entKey, ip });
    return fail(res, 403, 'Немає доступу до цього розділу');
  }

  // /api/:entity/export
  if (seg[1] === 'export') {
    if (!capable(user, 'export')) {
      await audit({ user_id: user.id, action: 'denied_export', entity: entKey, ip });
      return fail(res, 403, 'Експорт заборонений для вашої ролі');
    }
    const { rows } = await listRows(user, entKey, { ...query, limit: MAX_LIMIT });
    await audit({ user_id: user.id, action: 'export', entity: entKey, payload: { rows: rows.length, query }, ip });
    return send(res, 200, csv(rows, visibleFields(user, entKey), user), {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${entKey}-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }

  // /api/:entity/import — той самий CSV-формат, що видає export цієї
  // сутності (заголовки — підписи полів), тож export → правки в Excel →
  // import працює як єдиний цикл.
  if (seg[1] === 'import' && req.method === 'POST') {
    if (!can(user, entKey, 'create')) {
      await audit({ user_id: user.id, action: 'denied_import', entity: entKey, ip });
      return fail(res, 403, 'Немає прав на створення для цього розділу');
    }
    const body = await readBody(req);
    return ok(res, await importRows(user, entKey, String(body.csv || ''), ip));
  }

  const id = Number(seg[1]);

  // /api/:entity/:id/secret/:field — розкриття зашифрованого поля
  if (seg[2] === 'secret' && seg[3]) {
    if (!capable(user, 'secrets')) {
      await audit({ user_id: user.id, action: 'denied_reveal', entity: entKey, entity_id: id, ip });
      return fail(res, 403, 'Немає доступу до секретів');
    }
    const field = ent.fields.find((f) => f.name === seg[3] && f.type === 'secret');
    if (!field) return fail(res, 404, 'Поле не знайдено');
    const row = await get(`SELECT * FROM ${ent.table} WHERE id=?`, id);
    if (!row || !ownsRow(user, entKey, row)) return fail(res, 404, 'Запис не знайдено');
    const budget = await vault.checkRevealBudget(user);
    await audit({ user_id: user.id, action: 'reveal', entity: entKey, entity_id: id, payload: { field: field.name }, ip });
    await vault.noteReveal(user);
    return ok(res, { value: decrypt(row[field.name]), used: budget.used + 1, limit: budget.limit });
  }

  // /api/:entity/:id/history — журнал для акаунта
  if (seg[2] === 'history') {
    const rows = entKey === 'accounts'
      ? await all('SELECT * FROM account_events WHERE account_id=? ORDER BY created_at DESC', id)
      : await all('SELECT * FROM resource_assignments WHERE resource_type=? AND resource_id=? ORDER BY created_at DESC', entKey.replace(/s$/, ''), id);
    return ok(res, { rows });
  }

  if (req.method === 'GET' && !seg[1]) return ok(res, await listRows(user, entKey, query));

  if (req.method === 'GET' && id) {
    const row = await get(`SELECT * FROM ${ent.table} WHERE id=?`, id);
    if (!row || !ownsRow(user, entKey, row)) return fail(res, 404, 'Запис не знайдено');
    return ok(res, { row: sanitize(user, entKey, row) });
  }

  if (req.method === 'POST' && !seg[1]) {
    const body = await readBody(req);
    const row = await createEntityRecord(user, entKey, body, ip);
    return ok(res, { id: row.id, row });
  }

  if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
    const body = await readBody(req);
    return ok(res, { row: await updateEntityRecord(user, entKey, id, body, ip) });
  }

  if (req.method === 'DELETE' && id) {
    if (!can(user, entKey, 'delete')) return fail(res, 403, 'Немає прав на видалення');
    const current = await get(`SELECT * FROM ${ent.table} WHERE id=?`, id);
    if (!current || !ownsRow(user, entKey, current)) return fail(res, 404, 'Запис не знайдено');
    if (entKey === 'services' && await get('SELECT id FROM service_package_items WHERE component_service_id=?', id)) {
      return fail(res, 409, 'Послуга входить у пакет — спершу приберіть її звідти');
    }
    // Видалення картки шаблонів забрало б із собою всю гілку вкладень —
    // тому спершу треба розібрати її вручну.
    if (entKey === 'message_templates') {
      const kids = await get('SELECT COUNT(*) AS c FROM message_templates WHERE parent_id=?', id);
      if (Number(kids?.c || 0) > 0) {
        return fail(res, 409, `Спершу видаліть вкладені картки (${kids.c}) — тоді цю можна буде прибрати`);
      }
    }
    // Ферму можна видалити і непорожньою (пристрої нікуди не діваються) —
    // просто відв'язуємо їх, інакше farm_id лишився б висіти на неіснуючій фермі.
    if (entKey === 'farms') await run('UPDATE devices SET farm_id=NULL WHERE farm_id=?', id);
    // Видалення мапи забрало б із собою всю вкладену гілку — так само,
    // як картки шаблонів, спершу розбираємо вручну.
    if (entKey === 'client_maps') {
      const kids = await get('SELECT COUNT(*) AS c FROM client_maps WHERE parent_id=?', id);
      if (Number(kids?.c || 0) > 0) {
        return fail(res, 409, `Спершу видаліть вкладені мапи (${kids.c}) — тоді цю можна буде прибрати`);
      }
    }
    await remove(ent.table, id);
    await audit({ user_id: user.id, action: 'delete', entity: entKey, entity_id: id, payload: redact(ent, current), ip });
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
async function importConversions(text, user, ip) {
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
      if (row.external_id && await get('SELECT id FROM conversions WHERE external_id=?', row.external_id)) { skipped += 1; continue; }
      await insert('conversions', {
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
  await audit({ user_id: user.id, action: 'import', entity: 'conversions', payload: { imported, skipped }, ip });
  return { imported, skipped, errors: errors.slice(0, 20) };
}

// ── Трекінг: редірект по лінку ────────────────────────────────────────────
export async function handleRedirect(req, res, url) {
  const slug = url.pathname.split('/')[2];
  const link = await get('SELECT * FROM tracking_links WHERE slug=?', slug);
  if (!link) return fail(res, 404, 'Лінк не знайдено');
  const clickId = token(10);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  await insert('clicks', {
    tracking_link_id: link.id, click_id: clickId,
    ip_hash: hashIp(clientIp(req)), user_agent: ua,
    // Гео дає CDN/проксі (Cloudflare, Railway); девайс і реферер — з заголовків.
    geo: String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || '').slice(0, 2) || null,
    device: /iPhone|iPad|Android|Mobile/i.test(ua) ? 'mobile' : 'desktop',
    referer: String(req.headers.referer || '').slice(0, 300) || null,
  });
  await run('UPDATE tracking_links SET clicks = clicks + 1 WHERE id=?', link.id);
  if (link.post_id) await run('UPDATE posts SET clicks = clicks + 1 WHERE id=?', link.post_id);
  const target = new URL(link.target_url);
  const subs = { sub1: link.account_id, sub2: link.creative_id, sub3: link.user_id, sub4: link.post_id };
  for (const [k, v] of Object.entries(subs)) if (v != null) target.searchParams.set(k, String(v));
  target.searchParams.set('click_id', clickId);
  res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
  res.end();
}

// ── Постбек від партнерки: /pb/:token?click_id=..&status=..&payout=.. ─────
export async function handlePostback(req, res, url) {
  const tok = url.pathname.split('/')[2];
  const q = Object.fromEntries(url.searchParams);
  const partner = await get('SELECT * FROM partners WHERE postback_token=?', tok);
  if (!partner) return fail(res, 403, 'invalid token');
  if (!rateLimit(`pb:${tok}`, 600, 60_000)) return fail(res, 429, 'rate limited');

  const status = ({ approved: 'approved', confirmed: 'approved', lead: 'hold', hold: 'hold', pending: 'hold', rejected: 'rejected', trash: 'rejected', paid: 'paid' })[String(q.status || 'hold').toLowerCase()] || 'hold';
  const event = ({ reg: 'reg', registration: 'reg', dep: 'dep', deposit: 'dep', sale: 'sale', click: 'click' })[String(q.event || q.goal || 'dep').toLowerCase()] || 'dep';

  const click = q.click_id ? await get('SELECT * FROM clicks WHERE click_id=?', q.click_id) : null;
  const link = click ? await get('SELECT * FROM tracking_links WHERE id=?', click.tracking_link_id) : null;

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
  if (!data.payout && data.offer_id) data.payout = await get('SELECT payout FROM offers WHERE id=?', data.offer_id)?.payout ?? 0;

  // Дедуплікація + оновлення статусу hold → approved → paid.
  const existing = data.external_id ? await get('SELECT * FROM conversions WHERE partner_id=? AND external_id=?', partner.id, data.external_id) : null;
  if (existing) {
    await update('conversions', existing.id, { status, payout: data.payout, event });
    return send(res, 200, 'ok');
  }
  const newId = await insert('conversions', data);
  if (event === 'dep' && data.user_id) {
    await notify('conversion', `💰 Деп: офер #${data.offer_id ?? '—'}, ${data.payout} ${data.currency}`, data.user_id);
  }
  await audit({ action: 'postback', entity: 'conversions', entity_id: newId, payload: { partner: partner.name, status, event }, ip: clientIp(req) });
  return send(res, 200, 'ok');
}
