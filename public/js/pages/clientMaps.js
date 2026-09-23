// «Підключення клієнта»: дерево дощок під клієнтом — папка в папці, як у
// Notion, тільки замість тексту всередині кожного вузла дошка з картками,
// стікерами, текстом, таблицями й стрілочками. Клік по картці, яка веде
// в дочірню мапу, провалює всередину — у межах нашого SPA-роутера, без
// відкриття нової вкладки.
//
// Свій редактор, а не стороння бібліотека: потрібні були стандартні
// пласкі елементи без «мальованого» стилю, ліва вертикальна панель
// інструментів (курсор/рука/стрілка + додавання елементів), як у FigJam,
// і стрілки, які самі магнітяться між елементами. Прості div-и в стилі
// решти CRM + SVG для ліній дають рівно це.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, modal, toast, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Кольори картки/стікера — перший акцентний колір самого CRM (щоб
// елементи виглядали частиною інтерфейсу), решта — кольорові варіанти на
// вибір, як стікери в Miro. Пастельне тло + насичена рамка — та сама мова
// кольору, що вже є в акцентах по всій CRM.
const ITEM_COLORS = [
  { key: 'accent', bg: '#e9edfc', stroke: '#6c8cff' },
  { key: 'yellow', bg: '#fff3bf', stroke: '#f2b705' },
  { key: 'pink', bg: '#ffe3ec', stroke: '#f06595' },
  { key: 'green', bg: '#e6fcf5', stroke: '#12b886' },
  { key: 'orange', bg: '#fff0e6', stroke: '#e8590c' },
  { key: 'purple', bg: '#f3f0ff', stroke: '#845ef7' },
];
const colorOf = (key) => ITEM_COLORS.find((c) => c.key === key) || ITEM_COLORS[0];

const newId = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Розмір елемента для розрахунку стрілок: у картки/стікера/тексту він
// фіксований, у таблиці залежить від поточної кількості рядків/стовпців
// (і росте, коли додають ще) — тому рахуємо це тут-таки, а не тримаємо
// окремим полем, яке довелось би синхронізувати з реальним рендером.
function itemSize(item) {
  if (item.kind === 'sticker') return { w: 180, h: 180 };
  if (item.kind === 'text') return { w: 220, h: 40 };
  if (item.kind === 'table') {
    const cols = item.cells[0]?.length || 2;
    const rows = item.cells.length || 2;
    return { w: cols * 92 + 30, h: rows * 34 + 46 };
  }
  return { w: 200, h: 120 }; // card
}

// Точка на межі прямокутника вздовж напрямку від його центру до (dx, dy) —
// той самий прийом, яким стрілка «магнітиться» рівно до краю елемента, а
// не висить десь посередині незалежно від того, де елементи зараз стоять.
function edgePoint(cx, cy, w, h, dx, dy) {
  if (!dx && !dy) return { x: cx, y: cy };
  const hw = w / 2, hh = h / 2;
  const scale = Math.min(dx ? Math.abs(hw / dx) : Infinity, dy ? Math.abs(hh / dy) : Infinity);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function makeItem(kind, x, y) {
  const base = { id: newId(), kind, x, y };
  if (kind === 'sticker') return { ...base, text: '', color: 'yellow' };
  if (kind === 'text') return { ...base, text: '' };
  if (kind === 'table') return { ...base, cells: [['', ''], ['', '']] };
  return { ...base, kind: 'card', text: '', color: 'accent', link: null };
}

// ── Сторінка-пікер: картки клієнтів, клік відкриває/створює їхню мапу ────
export async function renderClientMapsPicker() {
  const box = el('div', {});
  const { rows } = await api.get('/clients?limit=300');
  box.append(
    el('div', { class: 'muted', style: 'margin-bottom:14px;font-size:12.5px' },
      'Оберіть клієнта — відкриється (або створиться) дошка для нього'),
    rows.length ? el('div', { class: 'list-cards' }, ...rows.map((c) => {
      const card = el('div', { class: 'list-card' },
        el('div', { class: 'list-card-head' }, el('b', {}, c.name)),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          [c.geo_city, c.geo_country].filter(Boolean).join(', ') || '—'));
      card.addEventListener('click', async () => {
        try {
          const { id } = await api.get(`/client_maps/root?client_id=${c.id}`);
          location.hash = `#/map/${id}`;
        } catch (e) { toast(e.message, true); }
      });
      return card;
    })) : el('div', { class: 'card muted' }, 'Клієнтів ще немає'));
  return box;
}

