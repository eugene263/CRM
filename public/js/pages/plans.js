// Плани та норми: калькулятор від цілі, мій місяць, екран тімліда.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, num, pct, toast, modal } from '../ui.js';

const FIELDS = [
  ['goal_deals', 'Ціль: клієнтів/міс', 4],
  ['conv_meeting_to_deal', 'Зустріч → клієнт, %', 20],
  ['conv_reply_to_meeting', 'Відповідь → зустріч, %', 30],
  ['reply_rate', 'Reply rate, %', 8],
  ['touches_per_lead', 'Тачів на лід', 2.5],
  ['qualification_rate', 'Кваліфікація зі знайдених, %', 70],
  ['working_days', 'Робочих днів', 21],
  ['headcount', 'Людей у команді', 1],
];

export async function renderPlans() {
  const box = el('div', {});
  const inputs = {};
  const result = el('div', {});
  const coefficientNote = el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' });

  const real = await api.get('/kpi/coefficients');
  coefficientNote.textContent = real.enough
    ? `Коефіцієнти підставлені з вашої статистики (${real.leads} лідів історії).`
    : `${real.note}: у базі ${real.leads} лідів, орієнтири стають своїми від ${real.need}.`;

  const form = el('div', { class: 'row' }, ...FIELDS.map(([key, label, fallback]) => {
    const value = real.enough && real[key] != null ? real[key] : fallback;
    const input = el('input', { type: 'number', step: '0.1', value });
    inputs[key] = input;
    return el('div', {}, el('label', {}, label), input);
  }));

  async function recalc() {
    const payload = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, Number(i.value)]));
    const calc = await api.post('/kpi/calculator', payload);
    const tile = (label, value, hint) => el('div', { class: 'tile' },
      el('div', { class: 'label' }, label), el('div', { class: 'value' }, value),
      hint ? el('div', { class: 'hint' }, hint) : null);

    result.textContent = '';
    result.append(
      el('div', { class: 'tiles' },
        tile('Знайти/день', num(calc.daily.leads_found), 'на одну людину'),
        tile('Кваліфікувати/день', num(calc.daily.leads_qualified)),
        tile('Тачів/день', num(calc.daily.touches), `потрібно акаунтів: ${calc.accounts_needed}`),
        tile('Відповідей/день', num(calc.daily.replies)),
        tile('Зустрічей/день', num(calc.daily.meetings))),
      el('div', { class: 'card' }, el('h3', {}, 'Що це означає на місяць'),
        el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Крок'), el('th', { class: 'num' }, 'Потрібно'))),
          el('tbody', {},
            ...[['Клієнтів', calc.month.deals], ['Зустрічей', calc.month.meetings], ['Відповідей', calc.month.replies],
              ['Опрацьованих лідів', calc.month.touched_leads], ['Тачів', calc.month.touches], ['Знайдених лідів', calc.month.leads]]
              .map(([label, value]) => el('tr', {}, el('td', {}, label), el('td', { class: 'num' }, num(value))))))),
        el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
          `За лімітів 30–50 тачів на акаунт це щонайменше ${calc.accounts_needed} акаунтів або скриньок на людину.`)),
      state.meta.kpi_plans?.can.create ? el('div', { class: 'row' },
        el('div', { class: 'muted' }, 'Застосувати як норми — денні й місячні плани'),
        el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
          el('button', {
            class: 'btn primary',
            onclick: () => applyForm(calc),
          }, 'Поставити план команді'))) : null);
  }

  function applyForm(calc) {
    const picks = (state.refs.users || []).map((u) => {
      const cb = el('input', { type: 'checkbox', style: 'width:auto' });
      return { id: u.id, cb, node: el('label', { style: 'display:flex;gap:6px;align-items:center' }, cb, u.label) };
    });
    const start = el('input', { type: 'date', value: `${new Date().toISOString().slice(0, 7)}-01` });
    const body = el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Період з'), start),
      el('div', { style: 'display:grid;gap:6px;max-height:280px;overflow:auto' }, ...picks.map((p) => p.node)));

    const box2 = modal('Кому ставимо норму', body, [el('button', {
      class: 'btn primary',
      onclick: async () => {
        const user_ids = picks.filter((p) => p.cb.checked).map((p) => p.id);
        if (!user_ids.length) return toast('Оберіть хоча б одного', true);
        try {
          const res = await api.post('/kpi/apply', { calculation: calc, user_ids, period_start: start.value });
          box2.remove();
          toast(`Норми проставлені: ${res.applied} записів`);
        } catch (e) { toast(e.message, true); }
      },
    }, 'Застосувати')]);
  }

  const calcCard = el('div', { class: 'card' },
    el('h3', {}, 'Калькулятор норм — від цілі по клієнтах, а не зі стелі'),
    form, coefficientNote,
    el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn', onclick: recalc }, 'Перерахувати')),
    result);

  const monthCard = el('div', { class: 'card' }, el('h3', {}, 'Мій місяць'));
  const { rows: monthRows } = await api.get('/kpi/month');
  monthCard.append(monthRows.length
    ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Метрика'), el('th', { class: 'num' }, 'План'),
        el('th', { class: 'num' }, 'Факт'), el('th', { class: 'num' }, 'Виконання'), el('th', { class: 'num' }, 'Прогноз'))),
      el('tbody', {}, ...monthRows.map((r) => el('tr', {},
        el('td', {}, r.name), el('td', { class: 'num' }, num(r.target)), el('td', { class: 'num' }, num(r.fact)),
        el('td', { class: 'num' }, r.percent == null ? '—' : `${r.percent}%`),
        el('td', { class: 'num' }, r.forecast_percent == null ? '—' : `${r.forecast_percent}%`))))))
    : el('div', { class: 'muted' }, 'Місячних планів ще немає — порахуйте норму й застосуйте її.'));

  box.append(calcCard, monthCard);

  if (state.meta.kpi_plans && state.meta.kpi_plans.scope !== 'own') {
    const teamCard = el('div', { class: 'card' }, el('h3', {}, 'Команда сьогодні'));
    try {
      const team = await api.get('/kpi/team');
      teamCard.append(team.rows.length
        ? el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Людина'), el('th', {}, 'Норми (факт/план)'),
            el('th', { class: 'num' }, 'Брак'), el('th', {}, 'Останній тач'), el('th', { class: 'num' }, 'Ліди без руху'))),
          el('tbody', {}, ...team.rows.map((r) => el('tr', {},
            el('td', {}, r.name),
            el('td', {}, r.metrics.map((m) => `${m.metric}: ${m.fact}/${m.target}`).join(' · ') || '—'),
            el('td', { class: 'num' }, `${r.brak_rate}%`),
            el('td', {}, r.last_touch ? String(r.last_touch).slice(11, 16) : '—'),
            el('td', { class: 'num' }, num(r.stale_leads)))))))
        : el('div', { class: 'muted' }, 'У команді ще немає менеджерів із пошуку.'));
    } catch (e) {
      teamCard.append(el('div', { class: 'muted' }, e.message));
    }
    box.append(teamCard);
  }

  await recalc();
  return box;
}
