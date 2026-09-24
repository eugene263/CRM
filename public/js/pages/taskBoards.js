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

// Куратований набір іконок для плашки дошки у бічному меню — довільна
// іконка з icons.js, а не довільний файл, щоб плашки лишались однаково
// охайними в будь-якій темі.
const BOARD_ICONS = ['grid', 'checkSquare', 'checkCircle', 'flag', 'target', 'folder', 'calendar', 'book', 'layers', 'coins', 'trending', 'award', 'sparkles', 'gauge'];

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
// HH:MM:SS — компактний формат для попапу редагування трекера часу (як на
// референсі), на відміну від «X год Y хв» словами скрізь інде.
function formatHMS(total) {
  const s = Math.max(0, Math.round(total || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
const fmtDate = (v) => (v ? String(v).slice(0, 16).replace('T', ' ') : '—');

// Прогрес-бар «скільки натрекано з estimate» — модульного рівня, бо
// потрібен і в повній картці (над таблицею полів), і на плашці картки в
// канбані (compact); коли estimate не заданий — просто нічого не показуємо.
function progressBarNode(totalSeconds, estimateMinutes, compact = false) {
  if (!estimateMinutes) return null;
  const pct = Math.round(((totalSeconds || 0) / (estimateMinutes * 60)) * 100);
  const clamped = Math.min(100, Math.max(0, pct));
  return el('div', { class: `task-progress${compact ? ' compact' : ''}${pct > 100 ? ' over' : ''}`, title: `Натрекано ${formatSeconds(totalSeconds || 0)} з оцінки ${formatSeconds(estimateMinutes * 60)}` },
    el('div', { class: 'task-progress-track' }, el('div', { class: 'task-progress-fill', style: `width:${clamped}%` })),
    el('span', { class: 'task-progress-pct' }, `${pct}%`));
}

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
// Повторний клік по тій самій кнопці, поки її попап ще відкритий, —
// ЗАКРИВАЄ його, а не відкриває другий поверх першого (був баг). Перевірку
// робимо через box.isConnected, а не окремий «close»-колбек — бо більшість
// викликів самі роблять box2.remove() при виборі пункту, в обхід будь-якого
// колбека, і лише isConnected лишається правдивим джерелом «ще відкрито».
function openPopover(anchor, build) {
  if (anchor._popoverBox && anchor._popoverBox.isConnected) {
    anchor._popoverBox.remove();
    anchor._popoverBox = null;
    return null;
  }
  const rect = anchor.getBoundingClientRect();
  const box = el('div', { class: 'task-popover', style: 'visibility:hidden' });
  build(box, () => box.remove());
  document.body.append(box);
  anchor._popoverBox = box;
  // Позиціонування завжди в межах екрана по обох осях — інакше біля країв
  // (наприклад «+» у глибоко вкладеному спадному списку внизу сторінки)
  // попап вилітав за viewport і ставав недосяжним для кліків.
  // По горизонталі: за замовчуванням ліва межа попапу = ліва межа кнопки,
  // а якщо так вилазить за правий край — приліплюємо ПРАВУ межу попапу до
  // правої межі кнопки, він росте вліво.
  const boxWidth = box.offsetWidth;
  const left = (rect.left + boxWidth > window.innerWidth - 8) ? Math.max(8, rect.right - boxWidth) : rect.left;
  // По вертикалі: за замовчуванням під кнопкою, а якщо так вилазить за
  // нижній край — розкриваємо ВГОРУ від кнопки замість вниз.
  const boxHeight = box.offsetHeight;
  const top = (rect.bottom + 4 + boxHeight > window.innerHeight - 8)
    ? Math.max(8, rect.top - boxHeight - 4)
    : rect.bottom + 4;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.visibility = '';
  const close = (e) => { if (!box.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) { box.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
  return box;
}

let uidCounter = 0;
const uid = () => `u${Date.now().toString(36)}${(uidCounter += 1)}`;

// Нативний <input type=date|time> відкриває календарик по кліку тільки на
// власну малесеньку іконку в правому краї — клік будь-де в полі його НЕ
// відкриває. showPicker() відкриває його з будь-якого кліку по полю
// (старі браузери без підтримки — просто ігноруємо, поле лишається
// звичайним текстовим введенням).
function withPicker(input) {
  input.addEventListener('click', () => { try { input.showPicker(); } catch { /* немає підтримки — ок */ } });
  return input;
}

// Рядок попапу з чекбоксом — клікабельна ВСЯ плашка (не тільки сам
// квадратик чекбокса): клік будь-де в рядку перемикає чекбокс і викликає
// onToggle(checked). Клік по самому чекбоксу теж працює природно (не
// подвоюємо перемикання — беремо вже оновлений e.target.checked).
function checkboxRow(checked, onToggle, ...content) {
  const cb = el('input', { type: 'checkbox', checked: checked ? true : null });
  const apply = () => onToggle(cb.checked);
  cb.addEventListener('click', (e) => { e.stopPropagation(); apply(); });
  return el('div', {
    class: 'task-popover-item', onclick: (e) => { if (e.target === cb) return; cb.checked = !cb.checked; apply(); },
  }, cb, ...content);
}

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

// Статус — та сама кольорова пігулка, що й заголовок колонки на дошці
// (обраний колір колонки), з попапом-списком усіх колонок дошки в їхніх
// власних кольорах. Стрілочка після тексту показує НАПРЯМОК (▶), а не
// «розкривний список» (▼) — це кнопка з попапом, а не native <select>.
function buildStatusField(card, columns, onSet) {
  const current = columns.find((c) => c.id === card.column_id) || columns[0];
  const hex = tagColorHex(current?.color);
  const btn = el('button', {
    class: 'task-status-pill', type: 'button', style: `background:${hex}22;color:${hex}`,
  }, current?.name || '—', icon('chevronRight', 13));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, (box2) => {
      box2.append(...columns.map((c) => {
        const chex = tagColorHex(c.color);
        return el('div', {
          class: 'task-popover-item', onclick: () => { onSet(c.id); box2.remove(); },
        }, el('span', { class: 'kanban-col-pill', style: `background:${chex}22;color:${chex}` }, c.name));
      }));
    });
  });
  return btn;
}

// Кнопка-іконка з попапом на обидві дати (той самий вигляд і в повній
// картці, і на плашці в канбані — компактніша через .mini). Показує
// СКОРОЧЕНО (день.місяць, без року) — сам рік нікуди не дівається, він і в
// значенні, і в попапі вибору, де справді потрібен для вибору конкретної
// дати. { compact } лишає тільки іконку, коли дат ще не вибрано.
const shortDate = (iso) => {
  const parts = String(iso || '').slice(5).split('-');
  return parts.length === 2 && parts[1] ? `${parts[1]}.${parts[0]}` : null;
};
function buildDatesField(card, onSet, { compact = false } = {}) {
  const btn = el('button', { class: `task-picker-btn${compact ? ' mini' : ''}`, type: 'button', title: 'Дати' });
  btn.append(icon('calendar', compact ? 13 : 14));
  const startShort = shortDate(card.start_date);
  const dueShort = shortDate(card.due_date);
  if (startShort || dueShort) btn.append(el('span', {}, `${startShort || '…'} → ${dueShort || '…'}`));
  else if (!compact) btn.append(el('span', { class: 'muted' }, 'Дати'));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, (box2) => {
      const startInput = withPicker(el('input', { type: 'date', value: card.start_date || '', onchange: () => onSet({ start_date: startInput.value || null }) }));
      const dueInput = withPicker(el('input', { type: 'date', value: card.due_date || '', onchange: () => onSet({ due_date: dueInput.value || null }) }));
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
          const checkbox = el('input', { type: 'checkbox', checked: selected.has(t.id) ? true : null });
          const editBtn = el('button', {
            class: 'btn small icon-only', title: 'Редагувати тег',
            onclick: (ev) => { ev.stopPropagation(); box2.remove(); editTagModal(t, boardId, afterTagsChanged); },
          }, icon('edit', 11));
          const toggle = () => { if (checkbox.checked) selected.add(t.id); else selected.delete(t.id); apply(); };
          checkbox.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(); });
          return el('div', {
            class: 'task-popover-item task-tag-row',
            onclick: (ev) => { if (ev.target === checkbox || editBtn.contains(ev.target)) return; checkbox.checked = !checkbox.checked; toggle(); },
          }, checkbox, tagChip(t), el('div', { style: 'flex:1 1 auto' }), editBtn);
        }));
        // Колір нового тегу обирається одразу тут, до створення — не
        // доводиться потім окремо відкривати редагування, щоб перефарбувати.
        let newColor = TAG_COLORS[0].key;
        const newInput = el('input', { placeholder: 'Новий тег', style: 'font-size:12.5px' });
        const swatchRow = el('div', { class: 'task-tag-new-colors' });
        function renderSwatches() {
          swatchRow.textContent = '';
          swatchRow.append(...TAG_COLORS.map((c) => el('button', {
            type: 'button', class: `map-color-swatch${newColor === c.key ? ' active' : ''}`, style: `width:16px;height:16px;background:${c.hex};border-color:${c.hex}`,
            onclick: (ev) => { ev.stopPropagation(); newColor = c.key; renderSwatches(); },
          })));
        }
        renderSwatches();
        const addNew = async () => {
          const name = newInput.value.trim();
          if (!name) return;
          try {
            const { id } = await api.post(`/task_boards/${boardId}/tags`, { name, color: newColor });
            boardTags.push({ id, name, color: newColor });
            selected.add(id);
            newInput.value = '';
            await apply();
            renderList();
          } catch (err) { toast(err.message, true); }
        };
        newInput.addEventListener('keydown', (e2) => { if (e2.key === 'Enter') addNew(); });
        box2.append(el('div', { class: 'task-tag-new-row' }, newInput,
          el('button', { class: 'btn small icon-only', onclick: addNew }, icon('plus', 12))), swatchRow);
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
  if (type === 'toggle') return { id: uid(), type, title: '', open: true, children: [{ id: uid(), type: 'paragraph', text: '' }] };
  if (type === 'columns') return { id: uid(), type, columns: [[{ id: uid(), type: 'paragraph', text: '' }], [{ id: uid(), type: 'paragraph', text: '' }]] };
  return { id: uid(), type: 'paragraph', text: '' };
}

// Текстовий блок опису — contenteditable, тому зберігаємо як HTML. Дозволені
// теги/атрибути — жорсткий allowlist (bold/italic/underline/колір/розмір,
// які й видає наш тулбар через execCommand); усе інше розгортається чи
// прибирається. Санітизуємо ПЕРЕД будь-яким innerHTML-рендером (не лише на
// збереженні) — інакше пряме звернення до API в обхід UI могло б підкласти
// <img onerror=...> чи схоже, і воно виконалось би в браузері іншого учасника
// простору, який відкриє цю картку. ─────────────────────────────────────
const DESC_ALLOWED_TAGS = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'SPAN', 'FONT', 'BR', 'DIV']);
function sanitizeInlineHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstChild;
  function clean(node) {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.COMMENT_NODE) { child.remove(); return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      if (!DESC_ALLOWED_TAGS.has(child.tagName)) {
        while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
        child.remove();
        return;
      }
      [...child.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name === 'style') {
          const safe = [];
          for (const decl of attr.value.split(';')) {
            const [prop, val] = decl.split(':').map((s) => s?.trim());
            if (prop === 'color' && val && /^(#[0-9a-f]{3,8}|rgb\([\d,\s]+\))$/i.test(val)) safe.push(`color:${val}`);
            if (prop === 'font-size' && val && /^\d+(\.\d+)?(px|pt|em)$/.test(val)) safe.push(`font-size:${val}`);
          }
          if (safe.length) child.setAttribute('style', safe.join(';')); else child.removeAttribute('style');
        } else if (name === 'color' && child.tagName === 'FONT') {
          if (!/^#?[0-9a-f]{3,8}$/i.test(attr.value)) child.removeAttribute('color');
        } else {
          child.removeAttribute(attr.name);
        }
      });
      clean(child);
    });
  }
  clean(root);
  return root.innerHTML;
}

