// «Підключення клієнта»: дерево дощок під клієнтом — папка в папці, як у
// Notion, тільки замість тексту всередині кожного вузла дошка з картками
// й стрілочками. Клік по картці, яка веде в дочірню мапу, провалює
// всередину — у межах нашого SPA-роутера, без відкриття нової вкладки.
//
// Свій редактор, а не стороння бібліотека: потрібні були стандартні
// пласкі картки без «мальованого» стилю (клацнув «+ Картка» — картка
// з'явилась) і стрілки, які самі магнітяться між картками, а не вільне
// малювання. Прості div-картки в стилі решти CRM + SVG для ліній дають
// рівно це, без чужого візуального почерку якоїсь бібліотеки.
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

// Кольори картки — перший акцентний колір самого CRM (щоб картки
// виглядали частиною інтерфейсу), решта — кольорові варіанти на вибір,
// як стікери в Miro. Пастельне тло + насичена рамка — та сама мова
// кольору, що вже є в акцентах по всій CRM.
const CARD_COLORS = [
  { key: 'accent', bg: '#e9edfc', stroke: '#6c8cff' },
  { key: 'yellow', bg: '#fff3bf', stroke: '#f2b705' },
  { key: 'pink', bg: '#ffe3ec', stroke: '#f06595' },
  { key: 'green', bg: '#e6fcf5', stroke: '#12b886' },
  { key: 'orange', bg: '#fff0e6', stroke: '#e8590c' },
  { key: 'purple', bg: '#f3f0ff', stroke: '#845ef7' },
];
const colorOf = (key) => CARD_COLORS.find((c) => c.key === key) || CARD_COLORS[0];

