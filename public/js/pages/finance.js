// P&L, розрахунок ЗП і особистий заробіток (для крієйтора — тільки свій).
import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, num, pct, toast } from '../ui.js';

const monthNow = () => new Date().toISOString().slice(0, 7);

// Підпис профіту залежить від того, по якому скоупу його рахує сервер.
const profitLabel = (role) => ({ owner: 'Профіт компанії', head: 'Профіт компанії', teamlead: 'Профіт команди' })[role] || 'Мій профіт';
const myTitle = (role) => (['owner', 'head'].includes(role) ? 'Показники компанії' : role === 'teamlead' ? 'Показники команди' : 'Мій заробіток');

// Категорії витрат показуємо людськими підписами з метаданих.
function categoryLabel(value) {
  const field = state.meta.expenses?.fields.find((f) => f.name === 'category');
  return field?.options.find((o) => o.value === value)?.label || value;
}

export async function renderFinance() {
  const box = el('div', {});
  const period = el('input', { type: 'month', value: monthNow(), style: 'max-width:180px' });

  const myCard = el('div', { class: 'card' }, el('h3', {}, 'Мій заробіток'));
  const pnlCard = el('div', { class: 'card' }, el('h3', {}, 'P&L команди'));
  const salaryCard = el('div', { class: 'card' }, el('h3', {}, 'Розрахунок ЗП'));

  async function loadMy() {
    const data = await api.get(`/finance/my?period=${period.value}`);
    myCard.textContent = '';
    myCard.append(el('h3', {}, `${myTitle(state.user.role)} · ${data.period}`),
      el('div', { class: 'tiles' },
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Публікації'), el('div', { class: 'value' }, num(data.stats.posts))),
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Депи'), el('div', { class: 'value' }, num(data.stats.deps))),
        el('div', { class: 'tile' }, el('div', { class: 'label' }, profitLabel(state.user.role)),
          el('div', { class: `value ${data.stats.profit >= 0 ? 'pos' : 'neg'}` }, money(data.stats.profit))),
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Нараховано'),
          el('div', { class: 'value' }, money(data.payout?.total ?? 0)),
          el('div', { class: 'hint' }, data.payout ? (data.payout.status === 'paid' ? 'виплачено' : 'нараховано') : 'ще не рахували'))));
  }

  async function loadPnl() {
    if (!state.meta.expenses) return;
    const d = await api.get(`/finance/pnl?period=${period.value}`);
    pnlCard.textContent = '';
    pnlCard.append(el('h3', {}, `P&L · ${d.period}`),
      el('div', { class: 'tiles' },
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Дохід'), el('div', { class: 'value' }, money(d.revenue)), el('div', { class: 'hint' }, `у холді ${money(d.hold)}`)),
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Витрати'), el('div', { class: 'value' }, money(d.expenses))),
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'ЗП'), el('div', { class: 'value' }, money(d.salary))),
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Чистий профіт'),
          el('div', { class: `value ${d.profit >= 0 ? 'pos' : 'neg'}` }, money(d.profit)),
          el('div', { class: 'hint' }, `маржа ${pct(d.margin)} · ROI ${pct(d.roi)}`))),
      d.byCategory.length ? el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Категорія витрат'), el('th', { class: 'num' }, 'Сума'))),
        el('tbody', {}, ...d.byCategory.map((c) => el('tr', {}, el('td', {}, categoryLabel(c.category)), el('td', { class: 'num' }, money(c.amount))))))) : null);
  }

  async function loadSalary(commit = false) {
    if (!state.caps.salary_calc) return;
    const d = commit
      ? await api.post('/finance/salary', { period: period.value, commit: true })
      : await api.get(`/finance/salary?period=${period.value}`);
    salaryCard.textContent = '';
    salaryCard.append(el('h3', {}, `Розрахунок ЗП · ${d.period}`),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Співробітник'), el('th', {}, 'Роль'),
          el('th', { class: 'num' }, 'Профіт'), el('th', { class: 'num' }, 'Фікс'),
          el('th', { class: 'num' }, '%'), el('th', { class: 'num' }, 'Бонус'), el('th', { class: 'num' }, 'Разом'))),
        el('tbody', {}, ...d.rows.map((r) => el('tr', {},
          el('td', {}, r.user), el('td', {}, r.role),
          el('td', { class: 'num' }, money(r.profit)), el('td', { class: 'num' }, money(r.fix_amount)),
          el('td', { class: 'num' }, money(r.percent_amount)), el('td', { class: 'num' }, money(r.bonus_amount)),
          el('td', { class: 'num' }, money(r.total))))))),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('div', {}, el('b', {}, `Разом до виплати: ${money(d.total)}`)),
        el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
          el('button', { class: 'btn', onclick: () => loadSalary(false) }, 'Перерахувати'),
          el('button', {
            class: 'btn primary',
            onclick: async () => {
              if (!confirm(`Нарахувати ЗП за ${period.value}? Вже виплачені періоди не чіпаються.`)) return;
              await loadSalary(true);
              toast('Нараховано у «Виплати команді»');
            },
          }, 'Нарахувати'))),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
        'Формула: фікс + % від профіту + бонус за KPI. Профіт крієйтора — його апрувнуті конверсії мінус повішані на нього витрати; тімліда — по команді.'));
  }

  period.addEventListener('change', () => { loadMy(); loadPnl(); loadSalary(false); });
  box.append(el('div', { class: 'row', style: 'margin-bottom:14px' },
    el('div', { style: 'flex:0 0 200px' }, el('label', {}, 'Період'), period)), myCard, pnlCard,
    state.caps.salary_calc ? salaryCard : null);

  await loadMy();
  await loadPnl();
  await loadSalary(false);
  return box;
}
