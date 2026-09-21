// Списки пошуку: додавання лідів із фіксацією джерела, логування тачів,
// дедуплікація, захист від подвійного дотику й черга на сьогодні.
import { all, get, run, insert, update, audit } from './db.js';
import { notify } from './telegram.js';
import { checkChannelLimit } from './kpi.js';
import { ensureClientFromLead } from './clients.js';
import { hasGeminiKeys, geminiText } from './ai.js';

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 19).replace('T', ' ');

export const DEFAULT_STATUSES = [
  ['new', '🆕 Новий', '#8d95ab', 10], ['checking', '🔍 На перевірці', '#ffb020', 20],
  ['qualified', '✅ Кваліфікований', '#6c8cff', 30], ['disqualified', '❌ Не підходить', '#ff6b6b', 40, 1],
  ['contacted', '📤 Написали', '#6c8cff', 50], ['followup', '🔁 Фолоу-ап', '#6c8cff', 60],
  ['seen', '👀 Прочитали', '#ffb020', 70], ['replied', '💬 Відповіли', '#38d39f', 80],
  ['meeting', '🤝 Зустріч', '#38d39f', 90], ['proposal', '📄 КП надіслано', '#38d39f', 100],
  ['negotiation', '🔥 Переговори', '#38d39f', 110], ['won', '🏆 Клієнт', '#38d39f', 120, 1, 1],
  ['lost', '🚫 Відмова', '#ff6b6b', 130, 1], ['snoozed', '😴 Не зараз', '#8d95ab', 140],
];

const DICTS = {
  source_channel: [
    ['google_maps', 'Google Maps'], ['instagram_search', 'Instagram пошук'], ['hashtag', 'Хештег'],
    ['catalog', 'Каталог'], ['competitor', 'Конкурент'], ['referral', 'Реферал'], ['inbound', 'Вхідний'],
    ['expo', 'Виставка'], ['job_board', 'Job-борд'], ['ad_library', 'Ad Library'], ['tiktok_search', 'TikTok пошук'],
  ],
  touch_channel: [
    ['instagram_dm', 'Instagram DM'], ['telegram', 'Telegram'], ['email', 'Email'], ['whatsapp', 'WhatsApp'],
    ['viber', 'Viber'], ['facebook', 'Facebook'], ['linkedin', 'LinkedIn'], ['call', 'Дзвінок'],
    ['site_form', 'Форма на сайті'], ['meeting', 'Особиста зустріч'],
  ],
  disqualify_reason: [
    ['no_site', 'Немає сайту й соцмереж'], ['closed', 'Закрились'], ['strong_content', 'Уже мають сильний контент'],
    ['wrong_geo', 'Не наше гео'], ['competitor', 'Конкурент'], ['too_small', 'Занадто малі'],
  ],
  lost_reason: [
    ['price', 'Дорого'], ['no_budget', 'Немає бюджету'], ['in_house', 'Роблять самі'],
    ['chose_other', 'Вибрали іншого'], ['no_answer', 'Немає відповіді'],
  ],
};

export async function seedProspecting() {
  if (!(await get('SELECT id FROM lead_statuses LIMIT 1'))) {
    for (const [code, name, color, order, terminal = 0, won = 0] of DEFAULT_STATUSES) {
      await insert('lead_statuses', { code, name, color, sort_order: order, is_terminal: terminal, is_won: won });
    }
  }
  if (!(await get('SELECT id FROM dictionaries LIMIT 1'))) {
    for (const [kind, items] of Object.entries(DICTS)) {
      for (const [i, [code, label]] of items.entries()) {
        await insert('dictionaries', { kind, code, label, sort_order: (i + 1) * 10 });
      }
    }
  }
}

// ── Дедуплікація ──────────────────────────────────────────────────────────
const norm = (v) => String(v || '').toLowerCase().trim();
const domainOf = (url) => norm(url).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
// «Кав'ярня Світанок» і «Svitanok Coffee» — прибираємо все, крім букв і цифр.
const nameKey = (v) => norm(v).replace(/[^a-zа-яіїєґ0-9]/gi, '');

