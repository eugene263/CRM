// Шаблони скриптів: на відміну від message_templates (готовий текст
// повідомлення, який відправляють у DM/email), скрипт — це послідовність
// кроків розмови для дзвінка чи зустрічі плюс окремий блок
// «заперечення → відповідь», який шукають під час розмови, а не читають
// підряд.
import { all, get, run, insert, update } from './db.js';

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

const DEFAULT_SCRIPTS = [
  {
    name: 'Холодний дзвінок: перший контакт',
    category: 'cold_call',
    channel: 'call',
    description: 'Перший дзвінок бізнесу, якого ще не торкались. Мета — не продати, а домовитись на 10 хв демо.',
    steps: [
      ['step', 'Привітання', 'Добрий день, це {{company}}? Мене звати {{manager_name}}, я з Gennect — знімаємо короткі відео для бізнесів у {{city}}.'],
      ['step', 'Причина дзвінка', 'Побачив(ла) ваш акаунт — {{days_since_post}} днів без нового відео, хоча раніше постили регулярно. Зняли для вас приклад ролика на пробу, хочу показати.'],
      ['step', 'Виявлення потреби', 'Скажіть, а зараз хтось у команді знімає контент, чи це поки на паузі? Що заважає постити частіше — час, ідеї чи монтаж?'],
      ['step', 'Пропозиція', 'У нас пакет — 30 роликів на місяць під ключ, від сценарію до монтажу. Можу скинути приклад і коротко розказати, як це працює — 10 хвилин, зручно завтра о 15:00 чи ввечері?'],
      ['step', 'Закриття', 'Домовились, надішлю посилання на демо-ролик і нагадування напередодні. Дякую за час!'],
    ],
    objections: [
      ['Дорого', 'Розумію. Порахуймо на прикладі: скільки зараз коштує вам одне відео власними силами — час монтажера, зйомка? Часто виходить дорожче за пакетну ціну, просто ви це не рахували окремим рядком.'],
      ['Немає часу зараз', 'Це і є причина звернутись — ми забираємо саме виробництво на себе, від вас лише 15 хв на узгодження сценарію. Коли зручніше повернутись до розмови — на цьому тижні чи наступному?'],
      ['Уже працюємо з підрядником', 'Добре, що контент вже в роботі. Можу лишити приклад нашої роботи — якщо колись будете порівнювати варіанти, буде з чим звірити. Не проти, якщо надішлю?'],
      ['Не бачу сенсу в TikTok/Reels для нашого бізнесу', 'Часта думка до першого прикладу. Скину короткий кейс схожого бізнесу з цифрами — подивіться, коли зручно, і повернемось до розмови.'],
    ],
  },
  {
    name: 'Демо-дзвінок: презентація прикладу',
    category: 'demo',
    channel: 'meeting',
    description: 'Заплановані 10–15 хв після того, як лід погодився подивитись приклад ролика.',
    steps: [
      ['step', 'Привітання', 'Дякую, що знайшли час. Коротко нагадаю: ми зробили для вас приклад ролика на основі вашого профілю — покажу і розкажу, як це масштабувати.'],
      ['step', 'Показ прикладу', 'Ось ролик [посилання]. Звертаю увагу на хук у перші 2 секунди і на те, як показано продукт — саме це впливає на утримання глядача.'],
      ['step', 'Формат співпраці', 'Працюємо пакетами: 30 роликів на місяць, ви даєте доступ до продукту/локації раз на тиждень для зйомки, решту робимо ми.'],
      ['step', 'Ціна й умови', 'Пакет коштує {{price}}, оплата помісячно, перший місяць можна почати з меншого обсягу, щоб оцінити результат.'],
      ['step', 'Наступний крок', 'Якщо готові — надішлю договір і зберемо перший сценарій цього тижня. Що скажете?'],
    ],
    objections: [
      ['Треба порадитись', 'Звісно. Що саме важливо обговорити — бюджет чи формат контенту? Можу підготувати додаткові матеріали під це.'],
      ['А що як не спрацює', 'Тому й пропоную почати з меншого обсягу на перший місяць — оцінимо динаміку охоплень і зупинимось, якщо не підійде.'],
    ],
  },
];

export async function seedScripts() {
  if (await get('SELECT id FROM scripts LIMIT 1')) return { seeded: 0 };
  for (const s of DEFAULT_SCRIPTS) {
    const id = await insert('scripts', {
      name: s.name, category: s.category, channel: s.channel, description: s.description, is_active: 1,
    });
    let order = 10;
    for (const [kind, title, body] of s.steps) {
      await insert('script_steps', { script_id: id, kind, title, body, sort_order: order });
      order += 10;
    }
    order = 10;
    for (const [title, body] of s.objections) {
      await insert('script_steps', { script_id: id, kind: 'objection', title, body, sort_order: order });
      order += 10;
    }
  }
  return { seeded: DEFAULT_SCRIPTS.length };
}

export async function scriptWithSteps(scriptId) {
  const script = await get('SELECT * FROM scripts WHERE id=?', scriptId);
  if (!script) throw Object.assign(new Error('Скрипт не знайдено'), { status: 404 });
  const rows = await all('SELECT * FROM script_steps WHERE script_id=? ORDER BY sort_order, id', scriptId);
  return {
    script,
    steps: rows.filter((r) => r.kind === 'step'),
    objections: rows.filter((r) => r.kind === 'objection'),
  };
}

export async function listActiveScripts({ channel = null } = {}) {
  const rows = await all(
    `SELECT * FROM scripts WHERE is_active=1 ${channel ? 'AND channel=?' : ''} ORDER BY name`,
    ...(channel ? [channel] : []),
  );
  const withCounts = [];
  for (const s of rows) {
    const steps = Number((await get(`SELECT COUNT(*) AS c FROM script_steps WHERE script_id=? AND kind='step'`, s.id))?.c || 0);
    withCounts.push({ ...s, steps_count: steps });
  }
  return withCounts;
}

export async function saveStep(scriptId, payload) {
  const data = {
    script_id: scriptId,
    kind: payload.kind === 'objection' ? 'objection' : 'step',
    title: String(payload.title || '').trim(),
    body: payload.body ?? null,
    sort_order: Number(payload.sort_order || 100),
  };
  if (!data.title) throw Object.assign(new Error('Потрібен заголовок кроку'), { status: 400 });
  if (payload.id) {
    await update('script_steps', Number(payload.id), data);
  } else {
    await insert('script_steps', data);
  }
  await update('scripts', scriptId, { updated_at: now() });
  return scriptWithSteps(scriptId);
}

export async function deleteStep(scriptId, stepId) {
  await run('DELETE FROM script_steps WHERE id=? AND script_id=?', stepId, scriptId);
  return scriptWithSteps(scriptId);
}

export async function duplicateScript(scriptId, actorId) {
  const { script, steps, objections } = await scriptWithSteps(scriptId);
  const id = await insert('scripts', {
    name: `${script.name} (копія)`, category: script.category, channel: script.channel,
    description: script.description, is_active: 0, created_by: actorId,
  });
  for (const row of [...steps, ...objections]) {
    await insert('script_steps', { script_id: id, kind: row.kind, title: row.title, body: row.body, sort_order: row.sort_order });
  }
  return scriptWithSteps(id);
}
