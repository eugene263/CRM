// Робочий екран менеджера: черга на сьогодні, картка ліда з таймлайном,
// логування тачів, швидке додавання й воронка по джерелах.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, modal, toast, num, pct } from '../ui.js';

let dicts = null;
const dictOf = (kind) => (dicts?.dictionaries || []).filter((d) => d.kind === kind);
const statusName = (code) => (dicts?.statuses || []).find((s) => s.code === code)?.name || code;

async function loadDicts() {
  if (!dicts) dicts = await api.get('/prospecting/dictionaries');
  return dicts;
}

// ── Картка ліда ───────────────────────────────────────────────────────────
export async function openLead(leadId, onChange = () => {}) {
  await loadDicts();
  const card = await api.get(`/prospecting/leads/${leadId}`);
  const { lead, socials, sources, contacts, touches, notes, tasks } = card;

  const header = el('div', {},
    el('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
      el('b', { style: 'font-size:16px' }, lead.company_name),
      el('span', { class: 'badge' }, statusName(lead.status_code)),
      el('span', { class: 'badge' }, { hot: '🔥 Гарячий', warm: 'Теплий', cold: 'Холодний' }[lead.priority] || lead.priority),
      lead.score ? el('span', { class: 'muted' }, `скоринг ${lead.score}`) : null),
    el('div', { class: 'muted', style: 'margin-top:4px;font-size:12.5px' },
      [lead.geo_city, lead.geo_country, lead.vertical].filter(Boolean).join(' · ') || '—',
      lead.website ? ' · ' : '', lead.website ? el('a', { href: lead.website, target: '_blank', rel: 'noreferrer' }, 'сайт') : null));

  const socialBlock = el('div', { class: 'card', style: 'margin-top:12px' },
    el('h3', {}, 'Присутність'),
    socials.length ? el('div', {}, ...socials.map((s) => el('div', { class: 'alert-item' },
      el('span', {}, `${s.platform}: ${s.handle ? '@' + s.handle : '—'} · ${num(s.followers)} підписників`),
      el('span', { class: s.days_without_content > 60 ? '' : 'muted' },
        s.days_without_content == null ? 'дата останнього посту невідома' : `${s.days_without_content} дн. без контенту`))))
      : el('div', { class: 'muted' }, 'Соцмережі не заповнені'));

  const sourceBlock = el('div', { class: 'card' }, el('h3', {}, 'Де знайшли'),
    ...sources.map((s) => el('div', { class: 'alert-item' },
      el('span', {}, `${dictOf('source_channel').find((d) => d.code === s.channel)?.label || s.channel}${s.query ? ` · «${s.query}»` : ''}`),
      el('span', { class: 'muted' }, String(s.found_at).slice(0, 16)))),
    sources.length ? null : el('div', { class: 'muted' }, 'Джерело не вказане'));

  const timeline = el('div', { class: 'card' }, el('h3', {}, `Таймлайн · ${touches.length} тачів`),
    touches.length ? el('div', {}, ...touches.map((t) => el('div', { class: 'alert-item', style: 'align-items:flex-start' },
      el('div', {},
        el('div', {}, `${t.direction === 'in' ? '⬅️ Відповідь' : `➡️ Тач #${t.touch_number}`} · ${t.channel}${t.from_account ? ` · з ${t.from_account}` : ''}`),
        t.message_text ? el('div', { class: 'muted', style: 'font-size:12px;max-width:380px' }, t.message_text.slice(0, 160)) : null),
      el('span', { class: 'muted' }, String(t.sent_at).slice(0, 16)))))
      : el('div', { class: 'muted' }, 'Ще не писали'));

  const notesBlock = el('div', { class: 'card' }, el('h3', {}, 'Нотатки'),
    ...notes.map((n) => el('div', { class: 'alert-item' }, el('span', {}, n.text), el('span', { class: 'muted' }, String(n.created_at).slice(5, 16)))),
    (() => {
      const input = el('input', { placeholder: 'додати нотатку й Enter' });
      input.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !input.value.trim()) return;
        await api.post(`/prospecting/leads/${leadId}/note`, { text: input.value.trim() });
        toast('Додано'); box.remove(); openLead(leadId, onChange);
      });
      return el('div', { style: 'margin-top:8px' }, input);
    })());

  const actions = el('div', { class: 'row', style: 'margin-top:12px' },
    el('button', { class: 'btn primary', style: 'flex:0 0 auto', onclick: () => { box.remove(); touchForm(lead, contacts, onChange); } }, '✉️ Записати тач'),
    el('button', { class: 'btn', style: 'flex:0 0 auto', onclick: () => { box.remove(); statusForm(lead, onChange); } }, '🚦 Змінити статус'),
    tasks.filter((t) => t.status === 'open').length
      ? el('span', { class: 'muted' }, `відкритих задач: ${tasks.filter((t) => t.status === 'open').length}`) : null);

  const box = modal(`Лід #${lead.id}`, el('div', {}, header, actions, socialBlock, sourceBlock,
    el('div', { class: 'card' }, el('h3', {}, 'Контакти'),
      contacts.length ? el('div', {}, ...contacts.map((c) => el('div', { class: 'alert-item' },
        el('span', {}, `${c.kind}: ${c.value}`), el('span', { class: 'muted' }, c.person_name || '')))) : el('div', { class: 'muted' }, 'Контактів немає')),
    timeline, notesBlock));
  return box;
}