export async function findDuplicates({ website, phone, email, company_name, geo_city, google_place_id, instagram }) {
  const hits = [];
  const add = (row, score, reason) => { if (row && !hits.some((h) => h.lead.id === row.id)) hits.push({ lead: row, score, reason }); };

  if (google_place_id) add(await get('SELECT * FROM leads WHERE google_place_id=?', google_place_id), 100, 'Google Place ID');
  if (website) {
    const d = domainOf(website);
    if (d) add(await get('SELECT * FROM leads WHERE lower(website) LIKE ?', `%${d}%`), 95, 'домен');
  }
  if (phone) add(await get('SELECT * FROM leads WHERE phone=?', phone), 90, 'телефон');
  if (email) add(await get('SELECT * FROM leads WHERE lower(email)=?', norm(email)), 90, 'email');
  if (instagram) {
    const row = await get(
      `SELECT l.* FROM leads l JOIN lead_socials s ON s.lead_id=l.id
        WHERE s.platform='instagram' AND lower(s.handle)=?`, norm(instagram).replace('@', ''));
    add(row, 95, 'Instagram-нік');
  }
  if (company_name) {
    const candidates = await all(
      `SELECT * FROM leads WHERE ${geo_city ? 'lower(geo_city)=? AND ' : ''}length(company_name) > 2`,
      ...(geo_city ? [norm(geo_city)] : []));
    const key = nameKey(company_name);
    for (const c of candidates) {
      if (!key) break;
      const other = nameKey(c.company_name);
      if (other && (other.includes(key) || key.includes(other))) add(c, 60, 'схожа назва в тому ж місті');
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

export async function isSuppressed({ website, email, phone, instagram, company_name }) {
  const checks = [
    ['domain', domainOf(website)], ['email', norm(email)], ['phone', norm(phone)],
    ['instagram', norm(instagram).replace('@', '')], ['company', norm(company_name)],
  ].filter(([, v]) => v);
  for (const [kind, value] of checks) {
    const hit = await get('SELECT * FROM suppression_list WHERE kind=? AND lower(value)=?', kind, value);
    if (hit) return hit;
  }
  return null;
}

// ── Створення ліда ────────────────────────────────────────────────────────
export async function createLead(user, payload, { force = false } = {}) {
  const { source = {}, socials = [], contacts = [], ...lead } = payload;
  if (!lead.company_name) throw Object.assign(new Error('Потрібна назва бізнесу'), { status: 400 });
  if (!source.channel) throw Object.assign(new Error('Вкажіть, де знайшли лід — без цього не порахувати джерела'), { status: 400 });

  const instagram = socials.find((s) => s.platform === 'instagram')?.handle;
  const blocked = await isSuppressed({ ...lead, instagram });
  if (blocked) throw Object.assign(new Error(`Лід у чорному списку: ${blocked.reason || blocked.kind}`), { status: 409 });

  const dupes = await findDuplicates({ ...lead, instagram });
  if (dupes.length && !force) {
    const d = dupes[0];
    throw Object.assign(new Error(`Схоже на дубль (${d.reason}): «${d.lead.company_name}» — ${d.lead.status_code}, власник #${d.lead.owner_user_id ?? '—'}`),
      { status: 409, duplicate: { id: d.lead.id, reason: d.reason, score: d.score } });
  }

  const id = await insert('leads', {
    list_id: lead.list_id ?? null,
    board_order: await topOfColumn(lead.status_code || 'new'),
    company_name: lead.company_name,
    website: lead.website ?? null,
    geo_country: lead.geo_country ?? null,
    geo_city: lead.geo_city ?? null,
    address: lead.address ?? null,
    vertical: lead.vertical ?? null,
    size_metric: lead.size_metric ?? null,
    language: lead.language ?? null,
    status_code: lead.status_code || 'new',
    priority: lead.priority || 'warm',
    score: Number(lead.score || 0),
    expected_amount: lead.expected_amount === '' || lead.expected_amount == null ? null : Number(lead.expected_amount),
    owner_user_id: lead.owner_user_id ?? user.id,
    team_id: user.team_id ?? null,
    google_place_id: lead.google_place_id ?? null,
    phone: lead.phone ?? null,
    email: lead.email ?? null,
    tags: lead.tags ?? null,
    note: lead.note ?? null,
    created_by: user.id,
  });

  await insert('lead_sources', {
    lead_id: id, channel: source.channel, query: source.query ?? null, url: source.url ?? null,
    method: source.method || 'manual', signals: source.signals ? JSON.stringify(source.signals) : null,
    found_by: user.id,
  });
  for (const s of socials) {
    if (!s.platform) continue;
    await insert('lead_socials', {
      lead_id: id, platform: s.platform, handle: String(s.handle || '').replace('@', '') || null,
      url: s.url ?? null, followers: s.followers ?? null, last_post_at: s.last_post_at ?? null,
      avg_views: s.avg_views ?? null, checked_at: now(),
    });
  }
  for (const c of contacts) {
    if (!c.kind || !c.value) continue;
    await insert('lead_contacts', { lead_id: id, kind: c.kind, value: c.value, person_name: c.person_name ?? null, position: c.position ?? null, is_primary: c.is_primary ? 1 : 0 });
  }
  await insert('lead_status_history', { lead_id: id, from_status: null, to_status: lead.status_code || 'new', user_id: user.id });
  if (dupes.length && force) {
    await insert('duplicates_queue', { lead_a_id: id, lead_b_id: dupes[0].lead.id, match_score: dupes[0].score, match_reason: dupes[0].reason });
  }
  return { id, duplicates: dupes.length };
}

// ── Статуси ───────────────────────────────────────────────────────────────
// Позиція нової картки вгорі колонки — так само, як раніше картка
// спливала нагору сама через сортування за updated_at.
async function topOfColumn(statusCode) {
  const top = await get('SELECT MIN(board_order) AS v FROM leads WHERE status_code=?', statusCode);
  return top?.v == null ? 0 : Number(top.v) - 1000;
}

export async function setStatus(user, leadId, statusCode, extra = {}) {
  const lead = await get('SELECT * FROM leads WHERE id=?', leadId);
  if (!lead) throw Object.assign(new Error('Лід не знайдено'), { status: 404 });
  const status = await get('SELECT * FROM lead_statuses WHERE code=? AND is_active=1', statusCode);
  if (!status) throw Object.assign(new Error('Невідомий статус'), { status: 400 });
  if (statusCode === 'disqualified' && !extra.disqualify_reason) {
    throw Object.assign(new Error('Вкажіть причину дискваліфікації — без неї не видно, чому шукали не те'), { status: 400 });
  }
  if (statusCode === 'lost' && !extra.lost_reason) {
    throw Object.assign(new Error('Вкажіть причину відмови'), { status: 400 });
  }

  const patch = { status_code: statusCode, updated_at: now() };
  // Канбан передає точну позицію (перетягнули між конкретні картки чи в
  // порожнє місце в кінці/на початку колонки) — довіряємо їй, це лише
  // порядок показу, а не дані, від яких щось залежить. Якщо позицію не
  // передали (звичайна зміна статусу без drag&drop), картка стає першою
  // в новій колонці — так само, як і раніше, коли зверху спливало
  // щойно оновлене.
  if (extra.board_order !== undefined && extra.board_order !== null && extra.board_order !== '') {
    const order = Number(extra.board_order);
    if (!Number.isFinite(order)) throw Object.assign(new Error('Некоректна позиція картки'), { status: 400 });
    patch.board_order = order;
  } else if (statusCode !== lead.status_code) {
    patch.board_order = await topOfColumn(statusCode);
  }
  if (extra.disqualify_reason) patch.disqualify_reason = extra.disqualify_reason;
  if (extra.lost_reason) patch.lost_reason = extra.lost_reason;
  if (statusCode === 'qualified' && !lead.qualified_at) patch.qualified_at = now();
  if (statusCode === 'snoozed') {
    patch.snooze_until = extra.snooze_until || inDays(30);
    patch.next_contact_at = patch.snooze_until;
  }
  if (extra.next_contact_at) patch.next_contact_at = extra.next_contact_at;
  if (status.is_terminal) patch.next_contact_at = null;

  await update('leads', leadId, patch);
  await insert('lead_status_history', { lead_id: leadId, from_status: lead.status_code, to_status: statusCode, user_id: user.id, note: extra.note ?? null });

  // Лід виграно → клієнт заводиться сам, щоб команда не робила це руками.
  let clientId = null;
  if (status.is_won) {
    clientId = await ensureClientFromLead({ ...lead, ...patch }, user.id);
    await notify('client', `🏆 Новий клієнт: «${lead.company_name}»`, lead.owner_user_id);
  }
  return { ok: true, status: statusCode, client_id: clientId };
}

// ── Тачі ──────────────────────────────────────────────────────────────────
const TOUCH_GUARD_DAYS = Number(process.env.CRM_TOUCH_GUARD_DAYS || 3);
const FOLLOWUP_DAYS = Number(process.env.CRM_FOLLOWUP_DAYS || 3);

export async function logTouch(user, leadId, payload, { force = false } = {}) {
  const lead = await get('SELECT * FROM leads WHERE id=?', leadId);
  if (!lead) throw Object.assign(new Error('Лід не знайдено'), { status: 404 });
  if (!payload.channel) throw Object.assign(new Error('Вкажіть канал'), { status: 400 });
  if (payload.direction !== 'in' && !String(payload.message_text || '').trim()) {
    throw Object.assign(new Error('Тач без тексту повідомлення не зараховується'), { status: 400 });
  }

  // Захист від подвійного дотику: інший менеджер міг написати вчора.
  if (payload.direction !== 'in' && !force) {
    const recent = await get(
      `SELECT t.*, u.name AS user_name FROM touches t LEFT JOIN users u ON u.id=t.user_id
        WHERE t.lead_id=? AND t.direction='out' AND t.sent_at >= datetime('now','-${TOUCH_GUARD_DAYS} days')
        ORDER BY t.sent_at DESC LIMIT 1`, leadId);
    if (recent) {
      throw Object.assign(
        new Error(`${recent.user_name || 'Хтось'} уже писав ${String(recent.sent_at).slice(0, 16)} (${recent.channel}). Писати ще раз?`),
        { status: 409, needForce: true },
      );
    }
  }

  // Ліміт ріже платформа, а не менеджер: попереджаємо до відправки.
  if (payload.direction !== 'in' && !force) {
    const limit = await checkChannelLimit(payload.from_account, payload.channel);
    if (!limit.ok) throw Object.assign(new Error(limit.message), { status: 429, needForce: true });
  }

  const prev = Number((await get(
    `SELECT COUNT(*) AS c FROM touches WHERE lead_id=? AND direction='out'`, leadId))?.c || 0);
  const touchNumber = payload.direction === 'in' ? prev : prev + 1;

  const id = await insert('touches', {
    lead_id: leadId,
    contact_id: payload.contact_id ?? null,
    channel: payload.channel,
    direction: payload.direction || 'out',
    from_account: payload.from_account ?? null,
    template_id: payload.template_id ?? null,
    script_id: payload.script_id ?? null,
    message_text: payload.message_text ?? null,
    attachments: payload.attachments ? JSON.stringify(payload.attachments) : null,
    delivery_status: payload.delivery_status || 'sent',
    outcome: payload.outcome ?? null,
    touch_number: touchNumber,
    sent_at: payload.sent_at || now(),
    user_id: user.id,
  });

  // Статус і черга рухаються самі: менеджер не має ще й це клікати.
  const patch = { updated_at: now() };
  if (payload.direction === 'in') {
    patch.replied_at = now();
    patch.next_contact_at = now();
    await setStatus(user, leadId, 'replied');
    await notify('lead', `💬 Відповідь від «${lead.company_name}» (${payload.channel})`, lead.owner_user_id);
  } else {
    patch.touches_count = prev + 1;
    patch.last_touch_at = now();
    if (!lead.first_touch_at) patch.first_touch_at = now();
    patch.next_contact_at = inDays(FOLLOWUP_DAYS);
    if (!['replied', 'meeting', 'proposal', 'negotiation', 'won', 'lost'].includes(lead.status_code)) {
      await setStatus(user, leadId, touchNumber > 1 ? 'followup' : 'contacted');
    }
    await insert('lead_tasks', {
      lead_id: leadId, title: `Фолоу-ап: ${lead.company_name}`, due_at: inDays(FOLLOWUP_DAYS),
      assignee_user_id: lead.owner_user_id ?? user.id,
    });
  }
  await update('leads', leadId, patch);
  await audit({ user_id: user.id, action: 'touch', entity: 'leads', entity_id: leadId, payload: { channel: payload.channel, number: touchNumber } });
  return { id, touch_number: touchNumber, next_contact_at: patch.next_contact_at };
}

// ── Картка ліда: усе, що потрібно менеджеру на одному екрані ──────────────
export async function leadCard(leadId) {
  const lead = await get('SELECT * FROM leads WHERE id=?', leadId);
  if (!lead) throw Object.assign(new Error('Лід не знайдено'), { status: 404 });
  const socials = await all('SELECT * FROM lead_socials WHERE lead_id=?', leadId);
  const withSilence = socials.map((s) => ({
    ...s,
    days_without_content: s.last_post_at
      ? Math.floor((Date.now() - new Date(String(s.last_post_at).replace(' ', 'T')).getTime()) / 864e5)
      : null,
  }));
  return {
    lead,
    socials: withSilence,
    sources: await all('SELECT * FROM lead_sources WHERE lead_id=? ORDER BY found_at', leadId),
    contacts: await all('SELECT * FROM lead_contacts WHERE lead_id=? ORDER BY is_primary DESC, id', leadId),
    touches: await all('SELECT * FROM touches WHERE lead_id=? ORDER BY sent_at DESC', leadId),
    notes: await all('SELECT * FROM lead_notes WHERE lead_id=? ORDER BY created_at DESC', leadId),
    tasks: await all(`SELECT * FROM lead_tasks WHERE lead_id=? ORDER BY due_at`, leadId),
    history: await all('SELECT * FROM lead_status_history WHERE lead_id=? ORDER BY created_at DESC', leadId),
  };
}

// ── Черга на сьогодні ─────────────────────────────────────────────────────
export async function todayQueue(user, { limit = 100 } = {}) {
  const overdue = await all(
    `SELECT l.*, s.name AS status_name FROM leads l
       LEFT JOIN lead_statuses s ON s.code=l.status_code
      WHERE l.owner_user_id=? AND l.next_contact_at IS NOT NULL
        AND datetime(l.next_contact_at) <= datetime('now')
        AND l.status_code NOT IN ('won','lost','disqualified')
      ORDER BY CASE l.priority WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END, l.next_contact_at
      LIMIT ?`, user.id, limit);
  const fresh = await all(
    `SELECT l.* FROM leads l
      WHERE l.owner_user_id=? AND l.first_touch_at IS NULL AND l.status_code IN ('qualified','new')
      ORDER BY l.score DESC, l.created_at LIMIT ?`, user.id, limit);
  const replies = await all(
    `SELECT l.*, t.channel, t.sent_at FROM leads l
       JOIN touches t ON t.lead_id=l.id AND t.direction='in'
      WHERE l.owner_user_id=? AND l.status_code='replied'
      ORDER BY t.sent_at DESC LIMIT 50`, user.id);
  return { overdue, fresh, replies };
}

// ── Аналітика списків ─────────────────────────────────────────────────────
export async function funnel(user, { list_id = null } = {}) {
  const where = list_id ? 'WHERE l.list_id = ?' : '';
  const params = list_id ? [Number(list_id)] : [];

  const byStatus = await all(
    `SELECT l.status_code, COUNT(*) AS count FROM leads l ${where} GROUP BY l.status_code`, ...params);
  const bySource = await all(
    `SELECT s.channel,
            COUNT(DISTINCT l.id) AS leads,
            SUM(CASE WHEN l.qualified_at IS NOT NULL THEN 1 ELSE 0 END) AS qualified,
            SUM(CASE WHEN l.first_touch_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
            SUM(CASE WHEN l.replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
            SUM(CASE WHEN l.status_code='meeting' THEN 1 ELSE 0 END) AS meetings,
            SUM(CASE WHEN l.status_code='won' THEN 1 ELSE 0 END) AS won
       FROM lead_sources s JOIN leads l ON l.id=s.lead_id ${where}
      GROUP BY s.channel ORDER BY leads DESC`, ...params);
  const byChannel = await all(
    `SELECT t.channel, COUNT(*) AS touches,
            SUM(CASE WHEN t.direction='in' THEN 1 ELSE 0 END) AS replies
       FROM touches t JOIN leads l ON l.id=t.lead_id ${where}
      GROUP BY t.channel ORDER BY touches DESC`, ...params);
  // Скільки відповідей дає кожен наступний фолоу-ап — найдешевший спосіб
  // побачити, що команда здається зарано.
  const byTouchNumber = await all(
    `SELECT t.touch_number,
            COUNT(*) AS touches,
            SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM touches r WHERE r.lead_id=t.lead_id AND r.direction='in'
                    AND r.sent_at > t.sent_at
                ) THEN 1 ELSE 0 END) AS led_to_reply
       FROM touches t JOIN leads l ON l.id=t.lead_id
      WHERE t.direction='out' ${list_id ? 'AND l.list_id = ?' : ''}
      GROUP BY t.touch_number ORDER BY t.touch_number`, ...params);
  const disqualified = await all(
    `SELECT l.disqualify_reason AS reason, COUNT(*) AS count FROM leads l
      WHERE l.disqualify_reason IS NOT NULL ${list_id ? 'AND l.list_id = ?' : ''}
      GROUP BY l.disqualify_reason ORDER BY count DESC`, ...params);
  const speed = await get(
    `SELECT AVG(CAST((julianday(l.first_touch_at) - julianday(l.created_at)) AS NUMERIC)) AS days_to_first_touch
       FROM leads l WHERE l.first_touch_at IS NOT NULL ${list_id ? 'AND l.list_id = ?' : ''}`, ...params);

  return { byStatus, bySource, byChannel, byTouchNumber, disqualified, speed };
}

const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

// Канбан воронки: колонки — активні статуси лідів у своєму порядку,
// у кожній — ліди в скоупі користувача (той самий scopeWhere, що й
// генерик-список), сума очікуваних сум і кількість.
export async function kanban(scopeSql, scopeParams) {
  const statuses = await all('SELECT * FROM lead_statuses WHERE is_active=1 ORDER BY sort_order');
  // board_order — ручна позиція картки в колонці (перетягування задає її
  // явно); id як тайбрейкер, бо однакове значення трапляється в старих
  // записах, засіяних однією міграцією одним і тим самим кроком.
  const leads = await all(
    `SELECT l.id, l.company_name, l.status_code, l.expected_amount, l.priority, l.owner_user_id,
            l.geo_city, l.vertical, l.board_order, u.name AS owner_name
       FROM leads l LEFT JOIN users u ON u.id=l.owner_user_id
      WHERE ${scopeSql} ORDER BY l.board_order ASC, l.id ASC`, ...scopeParams);

  const byStatus = new Map(statuses.map((s) => [s.code, []]));
  for (const lead of leads) byStatus.get(lead.status_code)?.push(lead);

  return {
    columns: statuses.map((s) => {
      const rows = byStatus.get(s.code) || [];
      return {
        code: s.code, name: s.name, color: s.color, is_won: !!s.is_won, is_terminal: !!s.is_terminal,
        count: rows.length,
        sum: round2(rows.reduce((sum, r) => sum + Number(r.expected_amount || 0), 0)),
        leads: rows,
      };
    }),
  };
}

// «Особи» списку пошуку: контакти зведено по людині (лід + person_name),
// email/телефон розкладені по своїх колонках — щоб показати список
// контактів так само, як людину показують у CRM-каталогах, а не рядок на
// кожен канал зв'язку.
export async function listContacts(listId, scopeSql, scopeParams) {
  return all(
    `SELECT l.id AS lead_id, l.company_name, l.tags,
            COALESCE(lc.person_name, l.company_name) AS name,
            MAX(CASE WHEN lc.kind='email' THEN lc.value END) AS email,
            MAX(CASE WHEN lc.kind='phone' THEN lc.value END) AS phone,
            MAX(lc.position) AS position
       FROM lead_contacts lc JOIN leads l ON l.id = lc.lead_id
      WHERE l.list_id = ? AND ${scopeSql}
      GROUP BY l.id, COALESCE(lc.person_name, l.company_name)
      ORDER BY name`, listId, ...scopeParams);
}

// Google AI Studio видає GEMINI_API_KEY безкоштовно (з лімітами на
// кількість запитів) — тому саме він у пріоритеті, ANTHROPIC_API_KEY
// лишається як платна альтернатива, якщо вона вже є. Сам клієнт до Gemini
// (з ротацією кількох ключів) спільний з AI-чатом — див. ai.js.
async function callAnthropic(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`AI-пошук: помилка Anthropic API (${res.status}): ${text.slice(0, 300)}`), { status: 502 });
  }
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

// AI-пошук: ШІ не має живого доступу в інтернет чи до бази бізнесів, тому
// це не «знайти реальний бізнес», а «запропонувати гіпотези кандидатів»
// під нішу/гео/джерело — людина перевіряє й обирає, кого справді додати
// лідом (createLead викликає сама сторінка, тут лише список кандидатів).
export async function aiSearchCandidates({ channel, niche, geo, count, notes }) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!hasGeminiKeys() && !anthropicKey) {
    throw Object.assign(new Error(
      'AI-пошук не налаштовано: додайте змінну середовища GEMINI_API_KEY (безкоштовний ключ із Google AI Studio) або ANTHROPIC_API_KEY сервісу crm на Railway'), { status: 400 });
  }
  const n = Math.min(Math.max(Number(count) || 10, 1), 20);
  const channelLabel = (await get(`SELECT label FROM dictionaries WHERE kind='source_channel' AND code=?`, channel))?.label || channel || 'будь-яке';

  const prompt = `Ти допомагаєш менеджеру з продажу агентства контент-маркетингу підібрати гіпотези потенційних клієнтів (лідів) для ручної перевірки.
Джерело пошуку: ${channelLabel}
Ніша/сфера діяльності: ${niche || 'будь-яка'}
Гео: ${geo || 'не вказано'}
Додаткові критерії: ${notes || 'немає'}

У тебе немає живого доступу до інтернету чи актуальної бази бізнесів, тому НЕ видавай вигадані назви за перевірені реальні факти. Запропонуй ${n} правдоподібних прикладів-гіпотез бізнесу під ці критерії, чесно позначивши в полі reason кожного, що це орієнтовний приклад типу бізнесу, який вимагає ручної перевірки, а не підтверджений факт.

Поверни СУВОРО валідний JSON-масив без жодного тексту навколо, формат кожного елемента: {"company_name": "...", "geo_city": "...", "reason": "..."}`;

  const raw = hasGeminiKeys() ? await geminiText(prompt) : await callAnthropic(anthropicKey, prompt);
  let candidates;
  try {
    candidates = JSON.parse(raw);
  } catch {
    const match = raw.match(/\[[\s\S]*\]/);
    candidates = match ? JSON.parse(match[0]) : [];
  }
  if (!Array.isArray(candidates)) candidates = [];
  return candidates.slice(0, n).filter((c) => c && c.company_name);
}

