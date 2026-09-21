// Канбан воронки лідів: колонки — активні статуси лідів у своєму порядку
// (src/prospecting.js:kanban), картки перетягуються між колонками мишкою,
// перетягування міняє статус тим самим /prospecting/leads/:id/status, що
// й звичайна форма зміни статусу в картці ліда — «Клієнт» (is_won) так
// само сам заводить клієнта, «Не підходить»/«Відмова» так само вимагають
// причину.
//
// Позицію всередині колонки видно з board_order (src/prospecting.js) —
// перетягування може покласти картку і між двома конкретними картками,
// а не лише «десь у колонці»; лінія-індикатор показує, куди саме вона
// ляже. Біля лівого/правого краю дошки під час перетягування дошка сама
// прокручується вбік, щоб дотягнутись до колонки, якої зараз не видно.
import { api } from '../api.js';
import { el, money, modal, toast } from '../ui.js';
import { openLead } from './prospecting.js';

function pluralLeads(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'лід';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'ліди';
  return 'лідів';
}

let dictsCache = null;
async function reasonOptions(kind) {
  if (!dictsCache) dictsCache = (await api.get('/prospecting/dictionaries')).dictionaries;
  return dictsCache.filter((d) => d.kind === kind);
}

// Позиція нової картки з двох сусідніх значень board_order: якщо їх
// немає з одного боку — виходимо за край на фіксований крок, якщо є
// обидва — стаємо точно між ними. Той самий прийом, що на бекенді для
// нового ліда чи зміни статусу без явної позиції (src/prospecting.js).
function orderBetween(beforeOrder, afterOrder) {
  if (beforeOrder == null && afterOrder == null) return 1000;
  if (beforeOrder == null) return afterOrder - 1000;
  if (afterOrder == null) return beforeOrder + 1000;
  return (beforeOrder + afterOrder) / 2;
}

