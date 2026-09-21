// Універсальний список + форма для будь-якої сутності з /api/meta.
import { api } from '../api.js';
import { state, reloadRefs } from '../app.js';
import { el, money, num, badge, modal, toast } from '../ui.js';
import { credentialActions } from './vault.js';
import { openLead } from './prospecting.js';
import { scriptStepsModal } from './scripts.js';
import { clientCardModal } from './clients.js';
import { serviceCardModal } from './servicePackage.js';
import { renderLeadsKanban } from './leadsKanban.js';
import { renderProspectListsCards } from './prospectLists.js';
import { renderCostRates } from './costRates.js';
import { renderMessageTemplates } from './messageTemplates.js';
import { renderPayouts } from './payouts.js';
import { renderFarms } from './farms.js';
import { icon, withIcon } from '../icons.js';

const PAGE = 50;

function refLabel(field, value) {
  if (value === null || value === undefined) return '—';
  const list = state.refs[field.ref] || [];
  return list.find((r) => String(r.id) === String(value))?.label || `#${value}`;
}

function cellValue(field, row) {
  const v = row[field.name];
  if (v === null || v === undefined || v === '') return '—';
  if (field.type === 'ref') return refLabel(field, v);
  if (field.type === 'money') return money(v);
  if (field.type === 'number') return num(v);
  if (field.type === 'select') {
    const opt = (field.options || []).find((o) => o.value === String(v));
    return badge(v, opt?.label || v);
  }
  if (field.type === 'url') return el('a', { href: v, target: '_blank', rel: 'noreferrer' }, 'лінк');
  if (field.type === 'datetime') return String(v).slice(0, 16);
  if (field.type === 'textarea') return String(v).slice(0, 60);
  return String(v);
}

