// Собівартість послуг: із чого складається одиниця роботи, скільки вона
// коштує насправді і яку ціну ставити, щоб вийти на цільову маржу.
//
// Ставки живуть окремо від послуг: підняли годину монтажера — перерахувались
// усі послуги, де вона є, без ручного редагування кожної.
import { all, get, run, insert, update } from './db.js';

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const round = (v) => Math.round(Number(v || 0) * 100) / 100;

const DEFAULT_RATES = [
  ['editor_hour', 'Година монтажера', 'labor', 'год', 8],
  ['creator_hour', 'Година крієйтора', 'labor', 'год', 7],
  ['manager_hour', 'Година менеджера', 'labor', 'год', 9],
  ['account', 'Акаунт (закупка + фарм)', 'resource', 'шт', 12],
  ['proxy_month', 'Проксі, місяць', 'resource', 'міс', 15],
  ['sim', 'SIM-карта', 'resource', 'шт', 3],
  ['ai_tools', 'AI-сервіси на одиницю', 'subscription', 'шт', 1.5],
  ['overhead', 'Накладні витрати', 'overhead', '%', 15],
];

const DEFAULT_SERVICES = [
  {
    name: 'Пакет Reels: 30 відео/міс', category: 'Контент', unit: 'пакет', target_margin: 55, price: 1200,
    volume_per_month: 4,
    items: [
      ['editor_hour', 'Монтаж 30 роликів', 20],
      ['creator_hour', 'Зйомка й сценарії', 14],
      ['manager_hour', 'Комунікація з клієнтом', 4],
      ['ai_tools', 'AI-озвучка та субтитри', 30],
    ],
  },
  {
    name: 'Ведення TikTok-акаунта, місяць', category: 'Контент', unit: 'місяць', target_margin: 50, price: 650,
    volume_per_month: 6,
    items: [
      ['creator_hour', 'Ведення й публікації', 12],
      ['editor_hour', 'Монтаж 12 відео', 8],
      ['account', 'Акаунт із запасом на бан', 1],
      ['proxy_month', 'Проксі', 1],
    ],
  },
  {
    name: 'Один рекламний ролик', category: 'Контент', unit: 'шт', target_margin: 60, price: 90,
    volume_per_month: 40,
    items: [
      ['editor_hour', 'Монтаж', 2.5],
      ['creator_hour', 'Зйомка', 1],
      ['ai_tools', 'Сервіси', 1],
    ],
  },
];

export async function seedCosting() {
  if (!(await get('SELECT id FROM cost_rates LIMIT 1'))) {
    for (const [code, name, kind, unit, amount] of DEFAULT_RATES) {
      await insert('cost_rates', { code, name, kind, unit, amount });
    }
  }
  if (!(await get('SELECT id FROM services LIMIT 1'))) {
    for (const s of DEFAULT_SERVICES) {
      const id = await insert('services', {
        name: s.name, category: s.category, unit: s.unit, target_margin: s.target_margin,
        price: s.price, volume_per_month: s.volume_per_month, status: 'active',
      });
      for (const [i, [rate_code, name, quantity]] of s.items.entries()) {
        const rate = await get('SELECT * FROM cost_rates WHERE code=?', rate_code);
        await insert('service_cost_items', {
          service_id: id, rate_code, name, kind: rate?.kind || 'labor',
          quantity, sort_order: (i + 1) * 10,
        });
      }
    }
  }
}

// Ставки, підказані реальними даними CRM: щоб собівартість не жила
// в паралельній реальності з витратами, які вже в базі.
export async function suggestedRates() {
  const accountCost = await get(
    `SELECT ROUND(CAST(AVG(cost) AS NUMERIC), 2) AS v FROM accounts WHERE cost > 0`);
  const proxyCost = await get(
    `SELECT ROUND(CAST(AVG(cost) AS NUMERIC), 2) AS v FROM proxies WHERE cost > 0`);
  const simCost = await get(
    `SELECT ROUND(CAST(AVG(cost) AS NUMERIC), 2) AS v FROM sims WHERE cost > 0`);
  // Година роботи = нарахована ЗП за місяць / 168 робочих годин.
  const hour = await get(
    `SELECT ROUND(CAST(AVG(total) / 168.0 AS NUMERIC), 2) AS v FROM payouts WHERE status <> 'canceled' AND total > 0`);
  const services = await get(
    `SELECT ROUND(CAST(SUM(amount) AS NUMERIC), 2) AS v FROM expenses
      WHERE category='service' AND spent_at >= date('now','-30 days')`);

  return [
    { code: 'account', label: 'Акаунт', value: accountCost?.v ?? null, source: 'середня вартість акаунтів у базі' },
    { code: 'proxy_month', label: 'Проксі, місяць', value: proxyCost?.v ?? null, source: 'середня вартість проксі' },
    { code: 'sim', label: 'SIM-карта', value: simCost?.v ?? null, source: 'середня вартість SIM' },
    { code: 'editor_hour', label: 'Година роботи', value: hour?.v ?? null, source: 'нарахована ЗП / 168 год' },
    { code: 'ai_tools', label: 'Сервіси за місяць', value: services?.v ?? null, source: 'витрати категорії «Сервіси» за 30 днів' },
  ].filter((r) => r.value != null);
}

