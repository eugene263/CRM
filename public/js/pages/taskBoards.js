// «Задачі»: простори (Spaces) зі своїм довільним списком учасників, у
// просторі — кілька робочих дошок, на дошці — свої створювані колонки
// (як лідогенераційний канбан, тільки колонки редагує сама людина, а не
// довідник), у колонках — картки з повним функціоналом задачі: статус,
// дедлайн, трекер часу, виконавець, пріоритет, теги, опис, файли, а
// праворуч — коментарі й повна історія дій (Activity), як у ClickUp.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, modal, toast, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';

// Кожен пріоритет — свій колір прапорця (як у ClickUp): від сірого
// «нема» до червоного «терміново». Той самий колір, що на канві дошки,
// що в картці.
const PRIORITIES = [
  { value: '', label: 'Немає', color: '#8d95ab' },
  { value: 'low', label: 'Низький', color: '#748ffc' },
  { value: 'medium', label: 'Середній', color: '#f2b705' },
  { value: 'high', label: 'Високий', color: '#e8590c' },
  { value: 'urgent', label: 'Терміново', color: '#e03131' },
];
const priorityOf = (v) => PRIORITIES.find((p) => p.value === (v || '')) || PRIORITIES[0];

// Кольори тегів — та сама палітра, що вже прижилась у мапах клієнта
// (ITEM_COLORS): один впізнаваний набір кольорів по всій CRM.
const TAG_COLORS = [
  { key: 'accent', hex: '#6c8cff' }, { key: 'yellow', hex: '#f2b705' }, { key: 'pink', hex: '#f06595' },
  { key: 'green', hex: '#12b886' }, { key: 'orange', hex: '#e8590c' }, { key: 'purple', hex: '#845ef7' },
];
const tagColorHex = (key) => (TAG_COLORS.find((c) => c.key === key) || TAG_COLORS[0]).hex;

function tagChip(t) {
  const hex = tagColorHex(t.color);
  return el('span', { class: 'task-tag-chip', style: `background:${hex}22;color:${hex};border-color:${hex}` }, t.name);
}

function formatSeconds(total) {
  const s = Math.max(0, Math.round(total || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h} год ${m} хв`;
  if (m) return `${m} хв`;
  return `${s} с`;
}
const fmtDate = (v) => (v ? String(v).slice(0, 16).replace('T', ' ') : '—');

// Аватарка — кружечок з ініціалами й кольором за id людини (фотографій
// профілю в системі нема, і робити їх заради цього не варто).
const AVATAR_COLORS = ['#6c8cff', '#f2b705', '#f06595', '#12b886', '#e8590c', '#845ef7', '#20a97f', '#4263eb'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}
function avatarEl(name, userId, size = 20) {
  const color = AVATAR_COLORS[Math.abs(Number(userId) || 0) % AVATAR_COLORS.length];
  return el('span', {
    class: 'task-avatar', style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:${color}`,
  }, initials(name));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Спливаюче меню біля кнопки-власника — той самий прийом, що вже є в
