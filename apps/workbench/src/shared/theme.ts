// The colour theme preference (task d4a19e72): 跟随系统 / 浅色 / 深色, default 跟随系统. It is this browser's own choice, kept in localStorage; nothing goes to
// the project data or the server. If the storage cannot be read or written the page follows the system and keeps working. `public/theme-init.js` applies the
// same rule before the first paint; this module applies later changes and follows the system's light/dark switch while the preference is 跟随系统.
export type ThemePreference = "system" | "light" | "dark";
export const themeStorageKey = "evoloop.theme";
export const themeLabels: Record<ThemePreference, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
const listeners = new Set<() => void>();

export function readThemePreference(): ThemePreference {
  try { const saved = window.localStorage.getItem(themeStorageKey); return saved === "light" || saved === "dark" ? saved : "system"; } catch { return "system"; }
}
export function systemPrefersDark(): boolean { return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches; }
export function effectiveTheme(preference: ThemePreference): "light" | "dark" { return preference === "dark" || (preference === "system" && systemPrefersDark()) ? "dark" : "light"; }

/** Sets data-theme on <html>. The sample pages (/ui, /ui/flow) mark themselves with data-theme-sample and keep their own switch while they are open. */
export function applyTheme(preference: ThemePreference = readThemePreference()) {
  const root = document.documentElement;
  if (root.dataset.themeSample) return;
  const theme = effectiveTheme(preference);
  // Only when it differs: the pre-paint script has usually set it already, and a no-op write is still a change to anything watching the attribute.
  if (theme === "dark" && root.dataset.theme !== "dark") root.dataset.theme = "dark"; else if (theme === "light" && root.dataset.theme) delete root.dataset.theme;
  if (root.style.colorScheme !== theme) root.style.colorScheme = theme;
}

export function setThemePreference(preference: ThemePreference) {
  try { if (preference === "system") window.localStorage.removeItem(themeStorageKey); else window.localStorage.setItem(themeStorageKey, preference); } catch { /* not kept; still applied for this page */ }
  applyTheme(preference); listeners.forEach(listener => listener());
}
export function subscribeTheme(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Once at start: follow the system's switch (no reload) and another tab's change of the preference. */
export function installTheme() {
  applyTheme();
  if (typeof window.matchMedia === "function") {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (readThemePreference() === "system") applyTheme("system"); };
    if (query.addEventListener) query.addEventListener("change", onChange); else query.addListener?.(onChange);
  }
  window.addEventListener("storage", event => { if (event.key === themeStorageKey || event.key === null) { applyTheme(); listeners.forEach(listener => listener()); } });
}

/** For the sample pages: while open, they own data-theme; on leaving, the formal preference is applied again. */
export function claimThemeForSample(): () => void {
  document.documentElement.dataset.themeSample = "1";
  return () => { delete document.documentElement.dataset.themeSample; applyTheme(); };
}
