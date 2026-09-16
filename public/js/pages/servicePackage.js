// Пакет — послуга (services.is_package=1), зібрана з інших послуг: ціна
// рахується на бекенді (costing.js) сумою «ціна компонента × кількість»,
// тут лише перелік компонентів і форма додавання нового.
import { api } from '../api.js';
import { el, money, modal, toast, editableCell } from '../ui.js';
import { icon, withIcon } from '../icons.js';

export async function servicePackageModal(serviceId, onChange = () => {}) {
  const { service, items } = await api.get(`/costing/services/${serviceId}/package`);

  const patchItem = async (itemId, quantity) => {
    await api.put(`/costing/services/${serviceId}/package/items/${itemId}`, { quantity: quantity ?? 1 });
    box.remove();
    servicePackageModal(serviceId, onChange);
    onChange();
  };

  const rows = items.map((row) => el('tr', {},
    el('td', {}, row.name),
    el('td', { class: 'muted' }, row.unit),
    editableCell(row.quantity, { type: 'number', className: 'num', onSave: (v) => patchItem(row.id, v) }),
    el('td', { class: 'num' }, money(row.price)),
    el('td', { class: 'num' }, money(row.total)),
    el('td', {}, el('button', {
      class: 'btn small icon-only danger', title: 'Прибрати з пакета',
      onclick: async () => {
        await api.del(`/costing/services/${serviceId}/package/items/${row.id}`);
        box.remove(); servicePackageModal(serviceId, onChange); onChange();
      },
    }, icon('trash', 14)))));

  const total = items.reduce((s, r) => s + r.total, 0);

  const body = el('div', {},
    el('div', { class: 'muted', style: 'margin-bottom:10px' }, items.length
      ? `Ціна пакета рахується автоматично сумою вкладених послуг: ${money(total)}`
      : `Додайте хоча б одну послугу, щоб «${service.name}» стала пакетом — доти це звичайна послуга`),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Послуга'), el('th', {}, 'Од.'), el('th', { class: 'num' }, 'К-сть'),
        el('th', { class: 'num' }, 'Ціна'), el('th', { class: 'num' }, 'Сума'), el('th', {}, ''))),
      el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Компонентів ще немає'))])))),
    el('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => addItemForm(serviceId, onChange, box) }, withIcon('plus', 'Додати послугу')));

  const box = modal(`Пакет · ${service.name}`, body);
  return box;
}

async function addItemForm(serviceId, onChange, parentBox) {
  const { rows: services } = await api.get('/services?status=active&limit=200');
  const candidates = services.filter((s) => s.id !== serviceId && !Number(s.is_package));
  if (!candidates.length) return toast('Немає послуг, які можна додати (крім самої себе чи інших пакетів)', true);

  const service = el('select', {}, ...candidates.map((s) => el('option', { value: s.id }, `${s.name} (${money(s.price)}/${s.unit})`)));
  const quantity = el('input', { type: 'number', step: '0.1', value: 1 });
  const form = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Послуга'), service),
    el('div', { class: 'field' }, el('label', {}, 'Кількість'), quantity));

  const box2 = modal('Додати послугу в пакет', form, [el('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        await api.post(`/costing/services/${serviceId}/package/items`, {
          component_service_id: Number(service.value), quantity: Number(quantity.value) || 1,
        });
        box2.remove(); parentBox.remove(); servicePackageModal(serviceId, onChange); onChange();
      } catch (e) { toast(e.message, true); }
    },
  }, 'Додати')]);
}
