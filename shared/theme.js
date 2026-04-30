(() => {
  const STORAGE_KEY = "riq-theme";
  const THEMES = new Set(["dark", "light"]);

  function readTheme() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return THEMES.has(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  function defaultTheme() {
    const configured = document.documentElement.getAttribute("data-default-theme");
    return THEMES.has(configured) ? configured : "dark";
  }

  function activeTheme() {
    return readTheme() || document.documentElement.getAttribute("data-theme") || defaultTheme();
  }

  function persistTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Theme persistence is optional; the current page still updates.
    }
  }

  function setTheme(theme) {
    const next = THEMES.has(theme) ? theme : defaultTheme();
    document.documentElement.setAttribute("data-theme", next);
    persistTheme(next);
    syncToggle(next);
  }

  function syncToggle(theme) {
    const toggle = document.querySelector("[data-theme-toggle]");
    if (!toggle) return;
    const isDark = theme === "dark";
    toggle.setAttribute("aria-pressed", isDark ? "true" : "false");
    toggle.setAttribute("aria-label", isDark ? "Alternar para tema claro" : "Alternar para tema escuro");
    toggle.setAttribute("title", isDark ? "Alternar para tema claro" : "Alternar para tema escuro");
  }

  function homeHref() {
    return document.body.getAttribute("data-home-href") ||
      document.documentElement.getAttribute("data-home-href") ||
      "";
  }

  function createHomeLink() {
    const href = homeHref();
    if (!href || document.querySelector("[data-theme-home]")) return null;
    const link = document.createElement("a");
    link.className = "theme-home-link";
    link.href = href;
    link.setAttribute("data-theme-home", "");
    link.setAttribute("aria-label", "Ir para o início");
    link.setAttribute("title", "Início");
    link.textContent = "⌂";
    return link;
  }

  function createToggle() {
    if (document.querySelector("[data-theme-toggle]")) return null;
    const button = document.createElement("button");
    button.className = "theme-toggle";
    button.type = "button";
    button.setAttribute("data-theme-toggle", "");
    button.innerHTML = [
      '<span class="theme-toggle__icon" aria-hidden="true">☀</span>',
      '<span class="theme-toggle__rail" aria-hidden="true"><span class="theme-toggle__thumb"></span></span>',
      '<span class="theme-toggle__icon" aria-hidden="true">☾</span>',
    ].join("");
    button.addEventListener("click", () => {
      setTheme(activeTheme() === "dark" ? "light" : "dark");
    });
    return button;
  }

  function mountControls() {
    const slot = document.querySelector("[data-theme-slot]");
    const home = createHomeLink();
    const toggle = createToggle();
    if (!home && !toggle) return;

    if (slot) {
      if (home) slot.appendChild(home);
      if (toggle) slot.appendChild(toggle);
      return;
    }

    if (home) {
      home.classList.add("theme-home-link--floating");
      document.body.appendChild(home);
    }
    if (toggle) {
      toggle.classList.add("theme-toggle--floating");
      document.body.appendChild(toggle);
    }
  }

  setTheme(activeTheme());
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountControls);
  } else {
    mountControls();
  }
})();
