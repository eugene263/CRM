// Ферми: блок пристроїв (типово ~20 телефонів) одного клієнта в одному
// гео. Сторінка — плашки ферм зверху (клік фільтрує таблицю на конкретну
// ферму) і плаский фільтрований список акаунтів знизу: клієнт → ферма →
// гео → телефон → платформа → акаунт → тематика → відео → статус.
// Кількість відео — не окреме поле, а COUNT з posts (src/farms.js), щоб
// цифра не розходилась зі справжньою історією публікацій.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, num, badge, toast, modal, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';
import { openForm } from './entity.js';

const PLATFORM_LABEL = {
  tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube',
  facebook: 'Facebook', threads: 'Threads', x: 'X',
};
const FARM_STATUS_LABEL = { active: 'Активна', paused: 'Пауза', closed: 'Закрита' };
const ACCOUNT_STATUS_LABEL = {
  farm: 'Фарм', active: 'Актив', shadowban: 'Шедоубан', ban: 'Бан', sold: 'Проданий',
};

export async function renderFarms() {
  const ent = state.meta.farms;
  const canCreate = !!ent.can.create;
  const canEdit = !!ent.can.update;
  const canDelete = !!ent.can.delete;

  const box = el('div', {});
  const filters = { farm_id: '', client_id: '', geo: '', platform: '', status: '', niche: '', q: '' };
  let farmsList = [];
  let opts = { clients: [], geos: [], platforms: [], niches: [] };

  async function loadOverview() {
    const [{ rows }, filterOpts] = await Promise.all([api.get('/farms/overview'), api.get('/farms/filters')]);
    farmsList = rows;
    opts = filterOpts;
  }

  function query() {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    return params.toString();
  }

  async function render() {
    await loadOverview();
    const { rows } = await api.get(`/farms/accounts?${query()}`);
    box.textContent = '';
    box.append(
      el('div', { class: 'row', style: 'margin-bottom:14px;align-items:center' },
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          'Клієнт → ферма → телефон → акаунт: клік по плашці фільтрує таблицю на цю ферму'),
        el('div', { style: 'flex:1 1 auto;display:flex;justify-content:flex-end' },
          canCreate ? el('button', { class: 'btn primary', onclick: () => farmForm() }, withIcon('plus', 'Ферма')) : null)),
      farmCards(),
      tiles(rows),
      filterBar(),
      tableOf(rows));
  }

  // ── Плашки ферм: назва, клієнт, гео, заповненість телефонами ──────────
  function farmCards() {
    if (!farmsList.length) {
      return el('div', { class: 'card muted', style: 'margin-bottom:14px' },
        'Ферм ще немає — натисніть «+ Ферма», щоб створити першу.');
    }
    return el('div', { class: 'list-cards', style: 'margin-bottom:16px' }, ...farmsList.map((f) => {
      const picked = String(filters.farm_id) === String(f.id);
      const short = f.device_count < f.target_devices;
      const card = el('div', { class: `list-card${picked ? ' picked' : ''}` },
        el('div', { class: 'list-card-head' },
          el('b', {}, f.name),
          badge(f.status, FARM_STATUS_LABEL[f.status] || f.status)),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          [f.client_name || '—', f.geo].filter(Boolean).join(' · ')),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          el('span', { style: short ? 'color:var(--warn)' : undefined },
            `${num(f.device_count)} / ${num(f.target_devices)} телефонів`),
          ` · ${num(f.account_count)} акаунтів`),
        el('div', { class: 'list-card-foot' },
          el('span', {}),
          el('span', { class: 'list-card-actions' },
            canEdit ? el('button', {
              class: 'btn small icon-only', title: 'Редагувати ферму',
              onclick: (e) => { e.stopPropagation(); farmForm(f); },
            }, icon('edit', 14)) : null,
            canDelete ? el('button', {
              class: 'btn small icon-only danger', title: 'Видалити ферму',
              onclick: async (e) => {
                e.stopPropagation();
                if (!confirm(`Видалити ферму «${f.name}»? Телефони на ній лишаться, але без прив'язки до ферми.`)) return;
                try { await api.del(`/farms/${f.id}`); toast('Видалено'); await render(); }
                catch (err) { toast(err.message, true); }
              },
            }, icon('trash', 14)) : null)));
      card.addEventListener('click', () => {
        filters.farm_id = picked ? '' : f.id;
        render();
      });
      return card;
    }));
  }

  // ── Підсумок по поточному зрізу (враховує фільтри) ─────────────────────
  function tiles(rows) {
    const farmsShown = new Set(rows.map((r) => r.farm_id)).size;
    const devicesShown = new Set(rows.map((r) => r.device_id)).size;
    const videos = rows.reduce((sum, r) => sum + Number(r.videos_count || 0), 0);
    const tile = (label, value) => el('div', { class: 'tile' },
      el('div', { class: 'label' }, label), el('div', { class: 'value' }, value));
    return el('div', { class: 'tiles' },
      tile('Ферм у зрізі', num(farmsShown)),
      tile('Телефонів у зрізі', num(devicesShown)),
      tile('Акаунтів у зрізі', num(rows.length)),
      tile('Опубліковано відео', num(videos)));
  }

  // ── Фільтри ──────────────────────────────────────────────────────────
  function select(value, options, onChange, placeholder) {
    const s = el('select', {},
      el('option', { value: '' }, placeholder),
      ...options.map((o) => el('option', { value: o.value, selected: String(value) === String(o.value) }, o.label)));
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  function filterBar() {
    const search = el('input', { value: filters.q, placeholder: 'Пошук: акаунт, телефон, ферма…' });
    search.addEventListener('input', debounce(() => { filters.q = search.value.trim(); render(); }));
    const niche = el('input', { value: filters.niche, placeholder: 'напр. crypto, beauty…' });
    niche.addEventListener('input', debounce(() => { filters.niche = niche.value.trim(); render(); }));

    const hasFilters = Object.values(filters).some(Boolean);

    return el('div', { class: 'card', style: 'margin-bottom:16px' },
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Клієнт'), select(filters.client_id,
          opts.clients.map((c) => ({ value: c.id, label: c.name })),
          (v) => { filters.client_id = v; render(); }, 'Усі клієнти')),
        el('div', {}, el('label', {}, 'Гео'), select(filters.geo,
          opts.geos.map((g) => ({ value: g, label: g })),
          (v) => { filters.geo = v; render(); }, 'Усі гео')),
        el('div', {}, el('label', {}, 'Платформа'), select(filters.platform,
          opts.platforms.map((p) => ({ value: p, label: PLATFORM_LABEL[p] || p })),
          (v) => { filters.platform = v; render(); }, 'Усі платформи')),
        el('div', {}, el('label', {}, 'Статус акаунта'), select(filters.status,
          Object.entries(ACCOUNT_STATUS_LABEL).map(([value, label]) => ({ value, label })),
          (v) => { filters.status = v; render(); }, 'Будь-який')),
        el('div', {}, el('label', {}, 'Тематика'), niche),
        el('div', { style: 'flex:1 1 200px' }, el('label', {}, 'Пошук'), search)),
      hasFilters ? el('div', { style: 'margin-top:8px' },
        el('button', { class: 'btn small', onclick: () => {
          for (const k of Object.keys(filters)) filters[k] = '';
          render();
        } }, 'Скинути фільтри')) : null);
  }

  // ── Таблиця акаунтів ────────────────────────────────────────────────
  function tableOf(rows) {
    if (!rows.length) {
      return el('div', { class: 'card muted' }, 'Нічого не знайдено за цими фільтрами');
    }
    return el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Клієнт'), el('th', {}, 'Ферма'), el('th', {}, 'Гео'),
        el('th', {}, 'Телефон'), el('th', {}, 'Платформа'), el('th', {}, 'Акаунт'),
        el('th', {}, 'Тематика'), el('th', {}, 'Відео'), el('th', {}, 'Статус'))),
      el('tbody', {}, ...rows.map((r) => {
        const tr = el('tr', { style: 'cursor:pointer' },
          el('td', {}, r.client_name || '—'),
          el('td', {}, r.farm_name || '—'),
          el('td', {}, r.farm_geo || '—'),
          el('td', {}, r.device_model),
          el('td', {}, PLATFORM_LABEL[r.platform] || r.platform),
          el('td', {}, el('b', {}, r.nickname)),
          el('td', {}, r.niche || '—'),
          el('td', {}, num(r.videos_count)),
          el('td', {}, badge(r.account_status, ACCOUNT_STATUS_LABEL[r.account_status] || r.account_status)));
        tr.addEventListener('click', async () => {
          try {
            const { row } = await api.get(`/accounts/${r.id}`);
            openForm('accounts', row, render);
          } catch (e) { toast(e.message, true); }
        });
        return tr;
      }))));
  }

  // ── Форма ферми ─────────────────────────────────────────────────────
  function farmForm(row) {
    const name = el('input', { value: row?.name || '', placeholder: 'Наприклад: Ферма UA-1' });
    const clientSel = el('select', {}, el('option', { value: '' }, '—'),
      ...(state.refs.clients || []).map((c) => el('option', {
        value: c.id, selected: String(row?.client_id) === String(c.id),
      }, c.label)));
    const geo = el('input', { value: row?.geo || '' });
    const target = el('input', { type: 'number', value: row?.target_devices ?? 20 });
    const statusSel = el('select', {},
      ...Object.entries(FARM_STATUS_LABEL).map(([value, label]) => el('option', {
        value, selected: (row?.status || 'active') === value,
      }, label)));
    const note = el('textarea', { rows: 2 });
    note.value = row?.note || '';

    const form = el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Назва *'), name),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Клієнт *'), clientSel),
        el('div', {}, el('label', {}, 'Гео'), geo)),
      el('div', { class: 'row' },
        el('div', {}, el('label', {}, 'Ціль: телефонів'), target),
        el('div', {}, el('label', {}, 'Статус'), statusSel)),
      el('div', { class: 'field' }, el('label', {}, 'Нотатка'), note));

    const boxEl = modal(row ? `Ферма · ${row.name}` : 'Нова ферма', form, [actionButton('Зберегти', async () => {
      if (!name.value.trim()) return toast('Потрібна назва', true);
      if (!clientSel.value) return toast('Оберіть клієнта', true);
      const data = {
        name: name.value.trim(), client_id: clientSel.value, geo: geo.value.trim(),
        target_devices: target.value || 20, status: statusSel.value, note: note.value.trim(),
      };
      try {
        if (row) await api.put(`/farms/${row.id}`, data);
        else await api.post('/farms', data);
        boxEl.remove();
        toast('Збережено');
        await render();
      } catch (e) { toast(e.message, true); }
    })]);
  }

  await render();
  return box;
}

function debounce(fn, ms = 350) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
