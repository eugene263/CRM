// Ферми: блок пристроїв (типово ~20 телефонів) одного клієнта в одному
// гео. Сама вкладеність — devices.farm_id і accounts.device_id, тут лише
// агреговані вибірки під структурований UI з фільтрами (публікації
// рахуються з posts, а не зберігаються окремим полем — щоб цифра не
// розходилась із реальною історією заливів).
import { all, get } from './db.js';
import { scopeWhere } from './rbac.js';

// Ферми, видимі цьому користувачу, з підсумками по пристроях/акаунтах —
// для верхнього списку/плашок на сторінці.
export async function listFarms(user) {
  const scope = scopeWhere(user, 'farms', 'f');
  return all(
    `SELECT f.*, c.name AS client_name,
            (SELECT COUNT(*) FROM devices d WHERE d.farm_id = f.id) AS device_count,
            (SELECT COUNT(*) FROM accounts a JOIN devices d ON d.id = a.device_id
              WHERE d.farm_id = f.id) AS account_count
       FROM farms f LEFT JOIN clients c ON c.id = f.client_id
      WHERE ${scope.sql}
      ORDER BY c.name, f.name`, ...scope.params);
}

// Значення для випадаючих списків фільтра — лише те, що реально є в
// даних, а не весь довідник платформ: порожній фільтр не має сенсу.
export async function filterOptions(user) {
  const scope = scopeWhere(user, 'farms', 'f');
  const [clients, geos, platforms, niches] = await Promise.all([
    all(`SELECT DISTINCT c.id, c.name FROM farms f JOIN clients c ON c.id = f.client_id
          WHERE ${scope.sql} ORDER BY c.name`, ...scope.params),
    all(`SELECT DISTINCT f.geo AS geo FROM farms f WHERE ${scope.sql} AND f.geo IS NOT NULL AND f.geo <> ''
          ORDER BY f.geo`, ...scope.params),
    all(`SELECT DISTINCT a.platform AS platform FROM accounts a
          JOIN devices d ON d.id = a.device_id JOIN farms f ON f.id = d.farm_id
         WHERE ${scope.sql} ORDER BY a.platform`, ...scope.params),
    all(`SELECT DISTINCT a.niche AS niche FROM accounts a
          JOIN devices d ON d.id = a.device_id JOIN farms f ON f.id = d.farm_id
         WHERE ${scope.sql} AND a.niche IS NOT NULL AND a.niche <> '' ORDER BY a.niche`, ...scope.params),
  ]);
  return {
    clients, geos: geos.map((r) => r.geo), platforms: platforms.map((r) => r.platform),
    niches: niches.map((r) => r.niche),
  };
}

// Плаский, фільтрований рядок-на-акаунт список — головна таблиця сторінки.
// Кількість відео рахується тут-таки з posts, щоб не тримати другу правду
// поряд зі справжньою історією публікацій.
export async function listFarmAccounts(user, query = {}) {
  const scope = scopeWhere(user, 'farms', 'f');
  const where = [scope.sql];
  const params = [...scope.params];
  const eq = (col, value) => { if (value) { where.push(`${col} = ?`); params.push(value); } };

  eq('f.id', query.farm_id ? Number(query.farm_id) : null);
  eq('f.client_id', query.client_id ? Number(query.client_id) : null);
  eq('f.geo', query.geo || null);
  eq('a.platform', query.platform || null);
  eq('a.status', query.status || null);
  eq('d.id', query.device_id ? Number(query.device_id) : null);
  if (query.niche) { where.push('a.niche LIKE ?'); params.push(`%${query.niche}%`); }
  if (query.q) {
    where.push('(a.nickname LIKE ? OR d.model LIKE ? OR f.name LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`);
  }

  return all(
    `SELECT a.id, a.platform, a.nickname, a.status AS account_status, a.niche, a.geo AS account_geo,
            d.id AS device_id, d.model AS device_model, d.status AS device_status,
            f.id AS farm_id, f.name AS farm_name, f.geo AS farm_geo,
            c.id AS client_id, c.name AS client_name,
            (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id) AS videos_count
       FROM accounts a
       JOIN devices d ON d.id = a.device_id
       JOIN farms f ON f.id = d.farm_id
       LEFT JOIN clients c ON c.id = f.client_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.name, f.name, d.model, a.platform, a.nickname
      LIMIT 1000`, ...params);
}

// Картка однієї ферми: пристрої, згруповані по собі, з їхніми акаунтами —
// для дерева «ферма → телефон → акаунти» під фільтрами.
export async function farmDetail(user, farmId) {
  const scope = scopeWhere(user, 'farms', 'f');
  const farm = await get(
    `SELECT f.*, c.name AS client_name FROM farms f LEFT JOIN clients c ON c.id = f.client_id
      WHERE f.id = ? AND ${scope.sql}`, Number(farmId), ...scope.params);
  if (!farm) throw Object.assign(new Error('Ферму не знайдено'), { status: 404 });

  const devices = await all(
    `SELECT id, model, imei, status, holder_user_id FROM devices WHERE farm_id = ? ORDER BY model`, farm.id);
  const deviceIds = devices.map((d) => d.id);
  const accounts = deviceIds.length
    ? await all(
      `SELECT a.id, a.device_id, a.platform, a.nickname, a.status, a.niche, a.geo,
              (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id) AS videos_count
         FROM accounts a WHERE a.device_id IN (${deviceIds.map(() => '?').join(',')})
        ORDER BY a.platform, a.nickname`, ...deviceIds)
    : [];
  const byDevice = new Map(deviceIds.map((id) => [id, []]));
  for (const acc of accounts) byDevice.get(acc.device_id)?.push(acc);

  return {
    farm,
    devices: devices.map((d) => ({ ...d, accounts: byDevice.get(d.id) || [] })),
  };
}
