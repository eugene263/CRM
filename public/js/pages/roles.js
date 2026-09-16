// Конструктор ролей: матриця «роль × сутність × рівень/скоуп» і приховані поля.
// Усе, що тут змінюється, одразу діє на API — без деплою.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, toast, modal } from '../ui.js';
import { icon, withIcon } from '../icons.js';

const LEVELS = [['none', '—'], ['read', 'Читання'], ['write', 'Запис'], ['full', 'Повний']];
const SCOPES = [['own', 'Свої'], ['team', 'Команда'], ['all', 'Усі']];

export async function renderRoles() {
  const data = await api.get('/roles');
  const editable = state.caps.settings;
  const box = el('div', {});
  let current = data.roles[0]?.key;

  const tabs = el('div', { class: 'tabs' });
  const body = el('div', {});

  function permOf(roleKey, entity) {
    return data.permissions.find((p) => p.role_key === roleKey && p.entity === entity)
      || { role_key: roleKey, entity, level: 'none', scope: 'own', hidden_fields: null };
  }

  function renderRole() {
    tabs.textContent = '';
    for (const r of data.roles) {
      tabs.append(el('button', {
        class: `btn small${r.key === current ? ' active' : ''}`,
        onclick: () => { current = r.key; renderRole(); },
      }, r.is_system ? r.label : withIcon('edit', r.label, 13)));
    }
    if (editable) {
      tabs.append(el('button', {
        class: 'btn small primary',
        onclick: () => {
          const key = el('input', { placeholder: 'наприклад, buyer' });
          const label = el('input', { placeholder: 'Баєр' });
          const form = el('div', {},
            el('div', { class: 'field' }, el('label', {}, 'Ключ (латиниця)'), key),
            el('div', { class: 'field' }, el('label', {}, 'Назва'), label));
          const box2 = modal('Нова роль', form, [el('button', {
            class: 'btn primary',
            onclick: async () => {
              try {
                await api.post('/roles', { key: key.value.trim(), label: label.value.trim() || key.value.trim() });
                box2.remove(); toast('Роль створена без прав — відкрийте потрібні'); location.reload();
              } catch (e) { toast(e.message, true); }
            },
          }, 'Створити')]);
        },
      }, withIcon('plus', 'Роль')));
    }

    const role = data.roles.find((r) => r.key === current);
    const caps = el('div', { class: 'row', style: 'margin-bottom:14px' },
      ...[['can_reveal', 'Розкриття секретів'], ['can_export', 'Експорт'], ['can_salary_calc', 'Розрахунок ЗП'], ['can_settings', 'Адмін-права']]
        .map(([field, label]) => {
          const cb = el('input', { type: 'checkbox', checked: !!role[field], disabled: !editable || role.key === 'owner', style: 'width:auto' });
          cb.addEventListener('change', () => { role[field] = cb.checked ? 1 : 0; });
          return el('div', {}, el('label', {}, label), cb);
        }),
      (() => {
        const input = el('input', { type: 'number', value: role.reveal_daily_limit, disabled: !editable || role.key === 'owner' });
        input.addEventListener('change', () => { role.reveal_daily_limit = Number(input.value); });
        return el('div', {}, el('label', {}, 'Ліміт розкриттів/добу'), input);
      })());

    const rows = Object.entries(data.entities).map(([key, ent]) => {
      const perm = permOf(current, key);
      const levelSel = el('select', { disabled: !editable || current === 'owner' },
        ...LEVELS.map(([v, l]) => el('option', { value: v, selected: perm.level === v }, l)));
      const scopeSel = el('select', { disabled: !editable || current === 'owner' },
        ...SCOPES.map(([v, l]) => el('option', { value: v, selected: perm.scope === v }, l)));
      const hidden = el('input', {
        value: perm.hidden_fields || '', disabled: !editable || current === 'owner',
        placeholder: 'приховані поля через кому',
      });
      levelSel.addEventListener('change', () => { perm.level = levelSel.value; });
      scopeSel.addEventListener('change', () => { perm.scope = scopeSel.value; });
      hidden.addEventListener('change', () => { perm.hidden_fields = hidden.value; });
      if (!data.permissions.includes(perm)) data.permissions.push(perm);
      return el('tr', {},
        el('td', {}, ent.label), el('td', { class: 'muted' }, ent.group),
        el('td', {}, levelSel), el('td', {}, scopeSel), el('td', {}, hidden));
    });

    const saveBtn = el('button', {
      class: 'btn primary',
      onclick: async () => {
        const permissions = data.permissions
          .filter((p) => p.role_key === current)
          .map((p) => ({
            entity: p.entity, level: p.level, scope: p.scope,
            hidden_fields: String(p.hidden_fields || '').split(',').map((f) => f.trim()).filter(Boolean),
          }));
        try {
          await api.put(`/roles/${current}`, {
            label: role.label, can_reveal: role.can_reveal, can_export: role.can_export,
            can_salary_calc: role.can_salary_calc, can_settings: role.can_settings,
            reveal_daily_limit: role.reveal_daily_limit, permissions,
          });
          toast('Права збережені');
        } catch (e) { toast(e.message, true); }
      },
    }, 'Зберегти');

    const deleteBtn = role.is_system ? null : el('button', {
      class: 'btn danger',
      onclick: async () => {
        if (!confirm(`Видалити роль «${role.label}»?`)) return;
        try { await api.del(`/roles/${role.key}`); toast('Видалено'); location.reload(); }
        catch (e) { toast(e.message, true); }
      },
    }, 'Видалити роль');

    const footer = editable && current !== 'owner'
      ? el('div', { class: 'row', style: 'margin-top:12px' },
        el('div', { class: 'muted' }, 'Зміни застосовуються одразу, без перезапуску.'),
        el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, deleteBtn, saveBtn))
      : el('div', { class: 'muted', style: 'margin-top:10px' },
        current === 'owner' ? 'Права власника незмінні за визначенням.' : 'Ваша роль не може редагувати права.');

    body.textContent = '';
    body.append(caps, el('div', { class: 'card' },
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Розділ'), el('th', {}, 'Група'),
          el('th', {}, 'Рівень'), el('th', {}, 'Скоуп'), el('th', {}, 'Приховані поля'))),
        el('tbody', {}, ...rows))), footer));
  }

  renderRole();
  box.append(tabs, body);
  return box;
}
