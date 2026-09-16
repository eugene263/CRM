// Собівартість: з чого складається одиниця послуги, скільки вона коштує
// насправді і яку ціну ставити під цільову маржу.
//
// Обидві таблиці (послуги й ставки) редагуються прямо в клітинці — форма
// заради одного числа тут зайва, а от розбір послуги на рядки лишається
// модалкою, бо там треба обирати ставку зі списку.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, num, pct, modal, toast, editableCell } from '../ui.js';
import { icon, withIcon } from '../icons.js';

const KINDS = [['labor', 'Робота'], ['resource', 'Ресурс'], ['subscription', 'Підписка'], ['overhead', 'Накладні']];
const RATE_KINDS = [['labor', 'Робота'], ['resource', 'Ресурс'], ['subscription', 'Підписка'], ['overhead', 'Накладні']];

export async function renderCosting() {
  const box = el('div', {});
  const canEdit = !!state.meta.services?.can.update;
  const canCreate = !!state.meta.services?.can.create;
  const canDelete = !!state.meta.services?.can.delete;
  const canEditRates = !!state.meta.cost_rates?.can.update;
  const canCreateRates = !!state.meta.cost_rates?.can.create;
  const canDeleteRates = !!state.meta.cost_rates?.can.delete;

  async function render() {
    const data = await api.get('/costing/services');
    const suggest = await api.get('/costing/suggest');
    const rates = await api.get('/cost_rates?limit=200');
    box.textContent = '';

    const s = data.summary;
    box.append(el('div', { class: 'tiles' },
      tile('План виручки/міс', money(s.revenue_plan)),
      tile('План профіту/міс', money(s.profit_plan), `постійні витрати ${money(s.fixed.total)}`,
        s.profit_plan >= s.fixed.total ? 'pos' : 'neg'),
      tile('Покриття постійних', s.covers_fixed == null ? '—' : pct(s.covers_fixed),
        `ЗП ${money(s.fixed.salary)} · сервіси ${money(s.fixed.subscriptions)}`),
      tile('Точка беззбитковості', s.breakeven_units == null ? '—' : `${num(s.breakeven_units)} од.`,
        s.breakeven_service || '')));

    const patchService = async (id, field, value) => {
      await api.put(`/services/${id}`, { [field]: value });
      await render();
    };

    const rows = data.rows.map((r) => {
      const id = r.service.id;
      const tr = el('tr', {},
        canEdit
          ? editableCell(r.service.name, { onSave: (v) => patchService(id, 'name', v) })
          : el('td', {}, r.service.name),
        canEdit
          ? editableCell(r.service.unit, { className: 'muted', onSave: (v) => patchService(id, 'unit', v) })
          : el('td', { class: 'muted' }, r.service.unit),
        el('td', { class: 'num' }, money(r.cost)),
        el('td', { class: 'num' }, money(r.recommended_price)),
        canEdit
          ? editableCell(r.price, { type: 'number', className: 'num', format: money, onSave: (v) => patchService(id, 'price', v ?? 0) })
          : el('td', { class: 'num' }, money(r.price)),
        el('td', {
          class: 'num',
          style: r.margin_percent != null && r.margin_percent < r.service.target_margin ? 'color:var(--danger)' : undefined,
        }, r.margin_percent == null ? '—' : pct(r.margin_percent)),
        el('td', { class: 'num' }, money(r.profit)),
        canEdit
          ? editableCell(r.volume_per_month, { type: 'number', className: 'num', format: num, onSave: (v) => patchService(id, 'volume_per_month', v ?? 0) })
          : el('td', { class: 'num' }, num(r.volume_per_month)),
        el('td', { class: 'num' }, money(r.profit_per_month)),
        el('td', {},
          el('button', { class: 'btn small icon-only', title: 'Розбір', onclick: () => breakdown(id, render) }, icon('calculator', 15)),
          canEdit && r.price_gap != null && r.price_gap < 0 ? el('button', {
            class: 'btn small icon-only', style: 'margin-left:6px', title: 'Поставити рекомендовану ціну',
            onclick: async () => {
              await api.post(`/costing/services/${id}/apply-price`, {});
              toast('Ціну підтягнуто до цільової маржі');
              render();
            },
          }, icon('trending', 15)) : null,
          canDelete ? el('button', {
            class: 'btn small icon-only danger', style: 'margin-left:6px', title: 'Видалити послугу',
            onclick: async () => {
              if (!confirm(`Видалити послугу «${r.service.name}»?`)) return;
              await api.del(`/services/${id}`);
              render();
            },
          }, icon('trash', 15)) : null));
      return tr;
    });

    box.append(el('div', { class: 'card' },
      el('h3', {}, icon('calculator'), 'Послуги: собівартість і ціна'),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Послуга'), el('th', {}, 'Од.'),
          el('th', { class: 'num' }, 'Собівартість'), el('th', { class: 'num' }, 'Рекомендовано'),
          el('th', { class: 'num' }, 'Ціна'), el('th', { class: 'num' }, 'Маржа'),
          el('th', { class: 'num' }, 'Профіт/од'), el('th', { class: 'num' }, 'Обсяг/міс'),
          el('th', { class: 'num' }, 'Профіт/міс'), el('th', {}, ''))),
        el('tbody', {}, ...rows))),
      canCreate ? el('div', { style: 'margin-top:12px' },
        el('button', { class: 'btn', onclick: () => addServiceForm(render) }, withIcon('plus', 'Додати послугу'))) : null,
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        'Клікніть на назву, одиницю, ціну чи обсяг, щоб змінити. Рекомендована ціна = собівартість ÷ (1 − цільова маржа); червона маржа означає, що ціна нижча за неї.')));

    const patchRate = async (id, field, value) => {
      await api.put(`/cost_rates/${id}`, { [field]: value });
      await render();
    };

    const rateRows = rates.rows.map((r) => el('tr', {},
      canEditRates ? editableCell(r.name, { onSave: (v) => patchRate(r.id, 'name', v) }) : el('td', {}, r.name),
      el('td', { class: 'muted' }, r.code),
      el('td', { class: 'muted' }, RATE_KINDS.find((k) => k[0] === r.kind)?.[1] || r.kind),
      canEditRates ? editableCell(r.unit, { className: 'muted', onSave: (v) => patchRate(r.id, 'unit', v) }) : el('td', { class: 'muted' }, r.unit),
      canEditRates
        ? editableCell(r.amount, { type: 'number', className: 'num', format: money, onSave: (v) => patchRate(r.id, 'amount', v ?? 0) })
        : el('td', { class: 'num' }, money(r.amount)),
      el('td', {}, canDeleteRates ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити ставку',
        onclick: async () => {
          if (!confirm(`Видалити ставку «${r.name}»? Послуги, де вона використана, покажуть нульову вартість цього рядка.`)) return;
          await api.del(`/cost_rates/${r.id}`);
          render();
        },
      }, icon('trash', 15)) : null)));

    box.append(el('div', { class: 'card' },
      el('h3', {}, icon('ruler'), 'Ставки собівартості'),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Назва'), el('th', {}, 'Код'), el('th', {}, 'Тип'),
          el('th', {}, 'Одиниця'), el('th', { class: 'num' }, 'Ставка'), el('th', {}, ''))),
        el('tbody', {}, ...rateRows))),
      canCreateRates ? el('div', { style: 'margin-top:12px' },
        el('button', { class: 'btn', onclick: () => addRateForm(render) }, withIcon('plus', 'Додати ставку'))) : null,
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        'Зміна ставки одразу перераховує всі послуги, де вона використана.')));

    if (suggest.rates.length) {
      box.append(el('div', { class: 'card' },
        el('h3', {}, icon('trending'), 'Підказки зі ставок реальних даних'),
        el('div', {}, ...suggest.rates.map((r) => {
          const target = rates.rows.find((x) => x.code === r.code);
          return el('div', { class: 'alert-item' },
            el('span', {}, `${r.label}: ${money(r.value)}`),
            el('span', { class: 'muted' }, r.source),
            target && canEditRates ? el('button', {
              class: 'btn small', style: 'margin-left:8px',
              onclick: async () => { await patchRate(target.id, 'amount', r.value); toast('Ставку оновлено'); },
            }, 'Застосувати') : null);
        })),
        el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
          'Середні значення з реальних витрат у CRM — орієнтир, щоб ставки не жили окремо від фактичних цифр.')));
    }
  }

  function tile(label, value, hint, cls) {
    return el('div', { class: 'tile' },
      el('div', { class: 'label' }, label),
      el('div', { class: `value ${cls || ''}` }, value),
      hint ? el('div', { class: 'hint' }, hint) : null);
  }

  async function breakdown(serviceId, onChange) {
    const calc = await api.get(`/costing/services/${serviceId}`);
    const rates = (await api.get('/cost_rates?limit=100')).rows;

    // saveItem перезаписує весь рядок — тому інлайн-правка одного поля
    // відправляє назад повний рядок із заміненим значенням.
    const patchLine = async (line, field, value) => {
      await api.post(`/costing/services/${serviceId}/items`, {
        id: line.id, name: line.name, rate_code: line.rate_code, kind: line.kind,
        quantity: line.quantity, unit_cost: line.unit_cost, note: line.note,
        sort_order: line.sort_order, [field]: value,
      });
      box2.remove(); breakdown(serviceId, onChange); onChange();
    };

    const lines = calc.lines.map((line) => el('tr', {},
      canEdit
        ? editableCell(line.name, { onSave: (v) => patchLine(line, 'name', v) })
        : el('td', {}, line.name),
      el('td', { class: 'muted' }, KINDS.find((k) => k[0] === line.kind)?.[1] || line.kind),
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
          box2.remove(); breakdown(serviceId, onChange); onChange();
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

    const addRow = () => {
      const name = el('input', { placeholder: 'Наприклад: монтаж 30 роликів' });
      const rate = el('select', {}, el('option', { value: '' }, 'власна ціна'),
        ...rates.map((r) => el('option', { value: r.code }, `${r.name} — ${money(r.amount)}/${r.unit}`)));
      const qty = el('input', { type: 'number', step: '0.1', value: 1 });
      const custom = el('input', { type: 'number', step: '0.01', placeholder: 'ціна за одиницю' });
      const kind = el('select', {}, ...KINDS.map(([v, l]) => el('option', { value: v }, l)));
      const form = el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Назва рядка'), name),
        el('div', { class: 'row' },
          el('div', {}, el('label', {}, 'Ставка'), rate),
          el('div', {}, el('label', {}, 'Кількість'), qty)),
        el('div', { class: 'row' },
          el('div', {}, el('label', {}, 'Або своя ціна за одиницю'), custom),
          el('div', {}, el('label', {}, 'Тип'), kind)));

      const box3 = modal('Рядок собівартості', form, [el('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            await api.post(`/costing/services/${serviceId}/items`, {
              name: name.value, rate_code: rate.value || null, quantity: Number(qty.value),
              unit_cost: custom.value === '' ? null : Number(custom.value), kind: kind.value,
            });
            box3.remove(); box2.remove(); breakdown(serviceId, onChange); onChange();
          } catch (e) { toast(e.message, true); }
        },
      }, 'Додати')]);
    };

    const box2 = modal(`Собівартість · ${calc.service.name}`, el('div', {},
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Рядок'), el('th', {}, 'Тип'),
          el('th', { class: 'num' }, 'К-сть'), el('th', { class: 'num' }, 'Ціна'),
          el('th', { class: 'num' }, 'Сума'), el('th', {}, ''))),
        el('tbody', {}, ...lines))),
      summary,
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        '* — ціна задана вручну, ставка з довідника її не перерахує.'),
      canEdit ? el('div', { style: 'margin-top:12px' },
        el('button', { class: 'btn', onclick: addRow }, withIcon('plus', 'Додати рядок'))) : null));
  }

  function addServiceForm(onSaved) {
    const name = el('input', { placeholder: 'Наприклад: Пакет Reels: 30 відео/міс' });
    const unit = el('input', { placeholder: 'пакет', value: 'шт' });
    const price = el('input', { type: 'number', step: '0.01', placeholder: '0' });
    const margin = el('input', { type: 'number', step: '1', value: 50 });
    const volume = el('input', { type: 'number', step: '1', value: 0 });
    const form = el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Назва послуги'), name),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Одиниця'), unit),
        el('div', {}, el('label', {}, 'Цільова маржа, %'), margin)),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Ціна, $'), price),
        el('div', {}, el('label', {}, 'Обсяг/міс'), volume)));

    const box = modal('Нова послуга', form, [el('button', {
      class: 'btn primary',
      onclick: async () => {
        if (!name.value.trim()) return toast('Потрібна назва послуги', true);
        try {
          const res = await api.post('/services', {
            name: name.value.trim(), unit: unit.value.trim() || 'шт',
            price: price.value || 0, target_margin: margin.value || 0, volume_per_month: volume.value || 0,
          });
          box.remove();
          toast('Послугу додано — тепер заповніть склад собівартості');
          await onSaved();
          breakdown(res.id, onSaved);
        } catch (e) { toast(e.message, true); }
      },
    }, 'Створити')]);
  }

  function addRateForm(onSaved) {
    const code = el('input', { placeholder: 'наприклад, delivery_hour' });
    const name = el('input', { placeholder: 'Наприклад: Година доставки' });
    const kind = el('select', {}, ...RATE_KINDS.map(([v, l]) => el('option', { value: v }, l)));
    const unit = el('input', { placeholder: 'год', value: 'шт' });
    const amount = el('input', { type: 'number', step: '0.01', value: 0 });
    const form = el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Назва'), name),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Код (латиниця, унікальний)'), code),
        el('div', {}, el('label', {}, 'Тип'), kind)),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Одиниця'), unit),
        el('div', {}, el('label', {}, 'Ставка, $'), amount)));

    const box = modal('Нова ставка', form, [el('button', {
      class: 'btn primary',
      onclick: async () => {
        if (!name.value.trim() || !code.value.trim()) return toast('Потрібні назва і код', true);
        try {
          await api.post('/cost_rates', {
            code: code.value.trim(), name: name.value.trim(), kind: kind.value,
            unit: unit.value.trim() || 'шт', amount: amount.value || 0,
          });
          box.remove();
          await onSaved();
        } catch (e) { toast(e.message, true); }
      },
    }, 'Створити')]);
  }

  await render();
  return box;
}
