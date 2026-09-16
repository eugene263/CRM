// Шаблони скриптів: редагування кроків розмови (для "Кроки" в таблиці
// сутностей) і read-only переглядач для дзвінка (з картки ліда / форми тача).
import { api } from '../api.js';
import { state } from '../app.js';
import { el, modal, toast, editableCell } from '../ui.js';
import { icon, withIcon } from '../icons.js';

// ── Редагування кроків (адмінська модалка) ─────────────────────────────────
export async function scriptStepsModal(scriptId, onChange = () => {}) {
  const canEdit = !!state.meta.scripts?.can.update;
  const canCreate = !!state.meta.scripts?.can.create;

  async function render() {
    const { script, steps, objections } = await api.get(`/scripts/${scriptId}/full`);

    const patchStep = async (step, field, value) => {
      await api.post(`/scripts/${scriptId}/steps`, { id: step.id, kind: step.kind, title: step.title, body: step.body, sort_order: step.sort_order, [field]: value });
      box.remove();
      scriptStepsModal(scriptId, onChange);
      onChange();
    };

    const rowsOf = (list) => list.map((step) => el('tr', {},
      canEdit
        ? editableCell(step.title, { onSave: (v) => patchStep(step, 'title', v) })
        : el('td', {}, step.title),
      canEdit
        ? editableCell(step.body, { type: 'textarea', format: (v) => (v ? String(v).slice(0, 90) + (String(v).length > 90 ? '…' : '') : '—'), onSave: (v) => patchStep(step, 'body', v) })
        : el('td', {}, step.body || '—'),
      canEdit
        ? editableCell(step.sort_order, { type: 'number', className: 'num', onSave: (v) => patchStep(step, 'sort_order', v ?? 100) })
        : el('td', { class: 'num' }, step.sort_order),
      el('td', {}, canEdit ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити',
        onclick: async () => {
          await api.del(`/scripts/${scriptId}/steps/${step.id}`);
          box.remove(); scriptStepsModal(scriptId, onChange); onChange();
        },
      }, icon('trash', 14)) : null)));

    const addStep = (kind) => {
      const title = el('input', { placeholder: kind === 'objection' ? 'Заперечення, наприклад: «Дорого»' : 'Назва кроку, наприклад: «Привітання»' });
      const body = el('textarea', { rows: 4, placeholder: kind === 'objection' ? 'Що відповідати' : 'Текст кроку' });
      const sortOrder = el('input', { type: 'number', value: ((kind === 'objection' ? objections : steps).length + 1) * 10 });
      const form = el('div', {},
        el('div', { class: 'field' }, el('label', {}, kind === 'objection' ? 'Заперечення' : 'Заголовок кроку'), title),
        el('div', { class: 'field' }, el('label', {}, kind === 'objection' ? 'Відповідь' : 'Текст'), body),
        el('div', { class: 'field' }, el('label', {}, 'Порядок'), sortOrder));
      const box2 = modal(kind === 'objection' ? 'Нове заперечення' : 'Новий крок', form, [el('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!title.value.trim()) return toast('Потрібен заголовок', true);
          try {
            await api.post(`/scripts/${scriptId}/steps`, { kind, title: title.value.trim(), body: body.value, sort_order: Number(sortOrder.value) || 100 });
            box2.remove(); box.remove(); scriptStepsModal(scriptId, onChange); onChange();
          } catch (e) { toast(e.message, true); }
        },
      }, 'Додати')]);
    };

    // body — рідний DOM-елемент, тому .append() (на відміну від el()) не
    // фільтрує null/undefined сам: збираємо дітей в масив і чистимо вручну.
    body.textContent = '';
    body.append(...[
      script.description ? el('div', { class: 'muted', style: 'margin-bottom:12px' }, script.description) : null,
      el('h3', { style: 'font-size:14px;margin-top:0' }, 'Кроки розмови'),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Крок'), el('th', {}, 'Текст'), el('th', { class: 'num' }, 'Порядок'), el('th', {}, ''))),
        el('tbody', {}, ...(steps.length ? rowsOf(steps) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Кроків ще немає'))])))),
      canEdit ? el('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => addStep('step') }, withIcon('plus', 'Додати крок')) : null,

      el('h3', { style: 'font-size:14px;margin-top:20px' }, 'Заперечення'),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Заперечення'), el('th', {}, 'Відповідь'), el('th', { class: 'num' }, 'Порядок'), el('th', {}, ''))),
        el('tbody', {}, ...(objections.length ? rowsOf(objections) : [el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'Заперечень ще немає'))])))),
      canEdit ? el('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => addStep('objection') }, withIcon('plus', 'Додати заперечення')) : null,
    ].filter(Boolean));
    modalTitle.textContent = `Скрипт · ${script.name}`;
  }

  const body = el('div', {});
  const modalTitle = { set textContent(v) { box.querySelector('h3').textContent = v; } };
  const box = modal('Скрипт', body, canCreate ? [el('button', {
    class: 'btn', onclick: async () => { await api.post(`/scripts/${scriptId}/duplicate`, {}); box.remove(); toast('Створено копію'); onChange(); },
  }, withIcon('layers', 'Дублювати'))] : []);
  await render();
}

