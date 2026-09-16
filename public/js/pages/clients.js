// Картка клієнта: підписки на послуги (з costing), нотатки, історія
// статусів. Клієнт зʼявляється сам, коли лід переходить у статус із
// is_won=1 (prospecting.js), тому тут — лише подальше ведення.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, num, modal, toast, editableCell } from '../ui.js';
import { icon, withIcon } from '../icons.js';
import { openLead } from './prospecting.js';

const STATUS_LABEL = { active: 'Активний', paused: 'На паузі', churned: 'Пішов' };

let churnReasons = null;
async function loadChurnReasons() {
  if (!churnReasons) churnReasons = (await api.get('/dictionaries?kind=churn_reason&limit=50')).rows;
  return churnReasons;
}

export async function clientCardModal(clientId, onChange = () => {}) {
  const canEdit = !!state.meta.clients?.can.update;
  const { client, services, mrr, notes, history, sourceLead } = await api.get(`/clients/${clientId}/full`);
  await loadChurnReasons();

  const header = el('div', {},
    el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      el('b', { style: 'font-size:16px' }, client.name),
      el('span', { class: `badge ${client.status}` }, STATUS_LABEL[client.status] || client.status),
      el('span', { class: 'muted' }, `MRR ${money(mrr)}`)),
    el('div', { class: 'muted', style: 'margin-top:4px;font-size:12.5px' },
      [client.geo_city, client.geo_country, client.vertical].filter(Boolean).join(' · ') || '—',
      client.website ? ' · ' : '', client.website ? el('a', { href: client.website, target: '_blank', rel: 'noreferrer' }, 'сайт') : null,
      sourceLead ? ' · ' : '', sourceLead ? el('a', {
        href: '#', onclick: (e) => { e.preventDefault(); box.remove(); openLead(sourceLead.id, onChange); },
      }, `із ліда «${sourceLead.company_name}»`) : null),
    (client.contact_name || client.contact_email || client.contact_phone) ? el('div', { class: 'muted', style: 'font-size:12.5px;margin-top:2px' },
      [client.contact_name, client.contact_email, client.contact_phone].filter(Boolean).join(' · ')) : null);

  const patchService = async (row, field, value) => {
    await api.put(`/clients/${clientId}/services/${row.id}`, { [field]: value });
    box.remove();
    clientCardModal(clientId, onChange);
    onChange();
  };

  const serviceRows = services.map((row) => el('tr', {},
    el('td', {}, row.service_name),
    el('td', { class: 'muted' }, row.unit),
    canEdit && row.status === 'active'
      ? editableCell(row.quantity, { type: 'number', className: 'num', onSave: (v) => patchService(row, 'quantity', v ?? 1) })
      : el('td', { class: 'num' }, num(row.quantity)),
    canEdit && row.status === 'active'
      ? editableCell(row.price_override, { type: 'number', className: 'num', format: (v) => (v == null ? `${money(row.price)} (за замовчуванням)` : money(v)), onSave: (v) => patchService(row, 'price_override', v) })
      : el('td', { class: 'num' }, money(row.price_override ?? row.price)),
    el('td', { class: 'num' }, money(row.total)),
    el('td', {}, el('span', { class: `badge ${row.status}` }, { active: 'Активна', paused: 'Пауза', canceled: 'Скасована' }[row.status] || row.status)),
    el('td', {}, canEdit && row.status === 'active' ? el('button', {
      class: 'btn small icon-only danger', title: 'Скасувати підписку',
      onclick: async () => {
        if (!confirm(`Скасувати «${row.service_name}» для цього клієнта?`)) return;
        await api.put(`/clients/${clientId}/services/${row.id}`, { status: 'canceled' });
        box.remove(); clientCardModal(clientId, onChange); onChange();
      },
    }, icon('trash', 14)) : null)));

  const servicesBlock = el('div', { class: 'card' }, el('h3', {}, icon('calculator'), 'Послуги'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Послуга'), el('th', {}, 'Од.'), el('th', { class: 'num' }, 'К-сть'),
        el('th', { class: 'num' }, 'Ціна'), el('th', { class: 'num' }, 'Сума/міс'), el('th', {}, 'Статус'), el('th', {}, ''))),
      el('tbody', {}, ...(serviceRows.length ? serviceRows : [el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'Підписок ще немає'))])))),
    canEdit ? el('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => addServiceForm(clientId, onChange, box) }, withIcon('plus', 'Додати послугу')) : null);

  const notesBlock = el('div', { class: 'card' }, el('h3', {}, 'Нотатки'),
    ...notes.map((n) => el('div', { class: 'alert-item' }, el('span', {}, n.text), el('span', { class: 'muted' }, String(n.created_at).slice(5, 16)))),
    canEdit ? (() => {
      const input = el('input', { placeholder: 'додати нотатку й Enter' });
      input.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !input.value.trim()) return;
        await api.post(`/clients/${clientId}/notes`, { text: input.value.trim() });
        toast('Додано'); box.remove(); clientCardModal(clientId, onChange);
      });
      return el('div', { style: 'margin-top:8px' }, input);
    })() : null);

  const historyBlock = history.length ? el('div', { class: 'card' }, el('h3', {}, 'Історія статусів'),
    ...history.map((h) => el('div', { class: 'alert-item' },
      el('span', {}, `${STATUS_LABEL[h.from_status] || h.from_status || '—'} → ${STATUS_LABEL[h.to_status] || h.to_status}${h.reason ? ` (${h.reason})` : ''}`),
      el('span', { class: 'muted' }, String(h.created_at).slice(0, 16))))) : null;

  const actions = el('div', { class: 'row', style: 'margin-top:12px' },
    canEdit ? el('button', { class: 'btn', style: 'flex:0 0 auto', onclick: () => { box.remove(); statusForm(client, onChange); } }, withIcon('flag', 'Змінити статус')) : null);

  const box = modal(`Клієнт #${client.id}`, el('div', {}, header, actions, servicesBlock, notesBlock, historyBlock));
  return box;
}

