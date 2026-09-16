// Списки пошуку картками: кожна картка — гіпотеза (ніша/сфера/гео), клік
// відкриває повноекранну сторінку з тією самою парою вкладок «Особи»/
// «Організації», що й у довідкових CRM-каталогах контактів —
// «Організації» це ліди списку (вже є як сутність), «Особи» — контакти
// цих лідів, зведені по людині (src/prospecting.js:listContacts).
// Набір стовпців у кожній вкладці — на вибір (галочки, памʼять у
// localStorage): не всім потрібне те саме поле в таблиці.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, toast, badge, money } from '../ui.js';
import { icon, withIcon } from '../icons.js';
import { openForm } from './entity.js';
import { openLead, addForm } from './prospecting.js';

const SORTERS = {
  created: { label: 'Спочатку нові', fn: (a, b) => String(b.created_at).localeCompare(String(a.created_at)) },
  name: { label: 'За назвою (А-Я)', fn: (a, b) => a.name.localeCompare(b.name, 'uk') },
  deadline: { label: 'За дедлайном', fn: (a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')) },
  goal: { label: 'За ціллю лідів', fn: (a, b) => (b.goal_leads || 0) - (a.goal_leads || 0) },
};

const KIND_LABEL = { manual: 'Ручний', import: 'Імпорт', auto: 'Автоматичний', mixed: 'Змішаний', smart: 'Смарт' };
const STATUS_LABEL = { draft: 'Чернетка', active: 'В роботі', paused: 'Пауза', closed: 'Закритий', archived: 'Архів' };
const PRIORITY_LABEL = { hot: 'Гарячий', warm: 'Теплий', cold: 'Холодний' };

export async function renderProspectListsCards() {
  const ent = state.meta.prospect_lists;
  const grid = el('div', { class: 'list-cards' });
  const sortSel = el('select', { style: 'max-width:200px' },
    ...Object.entries(SORTERS).map(([v, s]) => el('option', { value: v }, s.label)));

  async function load() {
    const { rows } = await api.get('/prospect_lists?limit=200');
    const sorted = [...rows].sort(SORTERS[sortSel.value].fn);
    grid.textContent = '';
    grid.append(...(sorted.length ? sorted.map(renderCard) : [el('div', { class: 'muted' }, 'Списків ще немає')]));
  }

  function ownerLabel(row) {
    return (state.refs.users || []).find((u) => String(u.id) === String(row.owner_user_id))?.label || '—';
  }

  function renderCard(row) {
    const card = el('div', { class: 'list-card' },
      el('div', { class: 'list-card-head' },
        el('b', {}, row.name),
        badge(row.status, STATUS_LABEL[row.status] || row.status)),
      el('div', { class: 'muted', style: 'font-size:12.5px' },
        [KIND_LABEL[row.kind] || row.kind, row.geo, row.vertical].filter(Boolean).join(' · ') || '—'),
      row.goal_leads || row.deadline ? el('div', { class: 'muted', style: 'font-size:12.5px' },
        [row.goal_leads ? `ціль: ${row.goal_leads} лідів` : null, row.deadline ? `до ${row.deadline}` : null].filter(Boolean).join(' · ')) : null,
      el('div', { class: 'list-card-foot' },
        el('span', { class: 'muted', style: 'font-size:12px' }, ownerLabel(row)),
        el('span', { class: 'list-card-actions' },
          ent.can.update ? el('button', {
            class: 'btn small icon-only', title: 'Редагувати',
            onclick: (e) => { e.stopPropagation(); openForm('prospect_lists', row, load); },
          }, icon('edit', 14)) : null,
          ent.can.delete ? el('button', {
            class: 'btn small icon-only danger', title: 'Видалити',
            onclick: async (e) => {
              e.stopPropagation();
              if (!confirm(`Видалити список «${row.name}»?`)) return;
              await api.del(`/prospect_lists/${row.id}`);
              toast('Видалено');
              load();
            },
          }, icon('trash', 14)) : null)));

    card.addEventListener('click', () => { location.hash = `#/list/${row.id}`; });
    return card;
  }

  const toolbar = el('div', { class: 'row', style: 'margin-bottom:14px' },
    el('div', { class: 'muted', style: 'display:flex;align-items:center;gap:6px' }, icon('sort', 15), 'Сортування:'),
    sortSel,
    el('div', { style: 'flex:1 1 auto;display:flex;justify-content:flex-end' },
      ent.can.create ? el('button', { class: 'btn primary', onclick: () => openForm('prospect_lists', null, load) }, withIcon('plus', 'Додати')) : null));

  sortSel.addEventListener('change', load);
  await load();
  return el('div', {}, toolbar, grid);
}

// Набори стовпців для кожної вкладки картки списку — «always» завжди на
// екрані, «default» показуються, доки людина не зняла галочку.
const ORG_COLUMNS = [
  { key: 'company_name', label: 'Назва', always: true },
  { key: 'tags', label: 'Мітки', default: true },
  { key: 'email', label: 'Email', default: true },
  { key: 'phone', label: 'Телефон', default: true },
  { key: 'status_code', label: 'Статус', default: true },
  { key: 'geo_city', label: 'Місто' },
  { key: 'vertical', label: 'Вертикаль' },
  { key: 'priority', label: 'Пріоритет' },
  { key: 'score', label: 'Скоринг' },
  { key: 'expected_amount', label: 'Очікувана сума' },
];
const PEOPLE_COLUMNS = [
  { key: 'name', label: 'Назва', always: true },
  { key: 'tags', label: 'Мітки', default: true },
  { key: 'company_name', label: 'Організація', default: true },
  { key: 'email', label: 'Електронна пошта', default: true },
  { key: 'phone', label: 'Телефон', default: true },
  { key: 'position', label: 'Посада' },
];

function cellValue(row, key) {
  const v = row[key];
  if (v === null || v === undefined || v === '') return '—';
  if (key === 'status_code') return badge(v, v);
  if (key === 'priority') return PRIORITY_LABEL[v] || v;
  if (key === 'expected_amount') return money(v);
  if (key === 'email') return el('a', { href: `mailto:${v}`, onclick: (e) => e.stopPropagation() }, v);
  return v;
}

function columnPicker(columns, storageKey, onChange) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch { saved = null; }
  const visible = new Set(saved || columns.filter((c) => c.default).map((c) => c.key));

  const list = el('div', { class: 'col-picker-list' },
    ...columns.filter((c) => !c.always).map((c) => {
      const cb = el('input', { type: 'checkbox', checked: visible.has(c.key) });
      cb.addEventListener('change', () => {
        if (cb.checked) visible.add(c.key); else visible.delete(c.key);
        try { localStorage.setItem(storageKey, JSON.stringify([...visible])); } catch {}
        onChange();
      });
      return el('label', { class: 'col-picker-item' }, cb, c.label);
    }));

  const node = el('details', { class: 'col-picker' }, el('summary', {}, icon('grid', 14), 'Стовпці'), list);
  return { node, visible };
}

// Повноекранна сторінка списку (#/list/:id) — той самий формат, що й у
// референсі: велика таблиця контактів на всю ширину з перемикачем
// «Особи»/«Організації», вибором стовпців і ручним додаванням ліда прямо
// в цей список.
export async function renderListDetailPage(listId) {
  const { row: list } = await api.get(`/prospect_lists/${listId}`);

  const tab = { current: 'organizations' };
  const body = el('div', {});
  const pickerSlot = el('div', {});
  const orgsBtn = el('button', { class: 'btn small' }, withIcon('folder', 'Організації'));
  const peopleBtn = el('button', { class: 'btn small' }, withIcon('user', 'Особи'));

  const orgPicker = columnPicker(ORG_COLUMNS, 'crm_list_org_cols', () => renderTab());
  const peoplePicker = columnPicker(PEOPLE_COLUMNS, 'crm_list_people_cols', () => renderTab());

  const syncTabs = () => {
    orgsBtn.className = `btn small${tab.current === 'organizations' ? ' primary' : ''}`;
    peopleBtn.className = `btn small${tab.current === 'people' ? ' primary' : ''}`;
  };

  async function renderOrganizations() {
    const { rows } = await api.get(`/leads?list_id=${list.id}&limit=200`);
    if (!rows.length) return el('div', { class: 'muted' }, 'У списку ще немає лідів');
    const cols = ORG_COLUMNS.filter((c) => c.always || orgPicker.visible.has(c.key));
    return el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', {}, c.label)))),
      el('tbody', {}, ...rows.map((r) => el('tr', { style: 'cursor:pointer', onclick: () => openLead(r.id) },
        ...cols.map((c) => el('td', {}, cellValue(r, c.key))))))));
  }

  async function renderPeople() {
    const { rows } = await api.get(`/prospecting/lists/${list.id}/contacts`);
    if (!rows.length) return el('div', { class: 'muted' }, 'Контактних осіб ще немає');
    const cols = PEOPLE_COLUMNS.filter((c) => c.always || peoplePicker.visible.has(c.key));
    return el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', {}, c.label)))),
      el('tbody', {}, ...rows.map((r) => el('tr', { style: 'cursor:pointer', onclick: () => openLead(r.lead_id) },
        ...cols.map((c) => el('td', {}, cellValue(r, c.key))))))));
  }

  const renderTab = async () => {
    pickerSlot.textContent = '';
    pickerSlot.append(tab.current === 'people' ? peoplePicker.node : orgPicker.node);
    body.textContent = '';
    body.append(await (tab.current === 'people' ? renderPeople() : renderOrganizations()));
  };
  orgsBtn.onclick = () => { tab.current = 'organizations'; syncTabs(); renderTab(); };
  peopleBtn.onclick = () => { tab.current = 'people'; syncTabs(); renderTab(); };
  syncTabs();

  const addLeadBtn = el('button', {
    class: 'btn small primary',
    onclick: () => addForm(() => renderTab(), list.id),
  }, withIcon('plus', 'Додати ліда'));

  const header = el('div', { style: 'margin-bottom:14px' },
    el('a', { href: '#/e/prospect_lists', style: 'font-size:12.5px;display:inline-flex;align-items:center;gap:4px' },
      icon('chevronLeft', 13), 'Списки пошуку'),
    el('h2', { style: 'margin:6px 0 2px' }, list.name),
    list.description ? el('div', { class: 'muted' }, list.description) : null);

  const toolbar = el('div', { class: 'row', style: 'margin-bottom:12px;align-items:center' },
    peopleBtn, orgsBtn,
    el('div', { style: 'flex:1 1 auto' }),
    addLeadBtn, pickerSlot);

  const page = el('div', {}, header, el('div', { class: 'card' }, toolbar, body));
  await renderTab();
  return page;
}
