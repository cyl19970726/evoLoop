import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });
markdown.disable("image");
markdown.validateLink = value => {
  if (value.startsWith("#/p/")) return /^#\/p\/[a-z0-9-]+\/(?:tasks|documents)\/[a-z0-9-]+(?:\?revision=[a-z0-9-]+)?$/i.test(value);
  if (value.startsWith("#")) return /^#[a-z0-9_-]+$/i.test(value);
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};

export const maxDiagramLength = 6_000;
const maxDiagrams = 4;
const unsafeDiagram = /\b(?:click|href|callback|linkStyle|classDef)\b|%%\{|<[A-Za-z!/?]|javascript:|data:|https?:\/\//i;
export type MarkdownPart = { kind: "html"; value: string } | { kind: "diagram"; value: string };
interface ParsedTokenView { type: string; tag?: string; level?: number; content?: string; children?: ParsedTokenView[] | null }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }

export function splitMarkdown(source: string, options: { omitLeadingTitle?: string } = {}): MarkdownPart[] {
  const tokens = markdown.parse(source, {});
  const expectedTitle = options.omitLeadingTitle?.replace(/\s+/gu, " ").trim();
  if (expectedTitle) {
    const parsed = tokens as unknown as ParsedTokenView[];
    const headingIndex = parsed.findIndex(token => token.type === "heading_open" && token.tag === "h1" && token.level === 0);
    const heading = parsed[headingIndex];
    const inline = parsed[headingIndex + 1];
    const close = parsed[headingIndex + 2];
    if (heading && inline?.type === "inline" && close?.type === "heading_close" && close.tag === "h1" && close.level === 0) {
      const visibleTitle = (inline.children ?? []).map(token => {
        if (token.type === "text" || token.type === "code_inline") return token.content;
        if (token.type === "softbreak" || token.type === "hardbreak") return " ";
        return "";
      }).join("").replace(/\s+/gu, " ").trim();
      if (visibleTitle === expectedTitle) tokens.splice(headingIndex, 3);
    }
  }
  const parts: MarkdownPart[] = [];
  let pending: typeof tokens = [];
  let diagrams = 0;
  const flush = () => {
    if (pending.length) parts.push({ kind: "html", value: markdown.renderer.render(pending, markdown.options, {}) });
    pending = [];
  };
  for (const token of tokens) {
    if (token.type === "fence" && token.info.trim().toLowerCase() === "mermaid") {
      flush();
      diagrams++;
      parts.push(diagrams <= maxDiagrams && token.content.length <= maxDiagramLength && !unsafeDiagram.test(token.content)
        ? { kind: "diagram", value: token.content }
        : { kind: "html", value: `<pre class="diagram-omitted">图表超出安全范围；请阅读原文代码块。</pre><pre>${escapeHtml(token.content.slice(0, maxDiagramLength))}</pre>` });
    } else pending.push(token);
  }
  flush();
  return parts;
}