// ── Сторінка дошки (#/map/:id) ────────────────────────────────────────────
export async function renderMapCanvas(mapId) {
  const ent = state.meta.client_maps;
  const canEdit = !!ent.can.update;
  const canCreate = !!ent.can.create;
  const canDelete = !!ent.can.delete;

  const page = el('div', { style: 'display:flex;flex-direction:column;height:100%' });
  const crumbBar = el('div', { style: 'margin-bottom:10px' });
  const toolbar = el('div', { class: 'map-toolbar' });
  const workspace = el('div', { class: 'map-workspace' });
  const arrowsLayer = svgEl('svg', { class: 'map-arrows' });
  const viewport = el('div', { class: 'map-viewport' }, workspace);
  const area = el('div', { class: 'map-area' }, toolbar, viewport);
  workspace.append(arrowsLayer);
  page.append(crumbBar, area);

  let node, data;
  try {
    const res = await api.get(`/client_maps/${mapId}/scene`);
    node = res.node;
    data = normalizeScene(res.scene);
  } catch (e) {
    viewport.append(el('div', { class: 'card', style: 'margin:20px' },
      el('div', { class: 'error' }, 'Не вдалося завантажити дошку.'),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, String(e?.message || e))));
    return page;
  }
  const { rows: treeRows } = await api.get(`/client_maps/tree?client_id=${node.client_id}`);
  const byId = new Map(treeRows.map((r) => [r.id, r]));

  let saveTimer = null;
  // 'select' — типовий курсор (тягати/редагувати елементи); 'hand' — рука,
  // просто ходити по простору, ні з чим не взаємодіявши; 'connect' —
  // клік по двох елементах з'єднує їх стрілкою; 'place:<kind>' — наступний
  // клік по порожньому місцю ставить туди новий елемент цього виду.
  let mode = 'select';
  let connectFrom = null;
  let destroyed = false;
  window.addEventListener('hashchange', () => { destroyed = true; if (saveTimer) clearTimeout(saveTimer); }, { once: true });

  // Стара форма сцени ({cards, arrows}) читається так само — просто
  // проставляємо kind:'card' там, де його ще нема.
  function normalizeScene(scene) {
    if (scene && Array.isArray(scene.items) && Array.isArray(scene.arrows)) return scene;
    if (scene && Array.isArray(scene.cards) && Array.isArray(scene.arrows)) {
      return { items: scene.cards.map((c) => ({ ...c, kind: c.kind || 'card' })), arrows: scene.arrows };
    }
    return { items: [], arrows: [] };
  }

  function scheduleSave() {
    if (!canEdit) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (destroyed) return;
      try { await api.put(`/client_maps/${node.id}/scene`, { scene: data }); }
      catch (e) { toast(e.message, true); }
    }, 500);
  }

  function setMode(next) {
    mode = next;
    connectFrom = null;
    viewport.className = `map-viewport${mode === 'hand' ? ' mode-hand' : mode.startsWith('place:') ? ' mode-place' : ''}`;
    renderToolbar();
    renderCrumbHint();
    renderItems();
  }

  // ── Хлібні крихти + керування самою мапою ──────────────────────────────
  function breadcrumbPath() {
    const path = [];
    for (let cur = byId.get(node.id), hops = 0; cur && hops < 50; hops += 1) {
      path.unshift(cur);
      cur = cur.parent_id == null ? null : byId.get(cur.parent_id);
    }
    return path;
  }

  function renderCrumbHint() {
    let hint = document.getElementById('map-hint-' + node.id);
    const text = mode === 'connect'
      ? (connectFrom ? 'Тепер клікніть другий елемент' : 'Клікніть перший елемент, від якого піде стрілка')
      : mode.startsWith('place:')
        ? 'Клікніть порожнє місце на дошці, щоб розмістити елемент'
        : mode === 'hand'
          ? 'Рука: перетягуйте порожній простір мишею, щоб гортати дошку'
          : 'Тягайте елементи мишею; кольоровий кружечок — колір; іконка папки на картці провалює у вкладену мапу';
    if (hint) hint.textContent = text;
  }

  function renderCrumbs() {
    crumbBar.textContent = '';
    const row = el('div', { class: 'row', style: 'align-items:center;gap:8px;flex-wrap:wrap' },
      el('a', { href: '#/e/client_maps', style: 'display:inline-flex;align-items:center;gap:4px;font-size:12.5px' },
        icon('chevronLeft', 13), 'Підключення клієнта'));
    for (const step of breadcrumbPath()) {
      row.append(icon('chevronRight', 12),
        step.id === node.id
          ? el('b', { style: 'font-size:13.5px' }, step.name)
          : el('a', { href: `#/map/${step.id}`, style: 'font-size:13.5px' }, step.name));
    }
    row.append(
      el('div', { style: 'flex:1 1 auto' }),
      canEdit ? el('button', { class: 'btn small icon-only', title: 'Перейменувати', onclick: () => renameModal() },
        icon('edit', 14)) : null,
      canDelete ? el('button', { class: 'btn small icon-only danger', title: 'Видалити цю мапу', onclick: () => deleteThis() },
        icon('trash', 14)) : null);
    crumbBar.append(row, el('div', { class: 'map-toolbar-hint', id: 'map-hint-' + node.id, style: 'margin-top:4px' }));
    renderCrumbHint();
  }

  function renameModal() {
    const input = el('input', { value: node.name });
    const box = modal('Назва мапи', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
      [actionButton('Зберегти', async () => {
        if (!input.value.trim()) return toast('Потрібна назва', true);
        try {
          await api.put(`/client_maps/${node.id}`, { name: input.value.trim() });
          node.name = input.value.trim();
          const tn = byId.get(node.id); if (tn) tn.name = node.name;
          box.remove();
          renderCrumbs();
        } catch (e) { toast(e.message, true); }
      })]);
  }

  function deleteThis() {
    if (!confirm(`Видалити мапу «${node.name}»?`)) return;
    api.del(`/client_maps/${node.id}`)
      .then(() => { location.hash = node.parent_id ? `#/map/${node.parent_id}` : '#/e/client_maps'; })
      .catch((e) => toast(e.message, true));
  }

  // ── Ліва панель інструментів ────────────────────────────────────────────
  function toolBtn({ activeIf, iconName, title, onclick }) {
    return el('button', {
      class: `btn icon-only${activeIf ? ' primary' : ''}`, title, onclick,
    }, icon(iconName, 17));
  }

  function renderToolbar() {
    toolbar.textContent = '';
    toolbar.append(
      toolBtn({ activeIf: mode === 'select', iconName: 'pointer', title: 'Курсор — виділяти й тягати елементи', onclick: () => setMode('select') }),
      toolBtn({ activeIf: mode === 'hand', iconName: 'hand', title: 'Рука — просто гортати простір', onclick: () => setMode('hand') }),
      canCreate ? toolBtn({ activeIf: mode === 'connect', iconName: 'send', title: 'Стрілка — з’єднати два елементи', onclick: () => setMode(mode === 'connect' ? 'select' : 'connect') }) : null,
      canCreate ? el('div', { class: 'sep' }) : null,
      canCreate ? toolBtn({ activeIf: mode === 'place:card', iconName: 'folder', title: 'Додати картку (з переходом у вкладену мапу)', onclick: () => setMode(mode === 'place:card' ? 'select' : 'place:card') }) : null,
      canCreate ? toolBtn({ activeIf: mode === 'place:sticker', iconName: 'tag', title: 'Додати стікер', onclick: () => setMode(mode === 'place:sticker' ? 'select' : 'place:sticker') }) : null,
      canCreate ? toolBtn({ activeIf: mode === 'place:text', iconName: 'fileText', title: 'Додати текст', onclick: () => setMode(mode === 'place:text' ? 'select' : 'place:text') }) : null,
      canCreate ? toolBtn({ activeIf: mode === 'place:table', iconName: 'grid', title: 'Додати таблицю', onclick: () => setMode(mode === 'place:table' ? 'select' : 'place:table') }) : null);
  }

  // Клік по порожньому місцю робочої поверхні: або ставить новий елемент
  // (режим place:*), або, якщо клікнули по конкретному елементу в режимі
  // стрілки, обробляється власним обробником картки (сюди не доходить).
  workspace.addEventListener('click', (e) => {
    if (e.target !== workspace) return;
    if (!mode.startsWith('place:')) return;
    const kind = mode.slice('place:'.length);
    const item = makeItem(kind, 0, 0);
    const size = itemSize(item);
    item.x = Math.max(0, e.offsetX - size.w / 2);
    item.y = Math.max(0, e.offsetY - size.h / 2);
    data.items.push(item);
    setMode('select');
    scheduleSave();
    workspace.querySelector(`[data-item-id="${item.id}"] [contenteditable="true"]`)?.focus();
  });

  // Рука: перетягування порожнього простору гортає дошку, нічого не рухає.
  viewport.addEventListener('pointerdown', (e) => {
    if (mode !== 'hand') return;
    const startX = e.clientX, startY = e.clientY;
    const startLeft = viewport.scrollLeft, startTop = viewport.scrollTop;
    viewport.classList.add('panning');
    const onMove = (ev) => {
      viewport.scrollLeft = startLeft - (ev.clientX - startX);
      viewport.scrollTop = startTop - (ev.clientY - startY);
    };
    const onUp = () => {
      viewport.classList.remove('panning');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  // ── Спільне для всіх елементів ─────────────────────────────────────────
  function removeItem(itemId) {
    data.items = data.items.filter((i) => i.id !== itemId);
    data.arrows = data.arrows.filter((a) => a.from !== itemId && a.to !== itemId);
    renderItems();
    scheduleSave();
  }

  function colorDot(item) {
    const dot = el('button', {
      type: 'button', class: 'map-color-dot', title: 'Колір',
      style: `background:${colorOf(item.color).bg}`,
      onclick: (e) => { e.stopPropagation(); openColorMenu(dot, item); },
    });
    return dot;
  }

  function openColorMenu(anchor, item) {
    const rect = anchor.getBoundingClientRect();
    const row = el('div', {
      style: `position:fixed;left:${rect.left}px;top:${rect.bottom + 6}px;z-index:50;background:var(--panel);`
        + 'border:1px solid var(--line);border-radius:10px;padding:6px;display:flex;gap:6px;box-shadow:var(--shadow)',
    }, ...ITEM_COLORS.map((c) => el('button', {
      type: 'button', style: `width:22px;height:22px;border-radius:50%;background:${c.bg};border:2px solid ${c.stroke};cursor:pointer`,
      onclick: () => { item.color = c.key; row.remove(); renderItems(); scheduleSave(); },
    })));
    document.body.append(row);
    const close = (e) => { if (!row.contains(e.target)) { row.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  function startDrag(e, item, div) {
    if (mode !== 'select') return;
    if (e.target.closest('button, [contenteditable="true"]')) return;
    const startX = e.clientX, startY = e.clientY;
    const origX = item.x, origY = item.y;
    let dragging = false;
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 4) return;
      dragging = true;
      item.x = origX + dx; item.y = origY + dy;
      div.style.left = `${item.x}px`;
      div.style.top = `${item.y}px`;
      div.classList.add('dragging');
      drawArrows();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      div.classList.remove('dragging');
      if (dragging) scheduleSave();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function handleConnectClick(itemId) {
    if (!connectFrom) { connectFrom = itemId; renderCrumbHint(); renderItems(); return; }
    if (connectFrom !== itemId && !data.arrows.some((a) =>
      (a.from === connectFrom && a.to === itemId) || (a.from === itemId && a.to === connectFrom))) {
      data.arrows.push({ id: newId(), from: connectFrom, to: itemId });
      scheduleSave();
    }
    setMode('select');
  }

  function attachCommon(div, item) {
    div.addEventListener('pointerdown', (e) => startDrag(e, item, div));
    div.addEventListener('click', (e) => {
      if (mode !== 'connect') return;
      e.stopPropagation();
      handleConnectClick(item.id);
    });
  }

  // ── Побудова елементів за видом ─────────────────────────────────────────
  function buildCard(item) {
    const text = el('div', {
      class: 'map-item-text', contenteditable: (canEdit && mode === 'select') ? 'true' : 'false',
      onblur: () => { item.text = text.textContent; scheduleSave(); },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); text.blur(); } },
    }, item.text);
    const bar = el('div', { class: 'map-item-bar' },
      colorDot(item),
      el('div', { style: 'flex:1 1 auto' }),
      el('button', {
        class: 'btn small icon-only', title: item.link ? 'Перейти у вкладену мапу' : 'Створити вкладену мапу',
        onclick: (e) => { e.stopPropagation(); openOrCreateChild(item); },
      }, icon('folder', 13)),
      canDelete ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити картку',
        onclick: (e) => { e.stopPropagation(); removeItem(item.id); },
      }, icon('trash', 13)) : null);
    const color = colorOf(item.color);
    return el('div', { class: 'map-card', style: `background:${color.bg};border-color:${color.stroke}` }, text, bar);
  }

  async function openOrCreateChild(item) {
    if (item.link) { location.hash = `#/map/${item.link}`; return; }
    if (!canCreate) return;
    try {
      const { id } = await api.post(`/client_maps/${node.id}/children`, { name: item.text.trim() || 'Без назви' });
      item.link = id;
      scheduleSave();
      location.hash = `#/map/${id}`;
    } catch (e) { toast(e.message, true); }
  }

  function buildSticker(item) {
    const text = el('div', {
      class: 'map-item-text', contenteditable: (canEdit && mode === 'select') ? 'true' : 'false',
      onblur: () => { item.text = text.textContent; scheduleSave(); },
    }, item.text);
    const bar = el('div', { class: 'map-item-bar' },
      colorDot(item),
      el('div', { style: 'flex:1 1 auto' }),
      canDelete ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити стікер',
        onclick: (e) => { e.stopPropagation(); removeItem(item.id); },
      }, icon('trash', 13)) : null);
    const color = colorOf(item.color);
    return el('div', { class: 'map-sticker', style: `background:${color.bg};border-color:${color.stroke}` }, text, bar);
  }

  function buildText(item) {
    const text = el('div', {
      class: 'map-text-only', contenteditable: (canEdit && mode === 'select') ? 'true' : 'false',
      onblur: () => { item.text = text.textContent; scheduleSave(); },
    }, item.text || '');
    const del = canDelete ? el('button', {
      class: 'btn small icon-only danger', title: 'Видалити текст', style: 'position:absolute;top:-14px;right:-14px',
      onclick: (e) => { e.stopPropagation(); removeItem(item.id); },
    }, icon('trash', 11)) : null;
    return el('div', { style: 'position:relative' }, text, del);
  }

  function buildTable(item) {
    const table = el('table', { class: 'map-table' },
      ...item.cells.map((rowCells, r) => el('tr', {},
        ...rowCells.map((val, c) => el('td', {
          contenteditable: canEdit && mode === 'select' ? 'true' : 'false',
          onblur: (e) => { item.cells[r][c] = e.target.textContent; scheduleSave(); },
        }, val || '')))));
    const addCol = canEdit ? el('button', {
      class: 'btn small icon-only map-table-addcol', title: 'Додати стовпець',
      onclick: (e) => { e.stopPropagation(); item.cells.forEach((r) => r.push('')); renderItems(); scheduleSave(); },
    }, icon('plus', 12)) : null;
    const addRow = canEdit ? el('button', {
      class: 'btn small icon-only map-table-addrow', title: 'Додати рядок',
      onclick: (e) => { e.stopPropagation(); item.cells.push(new Array(item.cells[0].length).fill('')); renderItems(); scheduleSave(); },
    }, icon('plus', 12)) : null;
    const del = canDelete ? el('button', {
      class: 'btn small icon-only danger', title: 'Видалити таблицю',
      onclick: (e) => { e.stopPropagation(); removeItem(item.id); },
    }, icon('trash', 12)) : null;
    return el('div', { class: 'map-table-wrap' },
      el('div', { class: 'map-table-topbar' }, del),
      el('div', { class: 'map-table-body' }, table, addCol),
      el('div', { class: 'map-table-addrow-row' }, addRow));
  }

  function renderItems() {
    workspace.querySelectorAll('.map-item').forEach((n) => n.remove());
    for (const item of data.items) {
      let inner;
      if (item.kind === 'sticker') inner = buildSticker(item);
      else if (item.kind === 'text') inner = buildText(item);
      else if (item.kind === 'table') inner = buildTable(item);
      else inner = buildCard(item);
      const wrap = el('div', {
        class: `map-item${mode === 'connect' && connectFrom === item.id ? ' connect-source' : ''}`,
        'data-item-id': item.id,
        style: `left:${item.x}px;top:${item.y}px`,
      }, inner);
      attachCommon(wrap, item);
      workspace.append(wrap);
    }
    drawArrows();
  }

  function drawArrows() {
    arrowsLayer.textContent = '';
    const defs = svgEl('defs', {});
    arrowsLayer.append(defs);
    const marker = svgEl('marker', {
      id: 'map-arrowhead', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    });
    marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--muted)' }));
    defs.append(marker);
    const byIdItem = new Map(data.items.map((i) => [i.id, i]));
    for (const arrow of data.arrows) {
      const a = byIdItem.get(arrow.from), b = byIdItem.get(arrow.to);
      if (!a || !b) continue;
      const sa = itemSize(a), sb = itemSize(b);
      const ca = { x: a.x + sa.w / 2, y: a.y + sa.h / 2 };
      const cb = { x: b.x + sb.w / 2, y: b.y + sb.h / 2 };
      const p1 = edgePoint(ca.x, ca.y, sa.w, sa.h, cb.x - ca.x, cb.y - ca.y);
      const p2 = edgePoint(cb.x, cb.y, sb.w, sb.h, ca.x - cb.x, ca.y - cb.y);
      arrowsLayer.append(svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: 'var(--muted)', 'stroke-width': 2, 'marker-end': 'url(#map-arrowhead)',
      }));
    }
  }

  renderCrumbs();
  setMode('select');
  return page;
}
