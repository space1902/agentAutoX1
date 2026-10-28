export type Theme = "dark" | "light";

const KEY = "agentautox1.theme";

/** Default is dark; localStorage is a per-viewer convenience and may be unavailable. */
export function loadTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore: the theme just will not persist */
  }
}
