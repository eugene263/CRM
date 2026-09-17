// Шаблони повідомлень — дерево карток. Одна картка = заголовок, опис і
// теги; клік заходить усередину, і там такі самі картки, скільки завгодно
// рівнів. Та сама картка може бути і папкою, і готовим шаблоном: текст
// повідомлення живе в ній же, під описом.
import { api } from '../api.js';
import { state } from '../app.js';
import { el, badge, modal, toast, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';

const splitTags = (value) => String(value || '').split(',').map((t) => t.trim()).filter(Boolean);

async function loadTree() {
  const { rows } = await api.get('/message_templates?limit=500');
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const kids = new Map();
  for (const row of rows) {
    const parent = row.parent_id == null ? 0 : Number(row.parent_id);
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(row);
  }
  for (const list of kids.values()) {
    list.sort((a, b) => (Number(a.sort_order || 0) - Number(b.sort_order || 0))
      || String(a.name).localeCompare(String(b.name), 'uk'));
  }
  const pathOf = (row) => {
    const path = [];
    for (let cur = row, hops = 0; cur && hops < 50; hops += 1) {
      path.unshift(cur);
      cur = cur.parent_id == null ? null : byId.get(Number(cur.parent_id));
    }
    return path;
  };
  return { rows, byId, childrenOf: (id) => kids.get(Number(id) || 0) || [], pathOf };
}

// Форма картки: зверху те, що видно на самій картці, нижче — власне
// повідомлення. Текст необовʼязковий: картка може бути просто розділом.
function cardForm(tree, { row, parentId, onSaved }) {
  const name = el('input', { value: row?.name || '', placeholder: 'Наприклад: Холодний аутріч' });
  const description = el('textarea', { rows: 3 });
  description.value = row?.description || '';
  const tags = el('input', { value: row?.tags || '', placeholder: 'через кому: холодний, instagram' });
  const channel = el('input', { value: row?.channel || '', placeholder: 'instagram_dm, email, telegram…' });
  const subject = el('input', { value: row?.subject || '' });
  const body = el('textarea', { rows: 6 });
  body.value = row?.body || '';
  const variables = el('input', { value: row?.variables || '', placeholder: 'company, city' });
  const active = el('input', { type: 'checkbox', checked: row ? Number(row.is_active) !== 0 : true });

  const form = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Заголовок *'), name),
    el('div', { class: 'field' }, el('label', {}, 'Опис'), description),
    el('div', { class: 'field' }, el('label', {}, 'Теги'), tags),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Канал'), channel),
      el('div', {}, el('label', {}, 'Тема (email)'), subject)),
    el('div', { class: 'field' }, el('label', {}, 'Текст повідомлення'), body,
      el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:3px' },
        'Необовʼязково — картка може бути просто розділом із вкладеними картками')),
    el('div', { class: 'field' }, el('label', {}, 'Змінні'), variables),
    el('label', { class: 'row tight', style: 'gap:6px;align-items:center' }, active, 'Активний'));

  const box = modal(row ? `Картка · ${row.name}` : 'Нова картка', form, [actionButton('Зберегти', async () => {
    if (!name.value.trim()) return toast('Потрібен заголовок', true);
    const data = {
      name: name.value.trim(), description: description.value.trim(), tags: tags.value.trim(),
      channel: channel.value.trim(), subject: subject.value.trim(), body: body.value,
      variables: variables.value.trim(), is_active: active.checked ? 1 : 0,
    };
    if (!row) {
      data.parent_id = parentId ?? '';
      // Нова картка лягає в кінець списку сусідів, а не перемішується з ними.
      const siblings = tree.childrenOf(parentId || 0);
      data.sort_order = (siblings.reduce((max, s) => Math.max(max, Number(s.sort_order || 0)), 0) || 0) + 10;
    }
    try {
      if (row) await api.put(`/message_templates/${row.id}`, data);
      else await api.post('/message_templates', data);
      box.remove();
      toast('Збережено');
      await onSaved();
    } catch (e) { toast(e.message, true); }
  })]);
}

function cardNode(tree, row, { canEdit, canDelete, reload }) {
  const childCount = tree.childrenOf(row.id).length;
  const tagList = splitTags(row.tags);

  const card = el('div', { class: 'list-card' },
    el('div', { class: 'list-card-head' },
      el('b', {}, row.name),
      childCount ? badge('active', `${childCount} ${childCount === 1 ? 'картка' : 'карток'}`) : null),
    row.description ? el('div', { class: 'muted', style: 'font-size:12.5px' }, row.description) : null,
    tagList.length ? el('div', { class: 'row tight', style: 'gap:4px;flex-wrap:wrap' },
      ...tagList.map((t) => badge('tag', t))) : null,
    el('div', { class: 'list-card-foot' },
      el('span', { class: 'muted', style: 'font-size:12px' },
        [row.channel || null, row.body ? 'є текст' : null, Number(row.is_active) === 0 ? 'вимкнено' : null]
          .filter(Boolean).join(' · ') || 'розділ'),
      el('span', { class: 'list-card-actions' },
        canEdit ? el('button', {
          class: 'btn small icon-only', title: 'Редагувати',
          onclick: (e) => { e.stopPropagation(); cardForm(tree, { row, onSaved: reload }); },
        }, icon('edit', 14)) : null,
        canDelete ? el('button', {
          class: 'btn small icon-only danger', title: 'Видалити',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`Видалити картку «${row.name}»?`)) return;
            try {
              await api.del(`/message_templates/${row.id}`);
              toast('Видалено');
              await reload();
            } catch (err) { toast(err.message, true); }
          },
        }, icon('trash', 14)) : null)));

  card.addEventListener('click', () => { location.hash = `#/template/${row.id}`; });
  return card;
}

