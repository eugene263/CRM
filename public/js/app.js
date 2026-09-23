// Оболонка: логін, меню з /api/meta, хеш-роутер.
import { api } from './api.js';
import { el, toast, today, daysAgo } from './ui.js';
import { icon, withIcon } from './icons.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderEntity } from './pages/entity.js';
import { renderAnalytics } from './pages/analytics.js';
import { renderFinance } from './pages/finance.js';
import { renderProfile } from './pages/profile.js';
import { renderRoles } from './pages/roles.js';
import { renderProspecting } from './pages/prospecting.js';
import { renderPlans } from './pages/plans.js';
import { renderListDetailPage } from './pages/prospectLists.js';
import { renderTemplateCardPage } from './pages/messageTemplates.js';
import { renderMapCanvas } from './pages/clientMaps.js';
import { mountAiButton } from './aiChat.js';

export const state = {
  user: null, meta: {}, locked: [], refs: {}, caps: {},
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

$('#logout').append(withIcon('logout', 'Вийти'));
$('#logout').addEventListener('click', async () => {
  await api.post('/auth/logout');
  location.reload();
});

// Перемикач теми: вибір запамʼятовується, поки користувач його не змінить.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('crm_theme', theme); } catch {}
  const btn = $('#theme-toggle');
  btn.textContent = '';
  btn.append(icon(theme === 'light' ? 'moon' : 'sun', 15));
  btn.title = theme === 'light' ? 'Темна тема' : 'Світла тема';
  // Графіки читають кольори з CSS, тож після зміни теми їх треба перемалювати.
  if (state.user) route();
}

$('#theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
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
  state.locked = meta.locked || [];
  state.refs = meta.refs;
  state.caps = meta.caps;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who').textContent = `${state.user.name} · ${roleLabel(state.user.role)}`;
  $('#date-from').value = state.range.from;
  $('#date-to').value = state.range.to;
  applyTheme(document.documentElement.dataset.theme || 'dark');
  buildNav();
  mountAiButton();
  window.addEventListener('hashchange', route);
  route();
}

const ROLE_LABELS = {
  owner: 'Власник', head: 'Хед', teamlead: 'Тімлід', creator: 'Крієйтор',
  editor: 'Монтажер', farmer: 'Фармер', finance: 'Фінансист', analyst: 'Аналітик',
};
export const roleLabel = (r) => ROLE_LABELS[r] || r;

// Які категорії згорнуті — за назвою групи, переживає перезавантаження
// сторінки. Один спільний список на всі ролі: групи, яких у ролі немає,
// просто не використовуються.
function collapsedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem('crm_nav_collapsed') || '[]')); }
  catch { return new Set(); }
}
function setGroupCollapsed(group, collapsed) {
  const set = collapsedGroups();
  if (collapsed) set.add(group); else set.delete(group);
  try { localStorage.setItem('crm_nav_collapsed', JSON.stringify([...set])); } catch {}
}

// Ці розділи прибрані з активного меню на прохання власника — залишаються
// на місці підписом, щоб не губився контекст «розділ існує», але не
// відкриваються (напівпрозорі, не клікабельні). Це суто вигляд навігації:
// самі сторінки й API нікуди не зникли, RBAC тут ні до чого.
const DISABLED_NAV_KEYS = new Set([
  'resource_assignments', 'creatives', 'creative_versions', 'tasks', 'posts',
  'offers', 'offer_rates_history', 'tracking_links', 'conversions',
  'salary_rules', 'kpi_targets', 'touches', 'dictionaries', 'suppression_list',
  'channel_limits', 'work_calendar', 'ramp_up_plans', 'bonus_rules', 'quality_flags',
  'credentials', 'credential_grants', 'clicks', 'account_events', 'audit_log',
]);

