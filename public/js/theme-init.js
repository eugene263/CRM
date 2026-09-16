// Тему ставимо до першого малювання, щоб світлий інтерфейс не блимав темним.
// Окремим файлом, а не інлайном: CSP тримаємо строгим (default-src 'self').
(() => {
  let theme = null;
  try { theme = localStorage.getItem('crm_theme'); } catch { theme = null; }
  if (!theme) theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
})();