function execFormat(div, cmd, value) { div.focus(); document.execCommand(cmd, false, value); }

// Невеличкий рядок-тулбар над текстовим блоком, зʼявляється по фокусу на
// текст (а не floating біля курсору) — жирний/курсив/підкреслений/колір/
// розмір, «самі основні функції». Кнопки bold/italic/underline підсвічуються
// (.active), коли курсор стоїть у тексті з цим форматуванням — видиме
// підтвердження, що вибір «зафіксувався», а не просто клікнувся в порожнечу.
function buildFormatToolbar(div, b, scheduleSave) {
  const sync = () => { b.text = sanitizeInlineHtml(div.innerHTML); scheduleSave(); };
  const stateBtns = [];
  function updateActive() {
    stateBtns.forEach(([cmd, btn]) => {
      try { btn.classList.toggle('active', document.queryCommandState(cmd)); } catch { /* поза фокусом — ігноруємо */ }
    });
  }
  const mk = (iconName, title, action, label) => {
    const btn = el('button', { class: 'desc-fmt-btn', type: 'button', title });
    if (iconName) btn.append(icon(iconName, 13));
    if (label) btn.append(label);
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => { action(); sync(); updateActive(); });
    return btn;
  };
  const boldBtn = mk('bold', 'Жирний', () => execFormat(div, 'bold'));
  const italicBtn = mk('italic', 'Курсив', () => execFormat(div, 'italic'));
  const underlineBtn = mk('underline', 'Підкреслений', () => execFormat(div, 'underline'));
  stateBtns.push(['bold', boldBtn], ['italic', italicBtn], ['underline', underlineBtn]);
  const colorBtn = mk('textColor', 'Колір тексту', () => {}, null);
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(colorBtn, (box2) => {
      box2.append(el('div', { style: 'display:flex;gap:6px;padding:4px' }, ...TAG_COLORS.map((c) => el('button', {
        type: 'button', class: 'map-color-swatch', style: `width:18px;height:18px;background:${c.hex};border-color:${c.hex}`,
        onmousedown: (ev) => ev.preventDefault(),
        onclick: () => { execFormat(div, 'foreColor', c.hex); sync(); box2.remove(); div.focus(); },
      }))));
    });
  });
  const smallerBtn = mk(null, 'Менший розмір', () => execFormat(div, 'fontSize', '2'), 'A-');
  const biggerBtn = mk(null, 'Більший розмір', () => execFormat(div, 'fontSize', '5'), 'A+');
  div.addEventListener('keyup', updateActive);
  div.addEventListener('mouseup', updateActive);
  div.addEventListener('focus', updateActive);
  return el('div', { class: 'desc-fmt-toolbar' }, boldBtn, italicBtn, underlineBtn, colorBtn, smallerBtn, biggerBtn);
}

// Текст — contenteditable з санітизованим HTML і тулбаром форматування по
// фокусу (жирний/курсив/підкреслений/колір/розмір).
function renderParagraph(b, scheduleSave) {
  const div = el('div', { class: 'desc-block-text', contenteditable: 'true', 'data-placeholder': 'Текст…' });
  div.innerHTML = sanitizeInlineHtml(b.text || '');
  const toolbar = buildFormatToolbar(div, b, scheduleSave);
  toolbar.classList.add('hidden');
  div.addEventListener('focus', () => toolbar.classList.remove('hidden'));
  div.addEventListener('blur', () => { toolbar.classList.add('hidden'); b.text = sanitizeInlineHtml(div.innerHTML); scheduleSave(); });
  div.addEventListener('input', () => { b.text = sanitizeInlineHtml(div.innerHTML); scheduleSave(); });
  return el('div', {}, toolbar, div);
}

// Чек-лист — чекбокс і текст щільно поруч, максимально зліва (той самий
// gap, що між іконкою й підписом поля картки).
function renderChecklist(b, scheduleSave) {
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

// A, B, C … Z, AA, AB … — літери колонок (як в Excel/Google Таблицях).
function colLetter(i) {
  let n = i; let s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Таблиця — без кнопок «+ рядок/стовпець»: наведення на клітинку показує
// маленькі приглушені хендли по кутах (верх-право = додати колонку
// праворуч, з підсвіткою колонки; верх-ліво ПЕРШОЇ колонки = додати рядок
// вище, з підсвіткою рядка, а для решти колонок той самий кут = видалити
// колонку; низ-ліво першої колонки = видалити рядок). Наведення на всю
// таблицю показує зверху літери колонок і зліва номери рядків (Excel-
// стиль) — АЛЕ як overlay (position: absolute поверх таблиці, без жодного
// зарезервованого місця в layout: за замовчуванням цього рядка/колонки в
// потоці документа просто нема, вони з'являються ПОВЕРХ елементів лише на
// hover). Перетягуючи за літеру/номер — лінія між колонками/рядками
// показує, куди саме впаде колонка чи рядок.
function renderTable(b, scheduleSave) {
  if (!b.rows?.length) b.rows = [['', ''], ['', '']];
  const wrapTable = el('div', { class: 'desc-table-wrap' });
  const letterBar = el('div', { class: 'desc-table-letterbar' });
  const numBar = el('div', { class: 'desc-table-numbar' });
  // Кутовий квадратик (як в Excel/Google Таблицях) — клік виділяє (підсвічує)
  // всю таблицю разом.
  const cornerBtn = el('button', { type: 'button', class: 'desc-table-corner-btn', title: 'Виділити всю таблицю' });
  cornerBtn.addEventListener('click', (e) => { e.stopPropagation(); currentTable?.classList.toggle('selected'); });
  let draggingCol = null;
  let draggingRow = null;
  function moveColumnTo(from, toIndex) {
    const adj = toIndex > from ? toIndex - 1 : toIndex;
    if (adj === from) return;
    b.rows.forEach((row) => { const [item] = row.splice(from, 1); row.splice(adj, 0, item); });
    renderGrid(); scheduleSave();
  }
  function moveRowTo(from, toIndex) {
    const adj = toIndex > from ? toIndex - 1 : toIndex;
    if (adj === from) return;
    const [item] = b.rows.splice(from, 1);
    b.rows.splice(adj, 0, item);
    renderGrid(); scheduleSave();
  }
  // Фільтруємо саме .desc-table-letter/.desc-table-num — інакше вже
  // вставлений indicator-рядок сам потрапляв би в підрахунок і зсував би
  // індекс на наступному ж dragover/drop (був реальний баг: перетягування
  // взагалі переставало щось переставляти після першого руху миші).
  function colDropIndex(clientX) {
    const cells = [...letterBar.children].filter((c) => c.classList.contains('desc-table-letter'));
    let index = cells.length;
    for (let i = 0; i < cells.length; i += 1) {
      const r = cells[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) { index = i; break; }
    }
    return { cells, index };
  }
  function rowDropIndex(clientY) {
    const cells = [...numBar.children].filter((c) => c.classList.contains('desc-table-num'));
    let index = cells.length;
    for (let i = 0; i < cells.length; i += 1) {
      const r = cells[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { index = i; break; }
    }
    return { cells, index };
  }
  letterBar.addEventListener('dragover', (e) => {
    if (draggingCol == null) return;
    e.preventDefault();
    const { cells, index } = colDropIndex(e.clientX);
    letterBar.querySelectorAll('.desc-table-col-indicator').forEach((n) => n.remove());
    const indicator = el('div', { class: 'desc-table-col-indicator' });
    if (cells[index]) letterBar.insertBefore(indicator, cells[index]); else letterBar.append(indicator);
  });
  letterBar.addEventListener('drop', (e) => {
    if (draggingCol == null) return;
    e.preventDefault();
    const { index } = colDropIndex(e.clientX);
    moveColumnTo(draggingCol, index);
    draggingCol = null;
  });
  numBar.addEventListener('dragover', (e) => {
    if (draggingRow == null) return;
    e.preventDefault();
    const { cells, index } = rowDropIndex(e.clientY);
    numBar.querySelectorAll('.desc-table-row-indicator').forEach((n) => n.remove());
    const indicator = el('div', { class: 'desc-table-row-indicator' });
    if (cells[index]) numBar.insertBefore(indicator, cells[index]); else numBar.append(indicator);
  });
  numBar.addEventListener('drop', (e) => {
    if (draggingRow == null) return;
    e.preventDefault();
    const { index } = rowDropIndex(e.clientY);
    moveRowTo(draggingRow, index);
    draggingRow = null;
  });

  // currentTable — потрібен окремо від локальної const table у renderGrid():
  // при САМОМУ першому виклику renderGrid() (з конструктора renderTable(),
  // до того, як wrapTable взагалі приєднано до документа) getBoundingClientRect()
  // на щойно створених <td> дає нулі (детач-елемент ще не має layout) —
  // тому реальний перерахунок розмірів overlay-літер/номерів робимо на
  // mouseenter (гарантовано вже в документі, є справжній layout), а не
  // одразу під час рендеру.
  let currentTable = null;
  function renderGrid() {
    wrapTable.textContent = '';
    const table = el('table', { class: 'desc-table' });
    function highlightCol(ci, cls) { [...table.rows].forEach((tr) => tr.children[ci]?.classList.add(cls)); }
    function highlightRow(ri, cls) { [...(table.rows[ri]?.children || [])].forEach((td) => td.classList.add(cls)); }
    function clearHighlight() { table.querySelectorAll('td').forEach((td) => td.classList.remove('col-add-hl', 'col-del-hl', 'row-add-hl', 'row-del-hl')); }
    function handle(kind, corner, onEnter, onClick, title) {
      const btn = el('button', { type: 'button', class: `desc-table-handle ${kind} ${corner}`, title }, icon(kind === 'add' ? 'plus' : 'minus', 9));
      btn.addEventListener('mouseenter', onEnter);
      btn.addEventListener('mouseleave', clearHighlight);
      btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); renderGrid(); scheduleSave(); });
      return btn;
    }

    b.rows.forEach((row, ri) => {
      const tr = el('tr', {});
      row.forEach((cell, ci) => {
        const input = el('input', { value: cell, oninput: (e) => { row[ci] = e.target.value; scheduleSave(); } });
        const td = el('td', {}, input,
          handle('add', 'top-right', () => highlightCol(ci, 'col-add-hl'), () => b.rows.forEach((r) => r.splice(ci + 1, 0, '')), 'Додати колонку праворуч'),
          ci === 0
            ? handle('add', 'top-left', () => highlightRow(ri, 'row-add-hl'), () => b.rows.splice(ri, 0, b.rows[0].map(() => '')), 'Додати рядок вище')
            : (row.length > 1 ? handle('del', 'top-left', () => highlightCol(ci, 'col-del-hl'), () => b.rows.forEach((r) => r.splice(ci, 1)), 'Видалити колонку') : null),
          ci === 0 && b.rows.length > 1
            ? handle('del', 'bottom-left', () => highlightRow(ri, 'row-del-hl'), () => b.rows.splice(ri, 1), 'Видалити рядок')
            : null);
        tr.append(td);
      });
      table.append(tr);
    });
    wrapTable.append(table, letterBar, numBar, cornerBtn);
    currentTable = table;
    positionOverlays(table);
  }
  wrapTable.addEventListener('mouseenter', () => { if (currentTable) positionOverlays(currentTable); });
  // Виміряні пікселі реальних клітинок — overlay-літери/номери мають
  // ТОЧНО збігатись розміром з колонками/рядками, які вони позначають,
  // інакше «куди саме перетягую» виглядало б неправдиво.
  function positionOverlays(table) {
    letterBar.textContent = '';
    numBar.textContent = '';
    const firstRow = table.rows[0];
    if (!firstRow) return;
    [...firstRow.children].forEach((td, ci) => {
      const r = td.getBoundingClientRect();
      const cell = el('div', {
        class: 'desc-table-letter', draggable: 'true', title: 'Перетягніть, щоб перемістити колонку',
        style: `width:${r.width}px`,
      }, colLetter(ci));
      cell.addEventListener('dragstart', (e) => { draggingCol = ci; e.dataTransfer.effectAllowed = 'move'; });
      cell.addEventListener('dragend', () => letterBar.querySelectorAll('.desc-table-col-indicator').forEach((n) => n.remove()));
      letterBar.append(cell);
    });
    [...table.rows].forEach((tr, ri) => {
      const r = tr.getBoundingClientRect();
      const cell = el('div', {
        class: 'desc-table-num', draggable: 'true', title: 'Перетягніть, щоб перемістити рядок',
        style: `height:${r.height}px`,
      }, String(ri + 1));
      cell.addEventListener('dragstart', (e) => { draggingRow = ri; e.dataTransfer.effectAllowed = 'move'; });
      cell.addEventListener('dragend', () => numBar.querySelectorAll('.desc-table-row-indicator').forEach((n) => n.remove()));
      numBar.append(cell);
    });
  }
  renderGrid();
  return wrapTable;
}

