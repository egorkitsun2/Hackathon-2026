// Runs before the stylesheet so a saved/system dark theme is applied before paint.
(() => {
  let saved;
  try { saved = localStorage.getItem('team-voice-theme'); } catch { /* Storage may be blocked. */ }
  document.documentElement.dataset.theme = saved === 'light' || saved === 'dark'
    ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();