function formField(field, value, entKey, rowId) {
  const id = `f_${field.name}`;
  let input;
  if (field.type === 'select') {
    input = el('select', { name: field.name, id },
      el('option', { value: '' }, '—'),
      ...(field.options || []).map((o) => el('option', { value: o.value, selected: String(value) === o.value }, o.label)));
  } else if (field.type === 'ref') {
    input = el('select', { name: field.name, id },
      el('option', { value: '' }, '—'),
      ...(state.refs[field.ref] || []).map((r) => el('option', { value: r.id, selected: String(value) === String(r.id) }, `${r.label} (#${r.id})`)));
  } else if (field.type === 'textarea') {
    input = el('textarea', { name: field.name, id, rows: 3 }, value ?? '');
  } else if (field.type === 'secret' || field.type === 'password') {
    input = el('input', { name: field.name, id, type: 'password', placeholder: value ? 'збережено — введіть, щоб змінити' : '' });
  } else {
    const type = { number: 'number', money: 'number', date: 'date', datetime: 'datetime-local', url: 'url' }[field.type] || 'text';
    let v = value ?? '';
    if (field.type === 'datetime' && v) v = String(v).replace(' ', 'T').slice(0, 16);
    input = el('input', { name: field.name, id, type, step: field.type === 'money' ? '0.01' : undefined, value: v, disabled: field.readOnly });
  }
  const wrap = el('div', { class: 'field' },
    el('label', { for: id }, field.label + (field.required ? ' *' : '')), input,
    field.hint ? el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:3px' }, field.hint) : null);

  if (field.type === 'secret' && rowId && state.caps.secrets) {
    wrap.append(el('button', {
      class: 'btn small', type: 'button', style: 'margin-top:6px',
      onclick: async () => {
        const res = await api.get(`/${entKey}/${rowId}/secret/${field.name}`);
        toast(`${field.label}: ${res.value ?? '—'}`);
      },
    }, 'Показати (пишеться в аудит)'));
  }
  return wrap;
}

export function openForm(entKey, row, onSaved) {
  const ent = state.meta[entKey];
  const form = el('form', {});
  for (const f of ent.fields) {
    if (f.readOnly && !row) continue;
    form.append(formField(f, row?.[f.name], entKey, row?.id));
  }
  const save = el('button', { class: 'btn primary', type: 'submit' }, row ? 'Зберегти' : 'Створити');
  const box = modal(row ? `${ent.label}: редагування #${row.id}` : `${ent.label}: новий запис`, form, [save]);
  save.addEventListener('click', (e) => { e.preventDefault(); form.requestSubmit(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {};
    for (const f of ent.fields) {
      const input = form.querySelector(`[name="${f.name}"]`);
      if (!input || input.disabled) continue;
      let v = input.value;
      if ((f.type === 'secret' || f.type === 'password') && v === '') continue;  // не затираємо збережене
      if (f.type === 'datetime' && v) v = v.replace('T', ' ');
      data[f.name] = v;
    }
    try {
      if (row) await api.put(`/${entKey}/${row.id}`, data);
      else await api.post(`/${entKey}`, data);
      box.remove();
      toast('Збережено');
      await reloadRefs();
      onSaved();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

export async function renderEntity(entKey) {
  if (entKey === 'leads') return renderLeadsEntity();
  if (entKey === 'prospect_lists') return renderProspectListsCards();
  // Ставки живуть усередині послуг, тож цей екран — не таблиця ставок,
  // а список плашок: одна плашка = одна послуга зі своїми ставками.
  if (entKey === 'cost_rates') return renderCostRates();
  // Шаблони — дерево карток, а не плоска таблиця: одна картка може лежати
  // всередині іншої, скільки завгодно рівнів.
  if (entKey === 'message_templates') return renderMessageTemplates();
  // Виплати — рік → місяць → людина з PDF-звітами і міні-дашбордом.
  if (entKey === 'payouts') return renderPayouts();
  // Ферми — плашки ферм + фільтрований список акаунтів, а не плоска
  // таблиця самих ферм.
  if (entKey === 'farms') return renderFarms();
  return renderEntityTable(entKey);
}

// Ліди — єдина сутність із двома виглядами: звичайна таблиця й канбан
// воронки за статусами. Перемикач памʼятає вибір через localStorage.
async function renderLeadsEntity() {
  const mode = { current: localStorage.getItem('crm_leads_view') === 'kanban' ? 'kanban' : 'table' };
  const slot = el('div', {});
  const tableBtn = el('button', { class: 'btn small' }, 'Таблиця');
  const kanbanBtn = el('button', { class: 'btn small' }, 'Канбан');
  const syncButtons = () => {
    tableBtn.className = `btn small${mode.current === 'table' ? ' primary' : ''}`;
    kanbanBtn.className = `btn small${mode.current === 'kanban' ? ' primary' : ''}`;
  };
  const renderSlot = async () => {
    slot.textContent = '';
    slot.append(mode.current === 'kanban' ? await renderLeadsKanban(renderSlot) : await renderEntityTable('leads'));
  };
  const switchTo = (m) => { mode.current = m; localStorage.setItem('crm_leads_view', m); syncButtons(); renderSlot(); };
  tableBtn.onclick = () => switchTo('table');
  kanbanBtn.onclick = () => switchTo('kanban');
  syncButtons();

  const wrap = el('div', {}, el('div', { class: 'row', style: 'margin-bottom:14px' }, tableBtn, kanbanBtn), slot);
  await renderSlot();
  return wrap;
}

// Генерик-імпорт CSV: заголовки колонок — підписи полів (як у власному
// «Експорт CSV» цього розділу), тож export → правки в Excel → import
// працює як єдиний цикл. Кожен рядок іде через ту саму валідацію/скоуп/
// хуки, що й ручне створення — помилка одного рядка не зупиняє решту.
function importModal(entKey, onDone) {
  const fileInput = el('input', { type: 'file', accept: '.csv,text/csv' });
  const status = el('div', { style: 'font-size:12.5px;margin-top:10px' });
  modal(`Імпорт CSV — ${state.meta[entKey].label}`,
    el('div', {},
      el('div', { class: 'muted', style: 'font-size:12.5px;margin-bottom:10px' },
        'Заголовки колонок мають збігатися з назвами полів — простіше всього взяти файл із «Експорт CSV» цього розділу за зразок.'),
      fileInput, status),
    [el('button', {
      class: 'btn primary',
      onclick: async () => {
        const file = fileInput.files[0];
        if (!file) return toast('Оберіть файл', true);
        const text = await file.text();
        try {
          const res = await api.post(`/${entKey}/import`, { csv: text });
          status.textContent = `Імпортовано: ${res.imported} · пропущено: ${res.skipped}${res.errors.length ? ` · помилок: ${res.errors.length}` : ''}`;
          if (res.errors.length) {
            status.append(...res.errors.map((e) => el('div', { class: 'muted' }, `• ${e}`)));
          }
          toast(`Імпортовано ${res.imported} записів`);
          onDone();
        } catch (e) { toast(e.message, true); }
      },
    }, 'Імпортувати')]);
}

// «+Додати» для послуг веде одразу в ту саму картку-конструктор пакета, що
// й редагування наявної (serviceCardModal) — а не в голу генерик-форму.
// Картка вимагає вже наявний id (тягне /costing/services/:id/package), тож
// спершу тихо створюємо запис лише з назвою, а картку відкриваємо на ньому.
function newServiceModal(onDone) {
  const name = el('input', { placeholder: 'Наприклад: Ведення TikTok-акаунта, місяць' });
  const box = modal('Нова послуга',
    el('div', { class: 'field' }, el('label', {}, 'Пакети'), name),
    [el('button', {
      class: 'btn primary',
      onclick: async () => {
        if (!name.value.trim()) return toast('Вкажіть назву', true);
        try {
          const res = await api.post('/services', { name: name.value.trim(), status: 'active' });
          box.remove();
          serviceCardModal(res.id, onDone);
        } catch (e) { toast(e.message, true); }
      },
    }, 'Створити')]);
}

async function renderEntityTable(entKey) {
  const ent = state.meta[entKey];
  if (!ent) throw new Error('Розділ недоступний для вашої ролі');
  const box = el('div', {});
  const filters = { limit: PAGE, offset: 0 };

  const statusField = ent.fields.find((f) => f.name === 'status');
  const search = el('input', { placeholder: 'Пошук…', style: 'max-width:240px' });
  const statusSel = statusField
    ? el('select', { style: 'max-width:180px' }, el('option', { value: '' }, 'Усі статуси'),
      ...statusField.options.map((o) => el('option', { value: o.value }, o.label)))
    : null;

  const tableWrap = el('div', { class: 'table-wrap' });
  const pager = el('div', { class: 'pager' });

  async function load() {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(filters.offset) });
    if (search.value) params.set('q', search.value);
    if (statusSel?.value) params.set('status', statusSel.value);
    const dateField = ent.fields.find((f) => ['date', 'datetime'].includes(f.type) && f.list);
    if (dateField && ['posts', 'conversions', 'expenses', 'audit_log'].includes(entKey)) {
      params.set('from', state.range.from);
      params.set('to', state.range.to);
    }
    const data = await api.get(`/${entKey}?${params}`);
    const cols = ent.fields.filter((f) => f.list).slice(0, 9);
    const table = el('table', {},
      el('thead', {}, el('tr', {}, ...cols.map((f) => el('th', {}, f.label)), el('th', {}, ''))),
      el('tbody', {}, ...data.rows.map((row) => el('tr', {},
        ...cols.map((f) => el('td', { class: ['money', 'number'].includes(f.type) ? 'num' : '' }, cellValue(f, row))),
        el('td', {},
          ent.can.update && !ent.readOnlyEntity ? el('button', {
            class: 'btn small icon-only', title: 'Редагувати',
            onclick: () => (entKey === 'services' ? serviceCardModal(row.id, load) : openForm(entKey, row, load)),
          }, icon('edit', 15)) : null,
          entKey === 'access_requests' && row.status === 'pending' && (state.caps.settings || state.user.role === 'teamlead') ? el('span', {},
            el('button', {
              class: 'btn small', title: 'Схвалити',
              onclick: async () => { await api.post(`/access_requests/${row.id}/decide`, { approve: true }); toast('Схвалено'); load(); },
            }, icon('check', 15)),
            el('button', {
              class: 'btn small danger', style: 'margin-left:6px', title: 'Відхилити',
              onclick: async () => { await api.post(`/access_requests/${row.id}/decide`, { approve: false }); toast('Відхилено'); load(); },
            }, icon('ban', 15))) : null,
          ent.can.delete ? el('button', {
            class: 'btn small danger icon-only', style: 'margin-left:6px', title: 'Видалити',
            onclick: async () => {
              if (!confirm(`Видалити запис #${row.id}?`)) return;
              await api.del(`/${entKey}/${row.id}`);
              toast('Видалено');
              load();
            },
          }, icon('trash', 15)) : null,
          entKey === 'credentials' ? credentialActions(row, load) : null,
          entKey === 'leads' ? el('button', {
            class: 'btn small icon-only', style: 'margin-left:6px', title: 'Картка ліда',
            onclick: () => openLead(row.id, load),
          }, icon('folder', 15)) : null,
          entKey === 'scripts' ? el('button', {
            class: 'btn small icon-only', style: 'margin-left:6px', title: 'Кроки скрипту',
            onclick: () => scriptStepsModal(row.id, load),
          }, icon('layers', 15)) : null,
          entKey === 'clients' ? el('button', {
            class: 'btn small icon-only', style: 'margin-left:6px', title: 'Картка клієнта',
            onclick: () => clientCardModal(row.id, load),
          }, icon('award', 15)) : null,
          entKey === 'users' && state.caps.settings && row.status === 'active' ? el('button', {
            class: 'btn small danger icon-only', style: 'margin-left:6px', title: 'Офбординг',
            onclick: async () => {
              if (!confirm(`Офбординг ${row.name}?\n\nСесії буде вбито, доступи відкликано й позначено на ротацію, акаунт вимкнено.`)) return;
              try {
                const res = await api.post(`/users/${row.id}/offboard`, {});
                toast(`Відкликано доступів: ${res.revoked}`);
                load();
              } catch (e) { toast(e.message, true); }
            },
          }, icon('logout', 15)) : null,
          entKey === 'accounts' ? el('button', {
            class: 'btn small icon-only', style: 'margin-left:6px', title: 'Історія',
            onclick: async () => {
              const h = await api.get(`/accounts/${row.id}/history`);
              modal(`Історія акаунта #${row.id}`, el('div', { class: 'table-wrap' }, el('table', {},
                el('thead', {}, el('tr', {}, el('th', {}, 'Коли'), el('th', {}, 'Було'), el('th', {}, 'Стало'))),
                el('tbody', {}, ...h.rows.map((e2) => el('tr', {},
                  el('td', {}, String(e2.created_at).slice(0, 16)), el('td', {}, e2.from_status || '—'), el('td', {}, e2.to_status)))))));
            },
          }, icon('history', 15)) : null)))));
    tableWrap.textContent = '';
    tableWrap.append(data.rows.length ? table : el('div', { class: 'muted' }, 'Записів немає'));
    pager.textContent = '';
    pager.append(
      el('button', { class: 'btn small icon-only', onclick: () => { filters.offset = Math.max(0, filters.offset - PAGE); load(); } }, icon('chevronLeft', 14)),
      `${data.offset + 1}–${Math.min(data.offset + PAGE, data.total)} з ${data.total}`,
      el('button', { class: 'btn small icon-only', onclick: () => { if (filters.offset + PAGE < data.total) { filters.offset += PAGE; load(); } } }, icon('chevronRight', 14)));
  }

  const toolbar = el('div', { class: 'row', style: 'margin-bottom:14px' },
    search, statusSel,
    el('div', { style: 'flex:2 1 auto;display:flex;gap:8px;justify-content:flex-end' },
      el('button', { class: 'btn', onclick: () => { filters.offset = 0; load(); } }, 'Застосувати'),
      state.caps.export ? el('button', {
        class: 'btn',
        onclick: () => { window.location.href = `/api/${entKey}/export?limit=500`; toast('Експорт записано в аудит-лог'); },
      }, withIcon('download', 'Експорт CSV')) : null,
      ent.can.create ? el('button', { class: 'btn', onclick: () => importModal(entKey, load) }, withIcon('upload', 'Імпорт CSV')) : null,
      ent.can.create ? el('button', {
        class: 'btn primary',
        onclick: () => (entKey === 'services' ? newServiceModal(load) : openForm(entKey, null, load)),
      }, withIcon('plus', 'Додати')) : null));

  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { filters.offset = 0; load(); } });
  box.append(toolbar, el('div', { class: 'card' }, tableWrap, pager));
  if (ent.scope !== 'all') {
    box.append(el('div', { class: 'muted', style: 'font-size:12px' },
      ent.scope === 'own' ? 'Видно лише ваші записи.' : 'Видно записи вашої команди.'));
  }
  if (entKey === 'clients') {
    const tiles = el('div', { class: 'tiles', style: 'margin-bottom:14px' });
    box.prepend(tiles);
    const s = await api.get('/clients/summary');
    tiles.append(
      el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Активні клієнти'), el('div', { class: 'value pos' }, num(s.active))),
      el('div', { class: 'tile' }, el('div', { class: 'label' }, 'MRR'), el('div', { class: 'value' }, money(s.mrr))),
      el('div', { class: 'tile' }, el('div', { class: 'label' }, 'На паузі'), el('div', { class: 'value' }, num(s.paused))),
      el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Відтік за 30д'),
        el('div', { class: `value ${s.churned_30d ? 'neg' : ''}` }, s.churn_rate_30d != null ? `${s.churn_rate_30d}%` : '—')));
  }
  await load();
  return box;
}