// Спадний список — стрілочка щільно біля заголовка, без плашки під нею;
// прихований вміст — це ПОВНОЦІННИЙ вкладений список блоків (текст/чек-
// лист/таблиця/спадний список/колонки), а не проста нотатка.
function renderToggle(b, scheduleSave) {
  if (!b.children?.length) b.children = [{ id: uid(), type: 'paragraph', text: b.text || '' }];
  const bodyWrap = el('div', { style: b.open ? '' : 'display:none' });
  bodyWrap.append(renderBlockList(b.children, scheduleSave));
  const chevron = icon('chevronDown', 15);
  chevron.style.transform = b.open ? 'rotate(0deg)' : 'rotate(-90deg)';
  const toggleBtn = el('button', {
    class: 'desc-toggle-btn', type: 'button', title: b.open ? 'Згорнути' : 'Розгорнути',
    onclick: () => {
      b.open = !b.open; bodyWrap.style.display = b.open ? '' : 'none';
      chevron.style.transform = b.open ? 'rotate(0deg)' : 'rotate(-90deg)';
      toggleBtn.title = b.open ? 'Згорнути' : 'Розгорнути';
      scheduleSave();
    },
  }, chevron);
  const titleInput = el('input', {
    class: 'desc-toggle-title', value: b.title || '', placeholder: 'Заголовок спадного списку…',
    oninput: () => { b.title = titleInput.value; scheduleSave(); },
  });
  return el('div', {}, el('div', { class: 'desc-toggle-head' }, toggleBtn, titleInput), bodyWrap);
}

// Колонки — N незалежних вкладених списків блоків поруч; кількість колонок
// можна збільшувати/зменшувати, у кожній — той самий «+» на додавання блоків.
// Затиснувши за ручку (⣿) у лівому верхньому куті, колонку можна перетягнути
// на будь-яке інше місце серед колонок цього блоку.
function renderColumns(b, scheduleSave) {
  if (!b.columns?.length) b.columns = [[{ id: uid(), type: 'paragraph', text: '' }], [{ id: uid(), type: 'paragraph', text: '' }]];
  const wrap = el('div', { class: 'desc-columns' });
  let draggingIdx = null;
  function renderCols() {
    wrap.textContent = '';
    wrap.append(...b.columns.map((colBlocks, ci) => {
      const dragHandle = el('div', { class: 'desc-col-drag', draggable: 'true', title: 'Перетягніть, щоб перемістити колонку' }, icon('grip', 12));
      const col = el('div', { class: 'desc-column' },
        dragHandle,
        b.columns.length > 1
          ? el('button', { type: 'button', class: 'desc-col-remove', title: 'Прибрати колонку', onclick: () => { b.columns.splice(ci, 1); renderCols(); scheduleSave(); } }, icon('close', 10))
          : null,
        renderBlockList(colBlocks, scheduleSave));
      dragHandle.addEventListener('dragstart', (e) => { draggingIdx = ci; col.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      dragHandle.addEventListener('dragend', () => col.classList.remove('dragging'));
      col.addEventListener('dragover', (e) => { if (draggingIdx == null) return; e.preventDefault(); col.classList.add('drag-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', (e) => {
        if (draggingIdx == null) return;
        e.preventDefault(); col.classList.remove('drag-over');
        const [item] = b.columns.splice(draggingIdx, 1);
        b.columns.splice(ci, 0, item);
        draggingIdx = null;
        renderCols(); scheduleSave();
      });
      return col;
    }));
    wrap.append(el('button', {
      type: 'button', class: 'desc-col-add', title: 'Додати колонку',
      onclick: () => { b.columns.push([{ id: uid(), type: 'paragraph', text: '' }]); renderCols(); scheduleSave(); },
    }, icon('plus', 14)));
  }
  renderCols();
  return wrap;
}

function renderBlockContent(b, scheduleSave) {
  if (b.type === 'checklist') return renderChecklist(b, scheduleSave);
  if (b.type === 'table') return renderTable(b, scheduleSave);
  if (b.type === 'toggle') return renderToggle(b, scheduleSave);
  if (b.type === 'columns') return renderColumns(b, scheduleSave);
  return renderParagraph(b, scheduleSave);
}

// Список блоків — рекурсивний: та сама функція малює і верхній рівень опису
// картки, і вкладений вміст спадного списку/колонки. list мутується на
// місці (splice), ніколи не переприсвоюється — інакше вкладені посилання
// (b.children/колонка масиву) відв'язались би від батьківського блоку.
function renderBlockList(list, scheduleSave) {
  const wrap = el('div', { class: 'desc-blocks' });
  let draggingIdx = null;
  // Виділення цілих блоків (текст/таблиця/чек-лист/будь-що) — клік по
  // «гутеру» (порожній частині ліворуч від блоку, не по самих кнопочках)
  // додає блок до виділення, shift+клік — діапазон; Backspace/Delete, коли
  // є виділені блоки й фокус НЕ в тексті, який редагується — видаляє їх.
  let selected = new Set();
  let selectAnchor = null;
  function clearBlockSelection() {
    if (!selected.size) return;
    selected.clear();
    wrap.querySelectorAll(':scope > .desc-block.selected').forEach((r) => r.classList.remove('selected'));
  }
  function toggleBlockSelect(index, range) {
    const rows = [...wrap.children];
    if (range && selectAnchor != null) {
      const [from, to] = [selectAnchor, index].sort((a, b) => a - b);
      for (let i = from; i <= to; i += 1) { selected.add(i); rows[i]?.classList.add('selected'); }
    } else {
      selectAnchor = index;
      if (selected.has(index)) { selected.delete(index); rows[index]?.classList.remove('selected'); }
      else { selected.add(index); rows[index]?.classList.add('selected'); }
    }
  }
  function insertAfter(index, type) { list.splice(index + 1, 0, makeBlock(type)); renderAll(); scheduleSave(); }
  function removeBlock(index) {
    if (list.length > 1) list.splice(index, 1); else list.splice(0, list.length, makeBlock('paragraph'));
    renderAll(); scheduleSave();
  }
  function removeSelectedBlocks() {
    const indices = [...selected].sort((a, b) => b - a);
    indices.forEach((i) => list.splice(i, 1));
    if (!list.length) list.push(makeBlock('paragraph'));
    selected.clear(); selectAnchor = null;
    renderAll(); scheduleSave();
  }
  function moveBlock(from, to) {
    if (from === to) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    renderAll(); scheduleSave();
  }
  function blockTypeMenu(anchor, index) {
    openPopover(anchor, (box2) => {
      box2.append(
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); insertAfter(index, 'paragraph'); } }, icon('heading', 13), 'Текст'),
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); insertAfter(index, 'checklist'); } }, icon('checkSquare', 13), 'Чек-лист'),
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); insertAfter(index, 'table'); } }, icon('table', 13), 'Таблиця'),
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); insertAfter(index, 'toggle'); } }, icon('chevronDown', 13), 'Спадний список'),
        el('div', { class: 'task-popover-item', onclick: () => { box2.remove(); insertAfter(index, 'columns'); } }, icon('grid', 13), 'Колонки'));
    });
  }
  // Три кнопки колонкою (не рядком): зверху — перетягнути (переставити
  // блок вище/нижче будь-де в цьому списку), тоді додати, знизу — видалити.
  function renderAll() {
    wrap.textContent = '';
    wrap.append(...list.map((b, i) => {
      const dragBtn = el('button', { class: 'desc-block-drag', type: 'button', title: 'Перетягніть — щоб перемістити; клік — щоб виділити блок' }, icon('grip', 11));
      // Клік (без перетягування) по ручці — виділяє блок, той самий підхід,
      // що й довге затискання картки на дошці: браузер не шле click після
      // справжнього drag-жесту, тож звичайне перетягування лишається цілим.
      dragBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleBlockSelect(i, e.shiftKey); });
      const plusBtn = el('button', { class: 'desc-block-plus', type: 'button', title: 'Додати блок' }, icon('plus', 12));
      plusBtn.addEventListener('click', (e) => { e.stopPropagation(); blockTypeMenu(plusBtn, i); });
      const delBtn = el('button', { class: 'desc-block-del', type: 'button', title: 'Видалити блок', onclick: () => removeBlock(i) }, icon('trash', 11));
      const gutter = el('div', { class: 'desc-block-gutter' }, dragBtn, plusBtn, delBtn);
      gutter.addEventListener('click', (e) => {
        if (e.target !== gutter) return; // клік саме по порожній частині, не по кнопках
        toggleBlockSelect(i, e.shiftKey);
      });
      const row = el('div', { class: `desc-block${selected.has(i) ? ' selected' : ''}` }, gutter, renderBlockContent(b, scheduleSave));
      dragBtn.draggable = true;
      dragBtn.addEventListener('dragstart', (e) => { draggingIdx = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      dragBtn.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { if (draggingIdx == null) return; e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        if (draggingIdx == null) return;
        e.preventDefault(); row.classList.remove('drag-over');
        const from = draggingIdx; draggingIdx = null;
        moveBlock(from, i);
      });
      return row;
    }));
  }
  wrap.addEventListener('click', (e) => { if (e.target === wrap) clearBlockSelection(); });
  // Backspace/Delete видаляє виділені блоки — лише коли фокус НЕ в тексті,
  // який зараз редагується (інакше звичайне видалення символу в тексті
  // зламалось би). Клік по кнопці-ручці ФОКУСУЄ саму кнопку (а не body!),
  // тому перевіряємо не «фокус на body», а що активний елемент — не
  // текстове поле (contenteditable/input/textarea).
  function onKeydown(e) {
    if (!wrap.isConnected) { document.removeEventListener('keydown', onKeydown); return; }
    if (!selected.size || (e.key !== 'Backspace' && e.key !== 'Delete')) return;
    const ae = document.activeElement;
    const editingText = ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
    if (editingText) return;
    e.preventDefault();
    removeSelectedBlocks();
  }
  document.addEventListener('keydown', onKeydown);
  renderAll();
  return wrap;
}