// Постійні витрати місяця — потрібні, щоб порахувати точку беззбитковості.
export async function fixedMonthlyCosts() {
  const salary = Number((await get(
    `SELECT COALESCE(SUM(total),0) AS v FROM payouts WHERE period = strftime('%Y-%m','now') AND status <> 'canceled'`))?.v || 0);
  const subscriptions = Number((await get(
    `SELECT COALESCE(SUM(amount),0) AS v FROM expenses
      WHERE category IN ('service','other') AND spent_at >= date('now','-30 days')`))?.v || 0);
  return { salary: round(salary), subscriptions: round(subscriptions), total: round(salary + subscriptions) };
}

async function rateMap() {
  const rows = await all('SELECT * FROM cost_rates');
  return Object.fromEntries(rows.map((r) => [r.code, r]));
}

export async function serviceCost(serviceId, rates = null) {
  const service = await get('SELECT * FROM services WHERE id=?', serviceId);
  if (!service) throw Object.assign(new Error('Послугу не знайдено'), { status: 404 });
  const map = rates || (await rateMap());
  const items = await all('SELECT * FROM service_cost_items WHERE service_id=? ORDER BY sort_order, id', serviceId);

  const lines = items.map((item) => {
    const rate = item.rate_code ? map[item.rate_code] : null;
    const unitCost = item.unit_cost != null ? Number(item.unit_cost) : Number(rate?.amount || 0);
    return {
      ...item,
      unit: rate?.unit || 'шт',
      unit_cost: round(unitCost),
      from_rate: item.unit_cost == null && !!rate,
      total: round(Number(item.quantity) * unitCost),
    };
  });

  const direct = round(lines.filter((l) => l.kind !== 'overhead').reduce((s, l) => s + l.total, 0));
  // Накладні рахуємо відсотком від прямих витрат, а не окремим рядком —
  // інакше при зміні складу послуги вони «застигають».
  const overheadRate = Number(map.overhead?.amount || 0);
  const overhead = round(direct * (overheadRate / 100));
  const cost = round(direct + overhead);

  const margin = Number(service.target_margin || 0);
  const recommended = margin < 100 ? round(cost / (1 - margin / 100)) : null;
  const price = Number(service.price || 0);
  const profit = round(price - cost);
  const actualMargin = price > 0 ? round((profit / price) * 100) : null;
  const markup = cost > 0 ? round((profit / cost) * 100) : null;

  return {
    service, lines, direct, overhead_percent: overheadRate, overhead, cost,
    recommended_price: recommended,
    price, profit, margin_percent: actualMargin, markup_percent: markup,
    price_gap: recommended != null ? round(price - recommended) : null,
    volume_per_month: Number(service.volume_per_month || 0),
    profit_per_month: round(profit * Number(service.volume_per_month || 0)),
  };
}

export async function listServices({ status = null } = {}) {
  const rates = await rateMap();
  const services = await all(
    `SELECT id FROM services ${status ? 'WHERE status=?' : ''} ORDER BY id`, ...(status ? [status] : []));
  const rows = [];
  for (const s of services) rows.push(await serviceCost(s.id, rates));

  const fixed = await fixedMonthlyCosts();
  const totalProfit = round(rows.reduce((sum, r) => sum + r.profit_per_month, 0));
  const totalRevenue = round(rows.reduce((sum, r) => sum + r.price * r.volume_per_month, 0));

  // Точка беззбитковості: скільки одиниць найприбутковішої послуги закриває
  // постійні витрати місяця.
  const best = rows.slice().sort((a, b) => b.profit - a.profit)[0];
  const breakeven = best && best.profit > 0 ? Math.ceil(fixed.total / best.profit) : null;

  return {
    rows,
    summary: {
      revenue_plan: totalRevenue,
      profit_plan: totalProfit,
      fixed,
      covers_fixed: fixed.total > 0 ? round((totalProfit / fixed.total) * 100) : null,
      breakeven_units: breakeven,
      breakeven_service: best?.service?.name || null,
    },
  };
}

