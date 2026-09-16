// Тонкий клієнт до Gemini API. GEMINI_API_KEYS може містити кілька ключів
// через кому (кілька безкоштовних акаунтів = вищий сумарний ліміт запитів
// на хвилину/день) — по колу на кожен виклик, а на 429 (ліміт вичерпано)
// пробуємо наступний ключ зі списку, перш ніж провалитись.
function geminiKeys() {
  const list = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return list.split(',').map((k) => k.trim()).filter(Boolean);
}

export function hasGeminiKeys() {
  return geminiKeys().length > 0;
}

let geminiKeyCursor = 0;

export async function geminiRequest(body) {
  const model = 'gemini-3.6-flash';
  const keys = geminiKeys();
  if (!keys.length) {
    throw Object.assign(new Error('Gemini не налаштовано: додайте GEMINI_API_KEY(S)'), { status: 400 });
  }
  let lastError;
  for (let i = 0; i < keys.length; i += 1) {
    const apiKey = keys[(geminiKeyCursor + i) % keys.length];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      geminiKeyCursor = (geminiKeyCursor + i + 1) % keys.length;
      return res.json();
    }
    const text = await res.text();
    lastError = Object.assign(new Error(`AI: помилка Gemini API (${res.status}): ${text.slice(0, 300)}`), { status: 502 });
    if (res.status !== 429) throw lastError;
  }
  throw lastError;
}

export async function geminiText(prompt) {
  const data = await geminiRequest({ contents: [{ parts: [{ text: prompt }] }] });
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}
