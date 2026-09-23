// «Підключення клієнта»: дерево канв Excalidraw під клієнтом — папка в
// папці, як у Notion, тільки замість тексту всередині кожного вузла
// повноцінна дошка з картками й стрілочками. Клік по картці-посиланню на
// канві веде в дочірню мапу — у межах нашого SPA-роутера (onLinkOpen),
// без відкриття нової вкладки.
//
// Excalidraw — React-бібліотека, а решта фронтенду навмисно без React і
// без збірника; тому вантажимо React/ReactDOM/Excalidraw лише на цій
// сторінці через офіційно задокументований шлях без бандлера — ESM CDN
// (esm.sh) + import map (лежить у public/index.html, фіксує одну спільну
// версію react/react-dom, інакше в Excalidraw ламаються хуки).
import { api } from '../api.js';
import { state } from '../app.js';
import { el, modal, toast, actionButton } from '../ui.js';
import { icon, withIcon } from '../icons.js';

const EXCALIDRAW_VERSION = '0.18.0';
const REACT_VERSION = '19.0.0';

let libsPromise = null;
function loadExcalidraw() {
  if (!libsPromise) {
    libsPromise = (async () => {
      if (!document.getElementById('excalidraw-css')) {
        const link = el('link', {
          id: 'excalidraw-css', rel: 'stylesheet',
          href: `https://esm.sh/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}/dist/dev/index.css`,
        });
        document.head.append(link);
      }
      // Шрифти й іконки Excalidraw тягне з цього шляху — задати ДО імпорту,
      // як і радить офіційна документація для non-bundler інтеграції.
      window.EXCALIDRAW_ASSET_PATH = `https://esm.sh/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}/dist/prod/`;
      const [React, { createRoot }, ExcalidrawLib] = await Promise.all([
        import('react'),
        import('react-dom/client'),
        import(`https://esm.sh/@excalidraw/excalidraw@${EXCALIDRAW_VERSION}/dist/dev/index.js?external=react,react-dom`),
      ]);
      return { React: React.default || React, createRoot, ExcalidrawLib };
    })();
  }
  return libsPromise;
}

// ── Сторінка-пікер: картки клієнтів, клік відкриває/створює їхню мапу ────
export async function renderClientMapsPicker() {
  const box = el('div', {});
  const { rows } = await api.get('/clients?limit=300');
  box.append(
    el('div', { class: 'muted', style: 'margin-bottom:14px;font-size:12.5px' },
      'Оберіть клієнта — відкриється (або створиться) дошка з картками й стрілочками для нього'),
    rows.length ? el('div', { class: 'list-cards' }, ...rows.map((c) => {
      const card = el('div', { class: 'list-card' },
        el('div', { class: 'list-card-head' }, el('b', {}, c.name)),
        el('div', { class: 'muted', style: 'font-size:12.5px' },
          [c.geo_city, c.geo_country].filter(Boolean).join(', ') || '—'));
      card.addEventListener('click', async () => {
        try {
          const { id } = await api.get(`/client_maps/root?client_id=${c.id}`);
          location.hash = `#/map/${id}`;
        } catch (e) { toast(e.message, true); }
      });
      return card;
    })) : el('div', { class: 'card muted' }, 'Клієнтів ще немає'));
  return box;
}

