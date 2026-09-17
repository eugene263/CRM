// Собівартість: з чого складається одиниця послуги, скільки вона коштує
// насправді і яку ціну ставити під цільову маржу.
//
// Таблиця послуг редагується прямо в клітинці — форма заради одного числа
// тут зайва. Самі ставки живуть усередині послуги: «Розбір» відкриває той
// самий блок, що й плашка на екрані «Ставки собівартості».
import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, num, pct, modal, toast, editableCell, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';
import { costLinesBlock } from './costLines.js';

export async function renderCosting() {
  const box = el('div', {});
  const canEdit = !!state.meta.services?.can.update;
  const canCreate = !!state.meta.services?.can.create;
  const canDelete = !!state.meta.services?.can.delete;

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

    if (suggest.rates.length) {
      box.append(el('div', { class: 'card' },
        el('h3', {}, icon('trending'), 'Підказки з реальних даних'),
        el('div', {}, ...suggest.rates.map((r) => el('div', { class: 'alert-item' },
          el('span', {}, `${r.label}: ${money(r.value)}`),
          el('span', { class: 'muted' }, r.source)))),
        el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
          'Середні значення з фактичних витрат у CRM — орієнтир, коли ставите ставку в плашці послуги.')));
    }
  }

  function tile(label, value, hint, cls) {
    return el('div', { class: 'tile' },
      el('div', { class: 'label' }, label),
      el('div', { class: `value ${cls || ''}` }, value),
      hint ? el('div', { class: 'hint' }, hint) : null);
  }

  async function breakdown(serviceId, onChange) {
    const { service } = await api.get(`/costing/services/${serviceId}`);
    modal(`Собівартість · ${service.name}`, await costLinesBlock(serviceId, { canEdit, onChange }));
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

    const box = modal('Нова послуга', form, [actionButton('Створити', async () => {
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
    })]);
  }

  await render();
  return box;
}
