// Складові собівартості конкретної послуги (service_cost_items): рядки,
// підсумок і кнопка «Додати складову». Той самий блок показується і в
// «Фінанси → Собівартість → Розбір», і прямо в картці послуги — щоб не
// тримати дві копії тієї самої логіки й не заганяти людину в інший розділ
// лише заради того, щоб дописати рядок витрат.
import { api } from '../api.js';
import { el, money, num, pct, modal, toast, editableCell, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';

export const COST_KINDS = [
  ['labor', 'Робота'], ['resource', 'Ресурс'], ['subscription', 'Підписка'], ['overhead', 'Накладні'],
];

export async function costLinesBlock(serviceId, { canEdit = true, onChange = () => {} } = {}) {
  const box = el('div', {});

  async function reload() {
    const calc = await api.get(`/costing/services/${serviceId}`);
    const rates = (await api.get('/cost_rates?limit=100')).rows;
    box.textContent = '';
    box.append(...build(calc, rates));
  }

  // saveItem перезаписує весь рядок — тому інлайн-правка одного поля
  // відправляє назад повний рядок із заміненим значенням.
  const patchLine = async (line, field, value) => {
    await api.post(`/costing/services/${serviceId}/items`, {
      id: line.id, name: line.name, rate_code: line.rate_code, kind: line.kind,
      quantity: line.quantity, unit_cost: line.unit_cost, note: line.note,
      sort_order: line.sort_order, [field]: value,
    });
    await reload();
    onChange();
  };

  function addRowForm(rates) {
    const name = el('input', { placeholder: 'Наприклад: монтаж 30 роликів' });
    const rate = el('select', {}, el('option', { value: '' }, 'власна ціна'),
      ...rates.map((r) => el('option', { value: r.code }, `${r.name} — ${money(r.amount)}/${r.unit}`)));
    const qty = el('input', { type: 'number', step: '0.1', value: 1 });
    const custom = el('input', { type: 'number', step: '0.01', placeholder: 'ціна за одиницю' });
    const kind = el('select', {}, ...COST_KINDS.map(([v, l]) => el('option', { value: v }, l)));
    const form = el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Назва рядка'), name),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Ставка'), rate),
        el('div', {}, el('label', {}, 'Кількість'), qty)),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Або своя ціна за одиницю'), custom),
        el('div', {}, el('label', {}, 'Тип'), kind)));

    const formBox = modal('Складова собівартості', form, [actionButton('Додати', async () => {
      try {
        await api.post(`/costing/services/${serviceId}/items`, {
          name: name.value, rate_code: rate.value || null, quantity: Number(qty.value),
          unit_cost: custom.value === '' ? null : Number(custom.value), kind: kind.value,
        });
        formBox.remove();
        await reload();
        onChange();
      } catch (e) { toast(e.message, true); }
    })]);
  }

  function build(calc, rates) {
    const lines = calc.lines.map((line) => el('tr', {},
      canEdit
        ? editableCell(line.name, { onSave: (v) => patchLine(line, 'name', v) })
        : el('td', {}, line.name),
      el('td', { class: 'muted' }, COST_KINDS.find((k) => k[0] === line.kind)?.[1] || line.kind),
      canEdit
        ? editableCell(line.quantity, { type: 'number', className: 'num', format: (v) => `${num(v)} ${line.unit}`, onSave: (v) => patchLine(line, 'quantity', v ?? 0) })
        : el('td', { class: 'num' }, `${num(line.quantity)} ${line.unit}`),
      canEdit && !line.rate_code
        ? editableCell(line.unit_cost, { type: 'number', className: 'num', format: (v) => `${money(v)} *`, onSave: (v) => patchLine(line, 'unit_cost', v ?? 0) })
        : el('td', { class: 'num' }, money(line.unit_cost) + (line.from_rate ? '' : ' *')),
      el('td', { class: 'num' }, money(line.total)),
      el('td', {}, canEdit ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити рядок',
        onclick: async () => {
          await api.del(`/costing/services/${serviceId}/items/${line.id}`);
          await reload();
          onChange();
        },
      }, icon('trash', 14)) : null)));

    const summary = el('div', { class: 'row', style: 'margin-top:12px' },
      el('div', {}, el('div', { class: 'label' }, 'Прямі'), el('b', {}, money(calc.direct))),
      el('div', {}, el('div', { class: 'label' }, `Накладні ${calc.overhead_percent}%`), el('b', {}, money(calc.overhead))),
      el('div', {}, el('div', { class: 'label' }, 'Собівартість'), el('b', {}, money(calc.cost))),
      el('div', {}, el('div', { class: 'label' }, 'Рекомендована ціна'), el('b', {}, money(calc.recommended_price))),
      el('div', {}, el('div', { class: 'label' }, 'Поточна маржа'),
        el('b', { style: calc.margin_percent != null && calc.margin_percent < calc.service.target_margin ? 'color:var(--danger)' : undefined },
          calc.margin_percent == null ? '—' : pct(calc.margin_percent))));

    return [
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Рядок'), el('th', {}, 'Тип'),
          el('th', { class: 'num' }, 'К-сть'), el('th', { class: 'num' }, 'Ціна'),
          el('th', { class: 'num' }, 'Сума'), el('th', {}, ''))),
        el('tbody', {}, ...(lines.length
          ? lines
          : [el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Складових ще немає — собівартість нульова'))])))),
      summary,
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        '* — ціна задана вручну, ставка з довідника її не перерахує.'),
      canEdit ? el('div', { style: 'margin-top:12px' },
        el('button', { class: 'btn', onclick: () => addRowForm(rates) }, withIcon('plus', 'Додати складову'))) : null,
    ];
  }

  await reload();
  return box;
}
