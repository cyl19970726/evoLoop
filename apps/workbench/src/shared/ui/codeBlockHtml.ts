// The markup of a fenced code block (Task 5415aed3), pure so the Markdown parser and the tests use it without the UI.
const icon = (paths: string) => `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
export const copyIcon = icon('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>');
export const wrapIcon = icon('<line x1="3" x2="21" y1="6" y2="6"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><line x1="3" x2="10" y1="18" y2="18"/>');

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const maxLanguage = 24;

/** The language a fence names (its first word), or "" for none. */
export function fenceLanguage(info: string): string {
  const word = info.trim().split(/\s+/)[0] ?? "";
  return /^[\w+#.-]+$/.test(word) ? word.slice(0, maxLanguage) : "";
}
export const isDiff = (language: string) => ["diff", "patch"].includes(language.toLowerCase());

/** The class of one diff line: added, removed or a hunk/file line; context lines have none. */
export function diffLineKind(line: string): "add" | "del" | "hunk" | null {
  if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return null;
}

function bodyHtml(code: string, language: string): string {
  if (!isDiff(language)) return escapeHtml(code);
  return code.split(/(?<=\n)/).map(line => {
    const kind = diffLineKind(line);
    return kind ? `<span class="diff-${kind}">${escapeHtml(line)}</span>` : escapeHtml(line);
  }).join("");
}

const headHtml = (language: string) =>
  `<div class="code-head"><span class="code-lang">${escapeHtml(language)}</span><span class="code-tools">` +
  `<button type="button" data-code-wrap aria-pressed="false" aria-label="自动换行" title="自动换行">${wrapIcon}</button>` +
  `<button type="button" data-code-copy aria-label="复制代码" title="复制代码">${copyIcon}<span data-copy-label>复制</span></button></span></div>`;

/** The markup of one fenced block as the Markdown view draws it. */
export function codeBlockHtml(code: string, info: string): string {
  const language = fenceLanguage(info);
  return `<div class="code-block" data-code-block>${headHtml(language)}<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${bodyHtml(code, language)}</code></pre></div>`;
}

