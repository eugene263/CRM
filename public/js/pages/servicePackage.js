// Картка послуги: звичайні поля (назва, категорія, одиниця, ціна, маржа,
// обсяг, статус) і, тут же, унизу — компоненти пакета зі своєю кнопкою
// «Додати». Щойно компонент додано, послуга сама стає пакетом
// (services.is_package=1, costing.js), а ціна далі рахується автоматично —
// поле ціни стає нередагованим.
import { api } from '../api.js';
import { el, money, modal, toast, editableCell } from '../ui.js';
import { icon, withIcon } from '../icons.js';

const STATUS_OPTIONS = [['active', 'Активна'], ['draft', 'Чернетка'], ['archived', 'Архів']];

export async function serviceCardModal(serviceId, onChange = () => {}) {
  const { service, items } = await api.get(`/costing/services/${serviceId}/package`);
  const isPackage = !!Number(service.is_package);

  const name = el('input', { value: service.name });
  const category = el('input', { value: service.category || '' });
  const unit = el('input', { value: service.unit || '' });
  const price = el('input', { type: 'number', step: '0.01', value: service.price, disabled: isPackage });
  const targetMargin = el('input', { type: 'number', step: '1', value: service.target_margin });
  const volume = el('input', { type: 'number', step: '1', value: service.volume_per_month });
  const status = el('select', {}, ...STATUS_OPTIONS.map(([v, l]) => el('option', { value: v, selected: v === service.status }, l)));
  const description = el('textarea', { rows: 2 }, service.description || '');

  const fieldsBlock = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Пакети'), name),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Категорія'), category),
      el('div', {}, el('label', {}, 'Одиниця'), unit)),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Ціна, $'), price,
        isPackage ? el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:3px' }, 'Рахується автоматично із вкладених послуг') : null),
      el('div', {}, el('label', {}, 'Цільова маржа, %'), targetMargin)),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Обсяг/міс'), volume),
      el('div', {}, el('label', {}, 'Статус'), status)),
    el('div', { class: 'field' }, el('label', {}, 'Опис'), description));

  const patchItem = async (itemId, quantity) => {
    await api.put(`/costing/services/${serviceId}/package/items/${itemId}`, { quantity: quantity ?? 1 });
    box.remove();
    serviceCardModal(serviceId, onChange);
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
        box.remove(); serviceCardModal(serviceId, onChange); onChange();
      },
    }, icon('trash', 14)))));

  const total = items.reduce((s, r) => s + r.total, 0);

  const packageBlock = el('div', { style: 'margin-top:16px' },
    el('h3', {}, icon('layers'), 'Пакет: вкладені послуги'),
    el('div', { class: 'muted', style: 'margin-bottom:10px' }, items.length
      ? `Ціна пакета рахується автоматично сумою вкладених послуг: ${money(total)}`
      : `Додайте хоча б одну послугу, щоб «${service.name}» стала пакетом — доти це звичайна послуга`),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Послуга'), el('th', {}, 'Од.'), el('th', { class: 'num' }, 'К-сть'),
        el('th', { class: 'num' }, 'Ціна'), el('th', { class: 'num' }, 'Сума'), el('th', {}, ''))),
      el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Компонентів ще немає'))])))),
    el('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => addItemForm(serviceId, onChange, box) }, withIcon('plus', 'Додати')));

  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        const body = {
          name: name.value, category: category.value, unit: unit.value,
          target_margin: targetMargin.value, volume_per_month: volume.value,
          status: status.value, description: description.value,
        };
        if (!isPackage) body.price = price.value;
        await api.put(`/services/${serviceId}`, body);
        toast('Збережено');
        box.remove();
        onChange();
      } catch (e) { toast(e.message, true); }
    },
  }, 'Зберегти');

  const box = modal(`Пакети · ${service.name}`, el('div', {}, fieldsBlock, packageBlock), [save]);
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
        box2.remove(); parentBox.remove(); serviceCardModal(serviceId, onChange); onChange();
      } catch (e) { toast(e.message, true); }
    },
  }, 'Додати')]);
}
