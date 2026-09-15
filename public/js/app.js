// Оболонка: логін, меню з /api/meta, хеш-роутер.
import { api } from './api.js';
import { el, toast, today, daysAgo } from './ui.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderEntity } from './pages/entity.js';
import { renderAnalytics } from './pages/analytics.js';
import { renderFinance } from './pages/finance.js';
import { renderProfile } from './pages/profile.js';
import { renderRoles } from './pages/roles.js';

export const state = {
  user: null, meta: {}, refs: {}, caps: {},
  range: { from: daysAgo(29), to: today() },
};

const $ = (sel) => document.querySelector(sel);

async function boot() {
  try {
    const me = await api.get('/auth/me');
    state.user = me.user;
    await start();
  } catch {
    $('#login').classList.remove('hidden');
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const errBox = $('#login-error');
  errBox.classList.add('hidden');
  try {
    const res = await api.post('/auth/login', Object.fromEntries(form));
    state.user = res.user;
    $('#login').classList.add('hidden');
    await start();
  } catch (err) {
    if (err.data?.need2fa) $('#totp-field').classList.remove('hidden');
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
});

$('#logout').addEventListener('click', async () => {
  await api.post('/auth/logout');
  location.reload();
});

for (const id of ['#date-from', '#date-to']) {
  $(id).addEventListener('change', () => {
    state.range = { from: $('#date-from').value, to: $('#date-to').value };
    route();
  });
}

async function start() {
  const meta = await api.get('/meta');
  state.meta = meta.entities;
  state.refs = meta.refs;
  state.caps = meta.caps;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who').textContent = `${state.user.name} · ${roleLabel(state.user.role)}`;
  $('#date-from').value = state.range.from;
  $('#date-to').value = state.range.to;
  buildNav();
  window.addEventListener('hashchange', route);
  route();
}

const ROLE_LABELS = {
  owner: 'Власник', head: 'Хед', teamlead: 'Тімлід', creator: 'Крієйтор',
  editor: 'Монтажер', farmer: 'Фармер', finance: 'Фінансист', analyst: 'Аналітик',
};
export const roleLabel = (r) => ROLE_LABELS[r] || r;

function buildNav() {
  const nav = $('#nav');
  nav.textContent = '';
  const links = [
    { href: '#/dashboard', icon: '📊', label: 'Дашборд', group: 'Огляд' },
    { href: '#/analytics', icon: '🔍', label: 'Аналітика', group: 'Огляд' },
    { href: '#/finance', icon: '💵', label: 'Фінанси', group: 'Огляд' },
    ...(state.meta.users ? [{ href: '#/roles', icon: '🛡', label: 'Ролі та права', group: 'Огляд' }] : []),
  ];
  for (const ent of Object.values(state.meta)) {
    links.push({ href: `#/e/${ent.key}`, icon: ent.icon || '•', label: ent.label, group: ent.group });
  }
  links.push({ href: '#/profile', icon: '⚙️', label: 'Профіль і 2FA', group: 'Огляд' });

  const groups = [...new Set(links.map((l) => l.group))];
  for (const g of groups) {
    const box = el('div', { class: 'nav-group' }, el('h4', {}, g));
    for (const l of links.filter((x) => x.group === g)) {
      box.append(el('a', { href: l.href, 'data-href': l.href }, `${l.icon}  ${l.label}`));
    }
    nav.append(box);
  }
}

function markActive(hash) {
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.href === hash));
}

async function route() {
  const hash = location.hash || '#/dashboard';
  markActive(hash);
  const view = $('#view');
  view.textContent = '';
  view.append(el('div', { class: 'muted' }, 'Завантаження…'));
  const [section, arg] = hash.replace(/^#\//, '').split('/');
  try {
    let node;
    if (section === 'e') node = await renderEntity(arg);
    else if (section === 'analytics') node = await renderAnalytics();
    else if (section === 'finance') node = await renderFinance();
    else if (section === 'profile') node = await renderProfile();
    else if (section === 'roles') node = await renderRoles();
    else node = await renderDashboard();
    view.textContent = '';
    view.append(node);
    $('#page-title').textContent = section === 'e' ? (state.meta[arg]?.label || 'Розділ')
      : { analytics: 'Аналітика', finance: 'Фінанси', profile: 'Профіль', roles: 'Ролі та права' }[section] || 'Дашборд';
  } catch (err) {
    view.textContent = '';
    view.append(el('div', { class: 'card' }, el('div', { class: 'error' }, err.message)));
    toast(err.message, true);
  }
}

// Перезавантажити довідники після змін (нові акаунти/офери у списках).
export async function reloadRefs() {
  state.refs = await api.get('/refs');
}

boot();