export async function saveItem(serviceId, payload) {
  const data = {
    service_id: serviceId,
    rate_code: payload.rate_code || null,
    name: String(payload.name || '').trim(),
    kind: payload.kind || 'labor',
    quantity: Number(payload.quantity || 0),
    unit_cost: payload.unit_cost === '' || payload.unit_cost == null ? null : Number(payload.unit_cost),
    note: payload.note || null,
    sort_order: Number(payload.sort_order || 100),
  };
  if (!data.name) throw Object.assign(new Error('Потрібна назва рядка'), { status: 400 });
  if (payload.id) {
    await update('service_cost_items', Number(payload.id), data);
  } else {
    await insert('service_cost_items', data);
  }
  await update('services', serviceId, { updated_at: now() });
  return serviceCost(serviceId);
}

export async function deleteItem(serviceId, itemId) {
  await run('DELETE FROM service_cost_items WHERE id=? AND service_id=?', itemId, serviceId);
  return serviceCost(serviceId);
}

// Поставити ціну за цільовою маржею одним рухом.
export async function applyRecommendedPrice(serviceId) {
  const calc = await serviceCost(serviceId);
  if (calc.recommended_price == null) throw Object.assign(new Error('Маржа 100% недосяжна'), { status: 400 });
  await update('services', serviceId, { price: calc.recommended_price, updated_at: now() });
  return serviceCost(serviceId);
}

// ── Пакети послуг ─────────────────────────────────────────────────────────
// Пакет — та сама послуга (services.is_package=1), ціна якої не вводиться
// вручну, а рахується сумою (ціна компонента × кількість) по вкладених
// послугах. Компонентом може бути лише звичайна послуга — без вкладених
// пакетів, щоб не рахувати рекурсію й не ловити цикли.

export async function packageCard(packageId) {
  const service = await get('SELECT * FROM services WHERE id=?', packageId);
  if (!service) throw Object.assign(new Error('Послугу не знайдено'), { status: 404 });
  const items = (await all(
    `SELECT pi.*, s.name, s.unit, s.price
       FROM service_package_items pi JOIN services s ON s.id = pi.component_service_id
      WHERE pi.package_service_id=? ORDER BY s.name`, packageId))
    .map((row) => ({ ...row, total: round(Number(row.price) * Number(row.quantity)) }));
  return { service, items };
}

async function recomputePackagePrice(packageId) {
  const items = await all(
    `SELECT pi.quantity, s.price FROM service_package_items pi
       JOIN services s ON s.id = pi.component_service_id WHERE pi.package_service_id=?`, packageId);
  const price = round(items.reduce((sum, i) => sum + Number(i.price) * Number(i.quantity), 0));
  await update('services', packageId, { price, is_package: items.length ? 1 : 0, updated_at: now() });
}

// Ціна компонента змінилась (руками або тим самим рекалком) — перерахувати
// всі пакети, куди він вкладений, так само, як зміна ставки перераховує
// собівартість послуг, де вона використана.
export async function recomputePackagesUsingComponent(componentId) {
  const packages = await all(
    'SELECT DISTINCT package_service_id AS id FROM service_package_items WHERE component_service_id=?', componentId);
  for (const p of packages) await recomputePackagePrice(p.id);
}

export async function addPackageItem(packageId, componentId, quantity) {
  if (componentId === packageId) throw Object.assign(new Error('Послуга не може входити сама в себе'), { status: 400 });
  const component = await get('SELECT * FROM services WHERE id=?', componentId);
  if (!component) throw Object.assign(new Error('Послугу-компонент не знайдено'), { status: 400 });
  if (component.is_package) throw Object.assign(new Error('Пакет не можна вкладати в інший пакет'), { status: 400 });
  if (await get('SELECT id FROM service_package_items WHERE package_service_id=? AND component_service_id=?', packageId, componentId)) {
    throw Object.assign(new Error('Ця послуга вже в пакеті — зміните кількість замість повторного додавання'), { status: 400 });
  }
  const qty = Number(quantity || 1);
  if (!(qty > 0)) throw Object.assign(new Error('Кількість має бути більшою за нуль'), { status: 400 });
  await insert('service_package_items', { package_service_id: packageId, component_service_id: componentId, quantity: qty });
  await recomputePackagePrice(packageId);
  return packageCard(packageId);
}

export async function updatePackageItem(packageId, itemId, quantity) {
  const qty = Number(quantity || 0);
  if (!(qty > 0)) throw Object.assign(new Error('Кількість має бути більшою за нуль'), { status: 400 });
  await run('UPDATE service_package_items SET quantity=? WHERE id=? AND package_service_id=?', qty, itemId, packageId);
  await recomputePackagePrice(packageId);
  return packageCard(packageId);
}

export async function removePackageItem(packageId, itemId) {
  await run('DELETE FROM service_package_items WHERE id=? AND package_service_id=?', itemId, packageId);
  await recomputePackagePrice(packageId);
  return packageCard(packageId);
}