// ── Форма тача ────────────────────────────────────────────────────────────
function touchForm(lead, contacts, onChange) {
  const channel = el('select', {}, ...dictOf('touch_channel').map((d) => el('option', { value: d.code }, d.label)));
  const direction = el('select', {}, el('option', { value: 'out' }, 'Вихідний'), el('option', { value: 'in' }, 'Вхідний (відповідь)'));
  const from = el('input', { placeholder: 'з якого нашого акаунта/скриньки' });
  const contact = el('select', {}, el('option', { value: '' }, '—'),
    ...contacts.map((c) => el('option', { value: c.id }, `${c.kind}: ${c.value}`)));
  const template = el('select', {}, el('option', { value: '' }, 'без шаблону'),
    ...(dicts.templates || []).map((t) => el('option', { value: t.id }, t.name)));
  const text = el('textarea', { rows: 5, placeholder: 'текст повідомлення — без нього тач не зараховується' });
  const delivery = el('select', {}, ...[['sent', 'Надіслано'], ['delivered', 'Доставлено'], ['read', 'Прочитано'], ['failed', 'Не доставлено'], ['blocked', 'Заблокували']]
    .map(([v, l]) => el('option', { value: v }, l)));

  template.addEventListener('change', () => {
    const t = (dicts.templates || []).find((x) => String(x.id) === template.value);
    if (!t) return;
    const social = null;
    text.value = t.body
      .replace(/\{\{company\}\}/g, lead.company_name)
      .replace(/\{\{city\}\}/g, lead.geo_city || '')
      .replace(/\{\{vertical\}\}/g, lead.vertical || '');
  });

  const form = el('div', {},
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Канал'), channel),
      el('div', {}, el('label', {}, 'Напрямок'), direction)),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'З якого акаунта'), from),
      el('div', {}, el('label', {}, 'Кому'), contact)),
    el('div', { class: 'field' }, el('label', {}, 'Шаблон'), template),
    el('div', { class: 'field' }, el('label', {}, 'Текст'), text),
    el('div', { class: 'field' }, el('label', {}, 'Статус доставки'), delivery));

  const send = async (force = false) => {
    try {
      const res = await api.post(`/prospecting/leads/${lead.id}/touch${force ? '?force=1' : ''}`, {
        channel: channel.value, direction: direction.value, from_account: from.value || null,
        contact_id: contact.value ? Number(contact.value) : null,
        template_id: template.value ? Number(template.value) : null,
        message_text: text.value, delivery_status: delivery.value,
      });
      box.remove();
      toast(`Записано тач #${res.touch_number}. Наступний контакт: ${String(res.next_contact_at || '').slice(0, 10)}`);
      onChange();
    } catch (e) {
      if (e.data?.needForce && confirm(`${e.message}`)) return send(true);
      toast(e.message, true);
    }
  };

  const box = modal(`Тач · ${lead.company_name}`, form, [el('button', { class: 'btn primary', onclick: () => send(false) }, 'Записати')]);
}