function renderDescriptionEditor(card, onSave) {
  const blocks = (card.description_blocks && card.description_blocks.length)
    ? card.description_blocks.map((b) => ({ ...b }))
    : [{ ...makeBlock('paragraph'), text: card.description || '' }];
  let saveTimer = null;
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => onSave(blocks), 500); }
  return renderBlockList(blocks, scheduleSave);
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
        icon('chevronLeft', 13), 'Задачі'),
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

  // Зліва — фіксоване бокове меню (Spaces → Boards деревом), окремо від
  // самого контенту дошки/списку/календаря — те саме меню на всіх трьох
  // вьюхах, бо це одна й та сама renderTaskBoard(). Можна згорнути в
  // квадратні плашки-іконки (стан — у localStorage).
  const page = el('div', { style: 'display:flex;height:100%;min-width:0' });
  const content = el('div', { style: 'display:flex;flex-direction:column;height:100%;flex:1 1 auto;min-width:0;padding-left:16px' });
  const head = el('div', { style: 'margin-bottom:10px' });
  const kanban = el('div', { class: 'kanban', style: 'flex:1 1 auto' });
  content.append(head, kanban);
  const sidebar = el('div', { class: 'task-sidebar' });
  page.append(sidebar, content);

  let space, board, members, boardTags, rawColumns;
  let dragging = null;
  let draggingColumn = null;
  // Мультивибір карток (затиснути — обрати, потім клікати ще для набору) —
  // саме для нього правий клік по картці відкриває bulk-дії замість
  // одиночного видалення. Зберігаємо тільки id — DOM перемальовується при
  // кожному reload(), тож .selected навішуємо заново в renderCard().
  let selectedCardIds = new Set();
  let view = 'board'; // 'board' | 'list' | 'calendar'
  let calMode = 'week'; // 'week' | 'month' — тільки для view === 'calendar'
  let calAnchor = new Date();
  // Мультивибір скрізь: 0/1/кілька виконавців, тегів, рівнів пріоритету
  // одночасно — порожня множина = фільтр вимкнено.
  const filters = { assigneeIds: new Set(), tagIds: new Set(), priorities: new Set() };
  // Живі лічильники таймерів прямо на плашках картки (requirement: видно
  // «скільки вже пройшло», не заходячи в картку) — інтервали з попереднього
  // рендеру канбану інакше продовжують цокати в порожнечу після reload().
  let activeIntervals = [];

  // Фільтри діють однаково на обох вьюхах (дошка/список) — фільтруємо
  // картки всередині кожної колонки, самі колонки лишаються на місці
  // (порожня колонка після фільтра — це теж інформація).
  function filteredColumns() {
    if (!filters.assigneeIds.size && !filters.tagIds.size && !filters.priorities.size) return rawColumns;
    return rawColumns.map((col) => ({
      ...col,
      cards: col.cards.filter((c) => {
        if (filters.assigneeIds.size && !filters.assigneeIds.has(c.assignee_user_id)) return false;
        if (filters.tagIds.size && !(c.tags || []).some((t) => filters.tagIds.has(t.id))) return false;
        if (filters.priorities.size && !filters.priorities.has(c.priority || '')) return false;
        return true;
      }),
    }));
  }

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

  // Список типових задач і скільки годин на них зазвичай ставлять — орієнтир
  // для AI, коли вона оцінює estimate за описом (кнопка-іскорка біля поля
  // Estimate). Рядки редагуються прямо в модалці, порожні відкидаються при
  // збереженні (те саме робить і бек, це — підстраховка на клієнті).
  function openEstimateNormsModal() {
    const initial = board.estimate_norms && board.estimate_norms.length ? board.estimate_norms : [{ label: '', hours: 0 }];
    const rows = [];
    const list = el('div', { class: 'estimate-norms-list' });
    const addRow = (row = { label: '', hours: 0 }) => {
      const idx = rows.length;
      rows.push({ label: row.label || '', hours: row.hours || 0 });
      const labelInput = el('input', { value: rows[idx].label, placeholder: 'Напр., ресерч, створення акаунта…' });
      const hoursInput = el('input', { type: 'number', min: '0', step: '0.25', value: rows[idx].hours || '', placeholder: 'год', style: 'width:70px' });
      labelInput.addEventListener('input', () => { rows[idx].label = labelInput.value; });
      hoursInput.addEventListener('input', () => { rows[idx].hours = Number(hoursInput.value) || 0; });
      const line = el('div', { class: 'estimate-norms-row' },
        labelInput, hoursInput,
        el('button', { class: 'btn small icon-only danger', type: 'button', onclick: () => { rows[idx] = null; line.remove(); } }, icon('trash', 12)));
      list.append(line);
    };
    initial.forEach(addRow);
    const addBtn = el('button', { class: 'btn small', type: 'button', onclick: () => addRow() }, withIcon('plus', 'Додати рядок'));
    const content = el('div', { class: 'field', style: 'min-width:360px' },
      el('div', { class: 'muted', style: 'font-size:12.5px;margin-bottom:8px' },
        'Орієнтир для AI, коли вона оцінює час за описом задачі: типові задачі цієї дошки й скільки годин на них зазвичай іде.'),
      list, addBtn);
    const m = modal('Норма estimate', content, [actionButton('Зберегти', async () => {
      const clean = rows.filter(Boolean).map((r) => ({ label: String(r.label || '').trim(), hours: Number(r.hours) || 0 })).filter((r) => r.label);
      try {
        await api.put(`/task_boards/${boardId}`, { estimate_norms: clean });
        board.estimate_norms = clean;
        m.remove();
      } catch (e) { toast(e.message, true); }
    })]);
  }

  function boardMenu(anchor) {
    openPopover(anchor, (box2) => {
      box2.append(
        canEdit ? el('div', {
          class: 'task-popover-item',
          onclick: () => {
            box2.remove();
            const input = el('input', { value: board.name });
            const m = modal('Назва дошки', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
              [actionButton('Зберегти', async () => {
                if (!input.value.trim()) return toast('Потрібна назва', true);
                await api.put(`/task_boards/${boardId}`, { name: input.value.trim() });
                board.name = input.value.trim();
                m.remove(); renderHead();
              })]);
          },
        }, icon('edit', 13), 'Перейменувати дошку') : null,
        canEdit ? el('div', {
          class: 'task-popover-item',
          onclick: () => { box2.remove(); openEstimateNormsModal(); },
        }, icon('gauge', 13), 'Норма estimate') : null,
        canDelete ? el('div', {
          class: 'task-popover-item danger',
          onclick: async () => {
            box2.remove();
            if (!confirm(`Видалити дошку «${board.name}»?`)) return;
            try { await api.del(`/task_boards/${boardId}`); location.hash = `#/space/${space.id}`; }
            catch (e) { toast(e.message, true); }
          },
        }, icon('trash', 13), 'Видалити дошку') : null);
    });
  }

  // Загальний фільтр (теги + пріоритет, мультивибір в одному попапі) і
  // фільтр виконавців (окремо, теж мультивибір — можна одного, кількох чи
  // всіх) — зліва направо: [загальні фільтри] [виконавці] [⋮ дошки].
  const filterLabel = (base, count) => (count ? `${base} · ${count}` : base);
  function renderFilters() {
    const filterText = el('span', {}, filterLabel('Фільтри', filters.tagIds.size + filters.priorities.size));
    const filterBtn = el('button', { class: 'btn small task-filter-btn', type: 'button' }, icon('filter', 14), filterText);
    filterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopover(filterBtn, (box2) => {
        box2.append(el('div', { class: 'task-popover-heading' }, 'Теги'));
        if (!(boardTags || []).length) box2.append(el('div', { class: 'muted', style: 'padding:2px 8px 6px;font-size:12px' }, 'Тегів на дошці ще нема'));
        (boardTags || []).forEach((t) => {
          box2.append(checkboxRow(filters.tagIds.has(t.id), (checked) => {
            if (checked) filters.tagIds.add(t.id); else filters.tagIds.delete(t.id);
            filterText.textContent = filterLabel('Фільтри', filters.tagIds.size + filters.priorities.size);
            renderBody();
          }, tagChip(t)));
        });
        box2.append(el('div', { class: 'task-popover-heading' }, 'Пріоритет'));
        PRIORITIES.forEach((p) => {
          const ic = icon('flag', 13); ic.style.color = p.color;
          box2.append(checkboxRow(filters.priorities.has(p.value), (checked) => {
            if (checked) filters.priorities.add(p.value); else filters.priorities.delete(p.value);
            filterText.textContent = filterLabel('Фільтри', filters.tagIds.size + filters.priorities.size);
            renderBody();
          }, ic, p.label));
        });
      });
    });

    const assigneeText = el('span', {}, filterLabel('Виконавці', filters.assigneeIds.size));
    const assigneeBtn = el('button', { class: 'btn small task-filter-btn', type: 'button' }, icon('user', 14), assigneeText);
    assigneeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopover(assigneeBtn, (box2) => {
        if (!members.length) box2.append(el('div', { class: 'muted', style: 'padding:4px 8px;font-size:12px' }, 'Учасників ще нема'));
        members.forEach((m) => {
          box2.append(checkboxRow(filters.assigneeIds.has(m.user_id), (checked) => {
            if (checked) filters.assigneeIds.add(m.user_id); else filters.assigneeIds.delete(m.user_id);
            assigneeText.textContent = filterLabel('Виконавці', filters.assigneeIds.size);
            renderBody();
          }, avatarEl(m.name, m.user_id, 18), m.name));
        });
      });
    });
    return [filterBtn, assigneeBtn];
  }

  function renderHead() {
    head.textContent = '';
    const boardMenuBtn = el('button', { class: 'task-board-menu-btn', title: 'Меню дошки', onclick: (e) => { e.stopPropagation(); boardMenu(boardMenuBtn); } }, icon('more', 15));
    // renderHead() (де й малюються ці кнопки) раніше викликався лише при
    // reload() дошки — перемикання view (Дошка/Список/Календар) міняло
    // лише renderBody(), тому активна кнопка так і лишалась на «Дошка»
    // назавжди. Перемальовуємо і шапку теж, щоб .active перескочив на
    // справді обрану кнопку.
    const viewBtn = (key, label) => el('button', {
      class: `btn small${view === key ? ' active' : ''}`, onclick: () => { view = key; renderHead(); renderBody(); },
    }, label);
    head.append(el('div', { class: 'row tight', style: 'align-items:center;gap:8px;flex-wrap:wrap' },
      el('a', { href: `#/space/${space.id}`, style: 'display:inline-flex;align-items:center;gap:4px;font-size:12.5px' },
        icon('chevronLeft', 13), space.name),
      el('b', { style: 'font-size:16px' }, board.name),
      el('div', { class: 'tabs', style: 'margin:0' },
        viewBtn('board', withIcon('grid', 'Дошка')), viewBtn('list', withIcon('fileText', 'Список')), viewBtn('calendar', withIcon('calendar', 'Календар'))),
      el('div', { style: 'flex:1 1 auto' }),
      renderFilters(),
      boardMenuBtn));
  }

  async function reload() {
    const res = await api.get(`/task_boards/${boardId}`);
    space = res.space; board = res.board; members = res.members; boardTags = res.boardTags; rawColumns = res.columns;
    renderHead();
    renderBody();
  }

  function renderBody() {
    activeIntervals.forEach(clearInterval); activeIntervals = [];
    kanban.textContent = '';
    kanban.classList.toggle('kanban-list-mode', view === 'list');
    kanban.classList.toggle('kanban-calendar-mode', view === 'calendar');
    const columns = filteredColumns();
    if (view === 'list') kanban.append(renderListView(columns));
    else if (view === 'calendar') kanban.append(renderCalendarHead(), calMode === 'week' ? renderCalendarWeek(columns) : renderCalendarMonth(columns));
    else kanban.append(...columns.map(renderColumn), addColumnTile());
  }

  // ── Календар — окрема повноекранна вьюха задач дошки (не картки-плитки, а
  // дні тижня/місяця): задача показується в день дедлайну (або старту, якщо
  // дедлайну нема), клік по ній відкриває ту саму картку. «Сьогодні»/стрілки
  // гортають тиждень або місяць, перемикач Тиждень/Місяць — поруч. ────────
  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  const calPad = (n) => String(n).padStart(2, '0');
  const calDayKey = (dt) => `${dt.getFullYear()}-${calPad(dt.getMonth() + 1)}-${calPad(dt.getDate())}`;
  function calStartOfWeek(dt) {
    const nd = new Date(dt); const shift = (nd.getDay() + 6) % 7;
    nd.setDate(nd.getDate() - shift); nd.setHours(0, 0, 0, 0);
    return nd;
  }
  function calCardsByDate(columns) {
    const map = new Map();
    columns.forEach((col) => {
      col.cards.forEach((c) => {
        const key = (c.due_date || c.start_date || '').slice(0, 10);
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ card: c, col });
      });
    });
    return map;
  }
  function calTaskChip(card, col) {
    const hex = tagColorHex(col.color);
    const m = members.find((mm) => mm.user_id === card.assignee_user_id);
    const p = priorityOf(card.priority);
    const chip = el('div', { class: 'cal-task-chip', style: `border-left-color:${hex}`, title: card.title },
      p.value ? (() => { const ic = icon('flag', 11); ic.style.color = p.color; return ic; })() : null,
      m ? avatarEl(m.name, m.user_id, 14) : null,
      el('span', { class: 'cal-task-chip-title' }, card.title));
    chip.addEventListener('click', (e) => { e.stopPropagation(); openTaskCard(card.id, reload); });
    return chip;
  }
  // Клік по КЛІТИНЦІ дня (не по конкретній задачі — та сама подія
  // зупиняється в calTaskChip) відкриває панель праворуч: список усіх
  // задач цього дня і завантаження команди у відсотках (частка задач дня
  // на кожного виконавця, зі шкалою).
  function openDayPanel(dateKey, items) {
    const bg = el('div', { class: 'drawer-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
    const dateObj = new Date(`${dateKey}T00:00:00`);
    const dateLabel = dateObj.toLocaleDateString('uk-UA', { weekday: 'long', day: 'numeric', month: 'long' });
    const byMember = new Map();
    items.forEach(({ card }) => {
      const key = card.assignee_user_id || 'none';
      byMember.set(key, (byMember.get(key) || 0) + 1);
    });
    const total = items.length || 1;
    const workloadRows = [...byMember.entries()].sort((a, b) => b[1] - a[1]).map(([uid, count]) => {
      const m = members.find((mm) => mm.user_id === uid);
      const pct = Math.round((count / total) * 100);
      return el('div', { class: 'cal-panel-workload-row' },
        m ? avatarEl(m.name, m.user_id, 20) : el('span', { class: 'task-avatar task-avatar-empty' }, icon('user', 12)),
        el('span', { class: 'cal-panel-workload-name' }, m ? m.name : 'Без виконавця'),
        el('div', { class: 'task-progress-track', style: 'flex:1 1 auto' }, el('div', { class: 'task-progress-fill', style: `width:${pct}%` })),
        el('span', { class: 'muted', style: 'font-size:11.5px' }, `${pct}% (${count})`));
    });
    const panel = el('div', { class: 'cal-day-panel' },
      el('div', { class: 'cal-day-panel-head' },
        el('b', { style: 'text-transform:capitalize;flex:1 1 auto' }, dateLabel),
        el('button', { class: 'btn small icon-only', onclick: () => bg.remove() }, icon('close', 14))),
      el('div', { class: 'cal-day-panel-body' },
        el('div', { class: 'task-popover-heading' }, `Задачі (${items.length})`),
        items.length
          ? el('div', { style: 'display:flex;flex-direction:column;gap:4px' }, ...items.map(({ card, col }) => {
            const hex = tagColorHex(col.color);
            const m = members.find((mm) => mm.user_id === card.assignee_user_id);
            const row = el('div', { class: 'cal-panel-task-row' },
              el('span', { class: 'kanban-col-pill', style: `background:${hex}22;color:${hex}` }, col.name),
              el('span', { style: 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, card.title),
              m ? avatarEl(m.name, m.user_id, 18) : null);
            row.addEventListener('click', () => { bg.remove(); openTaskCard(card.id, reload); });
            return row;
          }))
          : el('div', { class: 'muted', style: 'font-size:12.5px' }, 'На цей день задач нема'),
        el('div', { class: 'task-popover-heading' }, 'Завантаження команди'),
        workloadRows.length ? el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, ...workloadRows) : el('div', { class: 'muted', style: 'font-size:12.5px' }, '—')));
    bg.append(panel);
    document.body.append(bg);
  }
  function calShiftAnchor(dir) {
    const nd = new Date(calAnchor);
    if (calMode === 'week') nd.setDate(nd.getDate() + dir * 7); else nd.setMonth(nd.getMonth() + dir);
    calAnchor = nd;
  }
  function renderCalendarHead() {
    const weekStart = calStartOfWeek(calAnchor);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
    const fmtShort = (dt) => `${calPad(dt.getDate())}.${calPad(dt.getMonth() + 1)}`;
    const label = calMode === 'week'
      ? `${fmtShort(weekStart)} — ${fmtShort(weekEnd)}`
      : calAnchor.toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
    const modeBtn = (key, label2) => el('button', {
      class: `btn small${calMode === key ? ' active' : ''}`, onclick: () => { calMode = key; renderBody(); },
    }, label2);
    return el('div', { class: 'cal-toolbar' },
      el('button', { class: 'btn small icon-only', title: 'Назад', onclick: () => { calShiftAnchor(-1); renderBody(); } }, icon('chevronLeft', 14)),
      el('button', { class: 'btn small', onclick: () => { calAnchor = new Date(); renderBody(); } }, 'Сьогодні'),
      el('button', { class: 'btn small icon-only', title: 'Вперед', onclick: () => { calShiftAnchor(1); renderBody(); } }, icon('chevronRight', 14)),
      el('b', { style: 'margin:0 8px;text-transform:capitalize' }, label),
      el('div', { style: 'flex:1 1 auto' }),
      el('div', { class: 'tabs', style: 'margin:0' }, modeBtn('week', 'Тиждень'), modeBtn('month', 'Місяць')));
  }
  function renderCalendarWeek(columns) {
    const byDate = calCardsByDate(columns);
    const start = calStartOfWeek(calAnchor);
    const todayKey = calDayKey(new Date());
    const wrap = el('div', { class: 'cal-week' });
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const key = calDayKey(d);
      const items = byDate.get(key) || [];
      const dayCell = el('div', { class: `cal-day${key === todayKey ? ' today' : ''}` },
        el('div', { class: 'cal-day-head' }, el('span', {}, WEEKDAYS[i]), el('b', {}, String(d.getDate()))),
        el('div', { class: 'cal-day-items' }, ...items.map(({ card, col }) => calTaskChip(card, col))));
      dayCell.addEventListener('click', () => openDayPanel(key, items));
      wrap.append(dayCell);
    }
    return wrap;
  }
  function renderCalendarMonth(columns) {
    const byDate = calCardsByDate(columns);
    const first = new Date(calAnchor.getFullYear(), calAnchor.getMonth(), 1);
    const gridStart = calStartOfWeek(first);
    const todayKey = calDayKey(new Date());
    const wrap = el('div', { class: 'cal-month' });
    WEEKDAYS.forEach((wd) => wrap.append(el('div', { class: 'cal-month-wd' }, wd)));
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(gridStart); d.setDate(d.getDate() + i);
      const key = calDayKey(d);
      const items = byDate.get(key) || [];
      const inMonth = d.getMonth() === calAnchor.getMonth();
      const shown = items.slice(0, 3);
      const rest = items.length - shown.length;
      const dayCell = el('div', { class: `cal-mday${inMonth ? '' : ' outside'}${key === todayKey ? ' today' : ''}` },
        el('div', { class: 'cal-mday-num' }, String(d.getDate())),
        el('div', { class: 'cal-mday-items' }, ...shown.map(({ card, col }) => calTaskChip(card, col)),
          rest > 0 ? el('div', { class: 'cal-mday-more' }, `+${rest} ще`) : null));
      dayCell.addEventListener('click', () => openDayPanel(key, items));
      wrap.append(dayCell);
    }
    return wrap;
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
            const startInput = withPicker(el('input', { type: 'date', value: draft.start_date || '', onchange: () => { draft.start_date = startInput.value || null; renderRows(); } }));
            const dueInput = withPicker(el('input', { type: 'date', value: draft.due_date || '', onchange: () => { draft.due_date = dueInput.value || null; renderRows(); } }));
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

    let cleanup = () => {};
    async function save() {
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }
      try {
        await api.post(`/task_boards/${boardId}/cards`, { column_id: col.id, title, ...draft });
        cleanup(); onDone(true);
      } catch (e) { toast(e.message, true); }
    }
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { cleanup(); onDone(false); }
    });

    // Заголовок на всю ширину зверху, «Зберегти» — на всю ширину знизу
    // (не поряд із заголовком); клік поза формою згортає її назад до
    // кнопки-тригера без збереження — але клік усередині відкритого
    // попапу вибору (він рендериться в body, поза цим box) не рахується
    // «поза формою». ─────────────────────────────────────────────────
    const box = el('div', { class: 'quick-add-box' },
      titleInput, rowsWrap,
      el('button', { class: 'btn primary quick-add-save', onclick: save }, 'Зберегти'));
    const outsideClick = (e) => {
      if (box.contains(e.target) || e.target.closest?.('.task-popover')) return;
      cleanup(); onDone(false);
    };
    cleanup = () => document.removeEventListener('mousedown', outsideClick);
    setTimeout(() => document.addEventListener('mousedown', outsideClick), 0);
    setTimeout(() => titleInput.focus(), 0);
    return box;
  }

  // ── Список — ті самі колонки й картки, що на дошці, тільки згруповані
  // таблицею замість карток-плиток (як у референсі). ──────────────────────
  function renderListRow(c, hex) {
    const p = priorityOf(c.priority);
    const m = members.find((mm) => mm.user_id === c.assignee_user_id);
    const priorityIcon = c.priority ? icon('flag', 13) : null;
    if (priorityIcon) priorityIcon.style.color = p.color;
    const row = el('div', { class: 'list-row' },
      el('span', { class: 'list-col-name with-icon' }, el('span', { style: `color:${hex}` }, icon('checkCircle', 15)), c.title),
      m ? el('span', { class: 'with-icon' }, avatarEl(m.name, m.user_id, 18), m.name) : el('span', { class: 'muted' }, '—'),
      c.due_date ? el('span', { class: 'list-due' }, c.due_date) : el('span', { class: 'muted' }, '—'),
      c.priority ? el('span', { class: 'with-icon' }, priorityIcon, p.label) : el('span', { class: 'muted' }, '—'),
      el('span', { class: 'muted' }, c.total_seconds ? formatSeconds(c.total_seconds) : '—'));
    row.addEventListener('click', () => openTaskCard(c.id, reload));
    return row;
  }

  function renderListView(columns) {
    const wrap = el('div', { class: 'list-view' });
    columns.forEach((col) => {
      const hex = tagColorHex(col.color);
      wrap.append(el('div', { class: 'list-group-head' },
        el('button', {
          class: 'btn small icon-only', title: col.collapsed ? 'Розгорнути' : 'Згорнути', onclick: () => toggleCollapse(col),
        }, icon(col.collapsed ? 'chevronRight' : 'chevronDown', 13)),
        el('span', { class: 'list-group-badge', style: `background:${hex}` }, icon('checkCircle', 13), col.name),
        el('span', { class: 'muted', style: 'font-size:12.5px' }, String(col.cards.length))));
      if (col.collapsed) return;

      wrap.append(el('div', { class: 'list-table' },
        el('div', { class: 'list-row list-table-head' },
          el('span', { class: 'list-col-name' }, 'Назва'), el('span', {}, 'Виконавець'),
          el('span', {}, 'Дедлайн'), el('span', {}, 'Пріоритет'), el('span', {}, 'Час')),
        ...col.cards.map((c) => renderListRow(c, hex))));

      const addWrap = el('div', { style: 'padding:6px 10px 14px' });
      function showTrigger() {
        addWrap.textContent = '';
        if (canCreate) addWrap.append(el('button', { class: 'btn small', onclick: () => showForm() }, withIcon('plus', 'Додати задачу')));
      }
      function showForm() {
        addWrap.textContent = '';
        addWrap.append(buildQuickAdd(col, (created) => { showTrigger(); if (created) reload(); }));
      }
      showTrigger();
      wrap.append(addWrap);
    });
    return wrap;
  }

  function renderColumn(col) {
    const hex = tagColorHex(col.color);
    // Легкий відтінок кольору колонки на весь її фон (не лише пігулка
    // заголовка) — color-mix поверх звичайного --panel-2, щоб тема не ламалась.
    const tintBg = `background: color-mix(in srgb, ${hex} 10%, var(--panel-2))`;

    if (col.collapsed) {
      const column = el('div', { class: 'kanban-col collapsed', 'data-column-id': col.id, 'data-order': col.board_order, style: tintBg },
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

    const column = el('div', { class: 'kanban-col', 'data-column-id': col.id, 'data-order': col.board_order, style: tintBg },
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
      catch (e2) { if (e2.status === 409) wipLimitNotice(e2.message); else toast(e2.message, true); }
      await reload();
    });
    return column;
  }

  // WIP-ліміт («в роботі» — не більше однієї задачі на людину): окреме
  // спливне сповіщення, СПРАВА ЗВЕРХУ (звичайний toast() — знизу справа й
  // призначений для всього іншого в застосунку, тут навмисно окремо).
  function wipLimitNotice(message) {
    document.querySelector('.wip-limit-notice')?.remove();
    const notice = el('div', { class: 'wip-limit-notice' },
      icon('alert', 16),
      el('div', {}, el('div', { style: 'font-weight:600;margin-bottom:2px' }, 'Не можна перенести задачу'), el('div', {}, message)),
      el('button', { class: 'btn small icon-only', type: 'button', onclick: () => notice.remove() }, icon('close', 12)));
    document.body.append(notice);
    setTimeout(() => notice.remove(), 6000);
  }

  // Bulk-попап по правому кліку — «наразі це тільки видалення карточки»
  // (для однієї картки чи для всього поточного мультивибору одразу).
  function openCardContextMenu(e, cardIds) {
    document.querySelector('.task-popover')?.remove();
    const menu = el('div', { class: 'task-popover', style: `position:fixed;left:${e.clientX}px;top:${e.clientY}px;visibility:hidden` });
    const count = cardIds.length;
    menu.append(el('div', {
      class: 'task-popover-item danger',
      onclick: async () => {
        menu.remove();
        if (!confirm(count > 1 ? `Видалити ${count} задачі?` : 'Видалити цю задачу?')) return;
        try {
          await Promise.all(cardIds.map((id) => api.del(`/task_cards/${id}`)));
          clearSelection();
          await reload();
        } catch (err) { toast(err.message, true); }
      },
    }, icon('trash', 13), count > 1 ? `Видалити (${count})` : 'Видалити'));
    document.body.append(menu);
    const maxLeft = window.innerWidth - menu.offsetWidth - 8;
    const maxTop = window.innerHeight - menu.offsetHeight - 8;
    menu.style.left = `${Math.min(e.clientX, Math.max(8, maxLeft))}px`;
    menu.style.top = `${Math.min(e.clientY, Math.max(8, maxTop))}px`;
    menu.style.visibility = '';
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  function clearSelection() {
    selectedCardIds.forEach((id) => kanban.querySelector(`.kanban-card[data-card-id="${id}"]`)?.classList.remove('selected'));
    selectedCardIds.clear();
  }
  kanban.addEventListener('click', (e) => {
    if (selectedCardIds.size && !e.target.closest('.kanban-card')) clearSelection();
  });

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
    const progress = progressBarNode(c.total_seconds, c.estimate_minutes, true);
    if (progress) card.append(progress);
    if (timerNode) card.append(timerNode);
    if (selectedCardIds.has(c.id)) card.classList.add('selected');
    card.addEventListener('dragstart', () => {
      dragging = { id: c.id }; card.classList.add('dragging'); startAutoScroll();
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging'); dragging = null; stopAutoScroll(); clearIndicator();
      kanban.querySelectorAll('.kanban-col').forEach((k) => k.classList.remove('drag-over'));
    });

    // Затиснути (не клікнути!) картку — обрати її для мультивибору; поки
    // курсор не зрушив і не відпустили кнопку до спливання таймеру, це не
    // клік і не початок drag (draggable тимчасово вимикаємо на час чекання).
    const toggleSelected = () => {
      if (selectedCardIds.has(c.id)) { selectedCardIds.delete(c.id); card.classList.remove('selected'); }
      else { selectedCardIds.add(c.id); card.classList.add('selected'); }
    };
    let pressTimer = null, pressStart = null, longPressed = false;
    const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } card.draggable = true; };
    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      longPressed = false;
      pressStart = { x: e.clientX, y: e.clientY };
      card.draggable = false;
      pressTimer = setTimeout(() => { longPressed = true; card.draggable = true; toggleSelected(); }, 480);
    });
    card.addEventListener('pointerup', cancelPress);
    card.addEventListener('pointerleave', cancelPress);
    card.addEventListener('pointermove', (e) => {
      if (!pressTimer || !pressStart) return;
      if (Math.abs(e.clientX - pressStart.x) > 6 || Math.abs(e.clientY - pressStart.y) > 6) cancelPress();
    });
    card.addEventListener('click', (e) => {
      if (longPressed) { longPressed = false; e.preventDefault(); e.stopPropagation(); return; }
      if (selectedCardIds.size) { toggleSelected(); return; }
      openTaskCard(c.id, reload);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!selectedCardIds.has(c.id)) { clearSelection(); selectedCardIds.add(c.id); card.classList.add('selected'); }
      openCardContextMenu(e, [...selectedCardIds]);
    });
    return card;
  }

  // ── Бокове меню: Spaces → Boards деревом, фіксоване зліва на всіх трьох
  // вьюхах (Дошка/Список/Календар), бо все це одна й та сама сторінка.
  // Згорнуте — квадратні плашки-іконки (Space = лого чи ініціали, Board —
  // обрана іконка); розгорнуте — звичайне дерево з назвами й лічильником
  // карток. Стан згорнутості й розкритих просторів — у localStorage, як і
  // згортання груп головного меню (app.js). ───────────────────────────
  const SIDEBAR_COLLAPSE_KEY = 'task_sidebar_collapsed';
  const SIDEBAR_EXPANDED_KEY = 'task_sidebar_expanded_spaces';
  let sidebarCollapsed = false;
  try { sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1'; } catch { /* приватний режим — ігноруємо */ }
  function expandedSpaceIds() {
    try { return new Set(JSON.parse(localStorage.getItem(SIDEBAR_EXPANDED_KEY) || '[]')); } catch { return new Set(); }
  }
  function setExpandedSpaceIds(ids) { try { localStorage.setItem(SIDEBAR_EXPANDED_KEY, JSON.stringify([...ids])); } catch { /* ігноруємо */ } }

  function boardIconPicker(anchor, b) {
    openPopover(anchor, (box2) => {
      box2.append(...BOARD_ICONS.map((name) => el('div', {
        class: 'task-popover-item', onclick: async () => {
          box2.remove();
          try { await api.put(`/task_boards/${b.id}`, { icon: name }); await renderSidebar(); }
          catch (e) { toast(e.message, true); }
        },
      }, icon(name, 14))));
    });
  }

  function uploadSpaceLogo(s) {
    const input = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    input.addEventListener('change', async () => {
      const file = input.files[0]; if (!file) { input.remove(); return; }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        await api.put(`/task_spaces/${s.id}`, { logo_data_url: dataUrl });
        await renderSidebar();
      } catch (e) { toast(e.message, true); }
      input.remove();
    });
    document.body.append(input);
    input.click();
  }

  async function renderSidebar() {
    sidebar.textContent = '';
    sidebar.classList.toggle('collapsed', sidebarCollapsed);
    const toggleBtn = el('button', {
      class: 'task-sidebar-toggle', type: 'button', title: sidebarCollapsed ? 'Розгорнути меню' : 'Згорнути меню',
      onclick: () => {
        sidebarCollapsed = !sidebarCollapsed;
        try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, sidebarCollapsed ? '1' : '0'); } catch { /* ігноруємо */ }
        renderSidebar();
      },
    }, icon(sidebarCollapsed ? 'chevronRight' : 'chevronLeft', 14));
    sidebar.append(el('div', { class: 'task-sidebar-head' },
      sidebarCollapsed ? null : el('span', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.04em;flex:1 1 auto' }, 'Задачі'),
      toggleBtn));

    let spaces;
    try { spaces = (await api.get('/task_spaces/nav')).rows; }
    catch (e) { sidebar.append(el('div', { class: 'muted', style: 'padding:8px;font-size:12px' }, e.message)); return; }

    const list = el('div', { class: 'task-sidebar-list' });
    sidebar.append(list);
    const expanded = expandedSpaceIds();
    // Простір поточної дошки — завжди розгорнутий, інакше активну дошку
    // просто не видно було б у щойно завантаженому меню.
    const ownerSpace = spaces.find((sp) => sp.boards.some((b) => b.id === boardId));
    if (ownerSpace && !expanded.has(ownerSpace.id)) { expanded.add(ownerSpace.id); setExpandedSpaceIds(expanded); }

    spaces.forEach((s) => {
      if (sidebarCollapsed) {
        list.append(el('button', {
          class: 'task-sidebar-tile space', type: 'button', title: s.name,
          onclick: () => { location.hash = `#/space/${s.id}`; },
        }, s.logo_data_url ? el('img', { src: s.logo_data_url, class: 'task-sidebar-logo-img' }) : el('span', {}, initials(s.name))));
        s.boards.forEach((b) => {
          list.append(el('button', {
            class: `task-sidebar-tile board${b.id === boardId ? ' active' : ''}`, type: 'button', title: b.name,
            onclick: () => { location.hash = `#/board/${b.id}`; },
          }, icon(b.icon || 'grid', 16)));
        });
        return;
      }
      const isOpen = expanded.has(s.id);
      const logoBtn = el('button', {
        class: 'task-sidebar-logo-btn', type: 'button', title: canEdit ? 'Змінити лого простору' : s.name,
        onclick: (e) => { e.stopPropagation(); if (canEdit) uploadSpaceLogo(s); },
      }, s.logo_data_url ? el('img', { src: s.logo_data_url, class: 'task-sidebar-logo-img small' }) : el('span', { class: 'task-sidebar-logo-fallback' }, initials(s.name)));
      const spaceRow = el('div', {
        class: 'task-sidebar-space-row', onclick: () => {
          if (isOpen) expanded.delete(s.id); else expanded.add(s.id);
          setExpandedSpaceIds(expanded); renderSidebar();
        },
      }, icon(isOpen ? 'chevronDown' : 'chevronRight', 12), logoBtn, el('span', { class: 'task-sidebar-space-name' }, s.name));
      list.append(spaceRow);
      if (!isOpen) return;
      s.members?.length ? list.append(el('div', { class: 'task-sidebar-members' },
        ...s.members.slice(0, 6).map((m) => avatarEl(m.name, m.user_id, 18)))) : null;
      s.boards.forEach((b) => {
        const iconBtn = el('button', {
          class: 'task-sidebar-board-icon', type: 'button', title: canEdit ? 'Змінити іконку дошки' : b.name,
          onclick: (e) => { e.stopPropagation(); if (canEdit) boardIconPicker(iconBtn, b); },
        }, icon(b.icon || 'grid', 13));
        list.append(el('a', {
          href: `#/board/${b.id}`, class: `task-sidebar-board-row${b.id === boardId ? ' active' : ''}`,
        }, iconBtn, el('span', { class: 'task-sidebar-board-name' }, b.name), el('span', { class: 'muted', style: 'font-size:11px' }, String(b.card_count))));
      });
    });
  }

  await reload();
  await renderSidebar();
  return page;
}

