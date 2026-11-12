import { t } from './i18n.js?v=routing-v05-20261112-1';

const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let preference = null;
try {
  const saved = localStorage.getItem('team-voice-theme');
  if (saved === 'light' || saved === 'dark') preference = saved;
} catch { /* Theme switching still works without storage. */ }

export function renderThemeToggle() {
  const button = document.querySelector('#theme-toggle');
  const dark = document.documentElement.dataset.theme === 'dark';
  button.dataset.i18nLabel = dark ? 'switchLightTheme' : 'switchDarkTheme';
  button.setAttribute('aria-label', t(button.dataset.i18nLabel));
  button.setAttribute('aria-pressed', String(dark));
  button.title = t(button.dataset.i18nLabel);
}

export function initTheme() {
  document.documentElement.dataset.theme = preference ?? (systemTheme.matches ? 'dark' : 'light');
  renderThemeToggle();
  document.querySelector('#theme-toggle').addEventListener('click', () => {
    preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = preference;
    try { localStorage.setItem('team-voice-theme', preference); } catch { /* Keep the in-memory choice. */ }
    renderThemeToggle();
  });
  systemTheme.addEventListener('change', event => {
    if (preference !== null) return;
    document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
    renderThemeToggle();
  });
}
