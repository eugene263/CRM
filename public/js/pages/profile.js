// Профіль: зміна пароля, 2FA, активні сесії.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, toast, modal } from '../ui.js';
import { roleLabel } from '../app.js';

export async function renderProfile() {
  const box = el('div', {});
  const u = state.user;

  box.append(el('div', { class: 'card' }, el('h3', {}, 'Профіль'),
    el('div', {}, `${u.name} · ${u.email} · ${roleLabel(u.role)}`),
    el('div', { class: 'muted', style: 'margin-top:4px' }, `2FA: ${u.has_2fa ? 'увімкнена' : 'вимкнена'}`)));

  const pwd = el('input', { type: 'password', placeholder: 'новий пароль (мін. 8 символів)' });
  box.append(el('div', { class: 'card' }, el('h3', {}, 'Пароль'),
    el('div', { class: 'row' }, pwd,
      el('button', {
        class: 'btn primary', style: 'flex:0 0 auto',
        onclick: async () => {
          try { await api.post('/auth/password', { password: pwd.value }); toast('Пароль змінено'); pwd.value = ''; }
          catch (e) { toast(e.message, true); }
        },
      }, 'Змінити'))));

  box.append(el('div', { class: 'card' }, el('h3', {}, 'Двофакторна автентифікація'),
    el('div', { class: 'row' },
      el('button', {
        class: 'btn primary', style: 'flex:0 0 auto',
        onclick: async () => {
          const res = await api.post('/auth/2fa', {});
          modal('Підключіть 2FA', el('div', {},
            el('p', {}, 'Додайте цей секрет у Google Authenticator / Authy:'),
            el('code', { style: 'display:block;padding:10px;background:var(--panel-2);border-radius:8px;word-break:break-all' }, res.secret),
            el('p', { class: 'muted', style: 'font-size:12px' }, res.uri)));
        },
      }, 'Увімкнути / перевипустити'),
      el('button', {
        class: 'btn danger', style: 'flex:0 0 auto',
        onclick: async () => { await api.post('/auth/2fa', { disable: true }); toast('2FA вимкнена'); },
      }, 'Вимкнути'))));

  const sessions = await api.get('/auth/sessions');
  box.append(el('div', { class: 'card' }, el('h3', {}, 'Активні сесії'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Створена'), el('th', {}, 'Діє до'), el('th', {}, 'IP'), el('th', {}, 'Пристрій'), el('th', {}, ''))),
      el('tbody', {}, ...sessions.rows.map((s) => el('tr', {},
        el('td', {}, String(s.created_at).slice(0, 16)),
        el('td', {}, String(s.expires_at).slice(0, 16)),
        el('td', {}, s.ip || '—'),
        el('td', {}, String(s.user_agent || '—').slice(0, 40)),
        el('td', {}, el('button', {
          class: 'btn small danger',
          onclick: async () => {
            await api.del(`/auth/sessions/${encodeURIComponent(s.token)}`);
            toast('Сесію завершено');
            location.reload();
          },
        }, 'Завершити')))))))));

  return box;
}