function statusForm(lead, onChange) {
  const status = el('select', {}, ...(dicts.statuses || []).map((s) => el('option', { value: s.code, selected: s.code === lead.status_code }, s.name)));
  const reason = el('select', {}, el('option', { value: '' }, '—'));
  const next = el('input', { type: 'datetime-local' });

  const syncReasons = () => {
    const kind = status.value === 'disqualified' ? 'disqualify_reason' : status.value === 'lost' ? 'lost_reason' : null;
    reason.textContent = '';
    reason.append(el('option', { value: '' }, kind ? 'оберіть причину' : '—'));
    if (kind) for (const d of dictOf(kind)) reason.append(el('option', { value: d.code }, d.label));
    reason.disabled = !kind;
  };
  status.addEventListener('change', syncReasons);
  syncReasons();

  const form = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Статус'), status),
    el('div', { class: 'field' }, el('label', {}, 'Причина (для «не підходить» і «відмова»)'), reason),
    el('div', { class: 'field' }, el('label', {}, 'Наступний контакт'), next));

  const box = modal(`Статус · ${lead.company_name}`, form, [el('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        await api.post(`/prospecting/leads/${lead.id}/status`, {
          status_code: status.value,
          disqualify_reason: status.value === 'disqualified' ? reason.value : null,
          lost_reason: status.value === 'lost' ? reason.value : null,
          next_contact_at: next.value ? next.value.replace('T', ' ') : null,
          snooze_until: status.value === 'snoozed' && next.value ? next.value.replace('T', ' ') : null,
        });
        box.remove(); toast('Статус оновлено'); onChange();
      } catch (e) { toast(e.message, true); }
    },
  }, 'Зберегти')]);
}

// ── Додавання лідів ───────────────────────────────────────────────────────
function addForm(onChange) {
  const name = el('input', { placeholder: 'Назва бізнесу' });
  const site = el('input', { placeholder: 'сайт або посилання на профіль' });
  const city = el('input', { placeholder: 'місто' });
  const ig = el('input', { placeholder: 'instagram нік' });
  const followers = el('input', { type: 'number', placeholder: 'підписники' });
  const lastPost = el('input', { type: 'date' });
  const list = el('select', {}, el('option', { value: '' }, 'без списку'),
    ...(state.refs.prospect_lists || []).map((l) => el('option', { value: l.id }, l.label)));
  const channel = el('select', {}, ...dictOf('source_channel').map((d) => el('option', { value: d.code }, d.label)));
  const queryInput = el('input', { placeholder: 'запит або хештег: кавʼярні Львів' });
  const signals = ['ллє рекламу', 'наймає SMM', 'мертвий акаунт'].map((label) => {
    const cb = el('input', { type: 'checkbox', style: 'width:auto' });
    return { label, cb, node: el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:12.5px' }, cb, label) };
  });

  const form = el('div', {},
    el('div', { class: 'row' }, el('div', {}, el('label', {}, 'Бізнес *'), name), el('div', {}, el('label', {}, 'Місто'), city)),
    el('div', { class: 'field' }, el('label', {}, 'Сайт / посилання'), site),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Instagram'), ig),
      el('div', {}, el('label', {}, 'Підписники'), followers),
      el('div', {}, el('label', {}, 'Останній пост'), lastPost)),
    el('div', { class: 'field' }, el('label', {}, 'Список'), list),
    el('div', { class: 'card', style: 'margin-top:8px' }, el('h3', {}, 'Де знайшли *'),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Канал'), channel),
        el('div', {}, el('label', {}, 'Запит / хештег'), queryInput)),
      el('div', { style: 'display:flex;gap:14px;margin-top:8px;flex-wrap:wrap' }, ...signals.map((s) => s.node))));

  const submit = async (force = false) => {
    try {
      await api.post(`/prospecting/leads${force ? '?force=1' : ''}`, {
        company_name: name.value.trim(),
        website: site.value.trim() || null,
        geo_city: city.value.trim() || null,
        list_id: list.value ? Number(list.value) : null,
        socials: ig.value.trim() ? [{
          platform: 'instagram', handle: ig.value.trim().replace('@', ''),
          followers: followers.value ? Number(followers.value) : null,
          last_post_at: lastPost.value || null,
        }] : [],
        source: {
          channel: channel.value, query: queryInput.value.trim() || null,
          url: site.value.trim() || null, method: 'manual',
          signals: signals.filter((s) => s.cb.checked).map((s) => s.label),
        },
      });
      box.remove(); toast('Лід доданий'); onChange();
    } catch (e) {
      if (e.status === 409 && e.data?.duplicate && confirm(`${e.message}\n\nВсе одно додати?`)) return submit(true);
      toast(e.message, true);
    }
  };

  const box = modal('Новий лід', form, [el('button', { class: 'btn primary', onclick: () => submit(false) }, 'Додати')]);
}

