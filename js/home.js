(() => {
  const key = 'riq-reduce-transparency';
  const system = window.matchMedia('(prefers-reduced-transparency: reduce)');
  const root = document.documentElement;

  function apply(reduced) {
    root.toggleAttribute('data-reduce-transparency', reduced);
    const control = document.querySelector('[data-transparency-toggle]');
    if (control) control.checked = reduced;
  }

  function sync() {
    let reduced = system.matches;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) reduced = saved === 'true';
    } catch {
      // The system preference still applies when storage is unavailable.
    }
    apply(reduced);
  }

  sync();
  system.addEventListener('change', sync);
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) sync();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const control = document.querySelector('[data-transparency-toggle]');
    if (!control) return;
    sync();
    control.closest('label').hidden = false;
    control.addEventListener('change', () => {
      apply(control.checked);
      try {
        localStorage.setItem(key, String(control.checked));
      } catch {
        // The current page still updates when storage is unavailable.
      }
    });
  });
})();
