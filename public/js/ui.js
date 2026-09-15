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

export function toast(message, isError = false) {
  const t = el('div', { class: `toast${isError ? ' err' : ''}` }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 4200);
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

export function barList(rows, { labelKey = 'label', valueKey = 'revenue', format = money } = {}) {
  const max = Math.max(1, ...rows.map((r) => Number(r[valueKey]) || 0));
  return el('div', {}, ...rows.map((r) => el('div', { style: 'margin-bottom:8px' },
    el('div', { style: 'display:flex;justify-content:space-between;font-size:13px' },
      el('span', {}, r[labelKey] ?? '—'), el('span', { class: 'muted' }, format(r[valueKey]))),
    el('div', { style: 'height:6px;background:var(--panel-2);border-radius:4px;overflow:hidden;margin-top:3px' },
      el('div', { style: `height:100%;width:${((Number(r[valueKey]) || 0) / max) * 100}%;background:var(--accent)` })))));
}
