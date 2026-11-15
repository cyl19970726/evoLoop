/* Applies the stored colour theme before the first paint (task d4a19e72). A separate file, not an inline script: the page's CSP only allows scripts from its own origin.
   The same rule lives in src/shared/theme.ts; a test keeps the storage key and the values equal. Storage that cannot be read means 跟随系统. */
(function () {
  var preference = "system";
  try { var saved = window.localStorage.getItem("evoloop.theme"); if (saved === "light" || saved === "dark") preference = saved; } catch (e) { /* unreadable: follow the system */ }
  var dark = preference === "dark" || (preference === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  if (dark) root.setAttribute("data-theme", "dark"); else root.removeAttribute("data-theme");
  root.style.colorScheme = dark ? "dark" : "light";
})();