function gridOf(tree, parentId, opts, emptyText) {
  const children = tree.childrenOf(parentId || 0);
  if (!children.length) return el('div', { class: 'muted' }, emptyText);
  return el('div', { class: 'list-cards' }, ...children.map((row) => cardNode(tree, row, opts)));
}

export async function renderMessageTemplates() {
  const ent = state.meta.message_templates;
  const box = el('div', {});

  async function reload() {
    const tree = await loadTree();
    const opts = { canEdit: !!ent.can.update, canDelete: !!ent.can.delete, reload };
    box.textContent = '';
    box.append(
      el('div', { class: 'row', style: 'margin-bottom:14px;align-items:center' },
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          'Картки можна вкладати одна в одну: клік по картці відкриває те, що всередині неї'),
        el('div', { style: 'flex:1 1 auto;display:flex;justify-content:flex-end' },
          ent.can.create ? el('button', {
            class: 'btn primary',
            onclick: () => cardForm(tree, { parentId: null, onSaved: reload }),
          }, withIcon('plus', 'Додати')) : null)),
      gridOf(tree, 0, opts, 'Карток ще немає — натисніть «Додати»'));
  }

  await reload();
  return box;
}

// Сторінка однієї картки (#/template/:id): хлібні крихти до кореня, сама
// картка (опис, теги, текст) і картки, вкладені в неї.
export async function renderTemplateCardPage(id) {
  const ent = state.meta.message_templates;
  const page = el('div', {});

  async function reload() {
    const tree = await loadTree();
    const row = tree.byId.get(Number(id));
    if (!row) {
      page.textContent = '';
      page.append(el('div', { class: 'card muted' }, 'Картку не знайдено — можливо, її видалили'));
      return;
    }
    const opts = { canEdit: !!ent.can.update, canDelete: !!ent.can.delete, reload };
    const path = tree.pathOf(row);
    const tagList = splitTags(row.tags);

    const crumbs = el('div', { style: 'font-size:12.5px;display:flex;align-items:center;gap:4px;flex-wrap:wrap' },
      el('a', { href: '#/e/message_templates', style: 'display:inline-flex;align-items:center;gap:4px' },
        icon('chevronLeft', 13), 'Шаблони повідомлень'));
    for (const step of path.slice(0, -1)) {
      crumbs.append(icon('chevronRight', 12), el('a', { href: `#/template/${step.id}` }, step.name));
    }

    const content = [];
    if (row.subject) content.push(el('div', { class: 'muted', style: 'font-size:12.5px' }, `Тема: ${row.subject}`));
    if (row.body) content.push(el('pre', { class: 'template-body' }, row.body));
    if (row.variables) content.push(el('div', { class: 'muted', style: 'font-size:12px' }, `Змінні: ${row.variables}`));

    page.textContent = '';
    page.append(
      el('div', { style: 'margin-bottom:14px' },
        crumbs,
        el('h2', { style: 'margin:6px 0 2px' }, row.name),
        row.description ? el('div', { class: 'muted' }, row.description) : null,
        tagList.length ? el('div', { class: 'row tight', style: 'gap:4px;margin-top:6px;flex-wrap:wrap' },
          ...tagList.map((t) => badge('tag', t))) : null),
      content.length ? el('div', { class: 'card' },
        el('div', { class: 'row', style: 'align-items:center;margin-bottom:8px' },
          el('h3', { style: 'margin:0;flex:1 1 auto' }, icon('fileText'), 'Повідомлення'),
          ent.can.update ? el('button', {
            class: 'btn small icon-only', title: 'Редагувати картку',
            style: 'margin-left:auto;flex:0 0 auto',
            onclick: () => cardForm(tree, { row, onSaved: reload }),
          }, icon('edit', 15)) : null),
        ...content) : null,
      el('div', { class: 'card' },
        el('div', { class: 'row', style: 'align-items:center;margin-bottom:12px' },
          el('h3', { style: 'margin:0;flex:1 1 auto' }, icon('layers'), 'Усередині цієї картки'),
          el('div', { class: 'row tight', style: 'gap:6px;margin-left:auto;flex:0 0 auto' },
            !content.length && ent.can.update ? el('button', {
              class: 'btn small', onclick: () => cardForm(tree, { row, onSaved: reload }),
            }, withIcon('edit', 'Редагувати')) : null,
            ent.can.create ? el('button', {
              class: 'btn primary',
              onclick: () => cardForm(tree, { parentId: row.id, onSaved: reload }),
            }, withIcon('plus', 'Додати')) : null)),
        gridOf(tree, row.id, opts, 'Тут ще немає карток — натисніть «Додати», щоб створити першу')));
  }

  await reload();
  return page;
}
