import MarkdownIt from "markdown-it";
import { appPath } from "../appPath";
import { refHits, refTarget, type RefAnswer } from "../refLinks";
import { legacyWorkbenchRoute } from "./legacyWorkbenchLink";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A fixed Wiki revision link (stored as `#/p/…` or written as `/p/…`), returned as the path to open. */
export function fixedWikiHref(value: string, projectId?: string): string | null {
  if (!projectId || !uuid.test(projectId)) return null;
  const route = value.startsWith("#/p/") ? value.slice(1) : value;
  const [path, query, extra] = route.split("?");
  if (extra !== undefined || path !== `/p/${projectId}/knowledge` || !query) return null;
  const params = new URLSearchParams(query);
  if ([...params.keys()].join(",") !== "knowledgeId,knowledgeRevision") return null;
  const knowledgeId = params.get("knowledgeId"), revision = params.get("knowledgeRevision");
  return knowledgeId && revision && uuid.test(knowledgeId) && uuid.test(revision) &&
    route === `/p/${projectId}/knowledge?knowledgeId=${knowledgeId}&knowledgeRevision=${revision}` ? route : null;
}
function markdownFor(projectId?: string, linkify = false) {
  const markdown = new MarkdownIt({ html: false, linkify, breaks: false });
  // Only a complete http(s) address becomes a link: no bare domain, address or e-mail is guessed into one.
  if (linkify) markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  markdown.disable("image");
  markdown.validateLink = value => {
    if (value.startsWith("#/p/") || value.startsWith("/p/")) return !!fixedWikiHref(value, projectId) ||
      /^#?\/p\/[a-z0-9-]+\/(?:tasks|documents)\/[a-z0-9-]+(?:\?revision=[a-z0-9-]+)?$/i.test(value);
    if (value.startsWith("#")) return /^#[a-z0-9_-]+$/i.test(value);
    try {
      const url = new URL(value);
      return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  };
  return markdown;
}

/** The headings a document outline lists: those its source wrote as 二、三级标题 (`##`, `###`). */
export const outlineSelector = '.markdown-body [data-source-level="2"], .markdown-body [data-source-level="3"]';

export const maxDiagramLength = 6_000;
const maxDiagrams = 4;
const unsafeDiagram = /\b(?:click|href|callback|linkStyle|classDef)\b|%%\{|<[A-Za-z!/?]|javascript:|data:|https?:\/\//i;
export type MarkdownPart = { kind: "html"; value: string } | { kind: "diagram"; value: string };
interface ParsedTokenView { type: string; tag?: string; level?: number; content?: string; children?: ParsedTokenView[] | null }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!); }

type TokenLike = { type: string; content: string; attrSet(name: string, value: string): void };
type TokenMaker = new (type: string, tag: string, nesting: number) => TokenLike;

/**
 * 正文里的编号成链接 (Task a910ee96): walks the inline tokens (a fenced block is not one; text already inside a link is
 * skipped), calls `seen` for every candidate and, where `answerOf` knows the object, turns the written text into a link. Inline code
 * counts when it holds exactly one candidate. Nothing is built for a candidate the project did not resolve.
 */
function linkRefs(tokens: ParsedTokenView[], Token: TokenMaker, projectId: string,
  answerOf: ((key: string) => RefAnswer | undefined) | undefined, seen?: (key: string) => void): void {
  const link = (children: unknown[], key: string, label: TokenLike): boolean => {
    const target = refTarget(projectId, key, answerOf?.(key));
    if (!target) return false;
    const open = new Token("link_open", "a", 1);
    open.attrSet("href", target.href); open.attrSet("title", target.description); open.attrSet("aria-description", target.description);
    children.push(open, label, new Token("link_close", "a", -1));
    return true;
  };
  for (const inline of tokens) {
    if (inline.type !== "inline" || !inline.children) continue;
    const children: unknown[] = [];
    let insideLink = false;
    for (const child of inline.children) {
      if (child.type === "link_open") insideLink = true;
      const content = child.content ?? "";
      if (insideLink || (child.type !== "text" && child.type !== "code_inline")) children.push(child);
      else if (child.type === "code_inline") {
        const hits = refHits(content);
        const only = hits.length === 1 && hits[0]!.text === content ? hits[0]! : null;
        if (only) seen?.(only.key);
        if (!only || !link(children, only.key, child as unknown as TokenLike)) children.push(child);
      } else {
        let offset = 0;
        const text = (value: string) => { const token = new Token("text", "", 0); token.content = value; return token; };
        const out: unknown[] = [];
        for (const hit of refHits(content)) {
          seen?.(hit.key);
          const label = text(hit.text);
          const before = out.length;
          if (!link(out, hit.key, label)) continue;
          if (hit.index > offset) out.splice(before, 0, text(content.slice(offset, hit.index)));
          offset = hit.index + hit.text.length;
        }
        if (offset === 0) children.push(child);
        else { children.push(...out); if (offset < content.length) children.push(text(content.slice(offset))); }
      }
      if (child.type === "link_close") insideLink = false;
    }
    inline.children = children as ParsedTokenView[];
  }
}

