// RBAC: рівень доступу (none|read|write|full) + скоуп (all|team|own) для кожної
// пари роль×сутність, плюс приховування полів (ставки/фінанси) і капабіліті.
//
// Матриця нижче — це ДЕФОЛТИ, якими наповнюється БД при першому старті.
// Далі джерелом істини є таблиці roles/role_permissions, які редагуються
// в інтерфейсі: нова роль з'являється без деплою.
import { entities } from './entities.js';
import { all, get, run, insert } from './db.js';

export const LEVELS = { none: 0, read: 1, write: 2, full: 3 };

const R = (level, scope = 'all') => ({ level, scope });

// Базові набори, щоб матриця читалась, а не розповзалась на 200 рядків.
const RESOURCE = ['accounts', 'devices', 'sims', 'proxies', 'mail_accounts', 'resource_assignments', 'account_events', 'farms'];
const VAULT_SELF = { credentials: R('read', 'own'), credential_grants: R('read', 'own'), access_requests: R('write', 'own') };
// Пошук клієнтів: менеджер працює зі своїми лідами, довідники лише читає.
const PROSPECTING_SELF = {
  prospect_lists: R('write', 'team'), leads: R('full', 'own'), touches: R('read', 'own'),
  message_templates: R('read', 'all'), scripts: R('read', 'all'), lead_statuses: R('read', 'all'), dictionaries: R('read', 'all'),
  suppression_list: R('write', 'all'),
  // Виграний лід — це його клієнт: веде далі той самий менеджер.
  clients: R('full', 'own'),
  // Щоб підписати клієнта на послугу, менеджеру потрібен прайс — без права
  // редагувати собівартість.
  services: R('read', 'all'),
  // Свою норму менеджер бачить, але не редагує — інакше план втрачає сенс.
  kpi_plans: R('read', 'own'), channel_limits: R('read', 'own'), work_calendar: R('read', 'own'),
  ramp_up_plans: R('read', 'own'), bonus_rules: R('read', 'own'), quality_flags: R('read', 'own'),
};
const CONTENT = ['creatives', 'creative_versions', 'tasks'];
const MONEY = ['expenses', 'payouts', 'salary_rules', 'partners', 'offers', 'offer_rates_history',
  'services', 'cost_rates'];

function spread(keys, rule) {
  return Object.fromEntries(keys.map((k) => [k, rule]));
}

export const defaultMatrix = {
  owner: { '*': R('full', 'all') },

  head: { '*': R('full', 'all'), audit_log: R('read', 'all') },

  teamlead: {
    ...spread(RESOURCE, R('write', 'team')),
    prospect_lists: R('full', 'team'), leads: R('full', 'team'), touches: R('read', 'team'),
    clients: R('full', 'team'), client_maps: R('full', 'team'),
    message_templates: R('full', 'all'), scripts: R('full', 'all'), lead_statuses: R('write', 'all'), dictionaries: R('write', 'all'),
    suppression_list: R('full', 'all'),
    kpi_plans: R('full', 'team'), channel_limits: R('full', 'all'), work_calendar: R('full', 'team'),
    ramp_up_plans: R('full', 'team'), bonus_rules: R('read', 'all'), quality_flags: R('read', 'team'),
    credentials: R('write', 'team'),
    credential_grants: R('read', 'team'),
    access_requests: R('full', 'team'),
    ...spread(CONTENT, R('full', 'team')),
    posts: R('full', 'team'),
    tracking_links: R('write', 'team'),
    conversions: R('read', 'team'),
    offers: R('read', 'all'),
    partners: R('read', 'all'),
    offer_rates_history: R('read', 'all'),
    expenses: R('write', 'team'),
    payouts: R('read', 'team'),
    services: R('read', 'all'), cost_rates: R('read', 'all'),
    kpi_targets: R('write', 'team'),
    users: R('read', 'team'),
    teams: R('read', 'team'),
    notifications: R('read', 'team'),
  },

  creator: {
    ...VAULT_SELF,
    accounts: R('read', 'own'),
    posts: R('full', 'own'),
    creatives: R('write', 'own'),
    creative_versions: R('write', 'own'),
    tasks: R('write', 'own'),
    offers: R('read', 'all'),
    tracking_links: R('read', 'own'),
    conversions: R('read', 'own'),
    payouts: R('read', 'own'),
    kpi_targets: R('read', 'own'),
    notifications: R('read', 'own'),
  },

  sales: {
    ...VAULT_SELF,
    ...PROSPECTING_SELF,
    users: R('read', 'team'),
    teams: R('read', 'team'),
    notifications: R('read', 'own'),
    payouts: R('read', 'own'),
    kpi_targets: R('read', 'own'),
  },

  editor: {
    ...VAULT_SELF,
    creatives: R('write', 'all'),
    creative_versions: R('full', 'all'),
    tasks: R('write', 'own'),
    posts: R('read', 'all'),
    offers: R('read', 'all'),
    payouts: R('read', 'own'),
    notifications: R('read', 'own'),
  },

  farmer: {
    ...spread(RESOURCE, R('full', 'all')),
    credentials: R('full', 'all'),
    credential_grants: R('read', 'all'),
    access_requests: R('write', 'own'),
    posts: R('read', 'all'),
    payouts: R('read', 'own'),
    kpi_targets: R('read', 'own'),
    notifications: R('read', 'own'),
    users: R('read', 'all'),
    // Ферма прив'язана до клієнта — без читання клієнтів нема з чого
    // вибирати в формі ферми.
    clients: R('read', 'all'),
  },

  finance: {
    ...spread(MONEY, R('full', 'all')),
    credentials: R('read', 'own'), credential_grants: R('read', 'own'), access_requests: R('write', 'own'),
    conversions: R('write', 'all'),
    posts: R('read', 'all'),
    accounts: R('read', 'all'),
    users: R('read', 'all'),
    teams: R('read', 'all'),
    kpi_targets: R('write', 'all'),
    audit_log: R('read', 'all'),
    notifications: R('read', 'all'),
    devices: R('read', 'all'), sims: R('read', 'all'), proxies: R('read', 'all'), mail_accounts: R('read', 'all'), farms: R('read', 'all'),
    clients: R('read', 'all'), client_maps: R('read', 'all'),
  },

  // Аналітик читає цифри, але не сейф: інакше «read all» тихо відкриває креди.
  analyst: {
    '*': R('read', 'all'), audit_log: R('none'), salary_rules: R('none'),
    credentials: R('none'), credential_grants: R('none'), access_requests: R('none'),
  },
};

