export type ThemeMode = "system" | "light" | "dark";

const KEY = "flowdeck.theme";

export function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage 不可用时跟随系统 */
  }
  return "system";
}

export function saveThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* 忽略 */
  }
}

/** 把有效主题写到 <html data-theme>，返回实际生效的浅 / 深色 */
export function applyTheme(mode: ThemeMode): "light" | "dark" {
  const prefersDark =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false;
  const resolved = mode === "dark" || (mode === "system" && prefersDark) ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  return resolved;
}
