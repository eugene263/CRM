// Дії над записом сейфа: розкриття по одному полю, код 2FA, видача й повернення.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, modal, toast } from '../ui.js';
import { icon } from '../icons.js';

const SECRETS = [
  ['password_enc', 'Пароль'], ['recovery_enc', 'Recovery'], ['totp_seed_enc', '2FA seed'], ['notes_enc', 'Нотатки'],
];

// Значення показуємо в модалці й не лишаємо в DOM списку: скрін списку
// не має перетворюватись на злив бази.
function showSecret(label, value, extra) {
  modal(label, el('div', {},
    el('code', { style: 'display:block;padding:12px;background:var(--panel-2);border-radius:8px;word-break:break-all;font-size:15px' }, value ?? '—'),
    extra ? el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' }, extra) : null));
}

async function requestAccess(row) {
  const reason = prompt(`Навіщо потрібен доступ «${row.title}»?`);
  if (!reason) return;
  try {
    await api.post('/access_requests', { credential_id: row.id, reason, hours: 8 });
    toast('Запит надіслано тімліду');
  } catch (e) { toast(e.message, true); }
}

export function credentialActions(row, reload) {
  const wrap = el('span', {});

  wrap.append(el('button', {
    class: 'btn small', title: 'Показати секрет',
    onclick: () => {
      const menu = el('div', {});
      for (const [field, label] of SECRETS) {
        menu.append(el('button', {
          class: 'btn small', style: 'margin:4px 6px 0 0',
          onclick: async () => {
            try {
              const res = await api.get(`/credentials/${row.id}/reveal/${field}`);
              showSecret(label, res.value, `Розкриття записано в аудит · ${res.used} з ${res.limit} за добу`);
            } catch (e) {
              if (e.data?.needApproval || e.data?.needGrant) requestAccess(row);
              else toast(e.message, true);
            }
          },
        }, label));
      }
      menu.append(el('button', {
        class: 'btn small', style: 'margin:4px 6px 0 0',
        onclick: async () => {
          try {
            const res = await api.get(`/credentials/${row.id}/totp`);
            showSecret('Код 2FA', res.code, `Діє ще ${res.valid_seconds} с`);
          } catch (e) { toast(e.message, true); }
        },
      }, 'Код 2FA'));
      modal(`Доступ «${row.title}»`, menu);
    },
  }, icon('key', 15)));

  const canManage = state.meta.credentials?.can.update;
  if (canManage && row.status !== 'issued') {
    wrap.append(el('button', {
      class: 'btn small', style: 'margin-left:6px', title: 'Видати',
      onclick: () => {
        const who = el('select', {}, ...(state.refs.users || []).map((u) => el('option', { value: u.id }, u.label)));
        const due = el('input', { type: 'datetime-local' });
        const condition = el('input', { placeholder: 'стан при видачі' });
        const form = el('div', {},
          el('div', { class: 'field' }, el('label', {}, 'Кому'), who),
          el('div', { class: 'field' }, el('label', {}, 'Повернути до (необовʼязково)'), due),
          el('div', { class: 'field' }, el('label', {}, 'Нотатка'), condition));
        const box = modal(`Видати «${row.title}»`, form, [el('button', {
          class: 'btn primary',
          onclick: async () => {
            try {
              await api.post(`/credentials/${row.id}/issue`, {
                user_id: Number(who.value),
                due_at: due.value ? due.value.replace('T', ' ') : null,
                state_out: condition.value || null,
              });
              box.remove(); toast('Видано'); reload();
            } catch (e) { toast(e.message, true); }
          },
        }, 'Видати')]);
      },
    }, icon('idCard', 15)));
  }

  if (canManage && row.status === 'issued') {
    wrap.append(el('button', {
      class: 'btn small', style: 'margin-left:6px', title: 'Повернути',
      onclick: async () => {
        const state_in = prompt('Стан при поверненні (необовʼязково)') || null;
        try {
          await api.post(`/credentials/${row.id}/return`, { state_in });
          toast('Повернено. Пароль позначено на ротацію'); reload();
        } catch (e) { toast(e.message, true); }
      },
    }, icon('undo', 15)));
    wrap.append(el('button', {
      class: 'btn small danger', style: 'margin-left:6px', title: 'Відкликати',
      onclick: async () => {
        if (!confirm('Відкликати доступ? Він буде позначений як скомпрометований.')) return;
        await api.post(`/credentials/${row.id}/revoke`, { reason: 'ручне відкликання' });
        toast('Відкликано'); reload();
      },
    }, icon('ban', 15)));
  }

  return wrap;
}
