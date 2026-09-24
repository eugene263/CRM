// «Задачі»: незалежні від «Команд» простори (task_spaces) зі своїм
// довільним списком учасників (task_space_members) — кожен простір може
// мати кілька робочих дошок (task_boards), на дошці — свої створювані/
// редаговані/видалювані колонки (task_columns), у колонках — картки-задачі
// (task_cards) з описом/дедлайном/пріоритетом/тегами/виконавцем, трекером
// часу (task_time_entries), коментарями з файлами (task_comments +
// task_attachments) і повною історією дій (task_activity).
//
// Доступ гейтиться через generic can(user,'task_spaces',action) (сутність
// зареєстрована лише заради пункту меню й прав ролі — самі дані йдуть
// повз generic-CRUD), а ХТО САМЕ бачить конкретний простір — через
// членство в task_space_members: ролі зі скоупом 'all' (owner/head/
// analyst) бачать усі простори, решта — лише ті, куди їх додали.
import { all, get, run, insert } from './db.js';
import { scopeOf } from './rbac.js';
import { hasGeminiKeys, geminiText } from './ai.js';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

const canSeeAll = (user) => scopeOf(user, 'task_spaces') === 'all';

async function assertMember(user, spaceId) {
  if (canSeeAll(user)) return;
  const row = await get('SELECT id FROM task_space_members WHERE space_id=? AND user_id=?', spaceId, user.id);
  if (!row) throw Object.assign(new Error('Ви не учасник цього простору'), { status: 403 });
}

async function spaceIdOfBoard(boardId) {
  const row = await get('SELECT space_id FROM task_boards WHERE id=?', boardId);
  if (!row) throw Object.assign(new Error('Дошку не знайдено'), { status: 404 });
  return row.space_id;
}
async function boardIdOfColumn(columnId) {
  const row = await get('SELECT board_id FROM task_columns WHERE id=?', columnId);
  if (!row) throw Object.assign(new Error('Колонку не знайдено'), { status: 404 });
  return row.board_id;
}
async function cardRow(cardId) {
  const row = await get('SELECT id, board_id, column_id FROM task_cards WHERE id=?', cardId);
  if (!row) throw Object.assign(new Error('Картку не знайдено'), { status: 404 });
  return row;
}

