// 表示設定だけを保存する。契約データの保存とは独立。
const Theme = (() => {
  const KEY = 'keiyaku_theme_v1';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (_) {}
  if (!['light','dark'].includes(saved)) saved = null;
  function apply(mode) {
    document.documentElement.dataset.theme = mode;
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === mode));
    });
  }
  apply(saved || (system.matches ? 'dark' : 'light'));
  system.addEventListener('change', event => { if (!saved) apply(event.matches ? 'dark' : 'light'); });
  function init() {
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.addEventListener('click', () => {
        saved = button.dataset.themeChoice;
        apply(saved);
        try { localStorage.setItem(KEY,saved); } catch (_) {}
      });
    });
    apply(document.documentElement.dataset.theme);
  }
  return {init};
})();