// ── Картка задачі: великий попап з полями зліва й Activity/коментарями
// справа — режим редагування, як на скріні ClickUp. ───────────────────────

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

  // Пігулка кольору колонки (як і статус у полі картки) — за НАЗВОЮ
  // колонки з payload-у (колонки самі не зберігають, лише поточний
  // список), тому якщо колонку відтоді перейменували/видалили — просто
  // звичайний текст без кольору, без падінь.
  function statusPill(name, columnsList) {
    const col = (columnsList || []).find((c) => c.name === name);
    if (!col) return el('span', {}, name || '—');
    const hex = tagColorHex(col.color);
    return el('span', { class: 'task-status-pill-mini', style: `background:${hex}22;color:${hex}` }, name);
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

  // Плашка прикріпленого файлу — кнопка видалення (квадратна, червона
  // іконка) з'являється лише при наведенні на саму плашку.
  function fileChip(a, onDelete) {
    return el('div', { class: 'task-file-chip' },
      el('a', { href: `/api/task_attachments/${a.id}/file`, target: '_blank', rel: 'noreferrer', class: 'task-file-chip-link with-icon' }, icon('paperclip', 13), el('span', { class: 'task-file-chip-name' }, a.file_name)),
      onDelete ? el('button', { class: 'task-file-chip-del', type: 'button', title: 'Видалити файл', onclick: onDelete }, icon('close', 12)) : null);
  }

  // Невеличкий попап на місці кліку (а не окрема модалка): час початку —
  // час кінця, бейдж «+N», якщо кінець на інший день (з календариком, щоб
  // змінити саму дату), і жирна сума праворуч — той самий вигляд і з
  // кліку по сумі в «Трекер часу», і з кліку по згадці таймера в стрічці.
  function editTimeEntry(entryId, anchor) {
    const entry = d.timeEntries.find((t) => t.id === entryId);
    if (!entry) return;
    const pad2 = (n) => String(n).padStart(2, '0');
    const dayKey = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    const timeKey = (dt) => `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
    const startD = new Date(entry.started_at);
    const endD = entry.ended_at ? new Date(entry.ended_at) : new Date();

    openPopover(anchor, (box2) => {
      const startTimeInput = withPicker(el('input', { type: 'time', value: timeKey(startD) }));
      const endTimeInput = withPicker(el('input', { type: 'time', value: timeKey(endD) }));
      const startDateInput = withPicker(el('input', { type: 'date', value: dayKey(startD) }));
      const endDateInput = withPicker(el('input', { type: 'date', value: dayKey(endD) }));
      const dayBadge = el('span', { class: 'time-edit-daybadge hidden' });
      const totalLabel = el('b', { class: 'time-edit-total' });
      const datesWrap = el('div', { class: 'time-edit-dates hidden' },
        el('div', { class: 'task-popover-item', style: 'cursor:default' }, el('span', { class: 'muted', style: 'width:30px' }, 'З'), startDateInput),
        el('div', { class: 'task-popover-item', style: 'cursor:default' }, el('span', { class: 'muted', style: 'width:30px' }, 'До'), endDateInput));
      const calBtn = el('button', { class: 'btn small icon-only', type: 'button', title: 'Змінити дату', onclick: () => datesWrap.classList.toggle('hidden') }, icon('calendar', 13));

      function currentRange() {
        const s = new Date(`${startDateInput.value}T${startTimeInput.value || '00:00'}`);
        const e = new Date(`${endDateInput.value}T${endTimeInput.value || '00:00'}`);
        return { s, e };
      }
      // Поля дають лише точність до хвилини (як на референсі) — доки
      // користувач нічого не чіпав, сума показує СПРАВЖНІ (з точністю до
      // секунди) початкові started_at/ended_at, а не округлену з полів;
      // округлення до хвилини настає лише після реального редагування.
      function sync(precise) {
        const { s, e } = precise ? { s: startD, e: endD } : currentRange();
        const diffDays = Math.round((new Date(e.toDateString()) - new Date(s.toDateString())) / 86400000);
        dayBadge.textContent = diffDays > 0 ? `+${diffDays}` : '';
        dayBadge.classList.toggle('hidden', diffDays <= 0);
        totalLabel.textContent = formatHMS((e - s) / 1000);
      }
      let saveTimer = null;
      function save() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          const { s, e } = currentRange();
          try { await api.put(`/task_time_entries/${entryId}`, { started_at: s.toISOString(), ended_at: e.toISOString() }); await refresh(); }
          catch (err) { toast(err.message, true); }
        }, 400);
      }
      [startTimeInput, endTimeInput, startDateInput, endDateInput].forEach((inp) => {
        inp.addEventListener('change', () => { sync(false); save(); });
      });
      sync(true);

      box2.append(el('div', { class: 'time-edit-row' },
        startTimeInput, el('span', { class: 'muted' }, '–'), endTimeInput, dayBadge, calBtn,
        el('div', { style: 'flex:1 1 auto' }), totalLabel),
        datesWrap);
    });
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
    const statusField = buildStatusField(card, columns, (columnId) => {
      api.post(`/task_cards/${cardId}/move`, { column_id: columnId }).then(refresh).then(onChange).catch((e) => toast(e.message, true));
    });

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
    // Клік на суму часу — редагувати останній завершений запис (той самий
    // попап, що й з Activity). Поки таймер йде, число ще не «зафіксоване»
    // (постійно росте), тому клікабельним воно стає лише коли зупинено.
    const lastEntry = [...timeEntries].filter((t) => t.ended_at).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
    const timeLabelClickable = !isRunning && !!lastEntry;
    // Без явного зменшеного font-size — усі значення полів картки мають
    // бути ОДНАКОВОГО розміру (раніше «Трекер часу» виглядав дрібнішим за
    // сусідні поля саме через цей inline-override).
    const timeLabel = el('span', {
      class: `muted${timeLabelClickable ? ' activity-clickable' : ''}`,
      title: timeLabelClickable ? 'Редагувати запис часу' : undefined,
      onclick: timeLabelClickable ? () => editTimeEntry(lastEntry.id, timeLabel) : undefined,
    }, formatSeconds(totalSeconds));
    if (isRunning) {
      const startedAt = new Date(runningTimer.started_at).getTime();
      const tick = () => { timeLabel.textContent = formatSeconds(totalSeconds + Math.floor((Date.now() - startedAt) / 1000)); };
      tick();
      tickTimer = setInterval(tick, 1000);
    }
    const timerCell = el('div', { style: 'display:flex;align-items:center;gap:8px' }, timerBtn, timeLabel);

    // Estimate (у годинах — зручніше вводити людині, зберігається у
    // хвилинах) — і сам прогрес-бар «натрекано / оцінка» рахується від
    // цього поля. Автор — хто створив картку (created_by), лише читання.
    const estimateInput = el('input', {
      type: 'number', min: '0', step: '0.25', value: card.estimate_minutes ? String(card.estimate_minutes / 60) : '',
      placeholder: '—', style: 'width:64px',
    });
    estimateInput.addEventListener('change', () => {
      const v = estimateInput.value.trim();
      patch({ estimate_minutes: v ? Math.round(Number(v) * 60) : null });
    });
    // Текст опису без HTML-розмітки — для AI-запитів (уточнення опису,
    // оцінка estimate): чим детальніший опис, тим більший текст тут, а
    // отже — і більший обсяг, який AI закладе в оцінку часу.
    function descriptionPlainText() {
      return (card.description_blocks || [])
        .filter((b) => b.type === 'paragraph')
        .map((b) => String(b.text || '').replace(/<[^>]+>/g, ' ').trim())
        .filter(Boolean).join('\n');
    }
    // AI-оцінка estimate — кнопка-іскорка праворуч від поля: анімується,
    // поки триває запит, і сама проставляє estimate на основі опису задачі;
    // без опису — неактивна (лише інформаційне повідомлення при кліку).
    const aiEstimateBtn = el('button', {
      class: 'task-ai-estimate-btn', type: 'button', title: 'AI-оцінка часу за описом задачі',
      onclick: async () => {
        const desc = descriptionPlainText();
        if (!desc) { toast('Спочатку додайте опис задачі — AI оцінює час саме за його обсягом', true); return; }
        if (aiEstimateBtn.classList.contains('loading')) return;
        aiEstimateBtn.classList.add('loading');
        try {
          const res = await api.post(`/task_cards/${cardId}/estimate_ai`, { description: desc });
          if (res.hours) await patch({ estimate_minutes: Math.round(res.hours * 60) });
        } catch (e) { toast(e.message, true); }
        finally { aiEstimateBtn.classList.remove('loading'); }
      },
    }, icon('sparkles', 14));
    const estimateField = el('div', { style: 'display:flex;align-items:center;gap:6px' }, estimateInput, el('span', { class: 'muted' }, 'год'), aiEstimateBtn);
    const authorField = el('div', { class: 'with-icon' }, avatarEl(card.creator_name || '?', card.created_by, 18), card.creator_name || '—');

    // Автозбереження блоків опису НЕ йде через звичайний patch()/refresh() —
    // той перемальовує всю модалку й скинув би фокус посеред набору тексту.
    // Пишемо напряму, оновлюючи лише локальний card.description_blocks —
    // Activity й «редаговано» підхопить наступний природний refresh().
    const descArea = renderDescriptionEditor(card, async (blocks) => {
      try { await api.put(`/task_cards/${cardId}`, { description_blocks: blocks }); card.description_blocks = blocks; }
      catch (e) { toast(e.message, true); }
    });

    // ── AI-генерація опису: попап знизу картки (position:absolute bottom:0
    // відносно .task-drawer — сам box має position:relative), закривається
    // по надсиланню, і на його місці — мінімалістична анімація, поки йде
    // запит. Два режими: «з нуля» — результат дописується в блоки опису
    // (замінює єдиний порожній блок за замовчуванням або додається до
    // наявного вмісту); editExisting («Уточнити опис») — поточний опис
    // передається як контекст, а результат ПОВНІСТЮ його замінює. ───────
    async function generateAiDescription({ notes, detail, editExisting }) {
      box.querySelector('.task-ai-loading')?.remove();
      const loading = el('div', { class: 'task-ai-loading' }, icon('sparkles', 15), el('span', {}, editExisting ? 'Оновлюю опис…' : 'Генерую опис…'));
      box.append(loading);
      try {
        const body = { notes, detail };
        if (editExisting) body.existing = descriptionPlainText();
        const res = await api.post(`/task_cards/${cardId}/generate_description`, body);
        const text = String(res.text || '').trim();
        if (text) {
          const newBlocks = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => ({ ...makeBlock('paragraph'), text: line }));
          let finalBlocks;
          if (editExisting) {
            finalBlocks = newBlocks;
          } else {
            const current = card.description_blocks && card.description_blocks.length ? card.description_blocks : null;
            const isSingleEmpty = current && current.length === 1 && current[0].type === 'paragraph'
              && !String(current[0].text || '').replace(/<[^>]+>/g, '').trim();
            finalBlocks = (!current || isSingleEmpty) ? newBlocks : [...current, ...newBlocks];
          }
          await api.put(`/task_cards/${cardId}`, { description_blocks: finalBlocks });
        }
        await refresh();
      } catch (e) { toast(e.message, true); }
      finally { loading.remove(); }
    }

    // Мікрофон + маленька кнопка надсилання — ВСЕРЕДИНІ поля вводу (правий
    // нижній кут), а не окрема велика кнопка на всю висоту поля. Мікрофон —
    // голосове диктування (Web Speech API, uk-UA): клік запускає запис
    // (кнопка отримує клас .recording — пульсуюча анімація), розпізнаний
    // текст дописується в textarea; повторний клік або природне завершення
    // запису його зупиняють.
    function buildAiInputWrap(notesInput, onSend) {
      let recognition = null;
      let recording = false;
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const stopRecording = () => { try { recognition?.stop(); } catch { /* noop */ } };
      const micBtn = el('button', {
        class: 'task-ai-mic-btn', type: 'button', title: 'Диктувати голосом',
        onclick: () => {
          if (recording) { stopRecording(); return; }
          if (!SR) { toast('Голосове введення не підтримується цим браузером', true); return; }
          recognition = new SR();
          recognition.lang = 'uk-UA';
          recognition.interimResults = false;
          recognition.continuous = true;
          recognition.onresult = (ev) => {
            let text = '';
            for (let i = ev.resultIndex; i < ev.results.length; i += 1) text += ev.results[i][0].transcript;
            if (text.trim()) notesInput.value = (notesInput.value.trim() ? `${notesInput.value.trim()} ` : '') + text.trim();
          };
          recognition.onerror = () => { recording = false; micBtn.classList.remove('recording'); };
          recognition.onend = () => { recording = false; micBtn.classList.remove('recording'); };
          try { recognition.start(); recording = true; micBtn.classList.add('recording'); }
          catch { toast('Не вдалося увімкнути мікрофон', true); }
        },
      }, icon('mic', 14));
      if (!SR) micBtn.title = 'Голосове введення не підтримується цим браузером';
      const sendBtn = el('button', { class: 'task-ai-send-btn', type: 'button', title: 'Надіслати', onclick: () => { stopRecording(); onSend(); } }, icon('send', 14));
      const wrap = el('div', { class: 'task-ai-input-wrap' }, notesInput, el('div', { class: 'task-ai-input-controls' }, micBtn, sendBtn));
      wrap._stopRecording = stopRecording;
      return wrap;
    }

    // Закриття по кліку будь-де поза попапом — той самий підхід, що й у
    // openPopover (мишдаун поза панеллю й поза кнопкою-якорем закриває її).
    function closeAiPanelOnOutsideClick(panel, anchor) {
      const close = (e) => {
        if (!panel.isConnected) { document.removeEventListener('mousedown', close); return; }
        if (!panel.contains(e.target) && e.target !== anchor && !anchor?.contains?.(e.target)) {
          panel._stopRecording?.();
          panel.remove();
          document.removeEventListener('mousedown', close);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
    }

    // Три кнопки рівня деталізації — у шапці попапу (зліва від хрестика);
    // поле уточнення — велике (textarea), мікрофон і маленька кнопка
    // надсилання — всередині поля, в правому нижньому куті.
    function openAiDescPanel() {
      box.querySelector('.task-ai-desc-panel')?.remove();
      let detail = 'standard';
      const panel = el('div', { class: 'task-ai-desc-panel' });
      const doGenerate = () => {
        const notes = notesInput.value.trim();
        panel._stopRecording?.();
        panel.remove();
        generateAiDescription({ notes, detail });
      };
      const levelBtn = (key, label) => el('button', {
        type: 'button', class: `task-ai-level-btn${detail === key ? ' active' : ''}`,
        onclick: () => { detail = key; renderPanel(); },
      }, label);
      const notesInput = el('textarea', { class: 'task-ai-desc-input', rows: 5, placeholder: 'Уточніть, що додати в опис (необов’язково)…' });
      const inputWrap = buildAiInputWrap(notesInput, doGenerate);
      panel._stopRecording = () => inputWrap._stopRecording?.();
      function renderPanel() {
        panel.textContent = '';
        panel.append(
          el('div', { class: 'task-ai-desc-head' },
            withIcon('sparkles', 'AI-опис задачі'),
            el('div', { style: 'flex:1 1 auto' }),
            el('div', { class: 'task-ai-level-row' }, levelBtn('brief', 'Коротко'), levelBtn('standard', 'Стандартно'), levelBtn('detailed', 'Детально')),
            el('button', { class: 'btn small icon-only', type: 'button', onclick: () => { panel._stopRecording?.(); panel.remove(); } }, icon('close', 13))),
          el('div', { class: 'task-ai-desc-body' },
            el('div', { class: 'muted', style: 'font-size:12.5px' }, 'Опишу задачу на основі назви — можна одразу уточнити деталі нижче.')),
          el('div', { class: 'task-ai-desc-input-row' }, inputWrap));
      }
      renderPanel();
      box.append(panel);
      closeAiPanelOnOutsideClick(panel, aiDescBtn);
      notesInput.focus();
    }

    // Кнопка «Редагувати через AI» — з'являється лише коли в описі вже є
    // згенерований/написаний зміст; той самий попап-«bottom sheet», але
    // спрощений: без рівнів деталізації (тут не «з нуля», а уточнення
    // наявного) — просто поле й кнопка «Надіслати», результат ПОВНІСТЮ
    // замінює поточний опис (а не дописується до нього).
    function openAiEditPanel() {
      box.querySelector('.task-ai-desc-panel')?.remove();
      const panel = el('div', { class: 'task-ai-desc-panel' });
      const notesInput = el('textarea', { class: 'task-ai-desc-input', rows: 5, placeholder: 'Що додати чи змінити в описі…' });
      const doSend = () => {
        const notes = notesInput.value.trim();
        if (!notes) { notesInput.focus(); return; }
        panel._stopRecording?.();
        panel.remove();
        generateAiDescription({ notes, detail: 'standard', editExisting: true });
      };
      const inputWrap = buildAiInputWrap(notesInput, doSend);
      panel._stopRecording = () => inputWrap._stopRecording?.();
      panel.append(
        el('div', { class: 'task-ai-desc-head' },
          withIcon('sparkles', 'Уточнити опис'), el('div', { style: 'flex:1 1 auto' }),
          el('button', { class: 'btn small icon-only', type: 'button', onclick: () => { panel._stopRecording?.(); panel.remove(); } }, icon('close', 13))),
        el('div', { class: 'task-ai-desc-input-row' }, inputWrap));
      box.append(panel);
      closeAiPanelOnOutsideClick(panel, aiEditBtn);
      notesInput.focus();
    }

    const descHasContent = card.description_blocks && card.description_blocks.length
      && !(card.description_blocks.length === 1 && card.description_blocks[0].type === 'paragraph'
        && !String(card.description_blocks[0].text || '').replace(/<[^>]+>/g, '').trim());
    const aiDescBtn = el('button', { class: 'task-ai-desc-btn', type: 'button', title: 'Згенерувати опис через AI', onclick: openAiDescPanel }, icon('sparkles', 15));
    const aiEditBtn = descHasContent
      ? el('button', { class: 'task-ai-desc-btn', type: 'button', title: 'Уточнити опис через AI', onclick: openAiEditPanel }, icon('edit', 13))
      : null;
    const descHeader = el('div', { class: 'task-desc-header' }, el('span', { class: 'muted', style: 'font-size:12px' }, 'Опис'), el('div', { style: 'flex:1 1 auto' }), aiEditBtn, aiDescBtn);

    const fileInput = el('input', { type: 'file', style: 'display:none' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0]; if (!file) return;
      const dataUrl = await readFileAsDataUrl(file);
      try { await api.post(`/task_cards/${cardId}/attachments`, { file_name: file.name, mime: file.type, content: dataUrl }); await refresh(); }
      catch (e) { toast(e.message, true); }
      fileInput.value = '';
    });

    const cardMenuBtn = el('button', { class: 'task-board-menu-btn', title: 'Меню задачі' }, icon('more', 14));
    cardMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopover(cardMenuBtn, (box2) => {
        box2.append(canDelete ? el('div', {
          class: 'task-popover-item danger',
          onclick: async () => {
            box2.remove();
            if (!confirm('Видалити картку?')) return;
            try { await api.del(`/task_cards/${cardId}`); closeModal(); onChange(); }
            catch (e2) { toast(e2.message, true); }
          },
        }, icon('trash', 13), 'Видалити задачу') : el('div', { class: 'muted', style: 'padding:6px 8px;font-size:12px' }, 'Немає доступних дій'));
      });
    });
    // Верхня частина (крихти/меню, назва, прогрес, таблиця полів) — завжди
    // повністю видна, НЕ скролиться; скролиться лише вміст нижче (опис,
    // файли) — у своєму контейнері з тонким скролом, окремо від полів.
    const top = el('div', { class: 'task-drawer-top' },
      el('div', { class: 'row tight', style: 'align-items:center;gap:8px' },
        el('div', { class: 'task-drawer-crumb', style: 'flex:1 1 auto' }, [space?.name, board?.name].filter(Boolean).join(' / ')),
        cardMenuBtn),
      titleInput,
      progressBarNode(totalSeconds, card.estimate_minutes),
      el('div', { class: 'task-field-table' },
        fieldRow(fieldCell('dot', 'Статус', statusField), fieldCell('user', 'Виконавець', assigneeField)),
        fieldRow(fieldCell('calendar', 'Дати', datesCell), fieldCell('flag', 'Пріоритет', priorityField)),
        fieldRow(fieldCell('idCard', 'Автор', authorField), fieldCell('gauge', 'Estimate', estimateField)),
        fieldRow(fieldCell('clock', 'Трекер часу', timerCell), fieldCell('tag', 'Теги', tagsField))));
    const scroll = el('div', { class: 'task-drawer-scroll' },
      descHeader,
      descArea,
      el('div', { class: 'task-attach-list' },
        ...attachments.map((a) => fileChip(a, canDelete ? async () => { await api.del(`/task_attachments/${a.id}`); await refresh(); } : null))),
      el('button', { class: 'task-quick-row', onclick: () => fileInput.click() }, icon('paperclip', 14), 'Прикріпити файл'), fileInput);
    const main = el('div', { class: 'task-drawer-main' }, top, scroll);

    // ── Права частина: Activity + коментарі ────────────────────────────
    const feedItems = [
      // 'commented' — той самий факт, що й comments.map нижче вже показує
      // повною бульбашкою; окремий пункт в Activity був би дублем.
      ...activity.filter((a) => a.kind !== 'commented').map((a) => {
        const p = a.payload ? JSON.parse(a.payload) : {};
        const clickable = (a.kind === 'time_started' || a.kind === 'time_stopped') && p.entry_id;
        const content = a.kind === 'moved'
          ? [`${a.user_name || 'Хтось'} переніс(ла): `, statusPill(p.from, columns), ' → ', statusPill(p.to, columns), p.auto ? ' (автоматично)' : '']
          : [activityText(a)];
        const textNode = el('div', clickable ? { class: 'activity-clickable', title: 'Редагувати запис часу', onclick: () => editTimeEntry(p.entry_id, textNode) } : {}, ...content);
        return { created_at: a.created_at, node: el('div', { class: 'activity-item' },
          el('div', { class: 'activity-bullet' }),
          el('div', { class: 'activity-body' }, textNode, el('div', { class: 'muted', style: 'font-size:11px' }, fmtDate(a.created_at)))) };
      }),
      ...comments.filter((c) => !c.pinned).map((c) => ({ created_at: c.created_at, node: commentNode(c) })),
    ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    // Закріпити можна скільки завгодно коментарів одразу — вони виносяться
    // окремим блоком нагору стрічки, у порядку, в якому їх самих написали
    // (а не в порядку закріплення), щоб не плутати хронологію.
    function commentNode(c) {
      const pinBtn = el('button', {
        class: `activity-pin-btn${c.pinned ? ' pinned' : ''}`, title: c.pinned ? 'Відкріпити' : 'Закріпити зверху',
        onclick: async (e) => {
          e.stopPropagation();
          try { await api.put(`/task_comments/${c.id}/pin`, { pinned: !c.pinned }); await refresh(); }
          catch (err) { toast(err.message, true); }
        },
      }, icon('pin', 12));
      return el('div', { class: 'activity-item comment' },
        avatarEl(c.user_name || '?', c.user_id, 22),
        el('div', { class: 'activity-body' },
          el('div', { class: 'row', style: 'align-items:flex-start;gap:6px' },
            el('div', { style: 'flex:1 1 auto;min-width:0' }, el('b', {}, c.user_name || 'Хтось'), ': ', c.body),
            pinBtn),
          c.attachments.length ? el('div', { style: 'margin-top:4px;display:flex;flex-direction:column;gap:2px' }, ...c.attachments.map((a) => fileChip(a))) : null,
          el('div', { class: 'muted', style: 'font-size:11px' }, fmtDate(c.created_at))));
    }
    const pinnedComments = comments.filter((c) => c.pinned).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const pinnedSection = pinnedComments.length
      ? el('div', { class: 'activity-pinned' },
        el('div', { class: 'activity-pinned-head' }, icon('pin', 12), 'Закріплено'),
        ...pinnedComments.map(commentNode))
      : null;

    const feed = el('div', { class: 'activity-feed' }, pinnedSection, ...feedItems.map((it) => it.node));

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
    // Enter — надіслати коментар; Shift+Enter — звичайний перенос рядка.
    commentInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); }
    });

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
