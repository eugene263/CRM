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

let uidCounter = 0;
const uid = () => `u${Date.now().toString(36)}${(uidCounter += 1)}`;

// ── Спільні пікери полів — використовуються і в компактному вигляді на
// плашці картки в канбані, і в повній картці. onSet(patchFields) сам
// вирішує, що робити зі зміною (PUT + reload канбану чи PUT + refresh
// модалки) — сюди про це знати не треба. { compact } ховає текстову
// підпись, лишаючи тільки іконку/аватарку — для тісного рядка на картці.
function buildAssigneeField(card, members, onSet, { size = 20, compact = false } = {}) {
  const btn = el('button', { class: `task-picker-btn${compact ? ' mini' : ''}`, type: 'button', title: 'Виконавець' });
  const m = members.find((x) => x.user_id === card.assignee_user_id);
  btn.append(m ? avatarEl(m.name, m.user_id, size) : el('span', { class: 'task-avatar task-avatar-empty' }, icon('user', Math.round(size * 0.6))));
  if (!compact) btn.append(el('span', {}, m ? m.name : 'Не призначено'));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, (box2) => {
      box2.append(
        el('div', { class: 'task-popover-item', onclick: () => { onSet({ assignee_user_id: null }); box2.remove(); } },
          el('span', { class: 'task-avatar task-avatar-empty' }, icon('user', 12)), 'Не призначено'),
        ...members.map((mm) => el('div', {
          class: 'task-popover-item', onclick: () => { onSet({ assignee_user_id: mm.user_id }); box2.remove(); },
        }, avatarEl(mm.name, mm.user_id, 18), mm.name)));
    });
  });
  return btn;
}

function buildPriorityField(card, onSet, { compact = false } = {}) {
  const btn = el('button', { class: `task-picker-btn${compact ? ' mini' : ''}`, type: 'button', title: 'Пріоритет' });
  const p = priorityOf(card.priority);
  const ic = icon('flag', 14); ic.style.color = p.color;
  btn.append(ic);
  if (!compact) btn.append(el('span', {}, p.label));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, (box2) => {
      box2.append(...PRIORITIES.map((pp) => {
        const ic2 = icon('flag', 14); ic2.style.color = pp.color;
        return el('div', { class: 'task-popover-item', onclick: () => { onSet({ priority: pp.value || null }); box2.remove(); } }, ic2, pp.label);
      }));
    });
  });
  return btn;
}

// compact=false — інлайн-пара «дедлайн і дата початку» (повна картка);
// compact=true — одна кнопка-іконка з попапом на обидві дати (плашка в
// канбані). Клік будь-де по полю (не лише по значку календаря) одразу
// відкриває вибір дати: showPicker() саме для цього.
function buildDatesField(card, onSet, { compact = false } = {}) {
  if (!compact) {
    const startInput = el('input', {
      type: 'date', value: card.start_date || '', title: 'Дата початку',
      onclick: (e) => e.target.showPicker?.(), onchange: () => onSet({ start_date: startInput.value || null }),
    });
    const dueInput = el('input', {
      type: 'date', value: card.due_date || '', title: 'Дедлайн',
      onclick: (e) => e.target.showPicker?.(), onchange: () => onSet({ due_date: dueInput.value || null }),
    });
    return el('div', { style: 'display:flex;align-items:center;gap:6px' }, startInput, el('span', { class: 'muted' }, '→'), dueInput);
  }
  const btn = el('button', { class: 'task-picker-btn mini', type: 'button', title: 'Дати' });
  btn.append(icon('calendar', 13));
  if (card.due_date) btn.append(el('span', {}, card.due_date));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, (box2) => {
      const startInput = el('input', { type: 'date', value: card.start_date || '', onchange: () => onSet({ start_date: startInput.value || null }) });
      const dueInput = el('input', { type: 'date', value: card.due_date || '', onchange: () => onSet({ due_date: dueInput.value || null }) });
      box2.append(
        el('div', { class: 'task-popover-item', style: 'cursor:default' }, el('span', { class: 'muted', style: 'width:32px' }, 'З'), startInput),
        el('div', { class: 'task-popover-item', style: 'cursor:default' }, el('span', { class: 'muted', style: 'width:32px' }, 'До'), dueInput));
    });
  });
  return btn;
}