export async function renderLeadsKanban(onChange = () => {}) {
  const board = el('div', { class: 'kanban' });

  // dataTransfer.getData() під час dragover у більшості браузерів
  // повертає порожній рядок (readData дозволено лише на drop/dragstart) —
  // тому яку картку тягнемо, памʼятаємо тут, а не читаємо з події.
  let dragging = null;

  // ── Автопрокрутка дошки вбік під час перетягування ────────────────────
  const EDGE = 70;
  const SPEED = 16;
  let scrollDir = 0;
  let scrollRaf = null;

  function updateAutoScroll(e) {
    const rect = board.getBoundingClientRect();
    if (e.clientX < rect.left + EDGE) scrollDir = -1;
    else if (e.clientX > rect.right - EDGE) scrollDir = 1;
    else scrollDir = 0;
  }
  function scrollLoop() {
    if (scrollDir !== 0) board.scrollLeft += scrollDir * SPEED;
    scrollRaf = requestAnimationFrame(scrollLoop);
  }
  function startAutoScroll() { if (scrollRaf == null) scrollRaf = requestAnimationFrame(scrollLoop); }
  function stopAutoScroll() {
    if (scrollRaf != null) cancelAnimationFrame(scrollRaf);
    scrollRaf = null;
    scrollDir = 0;
  }
  board.addEventListener('dragover', (e) => { e.preventDefault(); updateAutoScroll(e); });

  function clearIndicator() {
    board.querySelectorAll('.kanban-drop-indicator').forEach((n) => n.remove());
  }

  async function reload() {
    const { columns } = await api.get('/prospecting/kanban');
    board.textContent = '';
    board.append(...columns.map(renderColumn));
  }

  function renderColumn(col) {
    const cards = el('div', { class: 'kanban-cards' }, ...col.leads.map(renderCard));
    const column = el('div', { class: 'kanban-col' },
      el('div', { class: 'kanban-col-head' },
        el('div', { class: 'kanban-col-title' }, col.name),
        el('div', { class: 'muted', style: 'font-size:12px' }, `${money(col.sum)} · ${col.count} ${pluralLeads(col.count)}`)),
      cards);

    // Куди саме в колонці впаде картка: перебираємо видимі картки (крім
    // тієї, яку тягнемо) і шукаємо першу, чия середина нижче за курсор.
    function dropTarget(clientY) {
      const items = [...cards.querySelectorAll('.kanban-card')]
        .filter((c) => Number(c.dataset.leadId) !== dragging?.id);
      let index = items.length;
      for (let i = 0; i < items.length; i += 1) {
        const rect = items[i].getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) { index = i; break; }
      }
      return { items, index };
    }

    column.addEventListener('dragover', (e) => {
      e.preventDefault();
      column.classList.add('drag-over');
      const { items, index } = dropTarget(e.clientY);
      clearIndicator();
      const indicator = el('div', { class: 'kanban-drop-indicator' });
      if (items[index]) cards.insertBefore(indicator, items[index]);
      else cards.appendChild(indicator);
    });
    column.addEventListener('dragleave', (e) => {
      // dragleave стріляє й при переході між дочірніми елементами колонки —
      // знімаємо підсвітку лише коли курсор реально вийшов за її межі.
      if (!column.contains(e.relatedTarget)) column.classList.remove('drag-over');
    });
    column.addEventListener('drop', async (e) => {
      e.preventDefault();
      column.classList.remove('drag-over');
      const { items, index } = dropTarget(e.clientY);
      clearIndicator();
      if (!dragging) return;
      const before = index > 0 ? Number(items[index - 1].dataset.order) : null;
      const after = index < items.length ? Number(items[index].dataset.order) : null;
      const order = orderBetween(before, after);
      const { id: leadId, fromStatus } = dragging;
      if (fromStatus === col.code) await applyStatus(leadId, col.code, { board_order: order });
      else await moveLead(leadId, col.code, order);
    });
    return column;
  }

  function renderCard(lead) {
    const card = el('div', {
      class: 'kanban-card', draggable: 'true',
      'data-lead-id': lead.id, 'data-order': lead.board_order,
    },
      el('div', { class: 'kanban-card-title' }, lead.company_name),
      el('div', { class: 'muted', style: 'font-size:12px' }, [lead.geo_city, lead.vertical].filter(Boolean).join(' · ') || '—'),
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-top:6px' },
        el('span', { class: 'muted', style: 'font-size:12px' }, lead.owner_name || '—'),
        lead.expected_amount ? el('b', { style: 'font-size:12.5px' }, money(lead.expected_amount)) : null));

    card.addEventListener('dragstart', (e) => {
      dragging = { id: lead.id, fromStatus: lead.status_code };
      // Дані самі по собі не читаються (див. коментар вище), але без
      // хоча б одного setData Firefox узагалі не почне перетягування.
      e.dataTransfer.setData('text/plain', String(lead.id));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
      startAutoScroll();
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragging = null;
      stopAutoScroll();
      clearIndicator();
      board.querySelectorAll('.kanban-col').forEach((c) => c.classList.remove('drag-over'));
    });
    card.addEventListener('click', () => openLead(lead.id, () => { reload(); onChange(); }));
    return card;
  }

  async function moveLead(leadId, statusCode, order) {
    const needsReason = statusCode === 'disqualified' || statusCode === 'lost';
    if (!needsReason) return applyStatus(leadId, statusCode, { board_order: order });

    const kind = statusCode === 'disqualified' ? 'disqualify_reason' : 'lost_reason';
    const options = await reasonOptions(kind);
    const select = el('select', {}, el('option', { value: '' }, 'оберіть причину'),
      ...options.map((o) => el('option', { value: o.code }, o.label)));
    const box = modal(statusCode === 'disqualified' ? 'Причина дискваліфікації' : 'Причина відмови',
      el('div', { class: 'field' }, el('label', {}, 'Причина'), select), [el('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!select.value) return toast('Оберіть причину', true);
          box.remove();
          await applyStatus(leadId, statusCode, {
            board_order: order,
            disqualify_reason: statusCode === 'disqualified' ? select.value : null,
            lost_reason: statusCode === 'lost' ? select.value : null,
          });
        },
      }, 'Зберегти')]);
  }

  async function applyStatus(leadId, statusCode, extra) {
    try {
      const res = await api.post(`/prospecting/leads/${leadId}/status`, { status_code: statusCode, ...extra });
      if (res.client_id) toast('Лід виграно — клієнта створено автоматично');
      await reload();
      onChange();
    } catch (e) {
      toast(e.message, true);
      await reload();
    }
  }

  await reload();
  return board;
}
