// Собівартість: з чого складається одиниця послуги, скільки вона коштує
// насправді і яку ціну ставити під цільову маржу.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, num, pct, modal, toast } from '../ui.js';
import { icon, withIcon } from '../icons.js';

const KINDS = [['labor', 'Робота'], ['resource', 'Ресурс'], ['subscription', 'Підписка'], ['overhead', 'Накладні']];

export async function renderCosting() {
  const box = el('div', {});
  const canEdit = !!state.meta.services?.can.update;

  async function render() {
    const data = await api.get('/costing/services');
    const suggest = await api.get('/costing/suggest');
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

    const rows = data.rows.map((r) => el('tr', {},
      el('td', {}, r.service.name),
      el('td', { class: 'muted' }, r.service.unit),
      el('td', { class: 'num' }, money(r.cost)),
      el('td', { class: 'num' }, money(r.recommended_price)),
      el('td', { class: 'num' }, money(r.price)),
      el('td', { class: 'num' }, r.margin_percent == null ? '—' : pct(r.margin_percent)),
      el('td', { class: 'num' }, money(r.profit)),
      el('td', { class: 'num' }, num(r.volume_per_month)),
      el('td', { class: 'num' }, money(r.profit_per_month)),
      el('td', {},
        el('button', { class: 'btn small icon-only', title: 'Розбір', onclick: () => breakdown(r.service.id, render) }, icon('calculator', 15)),
        canEdit && r.price_gap != null && r.price_gap < 0 ? el('button', {
          class: 'btn small', style: 'margin-left:6px', title: 'Поставити рекомендовану ціну',
          onclick: async () => {
            await api.post(`/costing/services/${r.service.id}/apply-price`, {});
            toast('Ціну підтягнуто до цільової маржі');
            render();
          },
        }, withIcon('trending', 'Ціна')) : null)));

    box.append(el('div', { class: 'card' },
      el('h3', {}, icon('calculator'), 'Послуги: собівартість і ціна'),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Послуга'), el('th', {}, 'Од.'),
          el('th', { class: 'num' }, 'Собівартість'), el('th', { class: 'num' }, 'Рекомендовано'),
          el('th', { class: 'num' }, 'Ціна'), el('th', { class: 'num' }, 'Маржа'),
          el('th', { class: 'num' }, 'Профіт/од'), el('th', { class: 'num' }, 'Обсяг/міс'),
          el('th', { class: 'num' }, 'Профіт/міс'), el('th', {}, ''))),
        el('tbody', {}, ...rows))),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        'Рекомендована ціна = собівартість ÷ (1 − цільова маржа). Червона маржа означає, що ціна нижча за неї.')));

    if (suggest.rates.length) {
      box.append(el('div', { class: 'card' },
        el('h3', {}, icon('ruler'), 'Ставки з ваших даних'),
        el('div', {}, ...suggest.rates.map((r) => el('div', { class: 'alert-item' },
          el('span', {}, `${r.label}: ${money(r.value)}`),
          el('span', { class: 'muted' }, r.source)))),
        el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
          'Це підказки з реальних витрат у CRM. Змінити ставку — розділ «Ставки собівартості», перерахунок піде по всіх послугах.')));
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

    const lines = calc.lines.map((line) => el('tr', {},
      el('td', {}, line.name),
      el('td', { class: 'muted' }, KINDS.find((k) => k[0] === line.kind)?.[1] || line.kind),
      el('td', { class: 'num' }, `${num(line.quantity)} ${line.unit}`),
      el('td', { class: 'num' }, money(line.unit_cost) + (line.from_rate ? '' : ' *')),
      el('td', { class: 'num' }, money(line.total)),
      el('td', {}, canEdit ? el('button', {
        class: 'btn small icon-only danger',
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
        el('b', { class: calc.margin_percent >= calc.service.target_margin ? '' : 'error' },
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

  await render();
  return box;
}