const CARD_W = 200, CARD_H = 120;
const newCardId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Точка на межі прямокутника вздовж напрямку від його центру до (dx, dy) —
// той самий прийом, яким стрілка «магнітиться» рівно до краю картки, а не
// висить десь посередині незалежно від того, де картки зараз стоять.
function edgePoint(cx, cy, w, h, dx, dy) {
  if (!dx && !dy) return { x: cx, y: cy };
  const hw = w / 2, hh = h / 2;
  const scale = Math.min(dx ? Math.abs(hw / dx) : Infinity, dy ? Math.abs(hh / dy) : Infinity);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

// ── Сторінка-пікер: картки клієнтів, клік відкриває/створює їхню мапу ────
export async function renderClientMapsPicker() {
  const box = el('div', {});
  const { rows } = await api.get('/clients?limit=300');
  box.append(
    el('div', { class: 'muted', style: 'margin-bottom:14px;font-size:12.5px' },
      'Оберіть клієнта — відкриється (або створиться) дошка з картками й стрілочками для нього'),
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
  const workspace = el('div', { class: 'map-workspace' });
  const arrowsLayer = svgEl('svg', { class: 'map-arrows' });
  const viewport = el('div', { class: 'map-viewport' }, workspace);
  workspace.append(arrowsLayer);
  page.append(crumbBar, viewport);

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
  let mode = 'idle';          // 'idle' | 'connect'
  let connectFrom = null;
  let destroyed = false;
  window.addEventListener('hashchange', () => { destroyed = true; if (saveTimer) clearTimeout(saveTimer); }, { once: true });

  function normalizeScene(scene) {
    if (scene && Array.isArray(scene.cards) && Array.isArray(scene.arrows)) return scene;
    return { cards: [], arrows: [] };
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

  // ── Хлібні крихти + керування самою мапою ──────────────────────────────
  function breadcrumbPath() {
    const path = [];
    for (let cur = byId.get(node.id), hops = 0; cur && hops < 50; hops += 1) {
      path.unshift(cur);
      cur = cur.parent_id == null ? null : byId.get(cur.parent_id);
    }
    return path;
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
      canCreate ? el('button', {
        class: `btn small${mode === 'connect' ? ' primary' : ''}`,
        onclick: () => { mode = mode === 'connect' ? 'idle' : 'connect'; connectFrom = null; renderCrumbs(); renderCards(); },
      }, withIcon('send', mode === 'connect' ? 'Оберіть 2 картки…' : 'Стрілка')) : null,
      canCreate ? el('button', { class: 'btn small primary', onclick: () => addCard() }, withIcon('plus', 'Картка')) : null,
      canDelete ? el('button', { class: 'btn small icon-only danger', title: 'Видалити цю мапу', onclick: () => deleteThis() },
        icon('trash', 14)) : null);
    crumbBar.append(row,
      el('div', { class: 'map-toolbar-hint', style: 'margin-top:4px' },
        mode === 'connect'
          ? (connectFrom ? 'Тепер клікніть другу картку' : 'Клікніть першу картку, від якої піде стрілка')
          : 'Перетягуйте картки мишею; кольоровий кружечок — змінити колір; іконка папки на картці провалює у вкладену мапу'));
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

  // ── Картки ──────────────────────────────────────────────────────────────
  function addCard() {
    const count = data.cards.length;
    const col = count % 5, row = Math.floor(count / 5);
    const card = { id: newCardId(), x: 40 + col * 240, y: 40 + row * 180, text: '', color: 'accent', link: null };
    data.cards.push(card);
    renderCards();
    scheduleSave();
    workspace.querySelector(`[data-card-id="${card.id}"] .map-card-text`)?.focus();
  }

  function removeCard(cardId) {
    data.cards = data.cards.filter((c) => c.id !== cardId);
    data.arrows = data.arrows.filter((a) => a.from !== cardId && a.to !== cardId);
    renderCards();
    scheduleSave();
  }

  async function openOrCreateChild(card) {
    if (card.link) { location.hash = `#/map/${card.link}`; return; }
    if (!canCreate) return;
    try {
      const { id } = await api.post(`/client_maps/${node.id}/children`, { name: card.text.trim() || 'Без назви' });
      card.link = id;
      scheduleSave();
      location.hash = `#/map/${id}`;
    } catch (e) { toast(e.message, true); }
  }

  function colorDot(card) {
    const dot = el('button', {
      type: 'button', class: 'map-card-dot', title: 'Колір картки',
      style: `background:${colorOf(card.color).bg}`,
      onclick: (e) => { e.stopPropagation(); openColorMenu(dot, card); },
    });
    return dot;
  }

  function openColorMenu(anchor, card) {
    const rect = anchor.getBoundingClientRect();
    const row = el('div', {
      style: `position:fixed;left:${rect.left}px;top:${rect.bottom + 6}px;z-index:50;background:var(--panel);`
        + 'border:1px solid var(--line);border-radius:10px;padding:6px;display:flex;gap:6px;box-shadow:var(--shadow)',
    }, ...CARD_COLORS.map((c) => el('button', {
      type: 'button', style: `width:22px;height:22px;border-radius:50%;background:${c.bg};border:2px solid ${c.stroke};cursor:pointer`,
      onclick: () => { card.color = c.key; row.remove(); renderCards(); scheduleSave(); },
    })));
    document.body.append(row);
    const close = (e) => { if (!row.contains(e.target)) { row.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  function startDrag(e, card, cardDiv) {
    if (mode === 'connect') return;
    const startX = e.clientX, startY = e.clientY;
    const origX = card.x, origY = card.y;
    let dragging = false;
    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 4) return;
      dragging = true;
      card.x = origX + dx; card.y = origY + dy;
      cardDiv.style.left = `${card.x}px`;
      cardDiv.style.top = `${card.y}px`;
      cardDiv.classList.add('dragging');
      drawArrows();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      cardDiv.classList.remove('dragging');
      if (dragging) scheduleSave();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  function handleConnectClick(cardId) {
    if (!connectFrom) { connectFrom = cardId; renderCrumbs(); renderCards(); return; }
    if (connectFrom !== cardId && !data.arrows.some((a) =>
      (a.from === connectFrom && a.to === cardId) || (a.from === cardId && a.to === connectFrom))) {
      data.arrows.push({ id: newCardId(), from: connectFrom, to: cardId });
      scheduleSave();
    }
    mode = 'idle'; connectFrom = null;
    renderCrumbs(); renderCards();
  }

  function renderCards() {
    workspace.querySelectorAll('.map-card').forEach((n) => n.remove());
    for (const card of data.cards) {
      const text = el('div', {
        class: 'map-card-text', contenteditable: (canEdit && mode !== 'connect') ? 'true' : 'false',
        onblur: () => { card.text = text.textContent; scheduleSave(); },
        onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); text.blur(); } },
      }, card.text);
      const bar = el('div', { class: 'map-card-bar' },
        colorDot(card),
        el('div', { style: 'flex:1 1 auto' }),
        el('button', {
          class: 'btn small icon-only', title: card.link ? 'Перейти у вкладену мапу' : 'Створити вкладену мапу',
          onclick: (e) => { e.stopPropagation(); openOrCreateChild(card); },
        }, icon('folder', 13)),
        canDelete ? el('button', {
          class: 'btn small icon-only danger', title: 'Видалити картку',
          onclick: (e) => { e.stopPropagation(); removeCard(card.id); },
        }, icon('trash', 13)) : null);
      const color = colorOf(card.color);
      const div = el('div', {
        class: `map-card${mode === 'connect' && connectFrom === card.id ? ' connect-source' : ''}`,
        'data-card-id': card.id,
        style: `left:${card.x}px;top:${card.y}px;background:${color.bg};border-color:${color.stroke}`,
      }, text, bar);
      div.addEventListener('pointerdown', (e) => {
        if (mode === 'connect') return;
        if (e.target.closest('.map-card-bar')) return;
        startDrag(e, card, div);
      });
      div.addEventListener('click', (e) => {
        if (mode !== 'connect') return;
        e.stopPropagation();
        handleConnectClick(card.id);
      });
      workspace.append(div);
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
    const byIdCard = new Map(data.cards.map((c) => [c.id, c]));
    for (const arrow of data.arrows) {
      const a = byIdCard.get(arrow.from), b = byIdCard.get(arrow.to);
      if (!a || !b) continue;
      const ca = { x: a.x + CARD_W / 2, y: a.y + CARD_H / 2 };
      const cb = { x: b.x + CARD_W / 2, y: b.y + CARD_H / 2 };
      const p1 = edgePoint(ca.x, ca.y, CARD_W, CARD_H, cb.x - ca.x, cb.y - ca.y);
      const p2 = edgePoint(cb.x, cb.y, CARD_W, CARD_H, ca.x - cb.x, ca.y - cb.y);
      arrowsLayer.append(svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: 'var(--muted)', 'stroke-width': 2, 'marker-end': 'url(#map-arrowhead)',
      }));
    }
  }

  renderCrumbs();
  renderCards();
  return page;
}
