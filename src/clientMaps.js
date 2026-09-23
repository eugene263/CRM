// «Підключення клієнта»: дерево канв Excalidraw під клієнтом — папка в
// папці, як у Notion, тільки замість тексту всередині кожного вузла
// повноцінна дошка з картками й стрілочками. Корінь дерева (parent_id
// IS NULL) створюється сам при першому відкритті клієнта.
//
// Побудова самих елементів канви (картка-посилання на дочірню мапу) —
// свідомо НЕ тут: Excalidraw має власний офіційний спосіб зібрати
// коректний елемент (convertToExcalidrawElements), і рахувати цю схему
// вручну на бекенді — крихко й дублює те, що бібліотека вже вміє.
// Бекенд лише створює/читає рядки дерева й зберігає JSON сцени як є.
import { all, get, run, insert } from './db.js';
import { scopeWhere } from './rbac.js';

export const MAX_SCENE_BYTES = 6 * 1024 * 1024;

function scopeFor(user) {
  return scopeWhere(user, 'client_maps', 'm');
}

// Вузол дерева з перевіркою скоупу — мінімум полів, без важкої сцени.
async function nodeOrThrow(user, mapId) {
  const scope = scopeFor(user);
  const row = await get(
    `SELECT m.id, m.client_id, m.parent_id, m.name, m.sort_order
       FROM client_maps m WHERE m.id = ? AND ${scope.sql}`, Number(mapId), ...scope.params);
  if (!row) throw Object.assign(new Error('Мапу не знайдено'), { status: 404 });
  return row;
}

// Усе дерево мап клієнта (без сцен) — для хлібних крихт і списку дочірніх
// вузлів у кожній картці.
export async function tree(user, clientId) {
  const scope = scopeFor(user);
  return all(
    `SELECT m.id, m.parent_id, m.name, m.sort_order
       FROM client_maps m WHERE m.client_id = ? AND ${scope.sql}
      ORDER BY m.parent_id IS NOT NULL, m.sort_order, m.id`, Number(clientId), ...scope.params);
}

// Корінь дерева клієнта — створюється сам при першому відкритті, щоб не
// показувати порожній стан «спершу створіть мапу» на рівному місці.
export async function ensureRoot(user, clientId) {
  const scope = scopeFor(user);
  const id = Number(clientId);
  const client = await get('SELECT id, name FROM clients WHERE id=?', id);
  if (!client) throw Object.assign(new Error('Клієнта не знайдено'), { status: 404 });

  const existing = await get(
    `SELECT m.id FROM client_maps m WHERE m.client_id=? AND m.parent_id IS NULL AND ${scope.sql}`,
    id, ...scope.params);
  if (existing) return existing.id;

  return insert('client_maps', { client_id: id, parent_id: null, name: `Підключення: ${client.name}` });
}

export async function getScene(user, mapId) {
  const node = await nodeOrThrow(user, mapId);
  const row = await get('SELECT scene FROM client_maps WHERE id=?', node.id);
  let scene;
  try { scene = JSON.parse(row.scene); } catch { scene = { elements: [], appState: {} }; }
  return { node, scene };
}

export async function saveScene(user, mapId, scene) {
  const node = await nodeOrThrow(user, mapId);
  const text = JSON.stringify(scene ?? { elements: [], appState: {} });
  if (Buffer.byteLength(text, 'utf8') > MAX_SCENE_BYTES) {
    throw Object.assign(new Error('Мапа завелика — приберіть частину елементів'), { status: 413 });
  }
  await run(`UPDATE client_maps SET scene=?, updated_at=datetime('now') WHERE id=?`, text, node.id);
  return { ok: true };
}

// Нова вкладена мапа: рядок у дереві плюс порядковий номер серед
// сиблінгів (фронтенд використовує його, щоб розкласти нові картки-
// посилання по канві без накладання одна на одну).
export async function createChild(user, parentId, name) {
  const parent = await nodeOrThrow(user, parentId);
  if (!name || !String(name).trim()) throw Object.assign(new Error('Потрібна назва'), { status: 400 });
  const siblings = await get('SELECT COUNT(*) AS c FROM client_maps WHERE parent_id=?', parent.id);
  const id = await insert('client_maps', {
    client_id: parent.client_id, parent_id: parent.id, name: String(name).trim(),
    sort_order: Number(siblings?.c || 0),
  });
  return { id, index: Number(siblings?.c || 0) };
}

// Перейменування, client_id/parent_id, sort_order — генерик-CRUD PUT
// /api/client_maps/:id уже це вміє (name/parent_id/sort_order — оголошені
// поля сутності), окремої функції не треба.
//
// Видалення так само йде через генерик DELETE — захист «не видаляти,
// доки є дочірні мапи» додано просто в api.js поруч із таким самим
// захистом для message_templates, щоб не дублювати цю перевірку тут.

