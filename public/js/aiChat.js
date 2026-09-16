// Плаваюча кнопка «AI» скрізь у CRM: попап-чат, де можна написати задачу
// природною мовою («додай ліда...», «познач X як програно» тощо) — сервер
// (aiAssistant.js) сам виконує її через ті самі права/скоуп, що й звичайний
// інтерфейс. Історія живе лише в памʼяті сторінки — навмисно без збереження,
// щоб не обіцяти постійність, якої немає.
import { api } from './api.js';
import { el, toast } from './ui.js';
import { icon, withIcon } from './icons.js';

const messages = []; // { role: 'user' | 'assistant', text }
let panelOpen = false;
let sending = false;
let messagesBox = null;
let panel = null;

function renderMessages() {
  if (!messagesBox) return;
  messagesBox.textContent = '';
  if (!messages.length) {
    messagesBox.append(el('div', { class: 'ai-chat-empty' },
      'Напиши задачу — наприклад: «додай ліда Кавʼярня Х у список Львів вересень» або «познач лід #12 як програний, причина — дорого».'));
  }
  for (const m of messages) {
    messagesBox.append(el('div', { class: `ai-msg ${m.role}` }, m.text));
  }
  if (sending) messagesBox.append(el('div', { class: 'ai-msg assistant pending' }, 'Друкує…'));
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

async function send(text) {
  messages.push({ role: 'user', text });
  sending = true;
  renderMessages();
  try {
    const res = await api.post('/ai/chat', { messages });
    messages.push({ role: 'assistant', text: res.text });
    for (const a of res.actions || []) {
      const label = a.tool === 'create_record' ? 'Створено' : 'Оновлено';
      messages.push({ role: 'assistant', text: `✅ ${label}: ${a.entity} #${a.row?.id ?? ''}` });
    }
  } catch (e) {
    messages.push({ role: 'assistant', text: `⚠️ ${e.message}` });
  } finally {
    sending = false;
    renderMessages();
  }
}

function buildPanel() {
  const textarea = el('textarea', {
    placeholder: 'Напиши задачу для AI…', rows: 2,
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
  });
  const submit = () => {
    const text = textarea.value.trim();
    if (!text || sending) return;
    textarea.value = '';
    send(text);
  };
  messagesBox = el('div', { class: 'ai-chat-messages' });
  renderMessages();
  return el('div', { class: 'ai-chat-panel' },
    el('div', { class: 'ai-chat-header' },
      withIcon('sparkles', 'AI-асистент'),
      el('button', { class: 'btn small', onclick: closePanel }, icon('minus', 14))),
    messagesBox,
    el('div', { class: 'ai-chat-input-row' },
      textarea,
      el('button', { class: 'btn primary small', onclick: submit }, icon('send', 15))));
}

function closePanel() {
  panelOpen = false;
  panel?.remove();
  panel = null;
  messagesBox = null;
}

function openPanel() {
  panelOpen = true;
  panel = buildPanel();
  document.body.append(panel);
}

export function mountAiButton() {
  if (document.querySelector('.ai-fab')) return;
  const fab = el('button', { class: 'ai-fab', title: 'AI-асистент', onclick: () => (panelOpen ? closePanel() : openPanel()) },
    icon('sparkles', 22));
  document.body.append(fab);
}