function bulkForm(onChange) {
  const text = el('textarea', { rows: 10, placeholder: 'по одному посиланню або @ніку в рядок' });
  const list = el('select', {}, el('option', { value: '' }, 'без списку'),
    ...(state.refs.prospect_lists || []).map((l) => el('option', { value: l.id }, l.label)));
  const channel = el('select', {}, ...dictOf('source_channel').map((d) => el('option', { value: d.code }, d.label)));
  const queryInput = el('input', { placeholder: 'запит або хештег для всієї пачки' });

  const form = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Посилання'), text),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Список'), list),
      el('div', {}, el('label', {}, 'Канал джерела'), channel),
      el('div', {}, el('label', {}, 'Запит'), queryInput)));

  const box = modal('Масова вставка', form, [el('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        const res = await api.post('/prospecting/bulk', {
          text: text.value, list_id: list.value ? Number(list.value) : null,
          source: { channel: channel.value, query: queryInput.value.trim() || null },
        });
        box.remove();
        toast(`Додано ${res.created}, пропущено ${res.skipped.length}`);
        if (res.skipped.length) {
          modal('Пропущені', el('div', {}, ...res.skipped.map((s) => el('div', { class: 'alert-item' },
            el('span', {}, s.line), el('span', { class: 'muted' }, s.reason)))));
        }
        onChange();
      } catch (e) { toast(e.message, true); }
    },
  }, 'Додати пачкою')]);
}

