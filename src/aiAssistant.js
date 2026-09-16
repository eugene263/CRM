// AI-чат-асистент (плаваюча кнопка «AI» скрізь у CRM): користувач пише
// задачу природною мовою, Gemini виконує її через ті самі функції
// генерик-CRUD (listEntityRows/createEntityRecord/updateEntityRecord), що
// й REST API, — тобто права та скоуп ролі діють однаково, чат не може
// нічого, чого не може сам користувач у звичайному інтерфейсі. Видалення
// записів свідомо не дали як інструмент — це рідкісна дія з високою ціною
// помилки, тож нехай лишається лише через звичайну форму з підтвердженням.
import { entities } from './entities.js';
import { can, visibleFields } from './rbac.js';
import { listEntityRows, createEntityRecord, updateEntityRecord } from './api.js';
import { hasGeminiKeys, geminiRequest } from './ai.js';
import { hasWebSearch, webSearch } from './webSearch.js';

// Google Search grounding у самому Gemini вимагає платного білінгу навіть за
// один пошуковий запит (перевірено напряму на реальних ключах — 429 «check
// your plan and billing» щоразу, коли в tools є google_search) — тому
// реальний веб-пошук підключений окремо через Tavily (безкоштовний рівень,
// без картки), як ще один інструмент у тому самому function-calling циклі.
function systemPrompt() {
  const webSearchLine = hasWebSearch()
    ? '\n\nУ тебе Є доступ до реального веб-пошуку через інструмент web_search (короткі фрагменти сторінок, не повний текст). Використовуй його, коли задача вимагає перевірити чи знайти реальний факт з інтернету (сайт, контакти, чи існує компанія тощо) — і все одно чітко познач у відповіді, що дані знайдені пошуком і варті ручної перевірки, а не видавай їх як стовідсотково підтверджені.'
    : '\n\nКРИТИЧНО ВАЖЛИВО: у тебе немає доступу до інтернету, пошуку чи будь-якої зовнішньої бази даних — тільки до того, що вже є в CRM через інструменти. Якщо задача вимагає реальних фактів, яких там немає (знайти телефон/email/сайт конкретного бізнесу, перевірити, чи компанія існує, тощо) — НІКОЛИ не вигадуй правдоподібні значення й не записуй їх у CRM як факт. Чесно скажи користувачу, що в тебе немає способу це реально знайти, і запропонуй, що можеш замість цього (наприклад, показати, яких контактів бракує, або структурувати те, що користувач сам надасть).';

  return `Ти — AI-асистент у CRM Gennect. Ти можеш переглядати й змінювати дані через надані інструменти (list_entities, describe_entity, find_records, create_record, update_record). Ці інструменти автоматично враховують права поточного користувача — якщо інструмент відмовив через брак прав, повідом про це користувачу, а не шукай обхідний шлях.${webSearchLine}

Правила:
- Перш ніж створити чи оновити запис у сутності, якщо не певен точних назв полів, виклич describe_entity.
- Не вигадуй значення обовʼязкових полів, яких користувач не назвав, — краще запитай уточнення одним коротким реченням.
- Коли дію виконано, коротко підтверди природною мовою, що саме зроблено і з якими значеннями.
- Якщо інструмент повернув помилку — поясни її користувачу простими словами.
- Відповідай українською, стисло і по суті.`;
}

