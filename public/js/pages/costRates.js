// Ставки собівартості = список плашок, одна плашка — одна послуга.
// Чорна кнопка «Додати» вгорі екрана створює нову плашку (нову послугу),
// а кнопка «Додати ставку» всередині плашки додає рядок саме в цю послугу.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, pct, modal, toast, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';
import { costLinesBlock } from './costLines.js';

const PICKED_KEY = 'crm_cost_group';

export async function renderCostRates() {
  const box = el('div', {});
  const canCreate = !!state.meta.services?.can.create;
  const canEdit = !!state.meta.services?.can.update;
  const canDelete = !!state.meta.services?.can.delete;
  let picked = Number(localStorage.getItem(PICKED_KEY)) || null;

  async function render() {
    const [{ rows: groups }, { rows: all }] = await Promise.all([
      api.get('/costing/groups'),
      api.get('/costing/services'),
    ]);
    if (!groups.some((g) => g.id === picked)) picked = groups[0]?.id ?? null;
    if (picked) localStorage.setItem(PICKED_KEY, String(picked));

    box.textContent = '';
    box.append(groupTabs(groups));

    const rows = all.filter((r) => Number(r.service.group_id) === picked);
    for (const row of rows) box.append(await serviceCard(row));

    if (!groups.length) {
      box.append(el('div', { class: 'card muted' },
        'Послуг ще немає — натисніть «Додати послугу», щоб створити першу.'));
    } else if (!rows.length) {
      box.append(el('div', { class: 'card muted' },
        'У цій послузі ще немає пакетів — натисніть «Додати», щоб створити першу плашку.'));
    }
    if (canCreate && picked) {
      box.append(el('div', { style: 'margin-top:14px' },
        el('button', { class: 'btn primary', onclick: () => newServiceForm() }, withIcon('plus', 'Додати'))));
    }
  }

  // Кнопки-послуги над плашками: активна підсвічена, поруч із нею — кошик
  // саме для неї, а в кінці ряду «+», що заводить нову послугу.
  function groupTabs(groups) {
    const tabs = el('div', { class: 'row tight', style: 'gap:8px;margin-bottom:16px;align-items:center' });
    for (const g of groups) {
      const isActive = g.id === picked;
      tabs.append(el('button', {
        class: `btn${isActive ? ' primary' : ''}`,
        onclick: () => { picked = g.id; localStorage.setItem(PICKED_KEY, String(g.id)); render(); },
      }, g.name));
      if (isActive && canEdit) {
        tabs.append(el('button', {
          class: 'btn small icon-only', title: 'Перейменувати послугу',
          onclick: () => renameGroupForm(g),
        }, icon('edit', 14)));
      }
      if (isActive && canDelete) {
        tabs.append(el('button', {
          class: 'btn small icon-only danger', title: 'Видалити послугу',
          onclick: async () => {
            if (!confirm(`Видалити послугу «${g.name}»?`)) return;
            try {
              await api.del(`/costing/groups/${g.id}`);
              picked = null;
              await render();
            } catch (e) { toast(e.message, true); }
          },
        }, icon('trash', 14)));
      }
    }
    if (canCreate) {
      tabs.append(el('button', { class: 'btn', onclick: () => newGroupForm() }, withIcon('plus', 'Послуга')));
    }
    return tabs;
  }

  function newGroupForm() {
    const name = el('input', { placeholder: 'Наприклад: Трафік ферма' });
    const formBox = modal('Нова послуга', el('div', { class: 'field' }, el('label', {}, 'Назва'), name),
      [actionButton('Створити', async () => {
        if (!name.value.trim()) return toast('Потрібна назва', true);
        try {
          const res = await api.post('/costing/groups', { name: name.value.trim() });
          formBox.remove();
          picked = res.id;
          await render();
        } catch (e) { toast(e.message, true); }
      })]);
  }

  function renameGroupForm(g) {
    const name = el('input', { value: g.name });
    const formBox = modal('Назва послуги', el('div', { class: 'field' }, el('label', {}, 'Назва'), name),
      [actionButton('Зберегти', async () => {
        if (!name.value.trim()) return toast('Потрібна назва', true);
        try {
          await api.put(`/costing/groups/${g.id}`, { name: name.value.trim() });
          formBox.remove();
          await render();
        } catch (e) { toast(e.message, true); }
      })]);
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
          class: 'btn small icon-only', title: 'Назва, ціна, маржа пакета',
          onclick: () => serviceFieldsForm(s),
        }, icon('edit', 15)) : null,
        canDelete ? el('button', {
          class: 'btn small icon-only danger', title: 'Видалити пакет',
          onclick: async () => {
            if (!confirm(`Видалити пакет «${s.name}» разом із його витратами?`)) return;
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
      el('div', { class: 'field' }, el('label', {}, 'Назва пакета'), name),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Одиниця'), unit),
        el('div', {}, el('label', {}, 'Цільова маржа, %'), margin)),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Ціна, $'), price),
        el('div', {}, el('label', {}, 'Обсяг/міс'), volume)));

    const formBox = modal('Новий пакет', form, [actionButton('Створити', async () => {
      if (!name.value.trim()) return toast('Потрібна назва пакета', true);
      try {
        await api.post('/services', {
          group_id: picked, name: name.value.trim(), unit: unit.value.trim() || 'шт',
          price: price.value || 0, target_margin: margin.value || 0,
          volume_per_month: volume.value || 0, status: 'active',
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
      el('div', { class: 'field' }, el('label', {}, 'Назва пакета'), name),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Категорія'), category),
        el('div', {}, el('label', {}, 'Одиниця'), unit)),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Ціна, $'), price,
          Number(s.is_package) ? el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:3px' },
            'Пакет — ціна рахується з вкладених послуг') : null),
        el('div', {}, el('label', {}, 'Цільова маржа, %'), margin)),
      el('div', { class: 'field' }, el('label', {}, 'Обсяг/міс'), volume));

    const formBox = modal(`Пакет · ${s.name}`, form, [actionButton('Зберегти', async () => {
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