// Фонове: розморозка «не зараз» і підсвічування застою.
export async function prospectingChecks() {
  const woken = await run(
    `UPDATE leads SET status_code='qualified', snooze_until=NULL
      WHERE status_code='snoozed' AND snooze_until IS NOT NULL AND datetime(snooze_until) <= datetime('now')`);
  const stale = await all(
    `SELECT id, company_name, owner_user_id FROM leads
      WHERE status_code IN ('contacted','followup') AND last_touch_at IS NOT NULL
        AND last_touch_at <= datetime('now','-14 days')`);
  for (const lead of stale) {
    await update('leads', lead.id, { next_contact_at: now() });
    await notify('lead', `⏰ «${lead.company_name}» без руху 14 днів — повернувся в чергу`, lead.owner_user_id);
  }
  return { woken: woken.changes, stale: stale.length };
}

// ── Масова вставка та злиття дублів ──────────────────────────────────────
// «Кинув 30 посилань стовпчиком» — типовий спосіб наповнення списку.
export async function bulkAdd(user, { text = '', list_id = null, source = {} }) {
  const lines = String(text).split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw Object.assign(new Error('Порожній список'), { status: 400 });
  if (!source.channel) throw Object.assign(new Error('Вкажіть канал джерела для всієї пачки'), { status: 400 });

  const created = [];
  const skipped = [];
  for (const line of lines.slice(0, 500)) {
    const isUrl = /^https?:\/\//i.test(line);
    const handle = line.startsWith('@') ? line.slice(1) : null;
    const igMatch = isUrl && /instagram\.com\/([^/?#]+)/i.exec(line);
    const ttMatch = isUrl && /tiktok\.com\/@([^/?#]+)/i.exec(line);
    const name = handle || igMatch?.[1] || ttMatch?.[1]
      || (isUrl ? line.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] : line);

    const socials = [];
    if (igMatch || handle) socials.push({ platform: 'instagram', handle: igMatch?.[1] || handle, url: isUrl ? line : null });
    if (ttMatch) socials.push({ platform: 'tiktok', handle: ttMatch[1], url: line });

    try {
      const res = await createLead(user, {
        company_name: name,
        website: isUrl && !igMatch && !ttMatch ? line : null,
        list_id,
        socials,
        source: { ...source, url: isUrl ? line : null, method: 'import' },
      });
      created.push({ line, id: res.id });
    } catch (e) {
      skipped.push({ line, reason: e.message });
    }
  }
  await audit({ user_id: user.id, action: 'leads_bulk_add', entity: 'leads', payload: { created: created.length, skipped: skipped.length } });
  return { created: created.length, skipped, ids: created.map((c) => c.id) };
}

// Злиття переносить історію, а не видаляє її: інакше зникає доказ, що
// ліду вже писали.
export async function resolveDuplicate(user, duplicateId, { action = 'merge' }) {
  const dup = await get('SELECT * FROM duplicates_queue WHERE id=?', duplicateId);
  if (!dup) throw Object.assign(new Error('Запис не знайдено'), { status: 404 });
  if (action === 'dismiss') {
    await update('duplicates_queue', duplicateId, { resolved: 1, resolved_by: user.id });
    return { ok: true, action: 'dismiss' };
  }
  const keep = Math.min(dup.lead_a_id, dup.lead_b_id);
  const drop = Math.max(dup.lead_a_id, dup.lead_b_id);
  for (const table of ['touches', 'lead_contacts', 'lead_socials', 'lead_sources', 'lead_notes', 'lead_tasks', 'lead_status_history']) {
    await run(`UPDATE ${table} SET lead_id=? WHERE lead_id=?`, keep, drop);
  }
  const counted = Number((await get(`SELECT COUNT(*) AS c FROM touches WHERE lead_id=? AND direction='out'`, keep))?.c || 0);
  await update('leads', keep, { touches_count: counted, updated_at: now() });
  await run('DELETE FROM leads WHERE id=?', drop);
  await update('duplicates_queue', duplicateId, { resolved: 1, resolved_by: user.id });
  await audit({ user_id: user.id, action: 'leads_merge', entity: 'leads', entity_id: keep, payload: { merged: drop } });
  return { ok: true, kept: keep, merged: drop };
}
