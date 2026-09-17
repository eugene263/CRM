// Ставки собівартості = список плашок, одна плашка — одна послуга.
// Чорна кнопка «Додати» вгорі екрана створює нову плашку (нову послугу),
// а кнопка «Додати ставку» всередині плашки додає рядок саме в цю послугу.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, pct, modal, toast, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';
import { costLinesBlock } from './costLines.js';

export async function renderCostRates() {
  const box = el('div', {});
  const canCreate = !!state.meta.services?.can.create;
  const canEdit = !!state.meta.services?.can.update;
  const canDelete = !!state.meta.services?.can.delete;

  async function render() {
    const { rows } = await api.get('/costing/services');
    box.textContent = '';

    for (const row of rows) box.append(await serviceCard(row));

    if (!rows.length) {
      box.append(el('div', { class: 'card muted' },
        'Послуг ще немає — натисніть «Додати», щоб створити першу плашку.'));
    }
    if (canCreate) {
      box.append(el('div', { style: 'margin-top:14px' },
        el('button', { class: 'btn primary', onclick: () => newServiceForm() }, withIcon('plus', 'Додати'))));
    }
  }

  // Одна плашка: шапка з назвою й цифрами послуги + її власні ставки.
  async function serviceCard(row) {
    const s = row.service;
    const marginOff = row.margin_percent != null && row.margin_percent < s.target_margin;

    const head = el('div', { class: 'row', style: 'align-items:center;margin-bottom:12px' },
      el('h3', { style: 'margin:0;flex:1 1 auto' }, icon('calculator'), s.name),
      el('div', { class: 'row tight', style: 'gap:18px;align-items:center;margin-left:auto;flex:0 0 auto' },
        el('div', {}, el('div', { class: 'label' }, 'Ціна'), el('b', {}, money(row.price))),
        el('div', {}, el('div', { class: 'label' }, 'Собівартість'), el('b', {}, money(row.cost))),
        el('div', {}, el('div', { class: 'label' }, 'Маржа'),
          el('b', { style: marginOff ? 'color:var(--danger)' : undefined },
            row.margin_percent == null ? '—' : pct(row.margin_percent))),
        canEdit ? el('button', {
          class: 'btn small icon-only', title: 'Назва, ціна, маржа послуги',
          onclick: () => serviceFieldsForm(s),
        }, icon('edit', 15)) : null,
        canDelete ? el('button', {
          class: 'btn small icon-only danger', title: 'Видалити послугу',
          onclick: async () => {
            if (!confirm(`Видалити послугу «${s.name}» разом із її ставками?`)) return;
            try {
              await api.del(`/services/${s.id}`);
              await render();
            } catch (e) { toast(e.message, true); }
          },
        }, icon('trash', 15)) : null));

    return el('div', { class: 'card', style: 'margin-bottom:14px' },
      head,
      await costLinesBlock(s.id, { canEdit, onChange: () => {} }));
  }

  function newServiceForm() {
    const name = el('input', { placeholder: 'Наприклад: Пакет Reels: 30 відео/міс' });
    const unit = el('input', { value: 'шт' });
    const price = el('input', { type: 'number', step: '0.01', value: 0 });
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

    const formBox = modal('Нова послуга', form, [actionButton('Створити', async () => {
      if (!name.value.trim()) return toast('Потрібна назва послуги', true);
      try {
        await api.post('/services', {
          name: name.value.trim(), unit: unit.value.trim() || 'шт', price: price.value || 0,
          target_margin: margin.value || 0, volume_per_month: volume.value || 0, status: 'active',
        });
        formBox.remove();
        toast('Плашку створено — тепер додайте в неї ставки');
        await render();
      } catch (e) { toast(e.message, true); }
    })]);
  }

  function serviceFieldsForm(s) {
    const name = el('input', { value: s.name });
    const category = el('input', { value: s.category || '' });
    const unit = el('input', { value: s.unit || '' });
    const price = el('input', { type: 'number', step: '0.01', value: s.price, disabled: !!Number(s.is_package) });
    const margin = el('input', { type: 'number', step: '1', value: s.target_margin });
    const volume = el('input', { type: 'number', step: '1', value: s.volume_per_month });
    const form = el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Назва послуги'), name),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Категорія'), category),
        el('div', {}, el('label', {}, 'Одиниця'), unit)),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Ціна, $'), price,
          Number(s.is_package) ? el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:3px' },
            'Пакет — ціна рахується з вкладених послуг') : null),
        el('div', {}, el('label', {}, 'Цільова маржа, %'), margin)),
      el('div', { class: 'field' }, el('label', {}, 'Обсяг/міс'), volume));

    const formBox = modal(`Послуга · ${s.name}`, form, [actionButton('Зберегти', async () => {
      try {
        const body = {
          name: name.value, category: category.value, unit: unit.value,
          target_margin: margin.value, volume_per_month: volume.value,
        };
        if (!Number(s.is_package)) body.price = price.value;
        await api.put(`/services/${s.id}`, body);
        formBox.remove();
        await render();
      } catch (e) { toast(e.message, true); }
    })]);
  }

  await render();
  return box;
}
