// Реальний веб-пошук для AI-чату через Tavily — на відміну від вбудованого
// Google Search grounding у Gemini (який вимагає платного білінгу навіть за
// один пошуковий запит — перевірено напряму на реальних ключах, 429 «check
// your plan and billing»), у Tavily є справжній безкоштовний рівень
// (1000 запитів/міс, без картки), спеціально під AI-агентів.
export function hasWebSearch() {
  return !!process.env.TAVILY_API_KEY;
}

export async function webSearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('Веб-пошук не налаштовано: додайте TAVILY_API_KEY сервісу crm на Railway'), { status: 400 });
  }
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 5, include_answer: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Веб-пошук: помилка Tavily API (${res.status}): ${text.slice(0, 300)}`), { status: 502 });
  }
  const data = await res.json();
  return {
    answer: data.answer || null,
    results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
  };
}
