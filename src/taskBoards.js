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

export async function createSpace(user, name) {
  const clean = requireName(name);
  const id = await insert('task_spaces', { name: clean, created_by: user.id });
  await insert('task_space_members', { space_id: id, user_id: user.id });
  return { id };
}

export async function renameSpace(user, spaceId, name) {
  await assertMember(user, spaceId);
  await run('UPDATE task_spaces SET name=? WHERE id=?', requireName(name), spaceId);
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

export async function renameBoard(user, boardId, name) {
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  await run('UPDATE task_boards SET name=? WHERE id=?', requireName(name), boardId);
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
            u.name AS assignee_name
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
  return { space, board, members, boardTags, columns: [...byColumn.values()] };
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

const CARD_FIELDS = ['title', 'description', 'start_date', 'due_date', 'priority', 'assignee_user_id'];
const FIELD_LABELS = { title: 'назву', description: 'опис', start_date: 'дату початку', due_date: 'дедлайн', priority: 'пріоритет' };

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

export async function moveCard(user, cardId, columnId, boardOrder) {
  const { board_id: boardId, column_id: fromColumnId } = await cardRow(cardId);
  const spaceId = await spaceIdOfBoard(boardId);
  await assertMember(user, spaceId);
  const col = await get('SELECT id, name, board_id FROM task_columns WHERE id=?', columnId);
  if (!col || col.board_id !== boardId) throw Object.assign(new Error('Колонка не належить цій дошці'), { status: 400 });
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