// ── Read-only перегляд для дзвінка ──────────────────────────────────────────
export async function scriptViewerModal(scriptId, { onUseInTouch } = {}) {
  const { script, steps, objections } = await api.get(`/scripts/${scriptId}/full`);
  const stepList = steps.length
    ? el('ol', { style: 'padding-left:20px;margin:0' }, ...steps.map((s) => el('li', { style: 'margin-bottom:10px' },
      el('div', { style: 'font-weight:500' }, s.title),
      s.body ? el('div', { class: 'muted', style: 'font-size:13px;white-space:pre-wrap' }, s.body) : null)))
    : el('div', { class: 'muted' }, 'Кроків не додано');

  const objList = objections.length
    ? el('div', {}, ...objections.map((o) => el('div', { class: 'card', style: 'padding:10px 12px;margin-bottom:8px' },
      el('div', { style: 'font-weight:500' }, `«${o.title}»`),
      o.body ? el('div', { class: 'muted', style: 'font-size:13px;white-space:pre-wrap;margin-top:4px' }, o.body) : null)))
    : el('div', { class: 'muted' }, 'Заперечень не додано');

  const box = modal(`Скрипт · ${script.name}`, el('div', {},
    script.description ? el('div', { class: 'muted', style: 'margin-bottom:12px' }, script.description) : null,
    el('h3', { style: 'font-size:14px' }, 'Кроки розмови'), stepList,
    el('h3', { style: 'font-size:14px;margin-top:18px' }, 'Заперечення'), objList),
    onUseInTouch ? [el('button', {
      class: 'btn primary',
      onclick: () => { box.remove(); onUseInTouch(script); },
    }, withIcon('send', 'Записати тач за цим скриптом'))] : []);
  return box;
}

// ── Пікер скриптів (кнопка «Скрипт» у картці ліда) ──────────────────────────
export async function scriptPickerModal(scriptsList, { onUseInTouch } = {}) {
  if (!scriptsList.length) {
    return modal('Скрипти', el('div', { class: 'muted' }, 'Активних скриптів ще немає — додайте їх у розділі «Шаблони скриптів».'));
  }
  const rows = scriptsList.map((s) => el('div', { class: 'alert-item' },
    el('div', {},
      el('div', {}, s.name),
      el('div', { class: 'muted', style: 'font-size:12px' }, [s.category, { call: 'дзвінок', meeting: 'зустріч', general: 'загальний' }[s.channel]].filter(Boolean).join(' · '))),
    el('button', { class: 'btn small', onclick: () => { box.remove(); scriptViewerModal(s.id, { onUseInTouch }); } }, 'Відкрити')));
  const box = modal('Скрипти', el('div', {}, ...rows));
  return box;
}