// Капабіліті поза CRUD (дефолти для сідингу таблиці roles).
const CAPS = {
  owner: ['secrets', 'export', 'salary_calc', 'settings', 'impersonate_filters'],
  head: ['secrets', 'export', 'salary_calc', 'settings'],
  teamlead: ['secrets', 'export'],
  farmer: ['secrets'],
  finance: ['export', 'salary_calc'],
  analyst: ['export'],
  // Крієйтору потрібне розкриття — інакше видача доступів безглузда. Межі
  // ставить не роль, а сам сейф: лише те, що на руках, і добовий ліміт.
  creator: ['secrets'],
  editor: ['secrets'],
  sales: ['secrets', 'export'],
};

export const ROLE_LABELS = {
  owner: 'Власник', head: 'Хед', teamlead: 'Тімлід', creator: 'Крієйтор',
  editor: 'Монтажер', farmer: 'Фармер', finance: 'Фінансист', analyst: 'Аналітик',
  sales: 'Менеджер з пошуку',
};

// ── Шар БД ────────────────────────────────────────────────────────────────
let cache = new Map();

// Права читаються з БД один раз на старт і після кожної зміни ролей:
// самі перевірки (can/scopeOf/hiddenFields) мають лишатись синхронними,
// бо викликаються десятки разів на кожен запит.
export async function refreshRbac() {
  const roles = new Map();
  for (const r of await all('SELECT * FROM roles')) roles.set(r.key, { ...r, perms: new Map() });
  for (const p of await all('SELECT * FROM role_permissions')) {
    roles.get(p.role_key)?.perms.set(p.entity, p);
  }
  cache = roles;
  // Поле «Роль» у формі користувача має показувати ролі з БД, включно з
  // кастомними — інакше нову роль неможливо нікому призначити.
  const roleField = entities.users.fields.find((f) => f.name === 'role');
  if (roleField && roles.size) {
    roleField.options = [...roles.values()]
      .map((r) => ({ value: r.key, label: r.label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'uk'));
  }
  return cache;
}

export const invalidateRbacCache = refreshRbac;

const loadCache = () => cache;

// Первинне наповнення: дефолти з коду → БД. Наявні рядки не чіпаємо.
export async function seedRoles() {
  if (await get('SELECT key FROM roles LIMIT 1')) { await refreshRbac(); return { seeded: 0 }; }
  let seeded = 0;
  for (const [key, label] of Object.entries(ROLE_LABELS)) {
    const caps = CAPS[key] || [];
    await run(`INSERT INTO roles (key, label, is_system, can_export, can_reveal, can_salary_calc, can_settings, reveal_daily_limit)
         VALUES (?,?,1,?,?,?,?,?)`,
      key, label,
      caps.includes('export') ? 1 : 0, caps.includes('secrets') ? 1 : 0,
      caps.includes('salary_calc') ? 1 : 0, caps.includes('settings') ? 1 : 0,
      { owner: 200, head: 200, teamlead: 50, farmer: 50 }[key] ?? 5);
    for (const entityKey of Object.keys(entities)) {
      const r = defaultRule(key, entityKey);
      const hidden = entities[entityKey].fields.filter((f) => (f.hideFor || []).includes(key)).map((f) => f.name);
      await insert('role_permissions', {
        role_key: key, entity: entityKey, level: r.level, scope: r.scope,
        hidden_fields: hidden.join(',') || null,
      });
    }
    seeded += 1;
  }
  await refreshRbac();
  return { seeded };
}

// Права для сутностей, доданих після сідингу (нові модулі в оновленні).
// Роль, додана в оновленні (наприклад, менеджер з пошуку), має з'явитись
// і в базі, яка сідилась раніше.
export async function syncNewRoles() {
  const known = new Set((await all('SELECT key FROM roles')).map((r) => r.key));
  const missing = Object.keys(ROLE_LABELS).filter((k) => !known.has(k));
  for (const key of missing) {
    const caps = CAPS[key] || [];
    await run(`INSERT INTO roles (key, label, is_system, can_export, can_reveal, can_salary_calc, can_settings, reveal_daily_limit)
               VALUES (?,?,1,?,?,?,?,?)`,
      key, ROLE_LABELS[key],
      caps.includes('export') ? 1 : 0, caps.includes('secrets') ? 1 : 0,
      caps.includes('salary_calc') ? 1 : 0, caps.includes('settings') ? 1 : 0,
      { owner: 200, head: 200, teamlead: 50, farmer: 50 }[key] ?? 5);
    for (const entityKey of Object.keys(entities)) {
      const r = defaultRule(key, entityKey);
      const hidden = entities[entityKey].fields.filter((f) => (f.hideFor || []).includes(key)).map((f) => f.name);
      await insert('role_permissions', {
        role_key: key, entity: entityKey, level: r.level, scope: r.scope,
        hidden_fields: hidden.join(',') || null,
      });
    }
  }
  if (missing.length) await refreshRbac();
  return { added: missing.length };
}

// Бекфілідемпотентний за парою (роль, сутність), а не за самою сутністю:
// якщо нову сутність і нову роль додали в одному оновленні, syncNewRoles()
// (вище) устигає дати новій ролі рядки на все, включно зі свіжими
// сутностями — тоді перевірка «чи є хоч один рядок на цю сутність» бачить
// її вже «відомою» і мовчки пропускає бекфіл для решти, вже існуючих
// ролей (власника включно). Саме так «Пошук клієнтів» лишив owner/head/
// teamlead без доступу до leads/prospect_lists/touches і подібних —
// рядок для sales уже існував, тому цикл нижче вважав сутність знайомою.
export async function syncNewEntities() {
  const known = new Set((await all('SELECT role_key, entity FROM role_permissions')).map((r) => `${r.role_key}:${r.entity}`));
  const roles = await all('SELECT key FROM roles');
  let added = 0;
  for (const role of roles) {
    for (const entityKey of Object.keys(entities)) {
      if (known.has(`${role.key}:${entityKey}`)) continue;
      const r = defaultRule(role.key, entityKey);
      const hidden = entities[entityKey].fields.filter((f) => (f.hideFor || []).includes(role.key)).map((f) => f.name);
      await insert('role_permissions', {
        role_key: role.key, entity: entityKey, level: r.level, scope: r.scope,
        hidden_fields: hidden.join(',') || null,
      });
      added += 1;
    }
  }
  if (added) await refreshRbac();
  return { added };
}

function defaultRule(roleKey, entityKey) {
  const m = defaultMatrix[roleKey] || {};
  return m[entityKey] || m['*'] || R('none');
}

export function rule(user, entityKey) {
  const role = loadCache().get(user?.role);
  if (!role) return defaultRule(user?.role, entityKey);
  return role.perms.get(entityKey) || R('none');
}

export const roleRow = (roleKey) => loadCache().get(roleKey) || null;

export function can(user, entityKey, action) {
  const need = { read: 1, create: 2, update: 2, delete: 3 }[action] ?? 3;
  const ent = entities[entityKey];
  if (!ent) return false;
  if (ent.readOnlyEntity && need > 1) return false;
  return LEVELS[rule(user, entityKey).level] >= need;
}

export const scopeOf = (user, entityKey) => rule(user, entityKey).scope;

const CAP_COLUMNS = { export: 'can_export', secrets: 'can_reveal', salary_calc: 'can_salary_calc', settings: 'can_settings' };

export function capable(user, cap) {
  const role = loadCache().get(user?.role);
  if (!role) return (CAPS[user?.role] || []).includes(cap);
  const column = CAP_COLUMNS[cap];
  return column ? !!role[column] : (CAPS[user?.role] || []).includes(cap);
}

export const revealLimit = (user) => Number(loadCache().get(user?.role)?.reveal_daily_limit ?? 20);

// SQL-фільтр за скоупом. Повертає {sql, params} для WHERE.
export function scopeWhere(user, entityKey, alias = 't') {
  const ent = entities[entityKey];
  const scope = scopeOf(user, entityKey);
  if (scope === 'all' || !ent) return { sql: '1=1', params: [] };
  if (scope === 'team') {
    if (ent.teamField) return { sql: `${alias}.${ent.teamField} IS ?`, params: [user.team_id ?? null] };
    if (ent.key === 'users' || ent.key === 'teams') {
      return ent.key === 'users'
        ? { sql: `${alias}.team_id IS ?`, params: [user.team_id ?? null] }
        : { sql: `${alias}.id IS ?`, params: [user.team_id ?? null] };
    }
    if (ent.ownField) {
      return {
        sql: `${alias}.${ent.ownField} IN (SELECT id FROM users WHERE team_id IS ?)`,
        params: [user.team_id ?? null],
      };
    }
    return { sql: '1=1', params: [] };
  }
  // own
  if (ent.ownField) return { sql: `${alias}.${ent.ownField} = ?`, params: [user.id] };
  return { sql: '1=0', params: [] };
}

export function ownsRow(user, entityKey, row) {
  const ent = entities[entityKey];
  const scope = scopeOf(user, entityKey);
  if (scope === 'all') return true;
  if (!row) return false;
  if (scope === 'own') return ent.ownField ? row[ent.ownField] === user.id : false;
  if (scope === 'team') {
    if (ent.teamField) return (row[ent.teamField] ?? null) === (user.team_id ?? null);
    return true;
  }
  return false;
}

// Поля, які роль взагалі не бачить (ставки реклів, собівартість ресурсів).
export function hiddenFields(user, entityKey) {
  const ent = entities[entityKey];
  if (!ent) return [];
  const perm = loadCache().get(user?.role)?.perms.get(entityKey);
  if (perm) return String(perm.hidden_fields || '').split(',').map((f) => f.trim()).filter(Boolean);
  return ent.fields.filter((f) => (f.hideFor || []).includes(user?.role)).map((f) => f.name);
}

// ab***@gmail.com — щоб список доступів не був готовою базою для зливу.
function maskValue(value) {
  const v = String(value);
  const at = v.indexOf('@');
  if (at > 0) return `${v.slice(0, Math.min(2, at))}${'*'.repeat(3)}${v.slice(at)}`;
  return v.length <= 3 ? '***' : `${v.slice(0, 2)}${'*'.repeat(3)}${v.slice(-1)}`;
}

// Секрети ніколи не віддаються списком — тільки через /reveal з аудитом.
export function sanitize(user, entityKey, row) {
  if (!row) return row;
  const ent = entities[entityKey];
  const out = { ...row };
  for (const name of hiddenFields(user, entityKey)) delete out[name];
  const relatedToUser = row.owner_user_id === user?.id || row.holder_user_id === user?.id;
  for (const f of ent.fields) {
    if (f.type === 'secret' && out[f.name] != null) out[f.name] = '••••••';
    if (f.type === 'password') delete out[f.name];
    if (f.mask && out[f.name] && !relatedToUser && !capable(user, 'secrets')) out[f.name] = maskValue(out[f.name]);
  }
  delete out.password_hash;
  delete out.totp_secret;
  return out;
}

export function visibleFields(user, entityKey) {
  const hidden = new Set(hiddenFields(user, entityKey));
  return entities[entityKey].fields.filter((f) => !hidden.has(f.name));
}
