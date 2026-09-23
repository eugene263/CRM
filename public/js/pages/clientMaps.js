// «Підключення клієнта»: дошка під клієнтом із картками, стікерами,
// текстом, заголовками, спадними меню й таблицями. Картка може вести у
// вкладену дошку — той самий редактор рекурсивно монтується в бічній
// панелі праворуч, тому «провалюватись» можна скільки завгодно рівнів
// углиб, не покидаючи поточної сторінки.
//
// Свій редактор, а не стороння бібліотека: потрібні були стандартні
// пласкі елементи без «мальованого» стилю, ліва вертикальна панель
// інструментів (курсор/рука/стрілка + додавання елементів + зум), як у
// FigJam, і стрілки, які самі магнітяться між елементами. Прості div-и в
// стилі решти CRM + SVG для ліній дають рівно це.
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

// «Світ» workspace у логічних (нескейлених) пікселях — той самий розмір,
// що заданий у styles.css для .map-workspace. Зум масштабує лише те, як
// це малюється (transform), самі координати елементів завжди в цій
// системі, тому збереження/стрілки/перетягування не залежать від зуму.
const WORLD_W = 3000;
const WORLD_H = 2000;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.15;

// Розмір елемента для розрахунку стрілок і рамки виділення: у картки/
// стікера/тексту/заголовка/меню він фіксований, у таблиці залежить від
// поточної кількості рядків/стовпців — тому рахуємо це тут-таки, а не
// тримаємо окремим полем, яке довелось би синхронізувати з рендером.
function itemSize(item) {
  if (item.kind === 'sticker') return { w: 180, h: 180 };
  if (item.kind === 'text') return { w: 220, h: 40 };
  if (item.kind === 'heading') return { w: 260, h: 44 };
  if (item.kind === 'select') return { w: 220, h: 76 };
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
  if (kind === 'heading') return { ...base, text: '' };
  if (kind === 'select') return { ...base, label: '', options: ['Варіант 1', 'Варіант 2'], value: 'Варіант 1' };
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

// Стара форма сцени ({cards, arrows}) читається так само — просто
// проставляємо kind:'card' там, де його ще нема.
function normalizeScene(scene) {
  if (scene && Array.isArray(scene.items) && Array.isArray(scene.arrows)) return scene;
  if (scene && Array.isArray(scene.cards) && Array.isArray(scene.arrows)) {
    return { items: scene.cards.map((c) => ({ ...c, kind: c.kind || 'card' })), arrows: scene.arrows };
  }
  return { items: [], arrows: [] };
}

// ── Сторінка дошки (#/map/:id) ────────────────────────────────────────────
export async function renderMapCanvas(mapId) {
  const ent = state.meta.client_maps;
  const canEdit = !!ent.can.update;
  const canCreate = !!ent.can.create;
  const canDelete = !!ent.can.delete;

  const page = el('div', { style: 'display:flex;flex-direction:column;height:100%' });
  const crumbBar = el('div', { style: 'margin-bottom:10px' });
  const boardHost = el('div', { style: 'position:relative' });
  page.append(crumbBar, boardHost);

  // Бічна панель картки — одна на всю сторінку, живе над дошкою й не
  // знищується при перемонтуванні вкладених рівнів. panelStack — стек
  // кадрів {item, ctx, view}: view — 'settings' (налаштування картки) чи
  // 'contents' (вкладена дошка всередині неї); той самий стек росте, коли
  // всередині вкладеної дошки клікають ще глибшу картку.
  const panel = el('div', { class: 'map-side-panel' });
  let panelStack = [];
  let panelNestedCtl = null;

  function closePanel() {
    panelStack = [];
    panel.classList.remove('open');
    if (panelNestedCtl) { panelNestedCtl.destroy(); panelNestedCtl = null; }
    panel.textContent = '';
  }
  function popPanel() {
    panelStack.pop();
    if (!panelStack.length) closePanel();
    else renderPanelFrame();
  }
  async function openPanelFrame(view, item, ctx) {
    const top = panelStack[panelStack.length - 1];
    if (top && top.item.id === item.id) top.view = view;
    else panelStack.push({ item, ctx, view });
    panel.classList.add('open');
    if (view === 'contents' && !item.link && ctx.canCreate) {
      try {
        const { id } = await api.post(`/client_maps/${ctx.mapId}/children`, { name: (item.text || '').trim() || 'Без назви' });
        item.link = id;
        ctx.save();
      } catch (e) { toast(e.message, true); }
    }
    await renderPanelFrame();
  }

  function tabBtn(label, active, onclick) {
    return el('button', { class: `btn small${active ? ' primary' : ''}`, onclick }, label);
  }

  async function renderPanelFrame() {
    if (panelNestedCtl) { panelNestedCtl.destroy(); panelNestedCtl = null; }
    panel.textContent = '';
    if (!panelStack.length) return;
    const frame = panelStack[panelStack.length - 1];
    const titleEl = el('b', {}, frame.item.text || 'Без назви');
    const head = el('div', { class: 'map-side-panel-head' },
      panelStack.length > 1 ? el('button', { class: 'btn small icon-only', title: 'Назад', onclick: popPanel }, icon('chevronLeft', 15)) : null,
      el('div', { class: 'map-side-panel-title' }, titleEl,
        el('div', { class: 'map-side-panel-tabs' },
          tabBtn('Налаштування', frame.view === 'settings', () => { frame.view = 'settings'; renderPanelFrame(); }),
          tabBtn('Вміст', frame.view === 'contents', () => openPanelFrame('contents', frame.item, frame.ctx)))),
      el('button', { class: 'btn small icon-only', title: 'Закрити', onclick: closePanel }, icon('close', 14)));
    const body = el('div', { class: 'map-side-panel-body' });
    panel.append(head, body);
    if (frame.view === 'settings') {
      renderSettingsBody(body, frame, titleEl);
    } else if (!frame.item.link) {
      body.append(el('div', { class: 'muted' },
        frame.ctx.canCreate ? 'Не вдалося створити вміст.' : 'Вмісту ще немає, а прав його створити — немає.'));
    } else {
      body.style.padding = '0';
      const host = el('div', { class: 'map-area embedded' });
      body.append(host);
      panelNestedCtl = await buildBoard(frame.item.link, host, { embedded: true });
    }
  }

  function renderSettingsBody(body, frame, titleEl) {
    const item = frame.item, ctx = frame.ctx;
    const textarea = el('textarea', {
      rows: 4,
      oninput: () => {
        ctx.captureBaseline();
        item.text = textarea.value;
        titleEl.textContent = item.text || 'Без назви';
        ctx.renderItems();
        ctx.save();
      },
      onblur: () => ctx.commitHistory(),
    }, item.text || '');
    const colorRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, ...ITEM_COLORS.map((c) => el('button', {
      type: 'button', class: `map-color-swatch${item.color === c.key ? ' active' : ''}`, style: `background:${c.bg};border-color:${c.stroke}`,
      onclick: () => { ctx.captureBaseline(); item.color = c.key; ctx.commitHistory(); ctx.renderItems(); ctx.save(); renderPanelFrame(); },
    })));
    const canOpen = !!item.link || ctx.canCreate;
    body.append(
      el('div', { class: 'field' }, el('label', {}, 'Текст картки'), textarea),
      el('div', { class: 'field' }, el('label', {}, 'Колір'), colorRow),
      el('button', {
        class: 'btn primary', style: 'align-self:flex-start', disabled: !canOpen,
        onclick: () => canOpen && openPanelFrame('contents', item, ctx),
      }, withIcon('folder', item.link ? 'Відкрити вміст картки' : 'Створити вміст картки')),
      ctx.canDelete ? el('button', {
        class: 'btn danger', style: 'align-self:flex-start',
        onclick: () => { if (!confirm('Видалити картку?')) return; ctx.removeItem(item.id); closePanel(); },
      }, withIcon('trash', 'Видалити картку')) : null);
  }

  // ── Побудова однієї дошки (кореневої або вкладеної в панелі) ───────────
  async function buildBoard(id, host, { embedded = false } = {}) {
    const toolbar = el('div', { class: 'map-toolbar' });
    const workspace = el('div', { class: 'map-workspace' });
    const arrowsLayer = svgEl('svg', { class: 'map-arrows' });
    const surface = el('div', { class: 'map-surface' }, workspace);
    const viewport = el('div', { class: 'map-viewport' }, surface);
    const hud = el('div', { class: 'map-hud' });
    const area = el('div', { class: `map-area${embedded ? ' embedded' : ''}` }, toolbar, viewport, hud);
    workspace.append(arrowsLayer);
    host.append(area);

    let node, data;
    try {
      const res = await api.get(`/client_maps/${id}/scene`);
      node = res.node;
      data = normalizeScene(res.scene);
    } catch (e) {
      host.textContent = '';
      host.append(el('div', { class: 'card', style: 'margin:12px' },
        el('div', { class: 'error' }, 'Не вдалося завантажити дошку.'),
        el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, String(e?.message || e))));
      return { node: null, destroy() {} };
    }

    let saveTimer = null;
    let destroyed = false;
    let mode = 'select';
    let connectFrom = null;
    let zoom = 1;
    let selected = new Set();
    let history = [];
    let future = [];
    let historyBaseline = null;
    let handDragged = false;

    if (!embedded) {
      window.addEventListener('hashchange', () => { destroyed = true; if (saveTimer) flushSave(); }, { once: true });
    }

    // ── Історія: captureBaseline() перед мутацією знімає стан «до», а
    // commitHistory() одразу після мутації штовхає його в стек — кожна
    // окрема дія (розмістити, видалити, підключити стрілку, відредагувати
    // й піти з поля) це один крок скасування. Дебаунс лишається тільки в
    // збереженні на сервер — commit не чекає на нього, інакше дві швидкі
    // дії поспіль (два розміщення картки за 500мс) злипались би в один
    // крок скасування замість двох. ─────────────────────────────────────
    function snapshot() { return JSON.parse(JSON.stringify({ items: data.items, arrows: data.arrows })); }
    function captureBaseline() { if (!historyBaseline) historyBaseline = snapshot(); }
    function commitHistory() {
      if (historyBaseline) {
        history.push(historyBaseline);
        if (history.length > 50) history.shift();
        historyBaseline = null;
        future = [];
      }
      renderHud();
    }
    function undo() {
      if (!history.length) return;
      future.push(snapshot());
      const prev = history.pop();
      data.items = prev.items; data.arrows = prev.arrows;
      selected = new Set();
      renderItems();
      scheduleSave();
    }
    function redo() {
      if (!future.length) return;
      history.push(snapshot());
      const next = future.pop();
      data.items = next.items; data.arrows = next.arrows;
      selected = new Set();
      renderItems();
      scheduleSave();
    }

    async function flushSave() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      try { await api.put(`/client_maps/${node.id}/scene`, { scene: data }); }
      catch (e) { toast(e.message, true); }
    }
    function scheduleSave() {
      if (!canEdit) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { if (!destroyed) flushSave(); }, 500);
    }

    // Клікова точка у «логічних» координатах workspace — ділимо на зум,
    // бо getBoundingClientRect() повертає вже візуально масштабований
    // прямокутник (transform це змінює), а координати елементів завжди
    // нескейлені.
    function localPoint(e) {
      const rect = workspace.getBoundingClientRect();
      return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
    }

    function applyZoom() {
      workspace.style.transform = `scale(${zoom})`;
      surface.style.width = `${WORLD_W * zoom}px`;
      surface.style.height = `${WORLD_H * zoom}px`;
    }
    function zoomBy(delta) {
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(zoom + delta).toFixed(2)));
      applyZoom();
    }

    function setMode(next) {
      mode = next;
      connectFrom = null;
      viewport.className = `map-viewport${mode === 'hand' ? ' mode-hand' : mode.startsWith('place:') ? ' mode-place' : ''}`;
      renderToolbar();
      renderItems();
    }

    function toolBtn({ activeIf, iconName, title, onclick }) {
      return el('button', { class: `btn icon-only${activeIf ? ' primary' : ''}`, title, onclick }, icon(iconName, 17));
    }

    function renderToolbar() {
      toolbar.textContent = '';
      toolbar.append(
        toolBtn({ activeIf: mode === 'select', iconName: 'pointer', title: 'Курсор — виділяти й тягати елементи (рамкою — декілька)', onclick: () => setMode('select') }),
        toolBtn({ activeIf: mode === 'hand', iconName: 'hand', title: 'Рука — гортати простір; клік по картці заходить всередину', onclick: () => setMode('hand') }),
        canCreate ? toolBtn({ activeIf: mode === 'connect', iconName: 'send', title: 'Стрілка — з’єднати два елементи', onclick: () => setMode(mode === 'connect' ? 'select' : 'connect') }) : null,
        canCreate ? el('div', { class: 'sep' }) : null,
        canCreate ? toolBtn({ activeIf: mode === 'place:card', iconName: 'folder', title: 'Додати картку', onclick: () => setMode(mode === 'place:card' ? 'select' : 'place:card') }) : null,
        canCreate ? toolBtn({ activeIf: mode === 'place:sticker', iconName: 'tag', title: 'Додати стікер', onclick: () => setMode(mode === 'place:sticker' ? 'select' : 'place:sticker') }) : null,
        canCreate ? toolBtn({ activeIf: mode === 'place:text', iconName: 'fileText', title: 'Додати текст', onclick: () => setMode(mode === 'place:text' ? 'select' : 'place:text') }) : null,
        canCreate ? toolBtn({ activeIf: mode === 'place:heading', iconName: 'heading', title: 'Додати заголовок', onclick: () => setMode(mode === 'place:heading' ? 'select' : 'place:heading') }) : null,
        canCreate ? toolBtn({ activeIf: mode === 'place:select', iconName: 'dropdown', title: 'Додати спадне меню', onclick: () => setMode(mode === 'place:select' ? 'select' : 'place:select') }) : null,
        canCreate ? toolBtn({ activeIf: mode === 'place:table', iconName: 'grid', title: 'Додати таблицю', onclick: () => setMode(mode === 'place:table' ? 'select' : 'place:table') }) : null,
        el('div', { class: 'map-toolbar-zoom' },
          toolBtn({ iconName: 'zoomIn', title: 'Наблизити', onclick: () => zoomBy(ZOOM_STEP) }),
          toolBtn({ iconName: 'zoomOut', title: 'Віддалити', onclick: () => zoomBy(-ZOOM_STEP) })));
    }

    function renderHud() {
      hud.textContent = '';
      hud.append(
        el('button', { class: 'btn small icon-only', title: 'Скасувати', disabled: !history.length, onclick: () => undo() }, icon('undo', 15)),
        el('button', { class: 'btn small icon-only', title: 'Повторити', disabled: !future.length, onclick: () => redo() }, icon('redo', 15)));
    }

    // Клік по порожньому місцю: у режимі place:* ставить новий елемент, у
    // режимі «рука» — якщо влучили в картку (елементи прозорі для кліку,
    // тож e.target тут завжди сам workspace) — заходить усередину неї.
    workspace.addEventListener('click', (e) => {
      if (e.target !== workspace) return;
      if (mode.startsWith('place:')) {
        const kind = mode.slice('place:'.length);
        const { x: lx, y: ly } = localPoint(e);
        captureBaseline();
        const item = makeItem(kind, 0, 0);
        const size = itemSize(item);
        item.x = Math.max(0, lx - size.w / 2);
        item.y = Math.max(0, ly - size.h / 2);
        data.items.push(item);
        commitHistory();
        setMode('select');
        scheduleSave();
        // Щойно розміщену картку одразу відкриваємо в панелі налаштувань —
        // не треба клікати вдруге, щоб дати їй назву; інші види елементів
        // редагуються прямо на канві, тож просто фокусуємо їх поле.
        if (kind === 'card') openPanelFrame('settings', item, ctx);
        else workspace.querySelector(`[data-item-id="${item.id}"] [contenteditable="true"]`)?.focus();
        return;
      }
      if (mode === 'hand') {
        if (handDragged) { handDragged = false; return; }
        const { x: lx, y: ly } = localPoint(e);
        const hit = [...data.items].reverse().find((it) => it.kind === 'card'
          && lx >= it.x && lx <= it.x + itemSize(it).w && ly >= it.y && ly <= it.y + itemSize(it).h);
        if (hit) openPanelFrame('contents', hit, ctx);
      }
    });

    // Рука: перетягування порожнього простору гортає дошку, нічого не
    // рухаючи; handDragged відрізняє це від «просто клікнули картку».
    viewport.addEventListener('pointerdown', (e) => {
      if (mode !== 'hand') return;
      const startX = e.clientX, startY = e.clientY;
      const startLeft = viewport.scrollLeft, startTop = viewport.scrollTop;
      viewport.classList.add('panning');
      handDragged = false;
      const onMove = (ev) => {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) handDragged = true;
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

    // Виділення рамкою — тільки в режимі курсора, старт з порожнього
    // місця; захоплені елементи потім тягаються всі разом.
    workspace.addEventListener('pointerdown', (e) => {
      if (mode !== 'select' || e.target !== workspace) return;
      const start = localPoint(e);
      const box = el('div', { class: 'map-marquee' });
      workspace.append(box);
      let last = { x: start.x, y: start.y, w: 0, h: 0 };
      const onMove = (ev) => {
        const p = localPoint(ev);
        const x = Math.min(start.x, p.x), y = Math.min(start.y, p.y);
        const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
        box.style.left = `${x}px`; box.style.top = `${y}px`; box.style.width = `${w}px`; box.style.height = `${h}px`;
        last = { x, y, w, h };
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        box.remove();
        if (last.w < 4 && last.h < 4) { selected = new Set(); renderItems(); return; }
        const next = new Set();
        for (const it of data.items) {
          const s = itemSize(it);
          if (it.x < last.x + last.w && it.x + s.w > last.x && it.y < last.y + last.h && it.y + s.h > last.y) next.add(it.id);
        }
        selected = next;
        renderItems();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });

    function removeItem(itemId) {
      captureBaseline();
      data.items = data.items.filter((i) => i.id !== itemId);
      data.arrows = data.arrows.filter((a) => a.from !== itemId && a.to !== itemId);
      selected.delete(itemId);
      commitHistory();
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
        onclick: () => { captureBaseline(); item.color = c.key; commitHistory(); row.remove(); renderItems(); scheduleSave(); },
      })));
      document.body.append(row);
      const close = (e) => { if (!row.contains(e.target)) { row.remove(); document.removeEventListener('mousedown', close); } };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
    }

    function startDrag(e, item) {
      if (mode !== 'select') return;
      if (e.target.closest('button, [contenteditable="true"], select')) return;
      if (!selected.has(item.id)) {
        // Оновлюємо саме виділення точково (класами), а не через
        // renderItems() — той знищив би й наново створив DOM-вузол, по
        // якому щойно стався pointerdown, і клік, який мав відкрити
        // панель картки, до вже відірваного від DOM елемента не дійде.
        for (const id of selected) workspace.querySelector(`[data-item-id="${id}"]`)?.classList.remove('selected');
        selected = new Set([item.id]);
        workspace.querySelector(`[data-item-id="${item.id}"]`)?.classList.add('selected');
      }
      const group = selected.size > 1 ? [...selected] : [item.id];
      const startX = e.clientX, startY = e.clientY;
      const origins = new Map(group.map((id) => { const it = data.items.find((x) => x.id === id); return [id, { x: it.x, y: it.y }]; }));
      const divs = new Map(group.map((id) => [id, workspace.querySelector(`[data-item-id="${id}"]`)]));
      let dragging = false;
      const onMove = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < 4) return;
        if (!dragging) captureBaseline();
        dragging = true;
        for (const id of group) {
          const it = data.items.find((x) => x.id === id);
          const o = origins.get(id);
          it.x = o.x + dx / zoom; it.y = o.y + dy / zoom;
          const d = divs.get(id);
          if (d) { d.style.left = `${it.x}px`; d.style.top = `${it.y}px`; d.classList.add('dragging'); }
        }
        drawArrows();
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        for (const d of divs.values()) d?.classList.remove('dragging');
        if (dragging) { item._justDragged = true; commitHistory(); scheduleSave(); }
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    }

    function handleConnectClick(itemId) {
      if (!connectFrom) { connectFrom = itemId; renderItems(); return; }
      if (connectFrom !== itemId && !data.arrows.some((a) =>
        (a.from === connectFrom && a.to === itemId) || (a.from === itemId && a.to === connectFrom))) {
        captureBaseline();
        data.arrows.push({ id: newId(), from: connectFrom, to: itemId });
        commitHistory();
        scheduleSave();
      }
      setMode('select');
    }

    function attachCommon(div, item) {
      div.addEventListener('pointerdown', (e) => startDrag(e, item));
      div.addEventListener('click', (e) => {
        if (mode === 'connect') { e.stopPropagation(); handleConnectClick(item.id); return; }
        if (mode === 'select' && item.kind === 'card') {
          if (item._justDragged) { item._justDragged = false; return; }
          if (e.target.closest('button, [contenteditable="true"]')) return;
          e.stopPropagation();
          openPanelFrame('settings', item, ctx);
        }
      });
    }

    // ── Побудова елементів за видом ───────────────────────────────────────
    function buildCard(item) {
      const text = el('div', { class: 'map-item-text' }, item.text || 'Без назви');
      const bar = el('div', { class: 'map-item-bar' },
        colorDot(item),
        el('div', { style: 'flex:1 1 auto' }),
        canDelete ? el('button', {
          class: 'btn small icon-only danger', title: 'Видалити картку',
          onclick: (e) => { e.stopPropagation(); removeItem(item.id); },
        }, icon('trash', 13)) : null);
      const color = colorOf(item.color);
      return el('div', { class: 'map-card', style: `background:${color.bg};border-color:${color.stroke}` }, text, bar);
    }

    function buildSticker(item) {
      const text = el('div', {
        class: 'map-item-text', contenteditable: (canEdit && mode === 'select') ? 'true' : 'false',
        onblur: () => { captureBaseline(); item.text = text.textContent; commitHistory(); scheduleSave(); },
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
        onblur: () => { captureBaseline(); item.text = text.textContent; commitHistory(); scheduleSave(); },
      }, item.text || '');
      const del = canDelete ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити текст', style: 'position:absolute;top:-14px;right:-14px',
        onclick: (e) => { e.stopPropagation(); removeItem(item.id); },
      }, icon('trash', 11)) : null;
      return el('div', { style: 'position:relative' }, text, del);
    }

    function buildHeading(item) {
      const text = el('div', {
        class: 'map-heading', contenteditable: (canEdit && mode === 'select') ? 'true' : 'false',
        onblur: () => { captureBaseline(); item.text = text.textContent; commitHistory(); scheduleSave(); },
      }, item.text || '');
      const del = canDelete ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити заголовок', style: 'position:absolute;top:-14px;right:-14px',
        onclick: (e) => { e.stopPropagation(); removeItem(item.id); },
      }, icon('trash', 11)) : null;
      return el('div', { style: 'position:relative' }, text, del);
    }

    function editSelectOptions(item) {
      const input = el('input', { class: 'map-select-options-input', value: item.options.join(', ') });
      const box = modal('Варіанти спадного меню', el('div', { class: 'field' },
        el('label', {}, 'Через кому'), input),
        [actionButton('Зберегти', () => {
          const opts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
          if (!opts.length) return toast('Потрібен хоча б один варіант', true);
          captureBaseline();
          item.options = opts;
          if (!opts.includes(item.value)) item.value = opts[0];
          commitHistory();
          renderItems();
          scheduleSave();
          box.remove();
        })]);
    }

    function buildSelect(item) {
      const label = el('div', {
        class: 'map-select-label', contenteditable: (canEdit && mode === 'select') ? 'true' : 'false',
        onblur: () => { captureBaseline(); item.label = label.textContent; commitHistory(); scheduleSave(); },
      }, item.label || 'Питання');
      const select = el('select', {
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => { captureBaseline(); item.value = e.target.value; commitHistory(); scheduleSave(); },
      }, ...item.options.map((o) => el('option', { value: o, selected: o === item.value ? true : null }, o)));
      const editBtn = canEdit ? el('button', {
        class: 'btn small icon-only', title: 'Редагувати варіанти',
        onclick: (e) => { e.stopPropagation(); editSelectOptions(item); },
      }, icon('edit', 12)) : null;
      const del = canDelete ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити спадне меню',
        onclick: (e) => { e.stopPropagation(); removeItem(item.id); },
      }, icon('trash', 12)) : null;
      return el('div', { class: 'map-select-wrap' }, label,
        el('div', { class: 'map-select-row' }, select, editBtn, del));
    }

    function buildTable(item) {
      const table = el('table', { class: 'map-table' },
        ...item.cells.map((rowCells, r) => el('tr', {},
          ...rowCells.map((val, c) => el('td', {
            contenteditable: canEdit && mode === 'select' ? 'true' : 'false',
            onblur: (e) => { captureBaseline(); item.cells[r][c] = e.target.textContent; commitHistory(); scheduleSave(); },
          }, val || '')))));
      const addCol = canEdit ? el('button', {
        class: 'btn small icon-only map-table-addcol', title: 'Додати стовпець',
        onclick: (e) => { e.stopPropagation(); captureBaseline(); item.cells.forEach((r) => r.push('')); commitHistory(); renderItems(); scheduleSave(); },
      }, icon('plus', 12)) : null;
      const addRow = canEdit ? el('button', {
        class: 'btn small icon-only map-table-addrow', title: 'Додати рядок',
        onclick: (e) => { e.stopPropagation(); captureBaseline(); item.cells.push(new Array(item.cells[0].length).fill('')); commitHistory(); renderItems(); scheduleSave(); },
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
        else if (item.kind === 'heading') inner = buildHeading(item);
        else if (item.kind === 'select') inner = buildSelect(item);
        else if (item.kind === 'table') inner = buildTable(item);
        else inner = buildCard(item);
        const cls = ['map-item'];
        if (mode === 'connect' && connectFrom === item.id) cls.push('connect-source');
        if (selected.has(item.id)) cls.push('selected');
        const wrap = el('div', { class: cls.join(' '), 'data-item-id': item.id, style: `left:${item.x}px;top:${item.y}px` }, inner);
        attachCommon(wrap, item);
        workspace.append(wrap);
      }
      drawArrows();
      renderHud();
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

    const ctx = { save: scheduleSave, removeItem, renderItems, captureBaseline, commitHistory, canCreate, canDelete, mapId: node.id };

    renderToolbar();
    applyZoom();
    renderItems();

    return {
      node,
      destroy() {
        destroyed = true;
        // Панель монтує/розмонтовує вкладені дошки при переході туди-сюди
        // між рівнями — якщо в цей момент є незбережена (дебаунсена) зміна,
        // її треба дописати одразу, інакше «зайти в картку й одразу назад»
        // тихо губить те, що щойно додали.
        if (saveTimer) flushSave();
      },
    };
  }

  const rootCtl = await buildBoard(mapId, boardHost, { embedded: false });
  if (!rootCtl.node) return page;
  boardHost.append(panel);

  function renameModal() {
    const input = el('input', { value: rootCtl.node.name });
    const box = modal('Назва дошки', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
      [actionButton('Зберегти', async () => {
        if (!input.value.trim()) return toast('Потрібна назва', true);
        try {
          await api.put(`/client_maps/${rootCtl.node.id}`, { name: input.value.trim() });
          rootCtl.node.name = input.value.trim();
          box.remove();
          renderCrumbs();
        } catch (e) { toast(e.message, true); }
      })]);
  }

  function deleteThis() {
    if (!confirm(`Видалити дошку «${rootCtl.node.name}»?`)) return;
    api.del(`/client_maps/${rootCtl.node.id}`)
      .then(() => { location.hash = '#/e/client_maps'; })
      .catch((e) => toast(e.message, true));
  }

  function renderCrumbs() {
    crumbBar.textContent = '';
    crumbBar.append(el('div', { class: 'row', style: 'align-items:center;gap:8px;flex-wrap:wrap' },
      el('a', { href: '#/e/client_maps', style: 'display:inline-flex;align-items:center;gap:4px;font-size:12.5px' },
        icon('chevronLeft', 13), 'Підключення клієнта'),
      el('b', { style: 'font-size:13.5px' }, rootCtl.node.name),
      el('div', { style: 'flex:1 1 auto' }),
      canEdit ? el('button', { class: 'btn small icon-only', title: 'Перейменувати', onclick: renameModal }, icon('edit', 14)) : null,
      canDelete ? el('button', { class: 'btn small icon-only danger', title: 'Видалити цю дошку', onclick: deleteThis }, icon('trash', 14)) : null));
  }
  renderCrumbs();

  return page;
}