// ── Сторінка ──────────────────────────────────────────────────────────────
export async function renderProspecting() {
  await loadDicts();
  const box = el('div', {});
  let tab = 'queue';
  const tabs = el('div', { class: 'tabs' });
  const body = el('div', {});

  const leadRow = (lead, extra) => el('tr', {},
    el('td', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); openLead(lead.id, render); } }, lead.company_name)),
    el('td', {}, statusName(lead.status_code)),
    el('td', {}, { hot: '🔥', warm: '·', cold: '❄️' }[lead.priority] || ''),
    el('td', { class: 'num' }, num(lead.touches_count)),
    el('td', {}, String(lead.next_contact_at || '—').slice(0, 16)),
    el('td', { class: 'muted' }, extra || lead.geo_city || ''));

  async function renderQueue() {
    const q = await api.get('/prospecting/queue');
    const table = (rows, empty, extra) => rows.length
      ? el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Бізнес'), el('th', {}, 'Статус'), el('th', {}, ''),
          el('th', { class: 'num' }, 'Тачів'), el('th', {}, 'Контакт'), el('th', {}, ''))),
        el('tbody', {}, ...rows.map((r) => leadRow(r, extra?.(r))))))
      : el('div', { class: 'muted' }, empty);

    body.textContent = '';
    body.append(
      el('div', { class: 'tiles' },
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Прострочені фолоу-апи'),
          el('div', { class: `value ${q.overdue.length ? 'neg' : 'pos'}` }, num(q.overdue.length))),
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Нові відповіді'),
          el('div', { class: 'value pos' }, num(q.replies.length))),
        el('div', { class: 'tile' }, el('div', { class: 'label' }, 'Ще не писали'),
          el('div', { class: 'value' }, num(q.fresh.length)))),
      el('div', { class: 'card' }, el('h3', {}, '💬 Відповіли — реагувати першими'), table(q.replies, 'Немає нових відповідей', (r) => r.channel)),
      el('div', { class: 'card' }, el('h3', {}, '⏰ Час писати'), table(q.overdue, 'Черга порожня')),
      el('div', { class: 'card' }, el('h3', {}, '🆕 Ще не торкались'), table(q.fresh, 'Усі ліди вже в роботі')));
  }

  async function renderFunnel() {
    const f = await api.get('/prospecting/funnel');
    const rate = (a, b) => (b > 0 ? pct((a / b) * 100) : '—');
    body.textContent = '';
    body.append(
      el('div', { class: 'card' }, el('h3', {}, 'Конверсія по джерелах — заради цього й збирається «де знайшли»'),
        f.bySource.length ? el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Канал'), el('th', { class: 'num' }, 'Лідів'),
            el('th', { class: 'num' }, 'Кваліфіковано'), el('th', { class: 'num' }, 'Написали'),
            el('th', { class: 'num' }, 'Відповіли'), el('th', { class: 'num' }, 'Зустрічі'),
            el('th', { class: 'num' }, 'Клієнти'), el('th', { class: 'num' }, 'Відповідь/тач'))),
          el('tbody', {}, ...f.bySource.map((r) => el('tr', {},
            el('td', {}, dictOf('source_channel').find((d) => d.code === r.channel)?.label || r.channel),
            el('td', { class: 'num' }, num(r.leads)), el('td', { class: 'num' }, num(r.qualified)),
            el('td', { class: 'num' }, num(r.contacted)), el('td', { class: 'num' }, num(r.replied)),
            el('td', { class: 'num' }, num(r.meetings)), el('td', { class: 'num' }, num(r.won)),
            el('td', { class: 'num' }, rate(r.replied, r.contacted)))))))
          : el('div', { class: 'muted' }, 'Ще немає даних')),
      el('div', { class: 'card' }, el('h3', {}, 'Відповіді по номеру тача'),
        f.byTouchNumber.length ? el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, '№ тача'), el('th', { class: 'num' }, 'Зроблено'),
            el('th', { class: 'num' }, 'Дали відповідь'), el('th', { class: 'num' }, '%'))),
          el('tbody', {}, ...f.byTouchNumber.map((r) => el('tr', {},
            el('td', {}, `${r.touch_number}-й`), el('td', { class: 'num' }, num(r.touches)),
            el('td', { class: 'num' }, num(r.led_to_reply)), el('td', { class: 'num' }, rate(r.led_to_reply, r.touches)))))))
          : el('div', { class: 'muted' }, 'Ще немає тачів'),
        el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' },
          'Якщо 2-й і 3-й тачі дають помітну частку відповідей — команда здається зарано.')),
      el('div', { class: 'card' }, el('h3', {}, 'Канали звʼязку'),
        el('div', { class: 'table-wrap' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Канал'), el('th', { class: 'num' }, 'Тачів'), el('th', { class: 'num' }, 'Відповідей'), el('th', { class: 'num' }, '%'))),
          el('tbody', {}, ...f.byChannel.map((r) => el('tr', {},
            el('td', {}, r.channel), el('td', { class: 'num' }, num(r.touches)),
            el('td', { class: 'num' }, num(r.replies)), el('td', { class: 'num' }, rate(r.replies, r.touches)))))))),
      f.disqualified.length ? el('div', { class: 'card' }, el('h3', {}, 'Причини дискваліфікації'),
        el('div', {}, ...f.disqualified.map((d) => el('div', { class: 'alert-item' },
          el('span', {}, dictOf('disqualify_reason').find((x) => x.code === d.reason)?.label || d.reason),
          el('span', { class: 'muted' }, num(d.count)))))) : null,
      el('div', { class: 'muted', style: 'font-size:12px' },
        f.speed?.days_to_first_touch != null
          ? `Середній час до першого тача: ${Number(f.speed.days_to_first_touch).toFixed(1)} дн.`
          : 'Перших тачів ще не було.'));
  }

  async function renderDuplicates() {
    const d = await api.get('/prospecting/duplicates');
    const rows = d.rows.map((r) => el('tr', {},
      el('td', {}, r.a_name),
      el('td', {}, r.b_name),
      el('td', {}, `${r.match_score}% · ${r.match_reason}`),
      el('td', {},
        el('button', {
          class: 'btn small primary',
          onclick: async () => {
            await api.post(`/prospecting/duplicates/${r.id}/resolve`, { action: 'merge' });
            toast('Обʼєднано — історія тачів збережена');
            render();
          },
        }, 'Обʼєднати'),
        el('button', {
          class: 'btn small', style: 'margin-left:6px',
          onclick: async () => {
            await api.post(`/prospecting/duplicates/${r.id}/resolve`, { action: 'dismiss' });
            toast('Позначено як різні');
            render();
          },
        }, 'Не дубль'))));

    const table = el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Лід А'), el('th', {}, 'Лід Б'), el('th', {}, 'Схожість'), el('th', {}, ''))),
      el('tbody', {}, ...rows)));

    body.textContent = '';
    body.append(el('div', { class: 'card' }, el('h3', {}, 'Можливі дублі'),
      rows.length ? table : el('div', { class: 'muted' }, 'Дублів не знайдено')));
  }

  async function render() {
    tabs.textContent = '';
    for (const [key, label] of [['queue', 'Мій день'], ['funnel', 'Воронка'], ['duplicates', 'Дублі']]) {
      tabs.append(el('button', { class: `btn small${tab === key ? ' active' : ''}`, onclick: () => { tab = key; render(); } }, label));
    }
    tabs.append(
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn small', onclick: () => bulkForm(render) }, '📋 Пачкою'),
      el('button', { class: 'btn small primary', onclick: () => addForm(render) }, '+ Лід'));
    if (tab === 'queue') await renderQueue();
    else if (tab === 'funnel') await renderFunnel();
    else await renderDuplicates();
  }

  box.append(tabs, body);
  await render();
  return box;
}