// ── Сторінка канви (#/map/:id) ───────────────────────────────────────────
export async function renderMapCanvas(mapId) {
  const ent = state.meta.client_maps;
  const canEdit = !!ent.can.update;
  const canCreate = !!ent.can.create;
  const canDelete = !!ent.can.delete;

  const page = el('div', { style: 'display:flex;flex-direction:column;height:100%' });
  const crumbBar = el('div', { style: 'margin-bottom:10px' });
  const canvasHost = el('div', { class: 'excalidraw-embed' });
  page.append(crumbBar, canvasHost);

  canvasHost.append(el('div', { class: 'muted', style: 'padding:40px;text-align:center' }, 'Завантажую дошку…'));

  let excalidrawAPI = null;
  let saveTimer = null;
  let destroyed = false;
  const stop = () => {
    destroyed = true;
    if (saveTimer) clearTimeout(saveTimer);
    window.removeEventListener('hashchange', stop);
  };
  window.addEventListener('hashchange', stop, { once: true });

  let node, scene, libs;
  try {
    [{ node, scene }, libs] = await Promise.all([
      api.get(`/client_maps/${mapId}/scene`),
      loadExcalidraw(),
    ]);
  } catch (e) {
    canvasHost.textContent = '';
    canvasHost.append(el('div', { class: 'card', style: 'margin:20px' },
      el('div', { class: 'error' }, 'Не вдалося завантажити редактор дошки (Excalidraw) — перевірте інтернет-зʼєднання.'),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, String(e?.message || e)),
      el('button', { class: 'btn small', style: 'margin-top:10px', onclick: () => renderMapCanvas(mapId).then((p) => {
        page.replaceWith(p); return p;
      }) }, 'Спробувати ще раз')));
    return page;
  }
  if (destroyed) return page;
  const { rows: treeRows } = await api.get(`/client_maps/tree?client_id=${node.client_id}`);
  if (destroyed) return page;

  const { React, createRoot, ExcalidrawLib } = libs;
  const byId = new Map(treeRows.map((r) => [r.id, r]));

  function breadcrumbPath() {
    const path = [];
    for (let cur = byId.get(node.id), hops = 0; cur && hops < 50; hops += 1) {
      path.unshift(cur);
      cur = cur.parent_id == null ? null : byId.get(cur.parent_id);
    }
    return path;
  }

  function renderCrumbs() {
    crumbBar.textContent = '';
    const row = el('div', { class: 'row', style: 'align-items:center;gap:8px' },
      el('a', { href: '#/e/client_maps', style: 'display:inline-flex;align-items:center;gap:4px;font-size:12.5px' },
        icon('chevronLeft', 13), 'Підключення клієнта'));
    for (const step of breadcrumbPath()) {
      row.append(icon('chevronRight', 12),
        step.id === node.id
          ? el('b', { style: 'font-size:13.5px' }, step.name)
          : el('a', { href: `#/map/${step.id}`, style: 'font-size:13.5px' }, step.name));
    }
    row.append(
      el('div', { style: 'flex:1 1 auto' }),
      canEdit ? el('button', {
        class: 'btn small icon-only', title: 'Перейменувати',
        onclick: () => renameModal(),
      }, icon('edit', 14)) : null,
      canCreate ? el('button', {
        class: 'btn small', onclick: () => addChildModal(),
      }, withIcon('plus', 'Вкладена мапа')) : null,
      canDelete ? el('button', {
        class: 'btn small icon-only danger', title: 'Видалити цю мапу',
        onclick: () => deleteThis(),
      }, icon('trash', 14)) : null);
    crumbBar.append(row);
  }

  function renameModal() {
    const input = el('input', { value: node.name });
    const box = modal('Назва мапи', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
      [actionButton('Зберегти', async () => {
        if (!input.value.trim()) return toast('Потрібна назва', true);
        try {
          await api.put(`/client_maps/${node.id}`, { name: input.value.trim() });
          node.name = input.value.trim();
          const treeNode = byId.get(node.id);
          if (treeNode) treeNode.name = node.name;
          box.remove();
          renderCrumbs();
        } catch (e) { toast(e.message, true); }
      })]);
  }

  function deleteThis() {
    if (!confirm(`Видалити мапу «${node.name}»?`)) return;
    api.del(`/client_maps/${node.id}`)
      .then(() => { location.hash = node.parent_id ? `#/map/${node.parent_id}` : '#/e/client_maps'; })
      .catch((e) => toast(e.message, true));
  }

  // Нова вкладена мапа: створює рядок у дереві на бекенді, а картку-
  // посилання на канві збирає офіційним способом Excalidraw
  // (convertToExcalidrawElements) — самі не рахуємо схему елемента.
  function addChildModal() {
    const input = el('input', { placeholder: 'Наприклад: Ферма UA-1' });
    const box = modal('Нова вкладена мапа', el('div', { class: 'field' }, el('label', {}, 'Назва'), input),
      [actionButton('Створити', async () => {
        if (!input.value.trim()) return toast('Потрібна назва', true);
        try {
          const { id, index } = await api.post(`/client_maps/${node.id}/children`, { name: input.value.trim() });
          const col = index % 4, row2 = Math.floor(index / 4);
          const [skeletonEl] = ExcalidrawLib.convertToExcalidrawElements([{
            type: 'rectangle', x: 60 + col * 260, y: 60 + row2 * 160, width: 220, height: 100,
            backgroundColor: '#e9edfc', strokeColor: '#6c8cff', roundness: { type: 3 },
            label: { text: input.value.trim(), fontSize: 16 },
            link: `#/map/${id}`,
          }]);
          const current = excalidrawAPI.getSceneElements();
          excalidrawAPI.updateScene({ elements: [...current, skeletonEl] });
          box.remove();
          scheduleSave();
        } catch (e) { toast(e.message, true); }
      })]);
  }

  function scheduleSave() {
    if (!canEdit || !excalidrawAPI) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (destroyed) return;
      const elements = excalidrawAPI.getSceneElements();
      const appState = excalidrawAPI.getAppState();
      try {
        await api.put(`/client_maps/${node.id}/scene`, {
          scene: {
            elements,
            appState: {
              viewBackgroundColor: appState.viewBackgroundColor,
              scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom,
            },
          },
        });
      } catch (e) { toast(e.message, true); }
    }, 800);
  }

  renderCrumbs();
  canvasHost.textContent = '';
  const root = createRoot(canvasHost);
  root.render(React.createElement(ExcalidrawLib.Excalidraw, {
    initialData: { elements: scene.elements || [], appState: scene.appState || {} },
    viewModeEnabled: !canEdit,
    excalidrawAPI: (apiRef) => { excalidrawAPI = apiRef; },
    onChange: () => scheduleSave(),
    onLinkOpen: (element, event) => {
      const link = element.link;
      if (!link) return;
      const { nativeEvent } = event.detail;
      const isNewTab = nativeEvent.ctrlKey || nativeEvent.metaKey || nativeEvent.shiftKey;
      if (link.startsWith('#/') && !isNewTab) {
        event.preventDefault();
        location.hash = link;
      }
    },
  }));

  return page;
}
