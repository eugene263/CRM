// Виплати команді: рік → місяць → людина → її PDF-звіти. Зверху міні-дашборд
// із сумами за місяць і за три місяці, щоб не рахувати в голові, скільки
// пішло на команду.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, money, num, pct, badge, toast, modal, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';

const YEAR_KEY = 'crm_payout_year';
const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
  'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const periodLabel = (period) => {
  const [y, m] = String(period).split('-');
  return `${MONTHS[Number(m) - 1] || m} ${y}`;
};
const MAX_MB = 8;

const fileSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);

// FileReader віддає data-URL; серверу потрібен лише base64 після коми.
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не вдалося прочитати файл'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

export async function renderPayouts() {
  const ent = state.meta.payouts;
  const canEdit = !!ent.can.update;
  const canUpload = !!ent.can.create;
  const canDelete = !!ent.can.delete;

  const box = el('div', {});
  let pickedYear = Number(localStorage.getItem(YEAR_KEY)) || null;
  let pickedPeriod = null;      // null — показуємо місяці року, інакше картку місяця

  async function render() {
    const { years, summary } = await api.get('/payouts/overview');
    if (!years.some((y) => y.year === pickedYear)) pickedYear = years[0]?.year ?? new Date().getFullYear();
    localStorage.setItem(YEAR_KEY, String(pickedYear));

    box.textContent = '';
    box.append(tiles(summary), yearTabs(years));
    box.append(pickedPeriod ? await monthCard(pickedPeriod) : monthsGrid(years));
  }

  // ── Міні-дашборд ──────────────────────────────────────────────────────
  function tiles(s) {
    const tile = (label, value, hint, cls) => el('div', { class: 'tile' },
      el('div', { class: 'label' }, label),
      el('div', { class: `value ${cls || ''}` }, value),
      hint ? el('div', { class: 'hint' }, hint) : null);

    const change = s.month_change_percent;
    return el('div', { class: 'tiles' },
      tile('Поточний місяць', money(s.month_total), `${s.period} · людей: ${num(s.people)}`),
      tile('Попередній місяць', money(s.prev_month_total),
        change === null ? s.prev_period : `${s.period} до ${s.prev_period}: ${change >= 0 ? '+' : ''}${pct(change)}`,
        change === null ? '' : (change > 0 ? 'neg' : 'pos')),
      tile('За 3 місяці', money(s.quarter_total), `з ${s.quarter_from} · у середньому ${money(s.avg_month)}/міс`),
      tile('Ще не виплачено', money(s.unpaid_total), `нарахувань: ${num(s.unpaid_count)}`,
        s.unpaid_total > 0 ? 'neg' : 'pos'),
      tile('Звіти за місяць', `${num(s.reported_people)} / ${num(s.team_size)}`,
        s.team_size > s.reported_people ? `без звіту: ${s.team_size - s.reported_people}` : 'усі здали'));
  }

  // Роки — такі самі кнопки-вкладки, як послуги у ставках собівартості.
  function yearTabs(years) {
    const list = years.length ? years : [{ year: new Date().getFullYear(), total: 0, months: [] }];
    return el('div', { class: 'row tight', style: 'gap:8px;margin-bottom:16px;align-items:center' },
      ...list.map((y) => el('button', {
        class: `btn${y.year === pickedYear ? ' primary' : ''}`,
        onclick: () => { pickedYear = y.year; pickedPeriod = null; render(); },
      }, `${y.year}`, el('span', { class: 'muted', style: 'margin-left:6px;font-size:12px' }, money(y.total)))));
  }

  // ── Місяці обраного року ──────────────────────────────────────────────
  function monthsGrid(years) {
    const months = years.find((y) => y.year === pickedYear)?.months || [];
    if (!months.length) {
      return el('div', { class: 'card muted' },
        `За ${pickedYear} рік виплат і звітів ще немає. Нарахування зʼявляються після розрахунку ЗП у «Фінансах», а звіти можна вкласти в будь-який місяць.`);
    }
    return el('div', { class: 'list-cards' }, ...months.map((m) => {
      const card = el('div', { class: 'list-card' },
        el('div', { class: 'list-card-head' },
          el('b', {}, m.month_name),
          m.total > 0 && m.paid >= m.total ? badge('paid', 'виплачено') : null),
        el('div', { style: 'font-size:20px;font-weight:600' }, money(m.total)),
        el('div', { class: 'list-card-foot' },
          el('span', { class: 'muted', style: 'font-size:12px' }, `людей: ${num(m.people)}`),
          el('span', { class: 'muted', style: 'font-size:12px' },
            m.reports ? `звітів: ${num(m.reports)}` : 'без звітів')));
      card.addEventListener('click', () => { pickedPeriod = m.period; render(); });
      return card;
    }));
  }

  // ── Картка місяця: люди, їхні суми та звіти ───────────────────────────
  async function monthCard(period) {
    const { rows } = await api.get(`/payouts/period/${period}`);
    const total = rows.reduce((sum, r) => sum + Number(r.payout?.total || 0), 0);

    const table = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Співробітник'), el('th', {}, 'Фікс'), el('th', {}, '%'),
        el('th', {}, 'Бонус'), el('th', {}, 'Разом'), el('th', {}, 'Статус'), el('th', {}, 'Звіти'))),
      el('tbody', {}, ...rows.map((r) => el('tr', {},
        el('td', {}, el('b', {}, r.user_name)),
        el('td', {}, money(r.payout?.fix_amount)),
        el('td', {}, money(r.payout?.percent_amount)),
        el('td', {}, money(r.payout?.bonus_amount)),
        el('td', {}, el('b', {}, money(r.payout?.total))),
        el('td', {}, r.payout ? badge(r.payout.status, {
          accrued: 'Нараховано', paid: 'Виплачено', canceled: 'Скасовано',
        }[r.payout.status] || r.payout.status) : el('span', { class: 'muted' }, '—')),
        el('td', {}, reportsCell(r, period))))));

    return el('div', { class: 'card' },
      el('div', { class: 'row', style: 'align-items:center;margin-bottom:12px' },
        el('button', {
          class: 'btn small', style: 'flex:0 0 auto',   // .row інакше розтягує кнопку на всю ширину
          onclick: () => { pickedPeriod = null; render(); },
        }, withIcon('chevronLeft', 'Місяці')),
        el('h3', { style: 'margin:0 0 0 8px;flex:1 1 auto' }, periodLabel(period)),
        el('div', { class: 'muted', style: 'margin-left:auto;flex:0 0 auto' }, `разом: ${money(total)}`)),
      el('div', { class: 'table-wrap' }, table));
  }

  function reportsCell(row, period) {
    const cell = el('div', { class: 'row tight', style: 'gap:6px;flex-wrap:wrap;align-items:center' },
      ...row.reports.map((rep) => reportChip(rep)));

    if (canUpload) {
      const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none' });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        if (file.size > MAX_MB * 1048576) return toast(`Файл завеликий: максимум ${MAX_MB} МБ`, true);
        await uploadReport(file, row.user_id, period);
      });
      cell.append(input, el('button', {
        class: 'btn small icon-only', title: 'Вкласти PDF-звіт',
        onclick: () => input.click(),
      }, icon('upload', 14)));
    }
    if (!row.reports.length && !canUpload) cell.append(el('span', { class: 'muted' }, '—'));
    return cell;
  }

  function reportChip(rep) {
    const mark = rep.applied_at ? 'ok' : { ok: 'warn', error: 'err', none: '' }[rep.ai_status] || '';
    const chip = el('span', { class: `report-chip ${mark}`, title: rep.ai_error || rep.ai_summary || rep.file_name },
      icon('fileText', 13),
      el('a', {
        href: `/api/payouts/reports/${rep.id}/file`, target: '_blank', rel: 'noreferrer',
        onclick: (e) => e.stopPropagation(),
      }, rep.file_name),
      rep.ai_amount != null ? el('b', {}, money(rep.ai_amount)) : null,
      el('button', {
        class: 'btn small icon-only', title: 'Що в цьому звіті',
        onclick: () => reportModal(rep),
      }, icon('eye', 13)));
    return chip;
  }

  async function uploadReport(file, userId, period) {
    try {
      toast(`Завантажую ${file.name}…`);
      const content = await readAsBase64(file);
      const { row } = await api.post('/payouts/reports', {
        user_id: userId, period, file_name: file.name, mime: file.type || 'application/pdf', content,
      });
      // Одразу пробуємо вичитати суму — це те, заради чого звіт і вкладають.
      if (canEdit) {
        try {
          const analyzed = await api.post(`/payouts/reports/${row.id}/analyze`, {});
          await render();
          return reportModal(analyzed.row);
        } catch (e) {
          toast(`Файл збережено, але ШІ не прочитав його: ${e.message}`, true);
        }
      } else {
        toast('Звіт вкладено');
      }
      await render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // Що ШІ вичитав зі звіту — і кнопка підставити суму у виплату.
  function reportModal(rep) {
    const line = (label, value) => el('div', { class: 'row', style: 'gap:8px;margin-bottom:4px' },
      el('span', { class: 'muted', style: 'flex:0 0 140px' }, label), el('span', { style: 'flex:1 1 auto' }, value));

    const content = el('div', {},
      line('Файл', el('a', { href: `/api/payouts/reports/${rep.id}/file`, target: '_blank', rel: 'noreferrer' }, rep.file_name)),
      line('Розмір', fileSize(Number(rep.size_bytes || 0))),
      line('Місяць', periodLabel(rep.period)),
      rep.ai_status === 'error'
        ? el('div', { class: 'error', style: 'margin-top:10px' }, rep.ai_error || 'ШІ не зміг прочитати звіт')
        : el('div', { style: 'margin-top:10px' },
          line('Сума зі звіту', rep.ai_amount != null ? `${money(rep.ai_amount)}${rep.ai_currency ? ` ${rep.ai_currency}` : ''}` : '— (у звіті не знайдено)'),
          rep.ai_period && rep.ai_period !== rep.period
            ? el('div', { class: 'muted', style: 'font-size:12.5px;margin-bottom:6px' },
              `У документі вказано інший період: ${rep.ai_period}`) : null,
          rep.ai_summary ? el('div', { class: 'muted', style: 'font-size:12.5px' }, rep.ai_summary) : null),
      rep.applied_at ? el('div', { class: 'muted', style: 'margin-top:10px;font-size:12px' },
        `Суму вже підставлено у виплату ${String(rep.applied_at).slice(0, 16)}`) : null,
      el('div', { class: 'muted', style: 'margin-top:10px;font-size:11.5px' },
        'ШІ читає PDF і пропонує суму — у виплату вона потрапляє лише після вашого підтвердження.'));

    // Суму можна виправити перед підстановкою: ШІ міг взяти не ту цифру,
    // а лишати виплату порожньою через це — гірше.
    const amountInput = el('input', { type: 'number', step: '0.01', style: 'max-width:160px',
      value: rep.ai_amount != null ? rep.ai_amount : '' });
    const actions = [];
    if (canEdit) {
      content.append(el('div', { class: 'field', style: 'margin-top:12px' },
        el('label', {}, 'Сума у виплату, $'), amountInput));
      actions.push(actionButton(rep.applied_at ? 'Підставити ще раз' : 'Підставити у виплату', async () => {
        if (amountInput.value === '') return toast('Вкажіть суму', true);
        try {
          await api.post(`/payouts/reports/${rep.id}/apply`, { amount: amountInput.value });
          modalBox.remove();
          toast(`Фікс за ${periodLabel(rep.period)} оновлено: ${money(amountInput.value)}`);
          await render();
        } catch (e) { toast(e.message, true); }
      }));
    }
    if (canEdit) {
      actions.push(actionButton('Прочитати ще раз', async () => {
        try {
          const { row } = await api.post(`/payouts/reports/${rep.id}/analyze`, {});
          modalBox.remove();
          await render();
          reportModal(row);
        } catch (e) { toast(e.message, true); }
      }, { className: 'btn' }));
    }
    if (canDelete) {
      actions.push(actionButton('Видалити звіт', async () => {
        if (!confirm(`Видалити звіт «${rep.file_name}»?`)) return;
        try {
          await api.del(`/payouts/reports/${rep.id}`);
          modalBox.remove();
          toast('Звіт видалено');
          await render();
        } catch (e) { toast(e.message, true); }
      }, { className: 'btn danger' }));
    }

    const modalBox = modal(`Звіт · ${rep.file_name}`, content, actions);
    return modalBox;
  }

  await render();
  return box;
}
