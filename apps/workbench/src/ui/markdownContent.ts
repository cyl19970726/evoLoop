import MarkdownIt from "markdown-it";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function fixedWikiHref(value: string, projectId?: string): string | null {
  if (!projectId || !uuid.test(projectId)) return null;
  const [path, query, extra] = value.split("?");
  if (extra !== undefined || path !== `#/p/${projectId}/knowledge` || !query) return null;
  const params = new URLSearchParams(query);
  if ([...params.keys()].join(",") !== "knowledgeId,knowledgeRevision") return null;
  const knowledgeId = params.get("knowledgeId"), revision = params.get("knowledgeRevision");
  return knowledgeId && revision && uuid.test(knowledgeId) && uuid.test(revision) &&
    value === `#/p/${projectId}/knowledge?knowledgeId=${knowledgeId}&knowledgeRevision=${revision}` ? value : null;
}
function markdownFor(projectId?: string) {
  const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });
  markdown.disable("image");
  markdown.validateLink = value => {
    if (value.startsWith("#/p/")) return !!fixedWikiHref(value, projectId) ||
      /^#\/p\/[a-z0-9-]+\/(?:tasks|documents)\/[a-z0-9-]+(?:\?revision=[a-z0-9-]+)?$/i.test(value);
    if (value.startsWith("#")) return /^#[a-z0-9_-]+$/i.test(value);
    try {
      const url = new URL(value);
      return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  };
  return markdown;
}

export const maxDiagramLength = 6_000;
const maxDiagrams = 4;
const unsafeDiagram = /\b(?:click|href|callback|linkStyle|classDef)\b|%%\{|<[A-Za-z!/?]|javascript:|data:|https?:\/\//i;
export type MarkdownPart = { kind: "html"; value: string } | { kind: "diagram"; value: string };
interface ParsedTokenView { type: string; tag?: string; level?: number; content?: string; children?: ParsedTokenView[] | null }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }

export function splitMarkdown(source: string, options: { omitLeadingTitle?: string; projectId?: string } = {}): MarkdownPart[] {
  const markdown = markdownFor(options.projectId);
  const tokens = markdown.parse(source, {});
  const TokenCtor = (MarkdownIt as unknown as {Token: new (type: string, tag: string, nesting: number) =>
    {type: string; content: string; attrSet(name: string, value: string): void}}).Token;
  if (options.projectId) for (const inline of tokens.filter(token => token.type === "inline") as unknown as ParsedTokenView[]) {
    if (!inline.children) continue;
    const children: Array<InstanceType<typeof TokenCtor>> = [];
    let insideLink = false;
    for (const child of inline.children) {
      if (child.type === "link_open") insideLink = true;
      if (child.type !== "text" || insideLink) children.push(child as InstanceType<typeof TokenCtor>);
      else {
        const pattern = /#\/p\/[0-9a-f-]+\/knowledge\?knowledgeId=[0-9a-f-]+&knowledgeRevision=[0-9a-f-]+/gi;
        let offset = 0;
        for (const match of (child.content ?? "").matchAll(pattern)) {
          const href = fixedWikiHref(match[0], options.projectId);
          if (!href || match.index === undefined || child.content?.[match.index - 1] === "(" ||
            /[-_/=%#&?a-z0-9]/i.test(child.content?.[match.index + match[0].length] ?? "")) continue;
          if (match.index > offset) { const text = new TokenCtor("text", "", 0); text.content = child.content!.slice(offset, match.index); children.push(text); }
          const open = new TokenCtor("link_open", "a", 1); open.attrSet("href", href); children.push(open);
          const label = new TokenCtor("text", "", 0); label.content = href; children.push(label);
          children.push(new TokenCtor("link_close", "a", -1));
          offset = match.index + match[0].length;
        }
        if (offset === 0) children.push(child as InstanceType<typeof TokenCtor>);
        else if (offset < child.content!.length) { const text = new TokenCtor("text", "", 0); text.content = child.content!.slice(offset); children.push(text); }
      }
      if (child.type === "link_close") insideLink = false;
    }
    inline.children = children;
  }
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
