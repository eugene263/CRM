// Дрібні DOM-хелпери, форматери та SVG-графік — без фреймворків і збірки.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const money = (v) => (v === null || v === undefined || v === '' ? '—' : `$${Number(v).toLocaleString('uk-UA', { maximumFractionDigits: 2 })}`);
export const num = (v) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('uk-UA', { maximumFractionDigits: 1 }));
export const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);
export const today = () => new Date().toISOString().slice(0, 10);
export const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// Палітра графіків береться з CSS — тоді зміна теми міняє й лінії.
// Обидва набори перевірені валідатором на контраст і розрізнення при CVD.
export function chartColor(slot) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--chart-${slot}`).trim();
  return value || '#5b7bf5';
}

export function toast(message, isError = false) {
  const t = el('div', { class: `toast${isError ? ' err' : ''}` }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 4200);
}

// Кнопка дії, яку не можна натиснути двічі: доки асинхронний обробник не
// завершився, повторні кліки ігноруються. Без цього нетерплячий подвійний
// клік по «Додати» шле два однакові POST — і в базі два однакові рядки
// (саме так це й відтворилось у браузері).
export function actionButton(label, handler, { className = 'btn primary' } = {}) {
  let busy = false;
  const btn = el('button', {
    class: className,
    onclick: async () => {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      try { await handler(); } finally { busy = false; btn.disabled = false; }
    },
  }, label);
  return btn;
}

export function modal(title, content, actions = []) {
  const bg = el('div', { class: 'drawer-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
  const box = el('div', { class: 'drawer' }, el('h3', {}, title), content,
    el('div', { class: 'actions' }, ...actions, el('button', { class: 'btn', onclick: () => bg.remove() }, 'Закрити')));
  bg.append(box);
  document.body.append(bg);
  return bg;
}

export function badge(value, label) {
  return el('span', { class: `badge ${String(value || '').toLowerCase()}` }, label || value || '—');
}

// Лінійний графік на кілька серій (без залежностей).
export function lineChart(rows, series, { height = 190 } = {}) {
  const w = 900, h = height, pad = { l: 46, r: 12, t: 12, b: 22 };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('preserveAspectRatio', 'none');
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)));
  const x = (i) => pad.l + (i * (w - pad.l - pad.r)) / Math.max(1, rows.length - 1);
  const y = (v) => h - pad.b - ((Number(v) || 0) / max) * (h - pad.t - pad.b);
  const add = (tag, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
    return n;
  };
  for (let i = 0; i <= 4; i += 1) {
    const yy = pad.t + (i * (h - pad.t - pad.b)) / 4;
    add('line', { x1: pad.l, x2: w - pad.r, y1: yy, y2: yy, class: 'grid-line' });
    const label = add('text', { x: 4, y: yy + 3 });
    label.textContent = num(Math.round((max * (4 - i)) / 4));
  }
  for (const s of series) {
    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[s.key]).toFixed(1)}`).join(' ');
    add('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round' });
  }
  rows.forEach((r, i) => {
    if (rows.length > 12 && i % Math.ceil(rows.length / 8) !== 0) return;
    const t = add('text', { x: x(i), y: h - 6, 'text-anchor': 'middle' });
    t.textContent = String(r.date || r.label || '').slice(5);
  });
  const wrap = el('div', {});
  wrap.append(svg, el('div', { class: 'legend' }, ...series.map((s) => el('span', {}, el('i', { style: `background:${s.color}` }), s.label))));
  return wrap;
}

// Клітинка «клік → інпут → збереження»: для таблиць, де формою відкривати
// заради одного числа незручно (собівартість, ставки). Enter/blur зберігає,
// Escape скасовує; порожній рядок для number-полів не шле запит.
export function editableCell(value, { type = 'text', format = (v) => v ?? '—', onSave, className = '' } = {}) {
  const td = el('td', { class: className });
  const multiline = type === 'textarea';
  let editing = false;

  function renderView() {
    editing = false;
    td.textContent = '';
    td.classList.add('editable');
    td.append(el('span', { class: 'editable-value' }, format(value)));
    td.onclick = () => renderEdit();
  }

  function renderEdit() {
    if (editing) return;
    editing = true;
    td.onclick = null;
    const input = multiline
      ? el('textarea', { rows: 3, value: value ?? '' })
      : el('input', {
        type: type === 'number' ? 'number' : 'text',
        step: type === 'number' ? 'any' : undefined,
        value: value ?? '',
      });
    if (multiline) input.value = value ?? '';   // textarea тексту не бере через атрибут value
    td.textContent = '';
    td.append(input);
    input.focus();
    if (!multiline) input.select();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const raw = input.value;
      if (raw === String(value ?? '')) { renderView(); return; }
      const next = type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
      if (type === 'number' && raw !== '' && Number.isNaN(next)) { renderView(); return; }
      try {
        await onSave(next);
        value = next;
      } catch (e) {
        toast(e.message, true);
      }
      renderView();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      // У textarea звичайний Enter — новий рядок; зберігає лише Ctrl/Cmd+Enter.
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { done = true; renderView(); }
    });
  }

  renderView();
  return td;
}

export function barList(rows, { labelKey = 'label', valueKey = 'revenue', format = money } = {}) {
  const max = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
  return el('div', {}, ...rows.map((r) => el('div', { style: 'margin-bottom:8px' },
    el('div', { style: 'display:flex;justify-content:space-between;font-size:13px' },
      el('span', {}, r[labelKey] ?? '—'), el('span', { class: 'muted' }, format(r[valueKey]))),
    el('div', { class: 'bar-track' },
      el('div', { class: 'bar-fill', style: `width:${((Number(r[valueKey]) || 0) / max) * 100}%` })))));
}
