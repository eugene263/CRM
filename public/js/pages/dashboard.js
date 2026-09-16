import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, num, pct, lineChart, barList, badge, chartColor } from '../ui.js';
import { icon, withIcon } from '../icons.js';

export async function renderDashboard() {
  const { from, to } = state.range;
  const data = await api.get(`/dashboard?from=${from}&to=${to}`);
  const s = data.summary;
  const box = el('div', {});

  const tile = (label, value, hint, cls) => el('div', { class: 'tile' },
    el('div', { class: 'label' }, label),
    el('div', { class: `value ${cls || ''}` }, value),
    hint ? el('div', { class: 'hint' }, hint) : null);

  // Тайли з грошима зʼявляються лише коли сервер реально віддав цифри для цієї ролі.
  box.append(el('div', { class: 'tiles' },
    s.revenue !== null ? tile('Дохід (апрув)', money(s.revenue), `у холді ${money(s.hold_amount)}`) : null,
    s.expenses !== null ? tile('Витрати', money(s.expenses)) : null,
    s.profit !== null ? tile('Профіт', money(s.profit), `ROI ${pct(s.roi)}`, s.profit >= 0 ? 'pos' : 'neg') : null,
    tile('Депи', num(s.deps), `реги ${num(s.regs)}`),
    tile('Публікації', num(s.posts), `перегляди ${num(s.views)}`),
    tile('CTR', pct(s.ctr), `клік→рега ${pct(s.cr_click_reg)} · рега→деп ${pct(s.cr_reg_dep)}`),
    tile('Акаунти в роботі', `${num(s.accounts.active)} / ${num(s.accounts.total)}`,
      `фарм ${s.accounts.farm} · бан ${s.accounts.banned} · тінь ${s.accounts.shadowban}`)));

  // Гроші й активність — окремі графіки: на спільній шкалі публікації
  // перетворюються на пряму лінію біля нуля.
  if (s.revenue !== null || s.expenses !== null) {
    box.append(el('div', { class: 'card' }, el('h3', {}, 'Дохід і витрати'),
      lineChart(data.timeline, [
        { key: 'revenue', label: 'Дохід, $', color: chartColor(1) },
        { key: 'expenses', label: 'Витрати, $', color: chartColor(2) },
      ])));
  }
  box.append(el('div', { class: 'card' }, el('h3', {}, 'Заливи, депи, бани'),
    lineChart(data.timeline, [
      { key: 'posts', label: 'Публікації', color: chartColor(3) },
      { key: 'deps', label: 'Депи', color: chartColor(1) },
      { key: 'bans', label: 'Бани', color: chartColor(2) },
    ])));

  const cols = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px' });
  cols.append(el('div', { class: 'card' }, el('h3', {}, 'Топ креативів'),
    data.topCreatives.length
      ? barList(data.topCreatives, data.topCreatives[0].revenue === null ? { valueKey: 'deps', format: (v) => `${v} деп.` } : {})
      : el('div', { class: 'muted' }, 'Немає даних')));
  if (data.topUsers.length) {
    cols.append(el('div', { class: 'card' }, el('h3', {}, 'Топ крієйторів'), barList(data.topUsers)));
  }
  box.append(cols);

  const a = data.alerts;
  const alerts = el('div', { class: 'card' }, el('h3', {}, icon('alert'), 'Що горить'));
  const items = [
    ...a.bans24.map((b) => ['ban', `Бан: ${b.platform} @${b.nickname} (${String(b.created_at).slice(5, 16)})`]),
    ...a.proxyExpiring.map((p) => ['clock', `Проксі #${p.id} ${p.provider || ''} ${p.geo || ''} — оплачено до ${p.paid_until}`]),
    ...a.planToday.map((p) => ['gauge', `${p.name}: план ${p.target}, факт ${p.fact}`]),
  ];
  if (!items.length) alerts.append(el('div', { class: 'muted' }, 'Чисто: банів за добу немає, проксі оплачені, плани виконуються.'));
  for (const [name, text] of items) alerts.append(el('div', { class: 'alert-item' }, withIcon(name, text)));
  box.append(alerts);

  box.append(el('div', { class: 'muted', style: 'font-size:12px' },
    `Період: ${s.from} — ${s.to}. Дохід — конверсії зі статусом «апрув»/«виплачено»; холд у профіт не входить.`));
  return box;
}