function orderBetween(before, after) {
  if (before == null && after == null) return 1000;
  if (before == null) return after - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

async function logActivity(cardId, userId, kind, payload) {
  await insert('task_activity', { card_id: cardId, user_id: userId, kind, payload: payload ? JSON.stringify(payload) : null });
}

function requireName(value, label = 'назву') {
  const clean = String(value || '').trim();
  if (!clean) throw Object.assign(new Error(`Потрібна ${label}`), { status: 400 });
  return clean;
}

// ── Простори ────────────────────────────────────────────────────────────
export async function listSpaces(user) {
  const counts = `(SELECT COUNT(*) FROM task_space_members m2 WHERE m2.space_id=s.id) AS member_count,
    (SELECT COUNT(*) FROM task_boards b WHERE b.space_id=s.id) AS board_count`;
  if (canSeeAll(user)) return all(`SELECT s.*, ${counts} FROM task_spaces s ORDER BY s.created_at DESC`);
  return all(
    `SELECT s.*, ${counts} FROM task_spaces s
     JOIN task_space_members m ON m.space_id=s.id AND m.user_id=?
     ORDER BY s.created_at DESC`, user.id,
  );
}

// Для бокового меню сторінки «Задачі» (Space → Boards деревом) — усі
// простори користувача РАЗОМ з їхніми дошками (icon/card_count) в двох
// запитах, а не по одному на простір.
export async function listSpacesWithBoards(user) {
  const spaces = canSeeAll(user)
    ? await all('SELECT * FROM task_spaces ORDER BY created_at DESC')
    : await all(
      `SELECT s.* FROM task_spaces s JOIN task_space_members m ON m.space_id=s.id AND m.user_id=?
       ORDER BY s.created_at DESC`, user.id,
    );
  const spaceIds = spaces.map((s) => s.id);
  let boards = [];
  let members = [];
  if (spaceIds.length) {
    const placeholders = spaceIds.map(() => '?').join(',');
    boards = await all(
      `SELECT b.id, b.space_id, b.name, b.icon, b.sort_order,
              (SELECT COUNT(*) FROM task_cards c WHERE c.board_id=b.id) AS card_count
       FROM task_boards b WHERE b.space_id IN (${placeholders}) ORDER BY b.sort_order, b.id`,
      ...spaceIds,
    );
    members = await all(
      `SELECT m.space_id, m.user_id, u.name FROM task_space_members m JOIN users u ON u.id=m.user_id
       WHERE m.space_id IN (${placeholders}) ORDER BY u.name`,
      ...spaceIds,
    );
  }
  const byId = new Map(spaces.map((s) => [s.id, { ...s, boards: [], members: [] }]));
  for (const b of boards) byId.get(b.space_id)?.boards.push(b);
  for (const m of members) byId.get(m.space_id)?.members.push(m);
  return [...byId.values()];
}

export async function createSpace(user, name) {
  const clean = requireName(name);
  const id = await insert('task_spaces', { name: clean, created_by: user.id });
  await insert('task_space_members', { space_id: id, user_id: user.id });
  return { id };
}

export async function renameSpace(user, spaceId, patch) {
  await assertMember(user, spaceId);
  const data = {};
  if ('name' in patch) data.name = requireName(patch.name);
  if ('logo_data_url' in patch) data.logo_data_url = patch.logo_data_url || null;
  if (!Object.keys(data).length) return { ok: true };
  await run(`UPDATE task_spaces SET ${Object.keys(data).map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(data), spaceId);
  return { ok: true };
}

export async function deleteSpace(user, spaceId) {
  await assertMember(user, spaceId);
  const boards = await get('SELECT COUNT(*) AS c FROM task_boards WHERE space_id=?', spaceId);
  if (Number(boards?.c || 0) > 0) throw Object.assign(new Error('Спершу видаліть дошки в цьому просторі'), { status: 409 });
  await run('DELETE FROM task_spaces WHERE id=?', spaceId);
  return { ok: true };
}

export async function getSpace(user, spaceId) {
  await assertMember(user, spaceId);
  const space = await get('SELECT * FROM task_spaces WHERE id=?', spaceId);
  if (!space) throw Object.assign(new Error('Простір не знайдено'), { status: 404 });
  const members = await all(
    'SELECT m.user_id, u.name, u.email FROM task_space_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=? ORDER BY u.name',
    spaceId,
  );
  const boards = await all(
    `SELECT b.id, b.name, b.sort_order, (SELECT COUNT(*) FROM task_cards c WHERE c.board_id=b.id) AS card_count
     FROM task_boards b WHERE b.space_id=? ORDER BY b.sort_order, b.id`, spaceId,
  );
  return { space, members, boards };
}

// Дашборд простору — аналітика по ВСІХ картках усіх дошок цього простору
// разом (не по одній дошці): скільки задач без виконавця, розподіл по
// виконавцях і по пріоритету, і скільки прострочено (є дедлайн у минулому,
// картка не в колонці «Готово» — та сама назва-константа, що й де-інде
// орієнтується на назви колонок, а не на окремий статус-флаг).
export async function getSpaceAnalytics(user, spaceId) {
  await assertMember(user, spaceId);
  const today = new Date().toISOString().slice(0, 10);

  const total = await get(
    'SELECT COUNT(*) AS c FROM task_cards c JOIN task_boards b ON b.id=c.board_id WHERE b.space_id=?', spaceId,
  );
  const unassigned = await get(
    'SELECT COUNT(*) AS c FROM task_cards c JOIN task_boards b ON b.id=c.board_id WHERE b.space_id=? AND c.assignee_user_id IS NULL',
    spaceId,
  );
  // Фільтр за назвою колонки («не в Готово») — звіряємо в JS, а не через
  // SQL LOWER(): вбудований LOWER() у SQLite опрацьовує лише ASCII й
  // мовчки НЕ переводить кирилицю в нижній регістр (той самий підводний
  // камінь, що й у autoMoveOnStartDate вище).
  const overdueCandidates = await all(
    `SELECT col.name AS column_name FROM task_cards c
     JOIN task_boards b ON b.id=c.board_id JOIN task_columns col ON col.id=c.column_id
     WHERE b.space_id=? AND c.due_date IS NOT NULL AND c.due_date<>'' AND c.due_date<?`,
    spaceId, today,
  );
  const overdueCount = overdueCandidates.filter((r) => String(r.column_name || '').trim().toLowerCase() !== 'готово').length;
  const byAssignee = await all(
    `SELECT u.id AS user_id, u.name, COUNT(*) AS count
     FROM task_cards c JOIN task_boards b ON b.id=c.board_id JOIN users u ON u.id=c.assignee_user_id
     WHERE b.space_id=? GROUP BY u.id, u.name ORDER BY count DESC, u.name`,
    spaceId,
  );
  const priorityRows = await all(
    `SELECT COALESCE(NULLIF(c.priority,''), '') AS priority, COUNT(*) AS count
     FROM task_cards c JOIN task_boards b ON b.id=c.board_id WHERE b.space_id=? GROUP BY priority`,
    spaceId,
  );
  const byPriority = ['', 'low', 'medium', 'high', 'urgent'].map((value) => ({
    priority: value,
    count: Number(priorityRows.find((r) => r.priority === value)?.count || 0),
  }));

  return {
    total_tasks: Number(total?.c || 0),
    unassigned_tasks: Number(unassigned?.c || 0),
    overdue_tasks: overdueCount,
    by_assignee: byAssignee.map((r) => ({ user_id: r.user_id, name: r.name, count: Number(r.count) })),
    by_priority: byPriority,
  };
}

export async function addMember(user, spaceId, userId) {
  await assertMember(user, spaceId);
  const u = await get('SELECT id, name FROM users WHERE id=?', Number(userId));
  if (!u) throw Object.assign(new Error('Користувача не знайдено'), { status: 404 });
  const exists = await get('SELECT id FROM task_space_members WHERE space_id=? AND user_id=?', spaceId, u.id);
  if (!exists) await insert('task_space_members', { space_id: spaceId, user_id: u.id });
  return { ok: true };
}

export async function removeMember(user, spaceId, userId) {
  await assertMember(user, spaceId);
  await run('DELETE FROM task_space_members WHERE space_id=? AND user_id=?', spaceId, Number(userId));
  return { ok: true };
}

// ── Дошки ───────────────────────────────────────────────────────────────
export async function createBoard(user, spaceId, name) {
  await assertMember(user, spaceId);
  const clean = requireName(name);
  const maxOrder = await get('SELECT MAX(sort_order) AS m FROM task_boards WHERE space_id=?', spaceId);
  const id = await insert('task_boards', { space_id: spaceId, name: clean, sort_order: (maxOrder?.m ?? -1) + 1, created_by: user.id });
  // Дефолтні колонки, щоб дошка не була порожньою відразу — назви можна
  // одразу перейменувати чи видалити, це просто стартова точка.
  const defaults = [
    { name: 'До виконання', color: 'accent' }, { name: 'В роботі', color: 'yellow' }, { name: 'Готово', color: 'green' },
  ];
  for (let i = 0; i < defaults.length; i += 1) {
    await insert('task_columns', { board_id: id, name: defaults[i].name, color: defaults[i].color, sort_order: i, board_order: i * 1000 });
  }
  return { id };
}

export async function renameBoard(user, boardId, patch) {
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const data = {};
  if ('name' in patch) data.name = requireName(patch.name);
  if ('icon' in patch) data.icon = patch.icon || null;
  if ('estimate_norms' in patch) {
    const rows = Array.isArray(patch.estimate_norms) ? patch.estimate_norms : [];
    data.estimate_norms = JSON.stringify(rows
      .map((r) => ({ label: String(r.label || '').trim().slice(0, 200), hours: Number(r.hours) || 0 }))
      .filter((r) => r.label));
  }
  if (!Object.keys(data).length) return { ok: true };
  await run(`UPDATE task_boards SET ${Object.keys(data).map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(data), boardId);
  return { ok: true };
}

export async function deleteBoard(user, boardId) {
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const cols = await get('SELECT COUNT(*) AS c FROM task_columns WHERE board_id=?', boardId);
  if (Number(cols?.c || 0) > 0) throw Object.assign(new Error('Спершу видаліть колонки цієї дошки'), { status: 409 });
  await run('DELETE FROM task_boards WHERE id=?', boardId);
  return { ok: true };
}

export async function getBoard(user, boardId) {
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const board = await get('SELECT * FROM task_boards WHERE id=?', boardId);
  const space = await get('SELECT id, name FROM task_spaces WHERE id=?', spaceId);
  const members = await all(
    'SELECT m.user_id, u.name FROM task_space_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=? ORDER BY u.name',
    spaceId,
  );
  const columns = await all('SELECT * FROM task_columns WHERE board_id=? ORDER BY board_order, id', boardId);
  const cards = await all(
    `SELECT c.id, c.column_id, c.title, c.priority, c.due_date, c.start_date, c.assignee_user_id, c.board_order,
            c.estimate_minutes, u.name AS assignee_name
     FROM task_cards c LEFT JOIN users u ON u.id=c.assignee_user_id
     WHERE c.board_id=? ORDER BY c.board_order`, boardId,
  );
  const cardIds = cards.map((c) => c.id);
  const tagsByCard = new Map();
  const runningByCard = new Map();
  const totalByCard = new Map();
  if (cardIds.length) {
    const placeholders = cardIds.map(() => '?').join(',');
    const tagRows = await all(
      `SELECT ct.card_id, t.id, t.name, t.color FROM task_card_tags ct
       JOIN task_tags t ON t.id=ct.tag_id WHERE ct.card_id IN (${placeholders})`,
      ...cardIds,
    );
    for (const r of tagRows) {
      if (!tagsByCard.has(r.card_id)) tagsByCard.set(r.card_id, []);
      tagsByCard.get(r.card_id).push({ id: r.id, name: r.name, color: r.color });
    }
    // Активний таймер і накопичений час — прямо на плашці картки в
    // канбані, щоб «скільки вже минуло» було видно, не заходячи в картку.
    const runningRows = await all(
      `SELECT card_id, MIN(started_at) AS started_at FROM task_time_entries
       WHERE ended_at IS NULL AND card_id IN (${placeholders}) GROUP BY card_id`,
      ...cardIds,
    );
    for (const r of runningRows) runningByCard.set(r.card_id, r.started_at);
    const totalRows = await all(
      `SELECT card_id, SUM(seconds) AS total FROM task_time_entries WHERE card_id IN (${placeholders}) GROUP BY card_id`,
      ...cardIds,
    );
    for (const r of totalRows) totalByCard.set(r.card_id, Number(r.total) || 0);
  }
  const byColumn = new Map(columns.map((c) => [c.id, { ...c, cards: [] }]));
  for (const card of cards) {
    byColumn.get(card.column_id)?.cards.push({
      ...card, tags: tagsByCard.get(card.id) || [],
      timer_running_since: runningByCard.get(card.id) || null,
      total_seconds: totalByCard.get(card.id) || 0,
    });
  }
  const boardTags = await all('SELECT id, name, color FROM task_tags WHERE board_id=? ORDER BY name', boardId);
  return {
    space, members, boardTags, columns: [...byColumn.values()],
    board: { ...board, estimate_norms: board.estimate_norms ? JSON.parse(board.estimate_norms) : [] },
  };
}

// ── Теги (керовані записи на дошку: назва + колір) ─────────────────────
export async function listTags(user, boardId) {
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  return all('SELECT id, name, color FROM task_tags WHERE board_id=? ORDER BY name', boardId);
}

export async function createTag(user, boardId, name, color) {
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const clean = requireName(name, 'назву тегу');
  const id = await insert('task_tags', { board_id: boardId, name: clean, color: color || 'accent' });
  return { id };
}

export async function updateTag(user, tagId, { name, color }) {
  const tag = await get('SELECT * FROM task_tags WHERE id=?', tagId);
  if (!tag) throw Object.assign(new Error('Тег не знайдено'), { status: 404 });
  const spaceId = await spaceIdOfBoard(tag.board_id);
  await assertMember(user, spaceId);
  const data = {};
  if (name != null) data.name = requireName(name, 'назву тегу');
  if (color != null) data.color = color;
  if (Object.keys(data).length) {
    await run(`UPDATE task_tags SET ${Object.keys(data).map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(data), tagId);
  }
  return { ok: true };
}

export async function deleteTag(user, tagId) {
  const tag = await get('SELECT * FROM task_tags WHERE id=?', tagId);
  if (!tag) throw Object.assign(new Error('Тег не знайдено'), { status: 404 });
  const spaceId = await spaceIdOfBoard(tag.board_id);
  await assertMember(user, spaceId);
  await run('DELETE FROM task_tags WHERE id=?', tagId); // task_card_tags має ON DELETE CASCADE
  return { ok: true };
}

export async function setCardTags(user, cardId, tagIds) {
  const { board_id: boardId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const ids = [...new Set((tagIds || []).map(Number).filter((n) => Number.isFinite(n)))];
  if (ids.length) {
    const valid = await all(`SELECT id FROM task_tags WHERE board_id=? AND id IN (${ids.map(() => '?').join(',')})`, boardId, ...ids);
    if (valid.length !== ids.length) throw Object.assign(new Error('Тег не належить цій дошці'), { status: 400 });
  }
  const before = (await all('SELECT tag_id FROM task_card_tags WHERE card_id=?', cardId)).map((r) => r.tag_id).sort();
  await run('DELETE FROM task_card_tags WHERE card_id=?', cardId);
  for (const tagId of ids) await run('INSERT INTO task_card_tags (card_id, tag_id) VALUES (?, ?)', cardId, tagId);
  const after = [...ids].sort();
  if (before.length !== after.length || before.some((v, i) => v !== after[i])) await logActivity(cardId, user.id, 'tags_changed', null);
  return { ok: true };
}

// ── Колонки ─────────────────────────────────────────────────────────────
const COLUMN_COLORS = new Set(['accent', 'yellow', 'pink', 'green', 'orange', 'purple']);

export async function createColumn(user, boardId, name, color) {
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const clean = requireName(name);
  const maxOrder = await get('SELECT MAX(board_order) AS m FROM task_columns WHERE board_id=?', boardId);
  const id = await insert('task_columns', {
    board_id: boardId, name: clean, color: COLUMN_COLORS.has(color) ? color : 'accent',
    board_order: (maxOrder?.m ?? 0) + 1000,
  });
  return { id };
}

// Єдина точка редагування колонки: назва/колір/згорнутість/позиція — усе
// частковими полями в одному тілі запиту, як і в updateCard.
export async function updateColumn(user, columnId, patch) {
  const boardId = await boardIdOfColumn(columnId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const data = {};
  if ('name' in patch) data.name = requireName(patch.name);
  if ('color' in patch) data.color = COLUMN_COLORS.has(patch.color) ? patch.color : 'accent';
  if ('collapsed' in patch) data.collapsed = patch.collapsed ? 1 : 0;
  if ('board_order' in patch) data.board_order = Number(patch.board_order) || 0;
  if (!Object.keys(data).length) return { ok: true };
  await run(`UPDATE task_columns SET ${Object.keys(data).map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(data), columnId);
  return { ok: true };
}

export async function deleteColumn(user, columnId) {
  const boardId = await boardIdOfColumn(columnId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const cards = await get('SELECT COUNT(*) AS c FROM task_cards WHERE column_id=?', columnId);
  if (Number(cards?.c || 0) > 0) throw Object.assign(new Error('Спершу перенесіть або видаліть картки з цієї колонки'), { status: 409 });
  await run('DELETE FROM task_columns WHERE id=?', columnId);
  return { ok: true };
}

// ── Картки ──────────────────────────────────────────────────────────────
// extra — необовʼязкові поля зі швидкого створення картки (як на
// референсі: заголовок + одразу виконавець/дати/пріоритет/теги, без
// відкриття повної картки). Записуються одним INSERT, без пообіцяної
// field_changed-активності на кожне поле — «створено» й так усе каже.
export async function createCard(user, boardId, columnId, title, extra = {}) {
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const col = await get('SELECT id FROM task_columns WHERE id=? AND board_id=?', columnId, boardId);
  if (!col) throw Object.assign(new Error('Колонка не належить цій дошці'), { status: 400 });
  const clean = requireName(title, 'назву картки');
  const maxOrder = await get('SELECT MAX(board_order) AS m FROM task_cards WHERE column_id=?', columnId);
  const row = { board_id: boardId, column_id: columnId, title: clean, board_order: (maxOrder?.m ?? 0) + 1000, created_by: user.id };
  if (extra.assignee_user_id) row.assignee_user_id = Number(extra.assignee_user_id);
  if (extra.due_date) row.due_date = extra.due_date;
  if (extra.start_date) row.start_date = extra.start_date;
  if (extra.priority) row.priority = extra.priority;
  const id = await insert('task_cards', row);
  await logActivity(id, user.id, 'created', null);
  if (Array.isArray(extra.tag_ids) && extra.tag_ids.length) await setCardTags(user, id, extra.tag_ids);
  return { id };
}

export async function getCard(user, cardId) {
  const { board_id: boardId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const board = await get('SELECT id, name FROM task_boards WHERE id=?', boardId);
  const space = await get('SELECT id, name FROM task_spaces WHERE id=?', spaceId);
  const card = await get(
    `SELECT c.*, u.name AS assignee_name, cu.name AS creator_name, col.name AS column_name
     FROM task_cards c
     LEFT JOIN users u ON u.id=c.assignee_user_id
     LEFT JOIN users cu ON cu.id=c.created_by
     LEFT JOIN task_columns col ON col.id=c.column_id
     WHERE c.id=?`, cardId,
  );
  const columns = await all('SELECT id, name, color FROM task_columns WHERE board_id=? ORDER BY board_order, id', boardId);
  const members = await all(
    'SELECT m.user_id, u.name FROM task_space_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=? ORDER BY u.name',
    spaceId,
  );
  const attachments = await all(
    'SELECT id, comment_id, file_name, mime, uploaded_by, created_at FROM task_attachments WHERE card_id=? ORDER BY created_at, id', cardId,
  );
  const comments = await all(
    `SELECT cm.id, cm.user_id, u.name AS user_name, cm.body, cm.pinned, cm.created_at
     FROM task_comments cm LEFT JOIN users u ON u.id=cm.user_id WHERE cm.card_id=? ORDER BY cm.created_at, cm.id`, cardId,
  );
  const timeEntries = await all(
    `SELECT te.id, te.user_id, u.name AS user_name, te.started_at, te.ended_at, te.seconds
     FROM task_time_entries te LEFT JOIN users u ON u.id=te.user_id WHERE te.card_id=? ORDER BY te.started_at, te.id`, cardId,
  );
  // created_at має точність до секунди (datetime('now')) — дві дії в тому
  // самому запиті (наприклад «створено» одразу за «переміщено») можуть
  // отримати ОДНАКОВИЙ timestamp, і SQLite/Postgres по-різному розбивають
  // нічию без явного тай-брейкера. id росте строго з порядком вставки,
  // тому він — надійніший другий ключ сортування, ніж сама мітка часу.
  const activity = await all(
    `SELECT a.id, a.user_id, u.name AS user_name, a.kind, a.payload, a.created_at
     FROM task_activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.card_id=? ORDER BY a.created_at, a.id`, cardId,
  );
  const running = await get(
    'SELECT id, started_at FROM task_time_entries WHERE card_id=? AND user_id=? AND ended_at IS NULL', cardId, user.id,
  );
  const cardTags = await all(
    `SELECT t.id, t.name, t.color FROM task_card_tags ct JOIN task_tags t ON t.id=ct.tag_id WHERE ct.card_id=? ORDER BY t.name`, cardId,
  );
  const boardTags = await all('SELECT id, name, color FROM task_tags WHERE board_id=? ORDER BY name', boardId);
  const byComment = new Map();
  const cardAttachments = [];
  for (const a of attachments) {
    if (a.comment_id) { if (!byComment.has(a.comment_id)) byComment.set(a.comment_id, []); byComment.get(a.comment_id).push(a); }
    else cardAttachments.push(a);
  }
  return {
    card: { ...card, description_blocks: card.description_blocks ? JSON.parse(card.description_blocks) : null },
    space, board, columns, members, attachments: cardAttachments,
    tags: cardTags, boardTags,
    comments: comments.map((c) => ({ ...c, attachments: byComment.get(c.id) || [] })),
    timeEntries, activity, runningTimer: running || null,
    totalSeconds: timeEntries.reduce((s, t) => s + (t.seconds || 0), 0),
  };
}

const CARD_FIELDS = ['title', 'description', 'start_date', 'due_date', 'priority', 'assignee_user_id', 'estimate_minutes'];
const FIELD_LABELS = { title: 'назву', description: 'опис', start_date: 'дату початку', due_date: 'дедлайн', priority: 'пріоритет', estimate_minutes: 'оцінку часу' };

// Якщо задачі щойно поставили дату початку, а вона й досі лежить у
// колонці ДО «До виконання»/«В роботі»/«Готово» (тобто в якомусь
// «беклозі») — переносимо в «До виконання» самі, як і з авто-трекером
// часу: звірка за НАЗВОЮ колонки, мовчки нічого не робить, якщо такої
// колонки на дошці нема або колонку перейменували.
const ACTIVE_COLUMN_NAMES = new Set(['до виконання', 'в роботі', 'готово']);
async function autoMoveOnStartDate(cardId, boardId, currentColumnId, userId) {
  const current = await get('SELECT name FROM task_columns WHERE id=?', currentColumnId);
  if (current && ACTIVE_COLUMN_NAMES.has(String(current.name || '').trim().toLowerCase())) return;
  // Порівнюємо в JS, а не через SQL LOWER() — та вбудована в SQLite
  // LOWER() опрацьовує лише ASCII й мовчки НЕ переводить кирилицю в
  // нижній регістр, тож 'До виконання' ніколи не збігся б із власним же
  // рядком-літералом у запиті (спіймано власним тестом).
  const columns = await all('SELECT id, name FROM task_columns WHERE board_id=?', boardId);
  const todo = columns.find((c) => String(c.name || '').trim().toLowerCase() === 'до виконання');
  if (!todo || todo.id === currentColumnId) return;
  const maxOrder = await get('SELECT MAX(board_order) AS m FROM task_cards WHERE column_id=?', todo.id);
  await run('UPDATE task_cards SET column_id=?, board_order=? WHERE id=?', todo.id, (maxOrder?.m ?? 0) + 1000, cardId);
  await logActivity(cardId, userId, 'moved', { from: current?.name || '—', to: todo.name, auto: true });
}

export async function updateCard(user, cardId, patch) {
  const { board_id: boardId, column_id: columnId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const current = await get('SELECT * FROM task_cards WHERE id=?', cardId);
  const data = {};
  for (const f of CARD_FIELDS) {
    if (!(f in patch)) continue;
    let v = patch[f];
    if (f === 'assignee_user_id') v = v ? Number(v) : null;
    if (f === 'estimate_minutes') v = v ? Number(v) : null;
    if (f === 'title') v = requireName(v, 'назву картки');
    if (v === current[f] || (v ?? null) === (current[f] ?? null)) continue;
    data[f] = v;
    if (f === 'assignee_user_id') {
      const name = v ? (await get('SELECT name FROM users WHERE id=?', v))?.name : null;
      await logActivity(cardId, user.id, 'assigned', { to: name || 'нікого' });
    } else {
      await logActivity(cardId, user.id, 'field_changed', { field: FIELD_LABELS[f] || f, from: current[f], to: v });
    }
  }
  // Блоки опису (Notion-подібний редактор) — окремий випадок: значення це
  // масив блоків, а не скаляр, і показувати «до/після» цілим JSON-блобом
  // в Activity нема сенсу — досить короткого запису факту зміни.
  if ('description_blocks' in patch) {
    const json = JSON.stringify(patch.description_blocks || []);
    if (json !== (current.description_blocks || '[]')) {
      data.description_blocks = json;
      await logActivity(cardId, user.id, 'description_changed', null);
    }
  }
  if (!Object.keys(data).length) return { ok: true };
  data.updated_at = new Date().toISOString();
  await run(`UPDATE task_cards SET ${Object.keys(data).map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(data), cardId);
  if ('start_date' in data && !current.start_date && data.start_date) {
    await autoMoveOnStartDate(cardId, boardId, columnId, user.id);
  }
  return { ok: true };
}

// AI-генерація опису задачі з її назви (+ необов'язкові уточнення від
// автора й рівень деталізації) — той самий Gemini-клієнт з ротацією
// ключів, що й AI-чат (ai.js), з ANTHROPIC_API_KEY як платним резервом,
// коли Gemini не налаштовано (той самий підхід, що й aiSearchCandidates
// у prospecting.js). Повертає ЛИШЕ текст — блоками опису його розкладає
// вже фронтенд (переносить рядки в окремі paragraph-блоки).
async function callAnthropicPlain(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`AI: помилка Anthropic API (${res.status}): ${text.slice(0, 300)}`), { status: 502 });
  }
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

const AI_DESC_DETAIL = {
  brief: 'Дуже коротко: 1-2 речення, тільки суть без деталей.',
  standard: 'Стандартно: короткий вступ на 1-2 речення й 2-4 пункти головних кроків або вимог.',
  detailed: 'Детально: розгорнутий опис, чіткі кроки виконання, критерії готовності (definition of done), можливі нюанси й ризики.',
};

export async function generateCardDescription(user, cardId, { notes, detail, existing } = {}) {
  const { board_id: boardId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const card = await get('SELECT title FROM task_cards WHERE id=?', cardId);
  const detailKey = AI_DESC_DETAIL[detail] ? detail : 'standard';
  // existing — режим «Уточнити опис»: користувач вже має написаний/
  // згенерований опис і просить його ДОПОВНИТИ чи ПЕРЕРОБИТИ, а не
  // почати з чистого аркуша — тому в промпт іде поточний текст як контекст,
  // і результат повністю ЗАМІНЮЄ його (фронтенд це й робить).
  const prompt = existing
    ? [
      'Ти — помічник, що уточнює й доповнює опис задачі в робочому таск-трекері, українською мовою, без markdown-розмітки (без зірочок, без заголовків на кшталт «Опис:»).',
      `Назва задачі: "${card.title}"`,
      `Поточний опис:\n"""\n${String(existing).slice(0, 3000)}\n"""`,
      `Уточнення від автора, що змінити чи додати: ${String(notes || '').slice(0, 1000)}`,
      'Виведи ЛИШЕ новий повний текст опису (він повністю замінить старий) — готовий вставити прямо в поле опису задачі.',
    ].join('\n')
    : [
      'Ти — помічник, що пише короткі ділові описи задач для команди в робочому таск-трекері, українською мовою, без зайвої води й без markdown-розмітки (без зірочок, без заголовків на кшталт «Опис:»).',
      `Назва задачі: "${card.title}"`,
      notes ? `Додаткові побажання автора: ${String(notes).slice(0, 1000)}` : null,
      AI_DESC_DETAIL[detailKey],
      'Виведи ЛИШЕ готовий текст опису — його вставлять прямо в поле опису задачі.',
    ].filter(Boolean).join('\n');

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!hasGeminiKeys() && !anthropicKey) {
    throw Object.assign(new Error('AI-генерація не налаштована: додайте GEMINI_API_KEY(S) або ANTHROPIC_API_KEY'), { status: 400 });
  }
  const text = hasGeminiKeys() ? await geminiText(prompt) : await callAnthropicPlain(anthropicKey, prompt);
  return { text: text.trim() };
}

// AI-оцінка часу (estimate) — читає ФАКТИЧНИЙ опис задачі (обсяг тексту
// сам по собі вже відображає рівень деталізації, обраний при генерації
// опису — коротко/стандартно/детально, — тож окремо його передавати не
// треба) плюс «норму estimate» дошки (список орієнтирів у годинах на
// типові задачі), і повертає ОДНЕ число годин. Без опису — відмова з
// чіткою причиною (перевіряється і на фронтенді, щоб не бити дарма API,
// але й тут теж — про всяк випадок прямого виклику).
export async function estimateCardAi(user, cardId, { description } = {}) {
  const { board_id: boardId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const desc = String(description || '').trim();
  if (!desc) throw Object.assign(new Error('Спочатку додайте опис задачі — AI оцінює час саме за його обсягом і змістом'), { status: 400 });
  const card = await get('SELECT title FROM task_cards WHERE id=?', cardId);
  const board = await get('SELECT estimate_norms FROM task_boards WHERE id=?', boardId);
  const norms = board?.estimate_norms ? JSON.parse(board.estimate_norms) : [];
  const prompt = [
    'Ти — помічник, що оцінює, скільки ГОДИН типово йде на виконання задачі в робочому таск-трекері, на основі її опису.',
    `Назва задачі: "${card.title}"`,
    `Опис задачі:\n"""\n${desc.slice(0, 3000)}\n"""`,
    norms.length ? `Орієнтир команди (типові задачі й скільки годин на них зазвичай ставлять):\n${norms.map((n) => `- ${n.label}: ${n.hours} год`).join('\n')}` : null,
    'Врахуй реальний обсяг роботи, описаний у тексті (докладний опис — це, як правило, більший обсяг задачі).',
    'Навіть для найпростішої задачі став реалістичний МІНІМУМ робочого часу (типово не менше 0.25-0.5 години) — враховуй перемикання контексту й перевірку результату, а не лише «чисту» дію.',
    'Виведи У ВІДПОВІДІ ЛИШЕ ОДНЕ число годин (можна дробове, наприклад 2.5) — без жодного тексту навколо.',
  ].filter(Boolean).join('\n');

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!hasGeminiKeys() && !anthropicKey) {
    throw Object.assign(new Error('AI-оцінка не налаштована: додайте GEMINI_API_KEY(S) або ANTHROPIC_API_KEY'), { status: 400 });
  }
  const text = hasGeminiKeys() ? await geminiText(prompt) : await callAnthropicPlain(anthropicKey, prompt);
  const match = String(text).match(/\d+([.,]\d+)?/);
  if (!match) throw Object.assign(new Error('AI не зміг визначити оцінку часу — спробуйте ще раз'), { status: 502 });
  const hours = Math.max(0.25, Math.round(Number(match[0].replace(',', '.')) * 4) / 4);
  return { hours };
}

// Перетягнули картку саме в колонку «В роботі» — трекер часу того, хто
// тягнув, стартує сам; перетягнули в будь-яку іншу — власний запущений
// таймер сам зупиняється. Звірка по НАЗВІ колонки (без урахування
// регістру/пробілів): у task_columns нема окремого поля-«коду», колонки
// довільні й перейменовувані, тому це єдиний спосіб впізнати «робочу»
// колонку — перейменують її, і авто-трекінг для цієї дошки просто мовчки
// перестане спрацьовувати, без падінь.
const AUTO_TRACK_COLUMN_NAME = 'в роботі';

async function autoTrackOnMove(cardId, userId, columnName) {
  const isTracked = String(columnName || '').trim().toLowerCase() === AUTO_TRACK_COLUMN_NAME;
  const running = await get('SELECT * FROM task_time_entries WHERE card_id=? AND user_id=? AND ended_at IS NULL', cardId, userId);
  if (isTracked) {
    if (running) return; // вже й так іде — не плодимо другий запис
    const id = await insert('task_time_entries', { card_id: cardId, user_id: userId, started_at: new Date().toISOString() });
    await logActivity(cardId, userId, 'time_started', { auto: true, entry_id: id });
  } else if (running) {
    const endedAt = new Date();
    const seconds = Math.max(0, Math.round((endedAt.getTime() - new Date(running.started_at).getTime()) / 1000));
    await run('UPDATE task_time_entries SET ended_at=?, seconds=? WHERE id=?', endedAt.toISOString(), seconds, running.id);
    await logActivity(cardId, userId, 'time_stopped', { seconds, auto: true, entry_id: running.id });
  }
}

// Ліміт WIP: одна людина — не більше однієї задачі одночасно в «робочій»
// колонці (тій самій, що й авто-трекінг вище — тій самій НАЗВОЮ). Перевірка
// лише при реальній зміні колонки (не при переставленні всередині тієї ж).
async function assertWipLimit(boardId, columnId, colName, cardId, cardsTable = 'task_cards') {
  if (String(colName || '').trim().toLowerCase() !== AUTO_TRACK_COLUMN_NAME) return;
  const card = await get(`SELECT assignee_user_id FROM ${cardsTable} WHERE id=?`, cardId);
  if (!card?.assignee_user_id) return;
  const clash = await get(
    `SELECT c.id, c.title FROM ${cardsTable} c WHERE c.board_id=? AND c.column_id=? AND c.assignee_user_id=? AND c.id<>?`,
    boardId, columnId, card.assignee_user_id, cardId,
  );
  if (!clash) return;
  const assignee = await get('SELECT name FROM users WHERE id=?', card.assignee_user_id);
  throw Object.assign(
    new Error(`${assignee?.name || 'Виконавець'} вже має задачу «${clash.title}» у колонці «${colName}» — спершу перенесіть чи заверште її, перш ніж брати нову`),
    { status: 409 },
  );
}

export async function moveCard(user, cardId, columnId, boardOrder) {
  const { board_id: boardId, column_id: fromColumnId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const col = await get('SELECT id, name, board_id FROM task_columns WHERE id=?', columnId);
  if (!col || col.board_id !== boardId) throw Object.assign(new Error('Колонка не належить цій дошці'), { status: 400 });
  if (columnId !== fromColumnId) await assertWipLimit(boardId, columnId, col.name, cardId);
  const order = boardOrder != null ? Number(boardOrder) : orderBetween(null, null);
  await run('UPDATE task_cards SET column_id=?, board_order=? WHERE id=?', columnId, order, cardId);
  if (columnId !== fromColumnId) {
    const fromCol = await get('SELECT name FROM task_columns WHERE id=?', fromColumnId);
    await logActivity(cardId, user.id, 'moved', { from: fromCol?.name || '—', to: col.name });
    await autoTrackOnMove(cardId, user.id, col.name);
  }
  return { ok: true };
}

export async function deleteCard(user, cardId) {
  const { board_id: boardId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  await run('DELETE FROM task_cards WHERE id=?', cardId);
  return { ok: true };
}

// ── Файли (base64 у БД — той самий підхід, що payout_reports) ───────────
function stripDataUrl(content) { return String(content || '').replace(/^data:[^,]*,/, ''); }

async function saveAttachment(cardId, commentId, file, uploadedBy) {
  const content = stripDataUrl(file?.content);
  const fileName = String(file?.file_name || '').trim();
  if (!fileName || !content) throw Object.assign(new Error('Потрібні назва файлу та вміст'), { status: 400 });
  const bytes = Math.ceil((content.length * 3) / 4);
  if (bytes > MAX_FILE_BYTES) throw Object.assign(new Error('Файл завеликий (максимум 8 МБ)'), { status: 413 });
  return insert('task_attachments', {
    card_id: cardId, comment_id: commentId, file_name: fileName,
    mime: file.mime || 'application/octet-stream', content, uploaded_by: uploadedBy,
  });
}

export async function addAttachment(user, cardId, file) {
  const { board_id: boardId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const id = await saveAttachment(cardId, null, file, user.id);
  await logActivity(cardId, user.id, 'attachment_added', { file_name: file.file_name });
  return { id };
}

export async function getAttachmentFile(user, attachmentId) {
  const row = await get('SELECT * FROM task_attachments WHERE id=?', attachmentId);
  if (!row) throw Object.assign(new Error('Файл не знайдено'), { status: 404 });
  const { board_id: boardId } = await cardRow(row.card_id);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  return { buffer: Buffer.from(row.content, 'base64'), mime: row.mime, name: row.file_name };
}

export async function deleteAttachment(user, attachmentId) {
  const row = await get('SELECT * FROM task_attachments WHERE id=?', attachmentId);
  if (!row) throw Object.assign(new Error('Файл не знайдено'), { status: 404 });
  const { board_id: boardId } = await cardRow(row.card_id);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  await run('DELETE FROM task_attachments WHERE id=?', attachmentId);
  return { ok: true };
}

// ── Коментарі ───────────────────────────────────────────────────────────
export async function addComment(user, cardId, body, attachments = []) {
  const { board_id: boardId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const text = String(body || '').trim();
  if (!text && !attachments.length) throw Object.assign(new Error('Порожній коментар'), { status: 400 });
  const commentId = await insert('task_comments', { card_id: cardId, user_id: user.id, body: text });
  for (const file of attachments) await saveAttachment(cardId, commentId, file, user.id);
  await logActivity(cardId, user.id, 'commented', { preview: text.slice(0, 80) });
  return { id: commentId };
}

export async function deleteComment(user, commentId) {
  const c = await get('SELECT * FROM task_comments WHERE id=?', commentId);
  if (!c) throw Object.assign(new Error('Коментар не знайдено'), { status: 404 });
  const { board_id: boardId } = await cardRow(c.card_id);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  await run('DELETE FROM task_comments WHERE id=?', commentId);
  return { ok: true };
}

// Закріпити можна скільки завгодно коментарів одразу (не лише один) —
// просто прапорець на кожному, порядок серед закріплених — за часом
// створення самого коментаря, як і в загальній стрічці.
export async function togglePinComment(user, commentId, pinned) {
  const c = await get('SELECT * FROM task_comments WHERE id=?', commentId);
  if (!c) throw Object.assign(new Error('Коментар не знайдено'), { status: 404 });
  const { board_id: boardId } = await cardRow(c.card_id);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  await run('UPDATE task_comments SET pinned=? WHERE id=?', pinned ? 1 : 0, commentId);
  return { ok: true };
}

// ── Трекер часу ─────────────────────────────────────────────────────────
export async function startTimer(user, cardId) {
  const { board_id: boardId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const running = await get('SELECT id FROM task_time_entries WHERE card_id=? AND user_id=? AND ended_at IS NULL', cardId, user.id);
  if (running) return { id: running.id };
  const id = await insert('task_time_entries', { card_id: cardId, user_id: user.id, started_at: new Date().toISOString() });
  await logActivity(cardId, user.id, 'time_started', { entry_id: id });
  return { id };
}

export async function stopTimer(user, cardId) {
  const { board_id: boardId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const running = await get('SELECT * FROM task_time_entries WHERE card_id=? AND user_id=? AND ended_at IS NULL', cardId, user.id);
  if (!running) throw Object.assign(new Error('Немає запущеного таймера'), { status: 409 });
  const endedAt = new Date();
  const seconds = Math.max(0, Math.round((endedAt.getTime() - new Date(running.started_at).getTime()) / 1000));
  await run('UPDATE task_time_entries SET ended_at=?, seconds=? WHERE id=?', endedAt.toISOString(), seconds, running.id);
  await logActivity(cardId, user.id, 'time_stopped', { seconds, entry_id: running.id });
  return { id: running.id, seconds };
}

// Редагувати можна або «скільки хвилин» (просто рахуємо кінець від
// незмінного початку), або точні межі «з — до» (тоді й початок, і кінець,
// і секунди рахуються з цих двох міток) — картка задачі дає обидва
// варіанти в одній формі.
export async function editTimeEntry(user, entryId, body) {
  const entry = await get('SELECT * FROM task_time_entries WHERE id=?', entryId);
  if (!entry) throw Object.assign(new Error('Запис не знайдено'), { status: 404 });
  const { board_id: boardId } = await cardRow(entry.card_id);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  if (entry.ended_at == null) throw Object.assign(new Error('Спершу зупиніть таймер'), { status: 409 });
  let startedAt = entry.started_at;
  let seconds;
  let endedAt;
  if (body?.started_at && body?.ended_at) {
    const start = new Date(body.started_at);
    endedAt = new Date(body.ended_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(endedAt.getTime())) {
      throw Object.assign(new Error('Некоректний час'), { status: 400 });
    }
    seconds = Math.round((endedAt.getTime() - start.getTime()) / 1000);
    if (seconds < 0) throw Object.assign(new Error('Кінець раніше початку'), { status: 400 });
    startedAt = start.toISOString();
  } else {
    seconds = Math.max(0, Math.round(Number(body?.seconds) || 0));
    endedAt = new Date(new Date(startedAt).getTime() + seconds * 1000);
  }
  await run('UPDATE task_time_entries SET started_at=?, seconds=?, ended_at=? WHERE id=?', startedAt, seconds, endedAt.toISOString(), entryId);
  await logActivity(entry.card_id, user.id, 'time_edited', { seconds, entry_id: entryId });
  return { ok: true };
}
