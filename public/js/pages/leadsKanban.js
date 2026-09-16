// Канбан воронки лідів: колонки — активні статуси лідів у своєму порядку
// (src/prospecting.js:kanban), картки перетягуються між колонками мишкою,
// перетягування міняє статус тим самим /prospecting/leads/:id/status, що
// й звичайна форма зміни статусу в картці ліда — «Клієнт» (is_won) так
// само сам заводить клієнта, «Не підходить»/«Відмова» так само вимагають
// причину.
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

export async function renderLeadsKanban(onChange = () => {}) {
  const board = el('div', { class: 'kanban' });

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

    column.addEventListener('dragover', (e) => { e.preventDefault(); column.classList.add('drag-over'); });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', async (e) => {
      e.preventDefault();
      column.classList.remove('drag-over');
      const leadId = Number(e.dataTransfer.getData('text/lead-id'));
      const fromStatus = e.dataTransfer.getData('text/from-status');
      if (!leadId || fromStatus === col.code) return;
      await moveLead(leadId, col.code);
    });
    return column;
  }

  function renderCard(lead) {
    const card = el('div', { class: 'kanban-card', draggable: 'true' },
      el('div', { class: 'kanban-card-title' }, lead.company_name),
      el('div', { class: 'muted', style: 'font-size:12px' }, [lead.geo_city, lead.vertical].filter(Boolean).join(' · ') || '—'),
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-top:6px' },
        el('span', { class: 'muted', style: 'font-size:12px' }, lead.owner_name || '—'),
        lead.expected_amount ? el('b', { style: 'font-size:12.5px' }, money(lead.expected_amount)) : null));

    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/lead-id', String(lead.id));
      e.dataTransfer.setData('text/from-status', lead.status_code);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => openLead(lead.id, () => { reload(); onChange(); }));
    return card;
  }

  async function moveLead(leadId, statusCode) {
    const needsReason = statusCode === 'disqualified' || statusCode === 'lost';
    if (!needsReason) return applyStatus(leadId, statusCode, {});

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