// openColorMenu мап клієнта: рендериться в document.body (не всередині
// попапа картки, щоб не обрізалось overflow), закривається кліком повз.
function openPopover(anchor, build) {
  const rect = anchor.getBoundingClientRect();
  const box = el('div', { class: 'task-popover', style: `left:${rect.left}px;top:${rect.bottom + 4}px` });
  build(box, () => box.remove());
  document.body.append(box);
  const close = (e) => { if (!box.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) { box.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
  return box;
}

// ── Пікер просторів (#/e/task_spaces) ─────────────────────────────────────
export async function renderTaskSpacesPicker() {
  const ent = state.meta.task_spaces;
  const canCreate = !!ent.can.create;
  const box = el('div', {});
  const { rows } = await api.get('/task_spaces');

  async function createSpace() {
    const input = el('input', { placeholder: 'Назва простору' });
    const m = modal('Новий простір', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
      [actionButton('Створити', async () => {
        if (!input.value.trim()) return toast('Потрібна назва', true);
        try {
          const { id } = await api.post('/task_spaces', { name: input.value.trim() });
          m.remove();
          location.hash = `#/space/${id}`;
        } catch (e) { toast(e.message, true); }
      })]);
  }

  box.append(
    el('div', { class: 'row', style: 'align-items:center;margin-bottom:14px' },
      el('div', { class: 'muted', style: 'font-size:12.5px;flex:1 1 auto' }, 'Простори — незалежні робочі області зі своїм списком учасників'),
      canCreate ? el('button', { class: 'btn primary', onclick: createSpace }, withIcon('plus', 'Новий простір')) : null),
    rows.length ? el('div', { class: 'list-cards' }, ...rows.map((s) => {
      const card = el('div', { class: 'list-card' },
        el('div', { class: 'list-card-head' }, el('b', {}, s.name)),
        el('div', { class: 'muted', style: 'font-size:12.5px' }, `${s.member_count} учасник(ів) · ${s.board_count} дошок(и)`));
      card.addEventListener('click', () => { location.hash = `#/space/${s.id}`; });
      return card;
    })) : el('div', { class: 'card muted' }, 'Просторів ще немає'));
  return box;
}

// ── Сторінка простору (#/space/:id) ───────────────────────────────────────
export async function renderTaskSpace(spaceId) {
  const ent = state.meta.task_spaces;
  const canEdit = !!ent.can.update;
  const canCreate = !!ent.can.create;
  const canDelete = !!ent.can.delete;

  const page = el('div', {});
  let data;
  try { data = await api.get(`/task_spaces/${spaceId}`); }
  catch (e) {
    page.append(el('div', { class: 'card' }, el('div', { class: 'error' }, e.message)));
    return page;
  }
  const { space, members, boards } = data;
  const memberIds = new Set(members.map((m) => m.user_id));

  const head = el('div', {});
  const body = el('div', { class: 'row', style: 'align-items:flex-start;margin-top:14px' });
  page.append(head, body);

  function renderHead() {
    head.textContent = '';
    head.append(el('div', { class: 'row', style: 'align-items:center;gap:8px' },
      el('a', { href: '#/e/task_spaces', style: 'display:inline-flex;align-items:center;gap:4px;font-size:12.5px' },
        icon('chevronLeft', 13), 'Простори задач'),
      el('b', { style: 'font-size:16px' }, space.name),
      el('div', { style: 'flex:1 1 auto' }),
      canEdit ? el('button', {
        class: 'btn small icon-only', title: 'Перейменувати',
        onclick: () => {
          const input = el('input', { value: space.name });
          const m = modal('Назва простору', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
            [actionButton('Зберегти', async () => {
              if (!input.value.trim()) return toast('Потрібна назва', true);
              await api.put(`/task_spaces/${spaceId}`, { name: input.value.trim() });
              space.name = input.value.trim();
              m.remove(); renderHead();
            })]);
        },
      }, icon('edit', 14)) : null,
      canDelete ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити простір',
        onclick: async () => {
          if (!confirm(`Видалити простір «${space.name}»?`)) return;
          try { await api.del(`/task_spaces/${spaceId}`); location.hash = '#/e/task_spaces'; }
          catch (e) { toast(e.message, true); }
        },
      }, icon('trash', 14)) : null));
  }

  function renderMembers() {
    const list = el('div', { class: 'card', style: 'width:260px;flex:0 0 auto' },
      el('h3', {}, 'Учасники'),
      ...members.map((m) => el('div', { class: 'row', style: 'align-items:center;gap:6px;margin-bottom:6px' },
        el('div', { class: 'with-icon', style: 'flex:1 1 auto' }, icon('user', 14), m.name),
        canEdit ? el('button', {
          class: 'btn small icon-only danger', title: 'Прибрати',
          onclick: async () => {
            await api.del(`/task_spaces/${spaceId}/members/${m.user_id}`);
            members.splice(members.indexOf(m), 1);
            memberIds.delete(m.user_id);
            list.replaceWith(renderMembers());
          },
        }, icon('trash', 12)) : null)));
    if (canEdit) {
      const options = (state.refs.users || []).filter((u) => !memberIds.has(u.id));
      const select = el('select', {}, el('option', { value: '' }, 'додати учасника…'),
        ...options.map((u) => el('option', { value: u.id }, u.label)));
      select.addEventListener('change', async () => {
        if (!select.value) return;
        const { id, label } = options.find((u) => String(u.id) === select.value);
        await api.post(`/task_spaces/${spaceId}/members`, { user_id: id });
        members.push({ user_id: id, name: label });
        memberIds.add(id);
        list.replaceWith(renderMembers());
      });
      list.append(select);
    }
    return list;
  }

  function renderBoards() {
    const wrap = el('div', { style: 'flex:1 1 auto' },
      el('div', { class: 'row', style: 'align-items:center;margin-bottom:10px' },
        el('h3', { style: 'margin:0;flex:1 1 auto' }, 'Робочі дошки'),
        canCreate ? el('button', { class: 'btn primary small', onclick: createBoard }, withIcon('plus', 'Нова дошка')) : null),
      boards.length ? el('div', { class: 'list-cards' }, ...boards.map((b) => {
        const card = el('div', { class: 'list-card' },
          el('div', { class: 'list-card-head' }, el('b', {}, b.name)),
          el('div', { class: 'muted', style: 'font-size:12.5px' }, `${b.card_count} задач(і)`));
        card.addEventListener('click', () => { location.hash = `#/board/${b.id}`; });
        return card;
      })) : el('div', { class: 'card muted' }, 'Дошок ще немає'));
    return wrap;
  }

  function createBoard() {
    const input = el('input', { placeholder: 'Назва дошки' });
    const m = modal('Нова дошка', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
      [actionButton('Створити', async () => {
        if (!input.value.trim()) return toast('Потрібна назва', true);
        const { id } = await api.post(`/task_spaces/${spaceId}/boards`, { name: input.value.trim() });
        m.remove();
        location.hash = `#/board/${id}`;
      })]);
  }

  renderHead();
  body.append(renderMembers(), renderBoards());
  return page;
}

