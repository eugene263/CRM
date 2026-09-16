// Розрізи ROI, життя акаунтів і детектор вигорання звʼязок.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, num, pct, toast } from '../ui.js';
import { icon, withIcon } from '../icons.js';

const DIMS = [
  ['offer', 'Офер'], ['user', 'Крієйтор'], ['account', 'Акаунт'],
  ['creative', 'Креатив'], ['geo', 'Гео'], ['platform', 'Платформа'], ['team', 'Команда'],
];

export async function renderAnalytics() {
  const box = el('div', {});
  let dim = 'offer';
  const tabs = el('div', { class: 'tabs' });
  const tableCard = el('div', { class: 'card' });

  async function load() {
    tabs.textContent = '';
    for (const [key, label] of DIMS) {
      tabs.append(el('button', {
        class: `btn small${key === dim ? ' active' : ''}`,
        onclick: () => { dim = key; load(); },
      }, label));
    }
    const { from, to } = state.range;
    const { rows } = await api.get(`/analytics/breakdown?dim=${dim}&from=${from}&to=${to}`);
    const cols = [
      ['label', 'Розріз', (r) => r.label],
      ['posts', 'Публікації', (r) => num(r.posts)],
      ['views', 'Перегляди', (r) => num(r.views)],
      ['clicks', 'Кліки', (r) => num(r.clicks)],
      ['regs', 'Реги', (r) => num(r.regs)],
      ['deps', 'Депи', (r) => num(r.deps)],
      ['revenue', 'Дохід', (r) => money(r.revenue)],
      ['cost', 'Витрати', (r) => money(r.cost)],
      ['profit', 'Профіт', (r) => money(r.profit)],
      ['roi', 'ROI', (r) => pct(r.roi)],
      ['epm', 'EPM', (r) => (r.epm == null ? '—' : `$${r.epm.toFixed(2)}`)],
    ];
    tableCard.textContent = '';
    tableCard.append(el('h3', {}, 'Розріз ефективності'),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ...cols.map(([, label], i) => el('th', { class: i ? 'num' : '' }, label)))),
        el('tbody', {}, ...rows.map((r) => el('tr', {},
          ...cols.map(([, , fn], i) => el('td', { class: i ? 'num' : '' }, fn(r)))))))),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        'Витрати підтягуються там, де привʼязка однозначна: собівартість акаунтів або витрати, повішані на крієйтора/команду.'));
  }

  const burnCard = el('div', { class: 'card' }, el('h3', {}, 'Вигорання звʼязок (7 днів проти попередніх 7)'));
  const lifeCard = el('div', { class: 'card' }, el('h3', {}, 'Життя акаунта до бану'));

  try {
    const burn = await api.get('/analytics/burnout');
    burnCard.append(burn.rows.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Креатив'), el('th', { class: 'num' }, 'CR було'),
        el('th', { class: 'num' }, 'CR зараз'), el('th', { class: 'num' }, 'Падіння'), el('th', {}, 'Вердикт'))),
      el('tbody', {}, ...burn.rows.slice(0, 15).map((r) => el('tr', {},
        el('td', {}, r.title),
        el('td', { class: 'num' }, pct(r.cr_prev)),
        el('td', { class: 'num' }, pct(r.cr_recent)),
        el('td', { class: 'num' }, r.drop_pct == null ? '—' : pct(r.drop_pct)),
        el('td', {}, r.burning ? withIcon('alert', 'вигорає') : '—'))))))
      : el('div', { class: 'muted' }, 'Замало даних за 14 днів.'));

    const life = await api.get('/analytics/lifetime');
    lifeCard.append(life.rows.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Платформа'), el('th', {}, 'Гео'),
        el('th', { class: 'num' }, 'Забанено'), el('th', { class: 'num' }, 'Середнє життя, днів'), el('th', { class: 'num' }, 'Середня вартість'))),
      el('tbody', {}, ...life.rows.map((r) => el('tr', {},
        el('td', {}, r.platform), el('td', {}, r.geo),
        el('td', { class: 'num' }, num(r.banned_accounts)),
        el('td', { class: 'num' }, num(r.avg_days)),
        el('td', { class: 'num' }, money(r.avg_cost)))))))
      : el('div', { class: 'muted' }, 'Банів ще не було.'));
  } catch (e) {
    toast(e.message, true);
  }

  box.append(tabs, tableCard, burnCard, lifeCard);
  await load();
  return box;
}
