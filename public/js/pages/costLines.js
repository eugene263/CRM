// Ставки однієї послуги: код, назва, тип, одиниця, ставка, кількість,
// активна — і кнопка «Додати», яка додає рядок саме в цю послугу.
// Спільного довідника ставок немає: у кожної послуги свої власні, тож та
// сама «Година монтажера» в різних послугах може коштувати по-різному.
//
// Той самий блок показується в плашці послуги на екрані «Ставки
// собівартості», всередині картки послуги і в «Фінанси → Собівартість» —
// щоб не тримати три копії тієї самої логіки.
import { api } from '../api.js';
import { el, money, num, pct, modal, toast, badge, editableCell, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';

export const COST_KINDS = [
  ['labor', 'Робота'], ['resource', 'Ресурс'], ['subscription', 'Підписка'], ['overhead', 'Накладні'],
];

const kindLabel = (kind) => COST_KINDS.find((k) => k[0] === kind)?.[1] || kind;

export async function costLinesBlock(serviceId, { canEdit = true, onChange = () => {} } = {}) {
  const box = el('div', {});

  async function reload() {
    const calc = await api.get(`/costing/services/${serviceId}`);
    box.textContent = '';
    box.append(...build(calc));
    onChange();
  }

  const saveLine = async (payload) => {
    await api.post(`/costing/services/${serviceId}/items`, payload);
    await reload();
  };

  // Інлайн-правка одного поля відправляє назад повний рядок із заміненим
  // значенням — saveItem на бекенді перезаписує рядок цілком.
  const patchLine = (line, field, value) => saveLine({ ...line, [field]: value });

  function lineForm(line = null) {
    const isOverhead = line?.kind === 'overhead';
    const code = el('input', { placeholder: 'editor_hour', value: line?.rate_code || '' });
    const name = el('input', { placeholder: 'Година монтажера', value: line?.name || '' });
    const kind = el('select', {}, ...COST_KINDS.map(([v, l]) =>
      el('option', { value: v, selected: line ? v === line.kind : v === 'labor' }, l)));
    const unit = el('input', { placeholder: 'год', value: line?.unit || (isOverhead ? '%' : 'год') });
    const amount = el('input', { type: 'number', step: '0.01', value: line?.unit_cost ?? 0 });
    const qty = el('input', { type: 'number', step: '0.1', value: line?.quantity ?? 1 });
    const active = el('input', { type: 'checkbox', checked: line ? !!Number(line.is_active) : true });

    const form = el('div', {},
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Код'), code),
        el('div', {}, el('label', {}, 'Назва'), name)),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Тип'), kind),
        el('div', {}, el('label', {}, 'Одиниця'), unit)),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Ставка, $'), amount),
        el('div', {}, el('label', {}, 'Кількість'), qty)),
      el('label', { class: 'check', style: 'margin-top:10px' }, active, ' Активна'),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        'Тип «Накладні» — це відсоток від решти витрат: одиниця «%», ставка — сам відсоток.'));

    const formBox = modal(line ? 'Ставка послуги' : 'Нова ставка послуги', form,
      [actionButton(line ? 'Зберегти' : 'Додати', async () => {
        if (!name.value.trim()) return toast('Потрібна назва', true);
        try {
          await saveLine({
            id: line?.id, rate_code: code.value.trim() || null, name: name.value.trim(),
            kind: kind.value, unit: unit.value.trim(), unit_cost: Number(amount.value || 0),
            quantity: Number(qty.value || 0), is_active: active.checked ? 1 : 0,
            note: line?.note ?? null, sort_order: line?.sort_order ?? 100,
          });
          formBox.remove();
        } catch (e) { toast(e.message, true); }
      })]);
  }

  function build(calc) {
    const rows = calc.lines.map((line) => el('tr', { style: Number(line.is_active) ? undefined : 'opacity:.45' },
      el('td', { class: 'muted' }, line.rate_code || '—'),
      canEdit
        ? editableCell(line.name, { onSave: (v) => patchLine(line, 'name', v) })
        : el('td', {}, line.name),
      el('td', {}, badge(line.kind, kindLabel(line.kind))),
      canEdit
        ? editableCell(line.unit, { className: 'muted', onSave: (v) => patchLine(line, 'unit', v) })
        : el('td', { class: 'muted' }, line.unit),
      canEdit
        ? editableCell(line.unit_cost, { type: 'number', className: 'num', format: money, onSave: (v) => patchLine(line, 'unit_cost', v ?? 0) })
        : el('td', { class: 'num' }, money(line.unit_cost)),
      canEdit
        ? editableCell(line.quantity, { type: 'number', className: 'num', format: num, onSave: (v) => patchLine(line, 'quantity', v ?? 0) })
        : el('td', { class: 'num' }, num(line.quantity)),
      el('td', { class: 'num' }, line.kind === 'overhead' ? `${num(line.unit_cost)}%` : money(line.total)),
      el('td', {}, canEdit
        ? el('button', {
          class: 'btn small icon-only', title: Number(line.is_active) ? 'Вимкнути рядок' : 'Увімкнути рядок',
          onclick: () => patchLine(line, 'is_active', Number(line.is_active) ? 0 : 1),
        }, icon(Number(line.is_active) ? 'check' : 'ban', 14))
        : badge(Number(line.is_active) ? 'active' : 'draft', Number(line.is_active) ? 'Так' : 'Ні')),
      el('td', {}, canEdit ? el('div', { class: 'row tight', style: 'gap:6px' },
        el('button', { class: 'btn small icon-only', title: 'Редагувати', onclick: () => lineForm(line) }, icon('edit', 14)),
        el('button', {
          class: 'btn small icon-only danger', title: 'Видалити рядок',
          onclick: async () => {
            await api.del(`/costing/services/${serviceId}/items/${line.id}`);
            await reload();
          },
        }, icon('trash', 14))) : null)));

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
        el('thead', {}, el('tr', {}, el('th', {}, 'Код'), el('th', {}, 'Назва'), el('th', {}, 'Тип'),
          el('th', {}, 'Одиниця'), el('th', { class: 'num' }, 'Ставка'), el('th', { class: 'num' }, 'К-сть'),
          el('th', { class: 'num' }, 'Сума'), el('th', {}, 'Активна'), el('th', {}, ''))),
        el('tbody', {}, ...(rows.length
          ? rows
          : [el('tr', {}, el('td', { colspan: 9, class: 'muted' }, 'Ставок ще немає — собівартість нульова'))])))),
      summary,
      canEdit ? el('div', { style: 'margin-top:12px' },
        el('button', { class: 'btn', onclick: () => lineForm() }, withIcon('plus', 'Додати ставку'))) : null,
    ];
  }

  const calc = await api.get(`/costing/services/${serviceId}`);
  box.append(...build(calc));
  return box;
}