function tools() {
  const declarations = [
    {
      name: 'list_entities',
      description: 'Список розділів CRM, доступних користувачу для читання, з правами на створення/редагування.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'describe_entity',
      description: 'Поля сутності (назва, тип, обовʼязковість, варіанти значень) — виклич перед create_record/update_record.',
      parameters: {
        type: 'OBJECT',
        properties: { entity: { type: 'STRING', description: 'Технічний ключ сутності, напр. leads, prospect_lists, clients, services' } },
        required: ['entity'],
      },
    },
    {
      name: 'find_records',
      description: 'Пошук записів сутності. q — пошук по текстових полях, filters_json — JSON-об’єкт точних фільтрів (напр. {"status":"new"}).',
      parameters: {
        type: 'OBJECT',
        properties: {
          entity: { type: 'STRING' },
          q: { type: 'STRING' },
          filters_json: { type: 'STRING' },
          limit: { type: 'NUMBER' },
        },
        required: ['entity'],
      },
    },
    {
      name: 'create_record',
      description: 'Створити новий запис. fields_json — JSON-об’єкт значень полів (дивись describe_entity для списку й обовʼязкових).',
      parameters: {
        type: 'OBJECT',
        properties: { entity: { type: 'STRING' }, fields_json: { type: 'STRING' } },
        required: ['entity', 'fields_json'],
      },
    },
    {
      name: 'update_record',
      description: 'Оновити наявний запис за id. fields_json — JSON-об’єкт лише тих полів, які треба змінити.',
      parameters: {
        type: 'OBJECT',
        properties: { entity: { type: 'STRING' }, id: { type: 'NUMBER' }, fields_json: { type: 'STRING' } },
        required: ['entity', 'id', 'fields_json'],
      },
    },
  ];
  if (hasWebSearch()) {
    declarations.push({
      name: 'web_search',
      description: 'Реальний пошук в інтернеті (Tavily) — короткі фрагменти сторінок і посилання. Використовуй, коли треба перевірити чи знайти факт, якого немає в CRM.',
      parameters: {
        type: 'OBJECT',
        properties: { query: { type: 'STRING' } },
        required: ['query'],
      },
    });
  }
  return [{ functionDeclarations: declarations }];
}

async function runTool(user, name, args) {
  try {
    if (name === 'list_entities') {
      return Object.entries(entities)
        .filter(([key]) => can(user, key, 'read'))
        .map(([key, ent]) => ({ key, label: ent.label, canCreate: can(user, key, 'create'), canUpdate: can(user, key, 'update') }));
    }
    if (name === 'describe_entity') {
      const ent = entities[args.entity];
      if (!ent) return { error: 'Невідома сутність' };
      if (!can(user, args.entity, 'read')) return { error: 'Немає доступу до цієї сутності' };
      return {
        label: ent.label,
        fields: visibleFields(user, args.entity).map((f) => ({
          name: f.name, label: f.label, type: f.type, required: !!f.required,
          ref: f.ref || undefined, options: f.options?.map((o) => o.value),
        })),
      };
    }
    if (name === 'find_records') {
      const filters = args.filters_json ? JSON.parse(args.filters_json) : {};
      const { rows, total } = await listEntityRows(user, args.entity, { ...filters, q: args.q, limit: args.limit || 10 });
      return { total, rows };
    }
    if (name === 'create_record') {
      const fields = JSON.parse(args.fields_json);
      const row = await createEntityRecord(user, args.entity, fields, null);
      return { ok: true, row };
    }
    if (name === 'update_record') {
      const fields = JSON.parse(args.fields_json);
      const row = await updateEntityRecord(user, args.entity, Number(args.id), fields, null);
      return { ok: true, row };
    }
    if (name === 'web_search') {
      return await webSearch(args.query);
    }
    return { error: 'Невідомий інструмент' };
  } catch (e) {
    return { error: e.message || 'Помилка виконання' };
  }
}

const MAX_STEPS = 6;

export async function runAiChat(user, messages) {
  const contents = (messages || [])
    .filter((m) => m && m.text)
    .slice(-20)
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.text).slice(0, 4000) }] }));
  if (!contents.length) throw Object.assign(new Error('Порожнє повідомлення'), { status: 400 });
  if (!hasGeminiKeys()) {
    throw Object.assign(new Error('AI-чат не налаштовано: додайте змінну середовища GEMINI_API_KEY(S) сервісу crm на Railway'), { status: 400 });
  }

  const actions = [];
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const data = await geminiRequest({ systemInstruction: { parts: [{ text: systemPrompt() }] }, tools: tools(), contents });
    const parts = data.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const text = parts.map((p) => p.text || '').join('').trim() || 'Не отримав відповіді від AI.';
      return { text, actions };
    }
    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const p of calls) {
      const result = await runTool(user, p.functionCall.name, p.functionCall.args || {});
      if ((p.functionCall.name === 'create_record' || p.functionCall.name === 'update_record') && result.ok) {
        actions.push({ tool: p.functionCall.name, entity: p.functionCall.args.entity, row: result.row });
      }
      // Gemini вимагає, щоб functionResponse.response був JSON-об'єктом, а не
      // масивом чи скаляром, — загортаємо все в { result } для однаковості.
      const response = Array.isArray(result) || result === null || typeof result !== 'object' ? { result } : result;
      responseParts.push({ functionResponse: { name: p.functionCall.name, response } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  return { text: 'Забагато кроків для цієї задачі — спробуй сформулювати простіше або розбий на частини.', actions };
}