// Теги належать дошці (task_tags), а не одній картці — обраний тут одразу
// видно всім карткам, куди його потім призначать. applyIds(ids) — записує
// вибір саме для ЦІЄЇ картки; afterTagsChanged() — сигнал «щось на дошці
// змінилось» (створили/перефарбували/видалили тег), той контекст, звідки
// викликано (канбан чи модалка), сам вирішує, що освіжити.
function buildTagsField(cardTags, boardTags, boardId, applyIds, afterTagsChanged, { compact = false } = {}) {
  let wrap;
  if (compact) {
    wrap = el('button', { class: 'task-picker-btn mini', type: 'button', title: 'Теги' });
    wrap.append(icon('tag', 13));
    if (cardTags.length) wrap.append(el('span', {}, String(cardTags.length)));
  } else {
    wrap = el('div', { class: 'task-tags-value' });
    if (!cardTags.length) wrap.append(el('span', { class: 'muted' }, 'Порожньо'));
    else wrap.append(...cardTags.map(tagChip));
  }
  wrap.addEventListener('click', (e) => {
    e.stopPropagation();
    const selected = new Set(cardTags.map((t) => t.id));
    openPopover(wrap, (box2) => {
      async function apply() {
        try { await applyIds([...selected]); } catch (err) { toast(err.message, true); }
      }
      function renderList() {
        box2.textContent = '';
        box2.append(...boardTags.map((t) => {
          const checkbox = el('input', {
            type: 'checkbox', checked: selected.has(t.id) ? true : null,
            onclick: (ev) => { ev.stopPropagation(); if (ev.target.checked) selected.add(t.id); else selected.delete(t.id); apply(); },
          });
          return el('div', { class: 'task-popover-item task-tag-row' },
            checkbox, tagChip(t), el('div', { style: 'flex:1 1 auto' }),
            el('button', {
              class: 'btn small icon-only', title: 'Редагувати тег',
              onclick: (ev) => { ev.stopPropagation(); box2.remove(); editTagModal(t, boardId, afterTagsChanged); },
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
          } catch (err) { toast(err.message, true); }
        };
        newInput.addEventListener('keydown', (e2) => { if (e2.key === 'Enter') addNew(); });
        box2.append(el('div', { class: 'task-tag-new-row' }, newInput,
          el('button', { class: 'btn small icon-only', onclick: addNew }, icon('plus', 12))));
      }
      renderList();
    });
  });
  return wrap;
}

function editTagModal(tag, boardId, afterChange) {
  const nameInput = el('input', { value: tag.name });
  const colorRow = el('div', { style: 'display:flex;gap:8px;margin-top:6px' }, ...TAG_COLORS.map((c) => el('button', {
    type: 'button', class: `map-color-swatch${tag.color === c.key ? ' active' : ''}`, style: `background:${c.hex};border-color:${c.hex}`,
    onclick: async () => {
      try { await api.put(`/task_tags/${tag.id}`, { color: c.key }); m.remove(); await afterChange(); }
      catch (e) { toast(e.message, true); }
    },
  })));
  const m = modal('Редагувати тег', el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Назва'), nameInput),
    el('div', { class: 'field' }, el('label', {}, 'Колір'), colorRow)),
    [actionButton('Зберегти', async () => {
      try { await api.put(`/task_tags/${tag.id}`, { name: nameInput.value.trim() || tag.name }); m.remove(); await afterChange(); }
      catch (e) { toast(e.message, true); }
    }),
    actionButton('Видалити тег', async () => {
      if (!confirm(`Видалити тег «${tag.name}» з усіх карток?`)) return;
      try { await api.del(`/task_tags/${tag.id}`); m.remove(); await afterChange(); }
      catch (e) { toast(e.message, true); }
    }, { className: 'btn danger' })]);
}

// ── Опис задачі: Notion-подібний редактор блоків (текст/чек-лист/таблиця/
// спадний список). Зберігає масив блоків цілком, з дебаунсом — не на
// кожен символ, а через паузу в наборі, щоб не бити PUT щосекунди й не
// засмічувати Activity. Стара «description» (plain text) лишається лише
// як стартова точка для карток, де блоків ще нема. ─────────────────────
function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; }

function makeBlock(type) {
  if (type === 'checklist') return { id: uid(), type, items: [{ id: uid(), text: '', checked: false }] };
  if (type === 'table') return { id: uid(), type, rows: [['', ''], ['', '']] };
  if (type === 'toggle') return { id: uid(), type, title: '', text: '', open: true };
  return { id: uid(), type: 'paragraph', text: '' };
}

function renderDescriptionEditor(card, onSave) {
  let blocks = (card.description_blocks && card.description_blocks.length)
    ? card.description_blocks.map((b) => ({ ...b }))
    : [{ ...makeBlock('paragraph'), text: card.description || '' }];
  const wrap = el('div', { class: 'desc-blocks' });
  let saveTimer = null;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => onSave(blocks), 500); }

  function insertAfter(index, type) { blocks.splice(index + 1, 0, makeBlock(type)); renderAll(); scheduleSave(); }
  function removeBlock(index) {
    blocks = blocks.length > 1 ? blocks.filter((_, i) => i !== index) : [makeBlock('paragraph')];
    renderAll(); scheduleSave();
  }

  function blockTypeMenu(anchor, index) {
    openPopover(anchor, (box2) => {
      box2.append(
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); insertAfter(index, 'paragraph'); } }, icon('heading', 13), 'Текст'),
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); insertAfter(index, 'checklist'); } }, icon('checkSquare', 13), 'Чек-лист'),
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); insertAfter(index, 'table'); } }, icon('table', 13), 'Таблиця'),
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); insertAfter(index, 'toggle'); } }, icon('chevronDown', 13), 'Спадний список'));
    });
  }

  function renderParagraph(b) {
    const ta = el('textarea', {
      class: 'desc-block-text', rows: 1, placeholder: 'Текст…',
      oninput: () => { autoGrow(ta); b.text = ta.value; scheduleSave(); },
    }, b.text || '');
    setTimeout(() => autoGrow(ta), 0);
    return ta;
  }

  function renderChecklist(b) {
    const list = el('div', { class: 'desc-checklist' });
    function renderItems() {
      list.textContent = '';
      if (!b.items?.length) b.items = [{ id: uid(), text: '', checked: false }];
      b.items.forEach((it, ii) => {
        const cb = el('input', { type: 'checkbox', checked: it.checked ? true : null, onchange: () => { it.checked = cb.checked; scheduleSave(); } });
        const txt = el('input', {
          class: 'desc-checklist-text', value: it.text, placeholder: 'Пункт…',
          oninput: () => { it.text = txt.value; scheduleSave(); },
          onkeydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); b.items.splice(ii + 1, 0, { id: uid(), text: '', checked: false }); renderItems(); scheduleSave(); }
          },
        });
        const rm = el('button', { class: 'btn small icon-only', title: 'Видалити пункт', onclick: () => { b.items.splice(ii, 1); renderItems(); scheduleSave(); } }, icon('close', 10));
        list.append(el('div', { class: 'desc-checklist-row' }, cb, txt, rm));
      });
    }
    renderItems();
    return list;
  }

  function renderTable(b) {
    if (!b.rows?.length) b.rows = [['', ''], ['', '']];
    const wrapTable = el('div', { class: 'desc-table-wrap' });
    function renderGrid() {
      wrapTable.textContent = '';
      const table = el('table', { class: 'desc-table' },
        ...b.rows.map((row) => el('tr', {}, ...row.map((cell, ci) => el('td', {},
          el('input', {
            value: cell, oninput: (e) => { row[ci] = e.target.value; scheduleSave(); },
          }))))));
      const toolbar = el('div', { class: 'desc-table-toolbar' },
        el('button', { class: 'btn small icon-only', title: 'Додати рядок', onclick: () => { b.rows.push(b.rows[0].map(() => '')); renderGrid(); scheduleSave(); } }, icon('plus', 11), 'рядок'),
        el('button', { class: 'btn small icon-only', title: 'Додати стовпець', onclick: () => { b.rows.forEach((row) => row.push('')); renderGrid(); scheduleSave(); } }, icon('plus', 11), 'стовпець'),
        b.rows.length > 1 ? el('button', { class: 'btn small icon-only', title: 'Прибрати рядок', onclick: () => { b.rows.pop(); renderGrid(); scheduleSave(); } }, icon('minus', 11), 'рядок') : null,
        b.rows[0].length > 1 ? el('button', { class: 'btn small icon-only', title: 'Прибрати стовпець', onclick: () => { b.rows.forEach((row) => row.pop()); renderGrid(); scheduleSave(); } }, icon('minus', 11), 'стовпець') : null);
      wrapTable.append(table, toolbar);
    }
    renderGrid();
    return wrapTable;
  }

  function renderToggle(b) {
    const body = el('textarea', {
      class: 'desc-block-text', rows: 1, placeholder: 'Прихований текст…',
      style: b.open ? '' : 'display:none',
      oninput: () => { autoGrow(body); b.text = body.value; scheduleSave(); },
    }, b.text || '');
    const chevron = icon('chevronDown', 13);
    chevron.style.transform = b.open ? 'rotate(0deg)' : 'rotate(-90deg)';
    const toggleBtn = el('button', { class: 'btn small icon-only', title: b.open ? 'Згорнути' : 'Розгорнути', onclick: () => { b.open = !b.open; body.style.display = b.open ? '' : 'none'; chevron.style.transform = b.open ? 'rotate(0deg)' : 'rotate(-90deg)'; if (b.open) setTimeout(() => autoGrow(body), 0); scheduleSave(); } }, chevron);
    const titleInput = el('input', {
      class: 'desc-toggle-title', value: b.title || '', placeholder: 'Заголовок спадного списку…',
      oninput: () => { b.title = titleInput.value; scheduleSave(); },
    });
    setTimeout(() => autoGrow(body), 0);
    return el('div', {}, el('div', { class: 'desc-toggle-head' }, toggleBtn, titleInput), body);
  }

  function renderBlockContent(b) {
    if (b.type === 'checklist') return renderChecklist(b);
    if (b.type === 'table') return renderTable(b);
    if (b.type === 'toggle') return renderToggle(b);
    return renderParagraph(b);
  }

  function renderAll() {
    wrap.textContent = '';
    wrap.append(...blocks.map((b, i) => {
      const plusBtn = el('button', { class: 'desc-block-plus', type: 'button', title: 'Додати блок' }, icon('plus', 12));
      plusBtn.addEventListener('click', (e) => { e.stopPropagation(); blockTypeMenu(plusBtn, i); });
      const delBtn = el('button', { class: 'desc-block-del', type: 'button', title: 'Видалити блок', onclick: () => removeBlock(i) }, icon('trash', 11));
      return el('div', { class: 'desc-block' }, el('div', { class: 'desc-block-gutter' }, plusBtn, delBtn), renderBlockContent(b));
    }));
  }
  renderAll();
  return wrap;
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

  let space, board, members, boardTags;
  let dragging = null;
  let draggingColumn = null;
  // Живі лічильники таймерів прямо на плашках картки (requirement: видно
  // «скільки вже пройшло», не заходячи в картку) — інтервали з попереднього
  // рендеру канбану інакше продовжують цокати в порожнечу після reload().
  let activeIntervals = [];

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
  function clearIndicator() { kanban.querySelectorAll('.kanban-drop-indicator').forEach((n) => n.remove()); }
  function clearColumnIndicator() { kanban.querySelectorAll('.kanban-col-drop-indicator').forEach((n) => n.remove()); }

  // ── Перетягування КОЛОНОК (за заголовок) — окремо від перетягування
  // карток: держимо їх у різних змінних (dragging/draggingColumn), і кожен
  // обробник на початку виходить, якщо йде «чужий» тип перетягування. ────
  function columnDropIndex(clientX) {
    const cols = [...kanban.querySelectorAll('.kanban-col')].filter((c) => Number(c.dataset.columnId) !== draggingColumn?.id);
    let index = cols.length;
    for (let i = 0; i < cols.length; i += 1) {
      const rect = cols[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) { index = i; break; }
    }
    return { cols, index };
  }
  kanban.addEventListener('dragover', (e) => {
    e.preventDefault(); updateAutoScroll(e);
    if (!draggingColumn) return;
    const { cols, index } = columnDropIndex(e.clientX);
    clearColumnIndicator();
    const indicator = el('div', { class: 'kanban-col-drop-indicator' });
    const addTile = kanban.querySelector('.kanban-add-col');
    if (cols[index]) kanban.insertBefore(indicator, cols[index]); else kanban.insertBefore(indicator, addTile);
  });
  kanban.addEventListener('drop', async (e) => {
    if (!draggingColumn) return;
    e.preventDefault();
    const { cols, index } = columnDropIndex(e.clientX);
    clearColumnIndicator();
    const before = index > 0 ? Number(cols[index - 1].dataset.order) : null;
    const after = index < cols.length ? Number(cols[index].dataset.order) : null;
    try { await api.put(`/task_columns/${draggingColumn.id}`, { board_order: orderBetween(before, after) }); }
    catch (e2) { toast(e2.message, true); }
    await reload();
  });

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
      }, icon('trash', 14)) : null));
  }

  async function reload() {
    activeIntervals.forEach(clearInterval); activeIntervals = [];
    const res = await api.get(`/task_boards/${boardId}`);
    space = res.space; board = res.board; members = res.members; boardTags = res.boardTags;
    renderHead();
    kanban.textContent = '';
    kanban.append(...res.columns.map(renderColumn), addColumnTile());
  }

  // ── Нова колонка — плитка праворуч від останньої, а не кнопка в шапці
  // дошки; колір обирається одразу при створенні (та сама палітра, що й у
  // тегів). ────────────────────────────────────────────────────────────
  function addColumnTile() {
    if (!canCreate) return el('div', {});
    return el('button', { class: 'kanban-add-col', onclick: addColumn }, icon('plus', 15), 'Колонка');
  }

  function addColumn() {
    const input = el('input', { placeholder: 'Назва колонки' });
    let color = TAG_COLORS[0].key;
    const colorRow = el('div', { style: 'display:flex;gap:8px;margin-top:6px' });
    function renderSwatches() {
      colorRow.textContent = '';
      colorRow.append(...TAG_COLORS.map((c) => el('button', {
        type: 'button', class: `map-color-swatch${color === c.key ? ' active' : ''}`, style: `background:${c.hex};border-color:${c.hex}`,
        onclick: () => { color = c.key; renderSwatches(); },
      })));
    }
    renderSwatches();
    const m = modal('Нова колонка', el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
      el('div', { class: 'field' }, el('label', {}, 'Колір'), colorRow)),
      [actionButton('Створити', async () => {
        if (!input.value.trim()) return toast('Потрібна назва', true);
        try { await api.post(`/task_boards/${boardId}/columns`, { name: input.value.trim(), color }); m.remove(); await reload(); }
        catch (e) { toast(e.message, true); }
      })]);
  }

  async function toggleCollapse(col) {
    try { await api.put(`/task_columns/${col.id}`, { collapsed: !col.collapsed }); await reload(); }
    catch (e) { toast(e.message, true); }
  }

  function startRename(col, pillEl) {
    const input = el('input', { value: col.name, class: 'kanban-col-rename-input' });
    pillEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = async () => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (v && v !== col.name) {
        try { await api.put(`/task_columns/${col.id}`, { name: v }); } catch (e) { toast(e.message, true); }
      }
      await reload();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = col.name; input.blur(); } });
    input.addEventListener('blur', commit);
  }

  function deleteColumn(col) {
    if (!confirm(`Видалити колонку «${col.name}»?`)) return;
    api.del(`/task_columns/${col.id}`).then(reload).catch((e) => toast(e.message, true));
  }

  // ── Меню «⋮» колонки: згорнути, перейменувати, змінити колір, видалити. ─
  function columnMenu(col, anchor, pillEl) {
    openPopover(anchor, (box2) => {
      box2.append(
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); toggleCollapse(col); } },
          icon(col.collapsed ? 'chevronRight' : 'chevronLeft', 13), col.collapsed ? 'Розгорнути' : 'Згорнути'),
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); startRename(col, pillEl); } },
          icon('edit', 13), 'Перейменувати'),
        el('div', { class: 'task-popover-item', style: 'cursor:default;flex-direction:column;align-items:flex-start;gap:6px' },
          el('div', { class: 'with-icon' }, icon('sparkles', 13), 'Колір'),
          el('div', { style: 'display:flex;gap:6px' }, ...TAG_COLORS.map((c) => el('button', {
            type: 'button', class: `map-color-swatch${col.color === c.key ? ' active' : ''}`, style: `width:18px;height:18px;background:${c.hex};border-color:${c.hex}`,
            onclick: async (e) => {
              e.stopPropagation(); box2.remove();
              try { await api.put(`/task_columns/${col.id}`, { color: c.key }); await reload(); }
              catch (err) { toast(err.message, true); }
            },
          })))),
        canDelete ? el('div', { class: 'task-popover-item danger', onclick: () => { box2.remove(); deleteColumn(col); } },
          icon('trash', 13), 'Видалити') : null);
    });
  }

  // ── Швидке створення картки — заголовок + одразу виконавець/дати/
  // пріоритет/теги, без відкриття повної картки (як на референсі). Save
  // або Enter — зберігає; повну картку можна доредагувати, відкривши її
  // після створення. ───────────────────────────────────────────────────
  function buildQuickAdd(col, onDone) {
    const draft = { assignee_user_id: null, due_date: null, start_date: null, priority: null, tag_ids: [] };
    let tagsLoaded = false;
    let localBoardTags = [];
    const titleInput = el('input', { class: 'quick-add-title', placeholder: 'Назва задачі…' });
    const rowsWrap = el('div', { class: 'quick-add-rows' });

    function fieldRowMini(iconName, label, valueText, onClick) {
      return el('button', { class: 'quick-add-row', type: 'button', onclick: onClick },
        icon(iconName, 14), el('span', { class: valueText ? '' : 'muted' }, valueText || label));
    }

    function renderRows() {
      rowsWrap.textContent = '';
      const assigneeName = draft.assignee_user_id ? members.find((m) => m.user_id === draft.assignee_user_id)?.name : null;
      const datesLabel = (draft.start_date || draft.due_date) ? `${draft.start_date || '…'} → ${draft.due_date || '…'}` : null;
      const priorityLabel = draft.priority ? priorityOf(draft.priority).label : null;
      const tagsLabel = draft.tag_ids.length ? `${draft.tag_ids.length} тег(и)` : null;
      rowsWrap.append(
        fieldRowMini('user', 'Виконавець', assigneeName, (e) => {
          e.stopPropagation();
          openPopover(e.currentTarget, (box2) => {
            box2.append(
              el('div', { class: 'task-popover-item', onclick: () => { draft.assignee_user_id = null; box2.remove(); renderRows(); } },
                el('span', { class: 'task-avatar task-avatar-empty' }, icon('user', 12)), 'Не призначено'),
              ...members.map((mm) => el('div', {
                class: 'task-popover-item', onclick: () => { draft.assignee_user_id = mm.user_id; box2.remove(); renderRows(); },
              }, avatarEl(mm.name, mm.user_id, 18), mm.name)));
          });
        }),
        fieldRowMini('calendar', 'Дати', datesLabel, (e) => {
          e.stopPropagation();
          openPopover(e.currentTarget, (box2) => {
            const startInput = el('input', { type: 'date', value: draft.start_date || '', onchange: () => { draft.start_date = startInput.value || null; renderRows(); } });
            const dueInput = el('input', { type: 'date', value: draft.due_date || '', onchange: () => { draft.due_date = dueInput.value || null; renderRows(); } });
            box2.append(
              el('div', { class: 'task-popover-item', style: 'cursor:default' }, el('span', { class: 'muted', style: 'width:30px' }, 'З'), startInput),
              el('div', { class: 'task-popover-item', style: 'cursor:default' }, el('span', { class: 'muted', style: 'width:30px' }, 'До'), dueInput));
          });
        }),
        fieldRowMini('flag', 'Пріоритет', priorityLabel, (e) => {
          e.stopPropagation();
          openPopover(e.currentTarget, (box2) => {
            box2.append(...PRIORITIES.filter((p) => p.value).map((pp) => {
              const ic2 = icon('flag', 14); ic2.style.color = pp.color;
              return el('div', { class: 'task-popover-item', onclick: () => { draft.priority = pp.value; box2.remove(); renderRows(); } }, ic2, pp.label);
            }));
          });
        }),
        fieldRowMini('tag', 'Тег', tagsLabel, async (e) => {
          e.stopPropagation();
          if (!tagsLoaded) {
            tagsLoaded = true;
            try { localBoardTags = (await api.get(`/task_boards/${board.id}/tags`)).rows; } catch { /* тегів ще нема — не критично */ }
          }
          openPopover(e.currentTarget, (box2) => {
            if (!localBoardTags.length) { box2.append(el('div', { class: 'muted', style: 'padding:6px 8px;font-size:12px' }, 'Тегів на дошці ще нема')); return; }
            box2.append(...localBoardTags.map((t) => {
              const cb = el('input', {
                type: 'checkbox', checked: draft.tag_ids.includes(t.id) ? true : null,
                onclick: (ev) => {
                  ev.stopPropagation();
                  if (ev.target.checked) draft.tag_ids.push(t.id); else draft.tag_ids = draft.tag_ids.filter((x) => x !== t.id);
                  renderRows();
                },
              });
              return el('div', { class: 'task-popover-item' }, cb, tagChip(t));
            }));
          });
        }),
      );
    }
    renderRows();

    async function save() {
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }
      try {
        await api.post(`/task_boards/${boardId}/cards`, { column_id: col.id, title, ...draft });
        onDone(true);
      } catch (e) { toast(e.message, true); }
    }
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') onDone(false);
    });

    const box = el('div', { class: 'quick-add-box' },
      el('div', { class: 'quick-add-title-row' }, titleInput,
        el('button', { class: 'btn small primary', onclick: save }, 'Зберегти ↵')),
      rowsWrap);
    setTimeout(() => titleInput.focus(), 0);
    return box;
  }

  function renderColumn(col) {
    const hex = tagColorHex(col.color);

    if (col.collapsed) {
      const column = el('div', { class: 'kanban-col collapsed', 'data-column-id': col.id, 'data-order': col.board_order },
        el('div', { class: 'kanban-col-collapsed-head', draggable: canEdit ? 'true' : 'false' },
          el('button', { class: 'btn small icon-only', title: 'Розгорнути', onclick: () => toggleCollapse(col) }, icon('chevronRight', 13))),
        el('div', { class: 'kanban-col-collapsed-title', style: `color:${hex}` }, col.name),
        el('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' }, String(col.cards.length)));
      const head = column.querySelector('.kanban-col-collapsed-head');
      head.addEventListener('dragstart', (e) => { draggingColumn = { id: col.id }; column.classList.add('dragging-col'); e.dataTransfer.effectAllowed = 'move'; });
      head.addEventListener('dragend', () => { draggingColumn = null; column.classList.remove('dragging-col'); clearColumnIndicator(); });
      return column;
    }

    const cards = el('div', { class: 'kanban-cards' }, ...col.cards.map(renderCard));
    const pill = el('span', { class: 'kanban-col-pill', style: `background:${hex}22;color:${hex}` }, col.name);
    const menuBtn = el('button', { class: 'btn small icon-only col-menu-btn', title: 'Меню колонки', onclick: (e) => { e.stopPropagation(); columnMenu(col, menuBtn, pill); } }, icon('more', 14));
    const addBtn = canCreate ? el('button', { class: 'btn small icon-only col-add-btn', title: 'Додати задачу', onclick: (e) => { e.stopPropagation(); showForm(); } }, icon('plus', 14)) : null;
    const headRow = el('div', { class: 'kanban-col-head', draggable: canEdit ? 'true' : 'false' },
      pill, el('span', { class: 'muted', style: 'font-size:12px;margin-left:6px' }, String(col.cards.length)),
      el('div', { style: 'flex:1 1 auto' }), addBtn, menuBtn);

    const addWrap = el('div', {});
    function showTrigger() {
      addWrap.textContent = '';
      if (canCreate) addWrap.append(el('button', { class: 'btn small', style: 'margin-top:8px;width:100%', onclick: () => showForm() }, withIcon('plus', 'Додати задачу')));
    }
    function showForm() {
      addWrap.textContent = '';
      addWrap.append(buildQuickAdd(col, (created) => { showTrigger(); if (created) reload(); }));
    }
    showTrigger();

    const column = el('div', { class: 'kanban-col', 'data-column-id': col.id, 'data-order': col.board_order },
      headRow, cards, addWrap);

    headRow.addEventListener('dragstart', (e) => {
      draggingColumn = { id: col.id }; column.classList.add('dragging-col'); e.dataTransfer.effectAllowed = 'move';
    });
    headRow.addEventListener('dragend', () => { draggingColumn = null; column.classList.remove('dragging-col'); clearColumnIndicator(); });

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
      if (draggingColumn) return; // йде перетягування колонки, а не картки
      e.preventDefault(); column.classList.add('drag-over');
      const { items, index } = dropTarget(e.clientY);
      clearIndicator();
      const indicator = el('div', { class: 'kanban-drop-indicator' });
      if (items[index]) cards.insertBefore(indicator, items[index]); else cards.appendChild(indicator);
    });
    column.addEventListener('dragleave', (e) => { if (!column.contains(e.relatedTarget)) column.classList.remove('drag-over'); });
    column.addEventListener('drop', async (e) => {
      if (draggingColumn) return;
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
    const card = el('div', { class: 'kanban-card', draggable: 'true', 'data-card-id': c.id, 'data-order': c.board_order },
      el('div', { class: 'kanban-card-title' }, c.title));

    const miniPatch = async (fields) => {
      try { await api.put(`/task_cards/${c.id}`, fields); await reload(); }
      catch (e) { toast(e.message, true); }
    };
    const tagsApply = async (ids) => { await api.put(`/task_cards/${c.id}/tags`, { tag_ids: ids }); await reload(); };

    const miniRow = el('div', { class: 'kanban-card-mini-row' },
      buildAssigneeField(c, members, miniPatch, { size: 18, compact: true }),
      buildDatesField(c, miniPatch, { compact: true }),
      buildPriorityField(c, miniPatch, { compact: true }),
      buildTagsField(c.tags || [], boardTags, board.id, tagsApply, reload, { compact: true }));

    let timerNode = null;
    if (c.timer_running_since) {
      const startedAt = new Date(c.timer_running_since).getTime();
      const timeText = el('span', {}, formatSeconds(c.total_seconds));
      timerNode = el('span', { class: 'kanban-card-timer live' }, icon('clock', 12), timeText);
      const iv = setInterval(() => { timeText.textContent = formatSeconds(c.total_seconds + Math.floor((Date.now() - startedAt) / 1000)); }, 1000);
      activeIntervals.push(iv);
    } else if (c.total_seconds) {
      timerNode = el('span', { class: 'kanban-card-timer' }, icon('clock', 12), formatSeconds(c.total_seconds));
    }

    card.append(miniRow);
    if (timerNode) card.append(timerNode);
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
      case 'description_changed': return `${who} оновив(ла) опис`;
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

    const datesCell = buildDatesField(card, patch);
    const assigneeField = buildAssigneeField(card, members, patch);
    const priorityField = buildPriorityField(card, patch);
    const tagsField = buildTagsField(
      tags, boardTags, board.id,
      (tagIds) => api.put(`/task_cards/${cardId}/tags`, { tag_ids: tagIds }).then(refresh),
      refresh,
    );

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

    // Автозбереження блоків опису НЕ йде через звичайний patch()/refresh() —
    // той перемальовує всю модалку й скинув би фокус посеред набору тексту.
    // Пишемо напряму, оновлюючи лише локальний card.description_blocks —
    // Activity й «редаговано» підхопить наступний природний refresh().
    const descArea = renderDescriptionEditor(card, async (blocks) => {
      try { await api.put(`/task_cards/${cardId}`, { description_blocks: blocks }); card.description_blocks = blocks; }
      catch (e) { toast(e.message, true); }
    });

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