async function addServiceForm(clientId, onChange, parentBox) {
  const { rows: services } = await api.get('/services?status=active&limit=200');
  const service = el('select', {}, ...services.map((s) => el('option', { value: s.id }, `${s.name} (${money(s.price)}/${s.unit})`)));
  const quantity = el('input', { type: 'number', step: '0.1', value: 1 });
  const price = el('input', { type: 'number', step: '0.01', placeholder: 'ціна за замовчуванням' });
  const form = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Послуга'), service),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Кількість'), quantity),
      el('div', {}, el('label', {}, 'Своя ціна (необовʼязково)'), price)));

  const box2 = modal('Додати послугу', form, [el('button', {
    class: 'btn primary',
    onclick: async () => {
      if (!service.value) return toast('Немає доступних послуг — додайте їх у Фінанси → Собівартість', true);
      try {
        await api.post(`/clients/${clientId}/services`, {
          service_id: Number(service.value), quantity: Number(quantity.value) || 1,
          price_override: price.value === '' ? null : Number(price.value),
        });
        box2.remove(); parentBox.remove(); clientCardModal(clientId, onChange); onChange();
      } catch (e) { toast(e.message, true); }
    },
  }, 'Додати')]);
}

function statusForm(client, onChange) {
  const status = el('select', {}, ...Object.entries(STATUS_LABEL).map(([v, l]) => el('option', { value: v, selected: v === client.status }, l)));
  const reason = el('select', {}, el('option', { value: '' }, '—'), ...churnReasons.map((r) => el('option', { value: r.label }, r.label)));
  const note = el('textarea', { rows: 3, placeholder: 'нотатка (необовʼязково)' });

  const syncReason = () => { reason.disabled = status.value !== 'churned'; };
  status.addEventListener('change', syncReason);
  syncReason();

  const form = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Статус'), status),
    el('div', { class: 'field' }, el('label', {}, 'Причина відтоку (для «Пішов»)'), reason),
    el('div', { class: 'field' }, el('label', {}, 'Нотатка'), note));

  const box = modal(`Статус · ${client.name}`, form, [el('button', {
    class: 'btn primary',
    onclick: async () => {
      if (status.value === 'churned' && !reason.value) return toast('Оберіть причину відтоку', true);
      try {
        await api.post(`/clients/${client.id}/status`, { status: status.value, reason: reason.value || null, note: note.value || null });
        box.remove(); toast('Статус оновлено'); onChange();
      } catch (e) { toast(e.message, true); }
    },
  }, 'Зберегти')]);
}
