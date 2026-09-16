// Списки пошуку картками: кожна картка — гіпотеза (ніша/сфера/гео), клік
// відкриває всередині ту саму пару вкладок «Особи»/«Організації», що й
// у довідкових CRM-каталогах контактів — «Організації» це ліди списку
// (уже є як сутність), «Особи» — контакти цих лідів, зведені по людині
// (src/prospecting.js:listContacts).
import { api } from '../api.js';
import { state, reloadRefs } from '../app.js';
import { el, modal, toast, badge } from '../ui.js';
import { icon, withIcon } from '../icons.js';
import { openForm } from './entity.js';
import { openLead } from './prospecting.js';

const SORTERS = {
  created: { label: 'Спочатку нові', fn: (a, b) => String(b.created_at).localeCompare(String(a.created_at)) },
  name: { label: 'За назвою (А-Я)', fn: (a, b) => a.name.localeCompare(b.name, 'uk') },
  deadline: { label: 'За дедлайном', fn: (a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')) },
  goal: { label: 'За ціллю лідів', fn: (a, b) => (b.goal_leads || 0) - (a.goal_leads || 0) },
};

const KIND_LABEL = { manual: 'Ручний', import: 'Імпорт', auto: 'Автоматичний', mixed: 'Змішаний', smart: 'Смарт' };
const STATUS_LABEL = { draft: 'Чернетка', active: 'В роботі', paused: 'Пауза', closed: 'Закритий', archived: 'Архів' };

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

    card.addEventListener('click', () => listDetailModal(row));
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

async function listDetailModal(list) {
  const tab = { current: 'organizations' };
  const body = el('div', {});
  const orgsBtn = el('button', { class: 'btn small' }, withIcon('folder', 'Організації'));
  const peopleBtn = el('button', { class: 'btn small' }, withIcon('user', 'Особи'));

  const syncTabs = () => {
    orgsBtn.className = `btn small${tab.current === 'organizations' ? ' primary' : ''}`;
    peopleBtn.className = `btn small${tab.current === 'people' ? ' primary' : ''}`;
  };

  async function renderOrganizations() {
    const { rows } = await api.get(`/leads?list_id=${list.id}&limit=200`);
    if (!rows.length) return el('div', { class: 'muted' }, 'У списку ще немає лідів');
    return el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Назва'), el('th', {}, 'Мітки'), el('th', {}, 'Email'), el('th', {}, 'Телефон'), el('th', {}, 'Статус'))),
      el('tbody', {}, ...rows.map((r) => el('tr', { style: 'cursor:pointer', onclick: () => openLead(r.id) },
        el('td', {}, r.company_name),
        el('td', {}, r.tags || '—'),
        el('td', {}, r.email || '—'),
        el('td', {}, r.phone || '—'),
        el('td', {}, badge(r.status_code, r.status_code)))))));
  }

  async function renderPeople() {
    const { rows } = await api.get(`/prospecting/lists/${list.id}/contacts`);
    if (!rows.length) return el('div', { class: 'muted' }, 'Контактних осіб ще немає');
    return el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Назва'), el('th', {}, 'Мітки'), el('th', {}, 'Організація'), el('th', {}, 'Електронна пошта'), el('th', {}, 'Телефон'))),
      el('tbody', {}, ...rows.map((r) => el('tr', { style: 'cursor:pointer', onclick: () => openLead(r.lead_id) },
        el('td', {}, r.name),
        el('td', {}, r.tags || '—'),
        el('td', {}, r.company_name),
        el('td', {}, r.email ? el('a', { href: `mailto:${r.email}` }, r.email) : '—'),
        el('td', {}, r.phone || '—'))))));
  }

  const renderTab = async () => {
    body.textContent = '';
    body.append(await (tab.current === 'people' ? renderPeople() : renderOrganizations()));
  };
  orgsBtn.onclick = () => { tab.current = 'organizations'; syncTabs(); renderTab(); };
  peopleBtn.onclick = () => { tab.current = 'people'; syncTabs(); renderTab(); };
  syncTabs();

  modal(`Список · ${list.name}`, el('div', {},
    list.description ? el('div', { class: 'muted', style: 'margin-bottom:10px' }, list.description) : null,
    el('div', { class: 'row', style: 'margin-bottom:12px' }, peopleBtn, orgsBtn),
    body));
  await renderTab();
}