/** The candidates a Markdown source holds (not those inside a fence or an existing link), deduplicated, in order. */
export function markdownRefKeys(source: string, projectId?: string): string[] {
  if (!projectId || !source) return [];
  const markdown = markdownFor(projectId);
  const TokenCtor = (MarkdownIt as unknown as { Token: TokenMaker }).Token;
  const keys = new Set<string>();
  linkRefs(markdown.parse(source, {}) as unknown as ParsedTokenView[], TokenCtor, projectId, undefined, key => keys.add(key));
  return [...keys];
}

export function splitMarkdown(source: string, options: { omitLeadingTitle?: string; projectId?: string; topHeading?: number; linkify?: boolean; refs?: (key: string) => RefAnswer | undefined } = {}): MarkdownPart[] {
  const markdown = markdownFor(options.projectId, options.linkify === true);
  const tokens = markdown.parse(source, {});
  const TokenCtor = (MarkdownIt as unknown as {Token: new (type: string, tag: string, nesting: number) =>
    {type: string; content: string; attrGet(name: string): string | null; attrSet(name: string, value: string): void}}).Token;
  if (options.projectId) for (const inline of tokens.filter(token => token.type === "inline") as unknown as ParsedTokenView[]) {
    if (!inline.children) continue;
    const children: Array<InstanceType<typeof TokenCtor>> = [];
    let insideLink = false;
    for (const child of inline.children) {
      if (child.type === "link_open") insideLink = true;
      if (child.type !== "text" || insideLink) children.push(child as InstanceType<typeof TokenCtor>);
      else {
        const pattern = /#?\/p\/[0-9a-f-]+\/knowledge\?knowledgeId=[0-9a-f-]+&knowledgeRevision=[0-9a-f-]+/gi;
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
    for (const child of children) {
      if (child.type !== "link_open") continue;
      const route = legacyWorkbenchRoute(child.attrGet("href") ?? "", options.projectId);
      if (route) child.attrSet("href", route);
    }
    inline.children = children;
  }
  // Documents keep the `#/p/…` links they were written with; they open as paths.
  for (const inline of tokens.filter(token => token.type === "inline") as unknown as ParsedTokenView[]) {
    for (const child of (inline.children ?? []) as unknown as Array<InstanceType<typeof TokenCtor>>) {
      const target = child.type === "link_open" ? child.attrGet("href") : null;
      const path = target?.startsWith("#/") ? appPath(target) : null;
      if (path) child.attrSet("href", path);
    }
  }
  // An address in a chat text leaves the workbench: it opens in a new tab and sends no referrer or window handle.
  if (options.linkify) for (const inline of tokens.filter(token => token.type === "inline") as unknown as ParsedTokenView[]) {
    for (const child of (inline.children ?? []) as unknown as Array<InstanceType<typeof TokenCtor>>) {
      if (child.type === "link_open" && /^https?:\/\//i.test(child.attrGet("href") ?? "")) { child.attrSet("target", "_blank"); child.attrSet("rel", "noopener noreferrer"); }
    }
  }
  if (options.refs && options.projectId) linkRefs(tokens as unknown as ParsedTokenView[], TokenCtor, options.projectId, options.refs);
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
  // The page has its own h1; a text read inside it starts its headings at `topHeading` (2 under the page title, 3 under
  // a section heading). The text's highest level moves there and the rest keep their distance, at most h6. Each heading
  // keeps the level its source wrote as `data-source-level`: the document outline lists the source's 二、三级标题
  // (outlineSelector), whatever tag they are drawn with.
  const headings = tokens.filter(token => token.type === "heading_open" || token.type === "heading_close");
  const levels = headings.map(token => Number(token.tag.slice(1))).filter(level => level >= 1 && level <= 6);
  if (levels.length) {
    const shift = Math.min(6, Math.max(2, options.topHeading ?? 2)) - Math.min(...levels);
    for (const token of headings) {
      const level = Number(token.tag.slice(1));
      if (level < 1 || level > 6) continue;
      if (token.type === "heading_open") token.attrSet("data-source-level", String(level));
      token.tag = `h${Math.min(6, Math.max(1, level + shift))}`;
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