function buildNav() {
  const nav = $('#nav');
  nav.textContent = '';
  const links = [
    { href: '#/dashboard', icon: 'dashboard', label: 'Дашборд', group: 'Огляд' },
    { href: '#/analytics', icon: 'analytics', label: 'Аналітика', group: 'Огляд' },
    { href: '#/finance', icon: 'finance', label: 'Фінанси', group: 'Огляд' },
    ...(state.meta.leads ? [{ href: '#/prospecting', icon: 'target', label: 'Пошук клієнтів', group: 'Огляд' }] : []),
    ...(state.meta.kpi_plans ? [{ href: '#/plans', icon: 'gauge', label: 'Плани та норми', group: 'Огляд' }] : []),
    ...(state.meta.users ? [{ href: '#/roles', icon: 'shield', label: 'Ролі та права', group: 'Огляд' }] : []),
  ];
  for (const ent of Object.values(state.meta)) {
    links.push({
      href: `#/e/${ent.key}`, icon: ent.icon || ent.key, label: ent.label, group: ent.group,
      disabled: DISABLED_NAV_KEYS.has(ent.key),
    });
  }
  // Розділи без доступу лишаються в меню замочком, а не зникають —
  // людина бачить, що розділ існує, і знає, що саме просити в адміна.
  for (const ent of state.locked) {
    links.push({ icon: ent.icon || ent.key, label: ent.label, group: ent.group, locked: true });
  }
  links.push({ href: '#/profile', icon: 'settings', label: 'Профіль і 2FA', group: 'Огляд' });

  const collapsed = collapsedGroups();
  const groups = [...new Set(links.map((l) => l.group))];
  for (const g of groups) {
    const items = el('div', { class: 'nav-items' });
    for (const l of links.filter((x) => x.group === g)) {
      items.append(l.locked
        ? el('span', { class: 'nav-locked', title: 'Немає доступу — зверніться до адміністратора' },
          icon(l.icon, 16), l.label, icon('lock', 13))
        : l.disabled
          ? el('span', { class: 'nav-disabled' }, icon(l.icon, 16), l.label)
          : el('a', { href: l.href, 'data-href': l.href }, icon(l.icon, 16), l.label));
    }
    const box = el('div', { class: `nav-group${collapsed.has(g) ? ' collapsed' : ''}` });
    box.append(
      el('h4', {
        onclick: () => {
          const isCollapsed = box.classList.toggle('collapsed');
          setGroupCollapsed(g, isCollapsed);
        },
      }, icon('chevronDown', 12), g),
      items,
    );
    nav.append(box);
  }
}

function markActive(hash) {
  document.querySelectorAll('#nav a').forEach((a) => {
    const isActive = a.dataset.href === hash;
    a.classList.toggle('active', isActive);
    // Категорія могла бути згорнута ще до переходу на цю сторінку —
    // не варто ховати пункт, на якому людина зараз стоїть.
    if (isActive) {
      const group = a.closest('.nav-group');
      if (group?.classList.contains('collapsed')) {
        group.classList.remove('collapsed');
        setGroupCollapsed(group.querySelector('h4')?.textContent?.trim(), false);
      }
    }
  });
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
    else if (section === 'list') node = await renderListDetailPage(Number(arg));
    else if (section === 'template') node = await renderTemplateCardPage(Number(arg));
    else if (section === 'map') node = await renderMapCanvas(Number(arg));
    else if (section === 'analytics') node = await renderAnalytics();
    else if (section === 'finance') node = await renderFinance();
    else if (section === 'profile') node = await renderProfile();
    else if (section === 'roles') node = await renderRoles();
    else if (section === 'prospecting') node = await renderProspecting();
    else if (section === 'plans') node = await renderPlans();
    else node = await renderDashboard();
    view.textContent = '';
    view.append(node);
    $('#page-title').textContent = section === 'e' ? (state.meta[arg]?.label || 'Розділ')
      : { analytics: 'Аналітика', finance: 'Фінанси', profile: 'Профіль', roles: 'Ролі та права', prospecting: 'Пошук клієнтів', plans: 'Плани та норми', list: 'Список пошуку',
        template: 'Шаблони повідомлень', map: 'Підключення клієнта' }[section] || 'Дашборд';
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