// ── Дошка (#/board/:id): канбан з редагованими колонками ──────────────────
function orderBetween(before, after) {
  if (before == null && after == null) return 1000;
  if (before == null) return after - 1000;
  if (after == null) return before + 1000;
  return (before + after) / 2;
}

export async function renderTaskBoard(boardId) {
  const ent = state.meta.task_spaces;
  const canEdit = !!ent.can.update;
  const canCreate = !!ent.can.create;
  const canDelete = !!ent.can.delete;

  const page = el('div', { style: 'display:flex;flex-direction:column;height:100%' });
  const head = el('div', { style: 'margin-bottom:10px' });
  const kanban = el('div', { class: 'kanban', style: 'flex:1 1 auto' });
  page.append(head, kanban);

  let space, board, members;
  let dragging = null;

  const EDGE = 70, SPEED = 16;
  let scrollDir = 0, scrollRaf = null;
  function updateAutoScroll(e) {
    const rect = kanban.getBoundingClientRect();
    if (e.clientX < rect.left + EDGE) scrollDir = -1;
    else if (e.clientX > rect.right - EDGE) scrollDir = 1;
    else scrollDir = 0;
  }
  function scrollLoop() { if (scrollDir !== 0) kanban.scrollLeft += scrollDir * SPEED; scrollRaf = requestAnimationFrame(scrollLoop); }
  function startAutoScroll() { if (scrollRaf == null) scrollRaf = requestAnimationFrame(scrollLoop); }
  function stopAutoScroll() { if (scrollRaf != null) cancelAnimationFrame(scrollRaf); scrollRaf = null; scrollDir = 0; }
  kanban.addEventListener('dragover', (e) => { e.preventDefault(); updateAutoScroll(e); });
  function clearIndicator() { kanban.querySelectorAll('.kanban-drop-indicator').forEach((n) => n.remove()); }

  function renderHead() {
    head.textContent = '';
    head.append(el('div', { class: 'row', style: 'align-items:center;gap:8px;flex-wrap:wrap' },
      el('a', { href: `#/space/${space.id}`, style: 'display:inline-flex;align-items:center;gap:4px;font-size:12.5px' },
        icon('chevronLeft', 13), space.name),
      el('b', { style: 'font-size:16px' }, board.name),
      el('div', { style: 'flex:1 1 auto' }),
      canEdit ? el('button', {
        class: 'btn small icon-only', title: 'Перейменувати дошку',
        onclick: () => {
          const input = el('input', { value: board.name });
          const m = modal('Назва дошки', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
            [actionButton('Зберегти', async () => {
              if (!input.value.trim()) return toast('Потрібна назва', true);
              await api.put(`/task_boards/${boardId}`, { name: input.value.trim() });
              board.name = input.value.trim();
              m.remove(); renderHead();
            })]);
        },
      }, icon('edit', 14)) : null,
      canDelete ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити дошку',
        onclick: async () => {
          if (!confirm(`Видалити дошку «${board.name}»?`)) return;
          try { await api.del(`/task_boards/${boardId}`); location.hash = `#/space/${space.id}`; }
          catch (e) { toast(e.message, true); }
        },
      }, icon('trash', 14)) : null,
      canCreate ? el('button', { class: 'btn primary small', onclick: addColumn }, withIcon('plus', 'Колонка')) : null));
  }

  async function reload() {
    const res = await api.get(`/task_boards/${boardId}`);
    space = res.space; board = res.board; members = res.members;
    renderHead();
    kanban.textContent = '';
    kanban.append(...res.columns.map(renderColumn));
  }

  function addColumn() {
    const input = el('input', { placeholder: 'Назва колонки' });
    const m = modal('Нова колонка', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
      [actionButton('Створити', async () => {
        if (!input.value.trim()) return toast('Потрібна назва', true);
        try { await api.post(`/task_boards/${boardId}/columns`, { name: input.value.trim() }); m.remove(); await reload(); }
        catch (e) { toast(e.message, true); }
      })]);
  }

  function renameColumn(col) {
    const input = el('input', { value: col.name });
    const m = modal('Назва колонки', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
      [actionButton('Зберегти', async () => {
        if (!input.value.trim()) return toast('Потрібна назва', true);
        await api.put(`/task_columns/${col.id}`, { name: input.value.trim() });
        m.remove(); await reload();
      })]);
  }

  function deleteColumn(col) {
    if (!confirm(`Видалити колонку «${col.name}»?`)) return;
    api.del(`/task_columns/${col.id}`).then(reload).catch((e) => toast(e.message, true));
  }

  function addCard(col) {
    api.post(`/task_boards/${boardId}/cards`, { column_id: col.id, title: 'Без назви' })
      .then(async ({ id }) => { await reload(); openTaskCard(id, reload); })
      .catch((e) => toast(e.message, true));
  }

  function renderColumn(col) {
    const cards = el('div', { class: 'kanban-cards' }, ...col.cards.map(renderCard));
    const column = el('div', { class: 'kanban-col' },
      el('div', { class: 'kanban-col-head row', style: 'align-items:center;gap:4px' },
        el('div', { class: 'kanban-col-title', style: 'flex:1 1 auto' }, `${col.name} · ${col.cards.length}`),
        canEdit ? el('button', { class: 'btn small icon-only', title: 'Перейменувати', onclick: () => renameColumn(col) }, icon('edit', 12)) : null,
        canDelete ? el('button', { class: 'btn small icon-only danger', title: 'Видалити колонку', onclick: () => deleteColumn(col) }, icon('trash', 12)) : null),
      cards,
      canCreate ? el('button', { class: 'btn small', style: 'margin-top:8px;width:100%', onclick: () => addCard(col) }, withIcon('plus', 'Картка')) : null);

    function dropTarget(clientY) {
      const items = [...cards.querySelectorAll('.kanban-card')].filter((c) => Number(c.dataset.cardId) !== dragging?.id);
      let index = items.length;
      for (let i = 0; i < items.length; i += 1) {
        const rect = items[i].getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) { index = i; break; }
      }
      return { items, index };
    }
    column.addEventListener('dragover', (e) => {
      e.preventDefault(); column.classList.add('drag-over');
      const { items, index } = dropTarget(e.clientY);
      clearIndicator();
      const indicator = el('div', { class: 'kanban-drop-indicator' });
      if (items[index]) cards.insertBefore(indicator, items[index]); else cards.appendChild(indicator);
    });
    column.addEventListener('dragleave', (e) => { if (!column.contains(e.relatedTarget)) column.classList.remove('drag-over'); });
    column.addEventListener('drop', async (e) => {
      e.preventDefault(); column.classList.remove('drag-over');
      const { items, index } = dropTarget(e.clientY);
      clearIndicator();
      if (!dragging) return;
      const before = index > 0 ? Number(items[index - 1].dataset.order) : null;
      const after = index < items.length ? Number(items[index].dataset.order) : null;
      try { await api.post(`/task_cards/${dragging.id}/move`, { column_id: col.id, board_order: orderBetween(before, after) }); }
      catch (e2) { toast(e2.message, true); }
      await reload();
    });
    return column;
  }

  function renderCard(c) {
    const p = priorityOf(c.priority);
    const priorityIcon = c.priority ? icon('flag', 13) : null;
    if (priorityIcon) priorityIcon.style.color = p.color;
    const card = el('div', { class: 'kanban-card', draggable: 'true', 'data-card-id': c.id, 'data-order': c.board_order },
      el('div', { class: 'kanban-card-title' }, c.title),
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:6px' },
        c.assignee_name
          ? el('span', { class: 'with-icon', style: 'font-size:12px' }, avatarEl(c.assignee_name, c.assignee_user_id, 16), c.assignee_name)
          : el('span', { class: 'muted', style: 'font-size:12px' }, '—'),
        priorityIcon ? el('span', { title: p.label }, priorityIcon) : null),
      c.due_date ? el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:4px' }, `до ${c.due_date}`) : null,
      c.tags?.length ? el('div', { style: 'margin-top:4px;display:flex;gap:4px;flex-wrap:wrap' }, ...c.tags.map(tagChip)) : null);
    card.addEventListener('dragstart', () => {
      dragging = { id: c.id }; card.classList.add('dragging'); startAutoScroll();
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging'); dragging = null; stopAutoScroll(); clearIndicator();
      kanban.querySelectorAll('.kanban-col').forEach((k) => k.classList.remove('drag-over'));
    });
    card.addEventListener('click', () => openTaskCard(c.id, reload));
    return card;
  }

  await reload();
  return page;
}

