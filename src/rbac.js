// RBAC: рівень доступу (none|read|write|full) + скоуп (all|team|own) для кожної
// пари роль×сутність, плюс приховування полів (ставки/фінанси) і капабіліті.
import { entities } from './entities.js';

export const LEVELS = { none: 0, read: 1, write: 2, full: 3 };

const R = (level, scope = 'all') => ({ level, scope });

// Базові набори, щоб матриця читалась, а не розповзалась на 200 рядків.
const RESOURCE = ['accounts', 'devices', 'sims', 'proxies', 'mail_accounts', 'resource_assignments', 'account_events'];
const CONTENT = ['creatives', 'creative_versions', 'tasks'];
const MONEY = ['expenses', 'payouts', 'salary_rules', 'partners', 'offers', 'offer_rates_history'];

function spread(keys, rule) {
  return Object.fromEntries(keys.map((k) => [k, rule]));
}

export const matrix = {
  owner: { '*': R('full', 'all') },

  head: { '*': R('full', 'all'), audit_log: R('read', 'all') },

  teamlead: {
    ...spread(RESOURCE, R('write', 'team')),
    ...spread(CONTENT, R('full', 'team')),
    posts: R('full', 'team'),
    tracking_links: R('write', 'team'),
    conversions: R('read', 'team'),
    offers: R('read', 'all'),
    partners: R('read', 'all'),
    offer_rates_history: R('read', 'all'),
    expenses: R('write', 'team'),
    payouts: R('read', 'team'),
    kpi_targets: R('write', 'team'),
    users: R('read', 'team'),
    teams: R('read', 'team'),
    notifications: R('read', 'team'),
  },

  creator: {
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

  editor: {
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
    posts: R('read', 'all'),
    payouts: R('read', 'own'),
    kpi_targets: R('read', 'own'),
    notifications: R('read', 'own'),
    users: R('read', 'all'),
  },

  finance: {
    ...spread(MONEY, R('full', 'all')),
    conversions: R('write', 'all'),
    posts: R('read', 'all'),
    accounts: R('read', 'all'),
    users: R('read', 'all'),
    teams: R('read', 'all'),
    kpi_targets: R('write', 'all'),
    audit_log: R('read', 'all'),
    notifications: R('read', 'all'),
    devices: R('read', 'all'), sims: R('read', 'all'), proxies: R('read', 'all'), mail_accounts: R('read', 'all'),
  },

  analyst: { '*': R('read', 'all'), audit_log: R('none'), salary_rules: R('none') },
};

// Капабіліті поза CRUD.
const CAPS = {
  owner: ['secrets', 'export', 'salary_calc', 'settings', 'impersonate_filters'],
  head: ['secrets', 'export', 'salary_calc', 'settings'],
  teamlead: ['secrets', 'export'],
  farmer: ['secrets'],
  finance: ['export', 'salary_calc'],
  analyst: ['export'],
  creator: [],
  editor: [],
};

export function rule(user, entityKey) {
  const m = matrix[user?.role] || {};
  return m[entityKey] || m['*'] || R('none');
}

export function can(user, entityKey, action) {
  const need = { read: 1, create: 2, update: 2, delete: 3 }[action] ?? 3;
  const ent = entities[entityKey];
  if (!ent) return false;
  if (ent.readOnlyEntity && need > 1) return false;
  return LEVELS[rule(user, entityKey).level] >= need;
}

export const scopeOf = (user, entityKey) => rule(user, entityKey).scope;
export const capable = (user, cap) => (CAPS[user?.role] || []).includes(cap);

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
  return ent.fields.filter((f) => (f.hideFor || []).includes(user?.role)).map((f) => f.name);
}

// Секрети ніколи не віддаються списком — тільки через /reveal з аудитом.
export function sanitize(user, entityKey, row) {
  if (!row) return row;
  const ent = entities[entityKey];
  const out = { ...row };
  for (const name of hiddenFields(user, entityKey)) delete out[name];
  for (const f of ent.fields) {
    if (f.type === 'secret' && out[f.name] != null) out[f.name] = '••••••';
    if (f.type === 'password') delete out[f.name];
  }
  delete out.password_hash;
  delete out.totp_secret;
  return out;
}

export function visibleFields(user, entityKey) {
  const hidden = new Set(hiddenFields(user, entityKey));
  return entities[entityKey].fields.filter((f) => !hidden.has(f.name));
}