// ── Картка задачі: великий попап з полями зліва й Activity/коментарями
// справа — режим редагування, як на скріні ClickUp. ───────────────────────
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function openTaskCard(cardId, onChange = () => {}) {
  const ent = state.meta.task_spaces;
  const canEdit = !!ent.can.update;
  const canDelete = !!ent.can.delete;

  let tickTimer = null;
  function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }
  function closeModal() { stopTick(); bg.remove(); }

  const bg = el('div', { class: 'drawer-bg', onclick: (e) => { if (e.target === bg) closeModal(); } });
  const box = el('div', { class: 'task-drawer' }, el('div', { class: 'muted', style: 'padding:20px' }, 'Завантаження…'));
  bg.append(box);
  document.body.append(bg);

  let d;
  try { d = await api.get(`/task_cards/${cardId}`); }
  catch (e) { box.textContent = ''; box.append(el('div', { class: 'error', style: 'padding:20px' }, e.message)); return; }

  async function refresh() { const fresh = await api.get(`/task_cards/${cardId}`); d = fresh; render(); onChange(); }
  async function patch(fields) {
    try { await api.put(`/task_cards/${cardId}`, fields); await refresh(); }
    catch (e) { toast(e.message, true); }
  }

  function activityText(a) {
    const p = a.payload ? JSON.parse(a.payload) : {};
    const who = a.user_name || 'Хтось';
    switch (a.kind) {
      case 'created': return `${who} створив(ла) цю картку`;
      case 'moved': return `${who} переніс(ла): ${p.from} → ${p.to}${p.auto ? ' (автоматично)' : ''}`;
      case 'assigned': return `${who} призначив(ла): ${p.to}`;
      case 'field_changed': return `${who} змінив(ла) ${p.field}: «${p.from ?? '—'}» → «${p.to ?? '—'}»`;
      case 'tags_changed': return `${who} змінив(ла) теги`;
      case 'time_started': return `${who} запустив(ла) таймер${p.auto ? ' (автоматично, перенесено в «В роботі»)' : ''}`;
      case 'time_stopped': return `${who} зупинив(ла) таймер: +${formatSeconds(p.seconds)}${p.auto ? ' (автоматично, перенесено з «В роботі»)' : ''}`;
      case 'time_edited': return `${who} відредагував(ла) час: ${formatSeconds(p.seconds)}`;
      case 'attachment_added': return `${who} додав(ла) файл: ${p.file_name}`;
      default: return `${who}: ${a.kind}`;
    }
  }

  function fileChip(a, onDelete) {
    return el('div', { class: 'row', style: 'align-items:center;gap:6px;font-size:12.5px' },
      el('a', { href: `/api/task_attachments/${a.id}/file`, target: '_blank', rel: 'noreferrer', class: 'with-icon' }, icon('paperclip', 13), a.file_name),
      onDelete ? el('button', { class: 'btn small icon-only danger', onclick: onDelete }, icon('trash', 11)) : null);
  }

  // Редагувати можна або «скільки хвилин» (швидко), або точні межі «з —
  // до» — якщо заповнено обидва точні поля, вони мають пріоритет.
  function editTimeEntry(entryId) {
    const entry = d.timeEntries.find((t) => t.id === entryId);
    if (!entry) return;
    const minutesInput = el('input', { type: 'number', min: '0', value: Math.round((entry.seconds || 0) / 60) });
    const startInput = el('input', { type: 'datetime-local', value: toLocalInput(entry.started_at) });
    const endInput = el('input', { type: 'datetime-local', value: entry.ended_at ? toLocalInput(entry.ended_at) : '' });
    const m = modal('Редагувати трекер часу', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Скільки часу (хвилин)'), minutesInput),
      el('div', { class: 'muted', style: 'margin:10px 0 6px;font-size:12px' }, 'або точний час, з якого по яку годину:'),
      el('div', { class: 'field' }, el('label', {}, 'З'), startInput),
      el('div', { class: 'field' }, el('label', {}, 'До'), endInput)),
      [actionButton('Зберегти', async () => {
        const body = (startInput.value && endInput.value)
          ? { started_at: new Date(startInput.value).toISOString(), ended_at: new Date(endInput.value).toISOString() }
          : { seconds: Number(minutesInput.value || 0) * 60 };
        try { await api.put(`/task_time_entries/${entryId}`, body); m.remove(); await refresh(); }
        catch (e) { toast(e.message, true); }
      })]);
  }

  function fieldRow(...cells) { return el('div', { class: 'task-field-row' }, ...cells); }
  function fieldCell(iconName, label, valueNode) {
    return el('div', { class: 'task-field-cell' },
      el('div', { class: 'task-field-label' }, icon(iconName, 14), label),
      el('div', { class: 'task-field-value' }, valueNode));
  }

  // ── Виконавець: кнопка з аватаркою+іменем, спливаюче меню з учасниками ──
  function buildAssigneeField(card, members) {
    const btn = el('button', { class: 'task-picker-btn', type: 'button' });
    const m = members.find((x) => x.user_id === card.assignee_user_id);
    btn.append(
      m ? avatarEl(m.name, m.user_id, 20) : el('span', { class: 'task-avatar task-avatar-empty' }, icon('user', 12)),
      el('span', {}, m ? m.name : 'Не призначено'));
    btn.addEventListener('click', () => openPopover(btn, (box2) => {
      box2.append(
        el('div', { class: 'task-popover-item', onclick: () => { patch({ assignee_user_id: null }); box2.remove(); } },
          el('span', { class: 'task-avatar task-avatar-empty' }, icon('user', 12)), 'Не призначено'),
        ...members.map((mm) => el('div', {
          class: 'task-popover-item', onclick: () => { patch({ assignee_user_id: mm.user_id }); box2.remove(); },
        }, avatarEl(mm.name, mm.user_id, 18), mm.name)));
    }));
    return btn;
  }

  // ── Пріоритет: кнопка з кольоровим прапорцем, спливаюче меню варіантів ──
  function buildPriorityField(card) {
    const btn = el('button', { class: 'task-picker-btn', type: 'button' });
    const p = priorityOf(card.priority);
    const ic = icon('flag', 14); ic.style.color = p.color;
    btn.append(ic, el('span', {}, p.label));
    btn.addEventListener('click', () => openPopover(btn, (box2) => {
      box2.append(...PRIORITIES.map((pp) => {
        const ic2 = icon('flag', 14); ic2.style.color = pp.color;
        return el('div', { class: 'task-popover-item', onclick: () => { patch({ priority: pp.value || null }); box2.remove(); } }, ic2, pp.label);
      }));
    }));
    return btn;
  }

  // ── Теги: чипи обраних, спливаючий чекліст усіх тегів дошки + додати/
  // перефарбувати. Кожен тег належить дошці, а не одній картці — обраний
  // тут одразу видно всім карткам, куди його потім призначать. ───────────
  function buildTagsField(cardTags, boardTags, boardId) {
    const wrap = el('div', { class: 'task-tags-value' });
    if (!cardTags.length) wrap.append(el('span', { class: 'muted' }, 'Порожньо'));
    else wrap.append(...cardTags.map(tagChip));
    wrap.addEventListener('click', () => {
      const selected = new Set(cardTags.map((t) => t.id));
      openPopover(wrap, (box2) => {
        async function apply() {
          try { await api.put(`/task_cards/${cardId}/tags`, { tag_ids: [...selected] }); await refresh(); }
          catch (e) { toast(e.message, true); }
        }
        function renderList() {
          box2.textContent = '';
          box2.append(...boardTags.map((t) => {
            const checkbox = el('input', {
              type: 'checkbox', checked: selected.has(t.id) ? true : null,
              onclick: (e) => { e.stopPropagation(); if (e.target.checked) selected.add(t.id); else selected.delete(t.id); apply(); },
            });
            return el('div', { class: 'task-popover-item task-tag-row' },
              checkbox, tagChip(t), el('div', { style: 'flex:1 1 auto' }),
              el('button', {
                class: 'btn small icon-only', title: 'Редагувати тег',
                onclick: (e) => { e.stopPropagation(); box2.remove(); editTag(t, boardId); },
              }, icon('edit', 11)));
          }));
          const newInput = el('input', { placeholder: 'Новий тег', style: 'font-size:12.5px' });
          const addNew = async () => {
            const name = newInput.value.trim();
            if (!name) return;
            try {
              const { id } = await api.post(`/task_boards/${boardId}/tags`, { name, color: 'accent' });
              boardTags.push({ id, name, color: 'accent' });
              selected.add(id);
              newInput.value = '';
              await apply();
              renderList();
            } catch (e) { toast(e.message, true); }
          };
          newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNew(); });
          box2.append(el('div', { class: 'task-tag-new-row' }, newInput,
            el('button', { class: 'btn small icon-only', onclick: addNew }, icon('plus', 12))));
        }
        renderList();
      });
    });
    return wrap;
  }

  function editTag(tag, boardId) {
    const nameInput = el('input', { value: tag.name });
    const colorRow = el('div', { style: 'display:flex;gap:8px;margin-top:6px' }, ...TAG_COLORS.map((c) => el('button', {
      type: 'button', class: `map-color-swatch${tag.color === c.key ? ' active' : ''}`, style: `background:${c.hex};border-color:${c.hex}`,
      onclick: async () => { tag.color = c.key; await api.put(`/task_tags/${tag.id}`, { color: c.key }); m.remove(); await refresh(); },
    })));
    const m = modal('Редагувати тег', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Назва'), nameInput),
      el('div', { class: 'field' }, el('label', {}, 'Колір'), colorRow)),
      [actionButton('Зберегти', async () => {
        try { await api.put(`/task_tags/${tag.id}`, { name: nameInput.value.trim() || tag.name }); m.remove(); await refresh(); }
        catch (e) { toast(e.message, true); }
      }),
      actionButton('Видалити тег', async () => {
        if (!confirm(`Видалити тег «${tag.name}» з усіх карток?`)) return;
        try { await api.del(`/task_tags/${tag.id}`); m.remove(); await refresh(); }
        catch (e) { toast(e.message, true); }
      }, { className: 'btn danger' })]);
  }

  function render() {
    const { card, space, board, columns, members, attachments, comments, tags, boardTags, timeEntries, activity, runningTimer, totalSeconds } = d;
    box.textContent = '';
    stopTick();

    // ── Ліва частина: поля задачі — той самий вигляд, що на референсі:
    // рядки з іконкою+назвою зліва, значенням справа, по два поля в рядок. ─
    const titleInput = el('input', {
      class: 'task-title', value: card.title,
      onblur: () => titleInput.value.trim() && titleInput.value.trim() !== card.title && patch({ title: titleInput.value.trim() }),
    });
    const statusSelect = el('select', {
      class: 'task-status-select',
      onchange: () => api.post(`/task_cards/${cardId}/move`, { column_id: Number(statusSelect.value) }).then(refresh).then(onChange),
    }, ...columns.map((c) => el('option', { value: c.id, selected: c.id === card.column_id ? true : null }, c.name)));

    // Дедлайн і дата початку — клік будь-де по полю (не лише по значку
    // календаря) одразу відкриває вибір дати: showPicker() саме для цього.
    const startInput = el('input', {
      type: 'date', value: card.start_date || '', title: 'Дата початку',
      onclick: (e) => e.target.showPicker?.(), onchange: () => patch({ start_date: startInput.value || null }),
    });
    const dueInput = el('input', {
      type: 'date', value: card.due_date || '', title: 'Дедлайн',
      onclick: (e) => e.target.showPicker?.(), onchange: () => patch({ due_date: dueInput.value || null }),
    });
    const datesCell = el('div', { style: 'display:flex;align-items:center;gap:6px' }, startInput, el('span', { class: 'muted' }, '→'), dueInput);

    const assigneeField = buildAssigneeField(card, members);
    const priorityField = buildPriorityField(card);
    const tagsField = buildTagsField(tags, boardTags, board.id);

    // ── Трекер часу: кнопка старт/стоп + живий лічильник секунд, поки йде
    // (без переліку «Власник Власник…» — усі старти/стопи й так видно в
    // Activity праворуч, звідти ж їх і редагують). ─────────────────────
    const isRunning = !!runningTimer;
    const timerBtn = el('button', {
      class: `btn small${isRunning ? ' danger' : ' primary'}`,
      onclick: async () => {
        try { await api.post(`/task_cards/${cardId}/timer/${isRunning ? 'stop' : 'start'}`); await refresh(); }
        catch (e) { toast(e.message, true); }
      },
    }, withIcon(isRunning ? 'pause' : 'play', isRunning ? 'Зупинити' : 'Почати'));
    const timeLabel = el('span', { class: 'muted', style: 'font-size:12px' }, formatSeconds(totalSeconds));
    if (isRunning) {
      const startedAt = new Date(runningTimer.started_at).getTime();
      const tick = () => { timeLabel.textContent = formatSeconds(totalSeconds + Math.floor((Date.now() - startedAt) / 1000)); };
      tick();
      tickTimer = setInterval(tick, 1000);
    }
    const timerCell = el('div', { style: 'display:flex;align-items:center;gap:8px' }, timerBtn, timeLabel);

    const descArea = el('textarea', {
      class: 'task-desc', rows: 4, placeholder: 'Додати опис задачі…',
      onblur: () => descArea.value !== (card.description || '') && patch({ description: descArea.value }),
    }, card.description || '');

    const fileInput = el('input', { type: 'file', style: 'display:none' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0]; if (!file) return;
      const dataUrl = await readFileAsDataUrl(file);
      try { await api.post(`/task_cards/${cardId}/attachments`, { file_name: file.name, mime: file.type, content: dataUrl }); await refresh(); }
      catch (e) { toast(e.message, true); }
      fileInput.value = '';
    });

    const main = el('div', { class: 'task-drawer-main' },
      el('div', { class: 'row', style: 'align-items:center;gap:8px' },
        el('div', { class: 'task-drawer-crumb', style: 'flex:1 1 auto' }, [space?.name, board?.name].filter(Boolean).join(' / ')),
        canDelete ? el('button', {
          class: 'btn small icon-only danger', title: 'Видалити картку',
          onclick: async () => { if (!confirm('Видалити картку?')) return; await api.del(`/task_cards/${cardId}`); closeModal(); onChange(); },
        }, icon('trash', 14)) : null,
        el('button', { class: 'btn small icon-only', onclick: closeModal }, icon('close', 14))),
      titleInput,
      el('div', { class: 'task-field-table' },
        fieldRow(fieldCell('dot', 'Статус', statusSelect), fieldCell('user', 'Виконавець', assigneeField)),
        fieldRow(fieldCell('calendar', 'Дати', datesCell), fieldCell('flag', 'Пріоритет', priorityField)),
        fieldRow(fieldCell('clock', 'Трекер часу', timerCell), fieldCell('tag', 'Теги', tagsField))),
      descArea,
      el('div', { class: 'task-attach-list' },
        ...attachments.map((a) => fileChip(a, canDelete ? async () => { await api.del(`/task_attachments/${a.id}`); await refresh(); } : null))),
      el('button', { class: 'task-quick-row', onclick: () => fileInput.click() }, icon('paperclip', 14), 'Прикріпити файл'), fileInput);

    // ── Права частина: Activity + коментарі ────────────────────────────
    const feedItems = [
      ...activity.map((a) => {
        const p = a.payload ? JSON.parse(a.payload) : {};
        const clickable = (a.kind === 'time_started' || a.kind === 'time_stopped') && p.entry_id;
        const textNode = el('div', clickable ? { class: 'activity-clickable', title: 'Редагувати запис часу', onclick: () => editTimeEntry(p.entry_id) } : {}, activityText(a));
        return { created_at: a.created_at, node: el('div', { class: 'activity-item' },
          el('div', { class: 'activity-bullet' }),
          el('div', { class: 'activity-body' }, textNode, el('div', { class: 'muted', style: 'font-size:11px' }, fmtDate(a.created_at)))) };
      }),
      ...comments.map((c) => ({ created_at: c.created_at, node: el('div', { class: 'activity-item comment' },
        el('div', { class: 'activity-bullet' }),
        el('div', { class: 'activity-body' },
          el('div', {}, el('b', {}, c.user_name || 'Хтось'), ': ', c.body),
          c.attachments.length ? el('div', { style: 'margin-top:4px;display:flex;flex-direction:column;gap:2px' }, ...c.attachments.map((a) => fileChip(a))) : null,
          el('div', { class: 'muted', style: 'font-size:11px' }, fmtDate(c.created_at)))) })),
    ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    const feed = el('div', { class: 'activity-feed' }, ...feedItems.map((it) => it.node));

    const commentInput = el('textarea', { rows: 2, placeholder: 'Написати коментар…' });
    const commentFile = el('input', { type: 'file', style: 'display:none' });
    let pendingAttachment = null;
    commentFile.addEventListener('change', async () => {
      const file = commentFile.files[0]; if (!file) return;
      pendingAttachment = { file_name: file.name, mime: file.type, content: await readFileAsDataUrl(file) };
      toast(`Файл додано до коментаря: ${file.name}`);
    });
    const sendComment = async () => {
      const body = commentInput.value.trim();
      if (!body && !pendingAttachment) return;
      try {
        await api.post(`/task_cards/${cardId}/comments`, { body, attachments: pendingAttachment ? [pendingAttachment] : [] });
        commentInput.value = ''; pendingAttachment = null; commentFile.value = '';
        await refresh();
      } catch (e) { toast(e.message, true); }
    };

    const side = el('div', { class: 'task-drawer-side' },
      el('div', { class: 'task-drawer-side-head' }, 'Activity'),
      feed,
      el('div', { class: 'task-comment-box' },
        commentInput,
        el('div', { class: 'task-comment-toolbar' },
          el('button', { class: 'btn small icon-only', title: 'Прикріпити файл', onclick: () => commentFile.click() }, icon('paperclip', 13)),
          commentFile,
          el('div', { style: 'flex:1 1 auto' }),
          el('button', { class: 'btn small primary', onclick: sendComment }, 'Надіслати'))));

    box.append(main, side);
    feed.scrollTop = feed.scrollHeight;
  }

  render();
}
