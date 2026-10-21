import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMarkdown } from "../src/ui/markdownContent.ts";

const fence = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\``;

test("ordinary Mermaid arrows remain renderable", () => {
  assert.deepEqual(splitMarkdown(fence("graph LR\nA-->B\nB<--C")).map(part => part.kind), ["diagram"]);
});

test("diagram HTML and interactive links fall back to escaped source", () => {
  for (const source of ["graph LR\nA-->B<br/>", "graph LR\nclick A https://example.com", "graph LR\nA[<script>alert(1)</script>]-->B"]) {
    const [part] = splitMarkdown(fence(source));
    assert.equal(part?.kind, "html");
    assert.ok(!part?.value.includes("<script>"));
  }
});

test("Markdown escapes HTML and refuses script links and remote images", () => {
  const html = splitMarkdown("<script>alert(1)</script> [bad](javascript:alert(1)) ![remote](https://example.com/a.png)").map(part => part.value).join("");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes("<img"));
});

test("structured knowledge Markdown renders headings, paragraphs, lists, tables, and safe links", () => {
  const source = [
    "# 固定知识标题",
    "",
    "正文段落，说明当前采用的判断。",
    "",
    "- 支持证据",
    "- 尚待核对的边界",
    "",
    "| 版本 | 状态 |",
    "| --- | --- |",
    "| v3 | 已复核 |",
    "",
    "[固定来源](https://example.com/source)",
  ].join("\n");
  const html = splitMarkdown(source).map(part => part.kind === "html" ? part.value : "").join("");
  assert.match(html, /<h1>固定知识标题<\/h1>/);
  assert.match(html, /<p>正文段落，说明当前采用的判断。<\/p>/);
  assert.match(html, /<ul>[\s\S]*<li>支持证据<\/li>[\s\S]*<li>尚待核对的边界<\/li>[\s\S]*<\/ul>/);
  assert.match(html, /<table>[\s\S]*<th>版本<\/th>[\s\S]*<td>v3<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<a href="https:\/\/example\.com\/source">固定来源<\/a>/);
});

test("structured knowledge Markdown keeps embedded HTML inert", () => {
  const html = splitMarkdown('# 标题\n\n<script>globalThis.compromised = true</script>\n\n[脚本链接](javascript:alert(1))').map(part => part.value).join("");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes('href="javascript:'));
});

test("reader can omit only a matching first top-level H1 after preserved prelude and code", () => {
  const source = [
    "> # 引用中的标题",
    "> 这不是正文顶层标题。",
    "",
    "```md",
    "# 固定材料可读",
    "```",
    "",
    "正文引言保留。",
    "",
    "# **固定材料** [可读](https://example.com) &amp; 核对",
    "",
    "## 后续结构",
    "",
    "| 项目 | 状态 |",
    "| --- | --- |",
    "| 来源 | 保留 |",
    "",
    "- 后续列表项",
  ].join("\n");
  const html = splitMarkdown(source, { omitLeadingTitle: "固定材料 可读 & 核对" })
    .map(part => part.kind === "html" ? part.value : "").join("");
  assert.match(html, /<blockquote>[\s\S]*<h1>引用中的标题<\/h1>/);
  assert.match(html, /<pre><code class="language-md"># 固定材料可读/);
  assert.match(html, /<p>正文引言保留。<\/p>/);
  assert.doesNotMatch(html, /<h1><strong>固定材料<\/strong>/);
  assert.match(html, /<h2>后续结构<\/h2>/);
  assert.match(html, /<table>[\s\S]*<td>保留<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<li>后续列表项<\/li>/);
  assert.match(source, /# \*\*固定材料\*\*/);
});

test("a different first top-level H1 prevents removal of later matching headings", () => {
  const html = splitMarkdown("# 正文自己的首标题\n\n# 外层标题", { omitLeadingTitle: "外层标题" })
    .map(part => part.kind === "html" ? part.value : "").join("");
  assert.match(html, /<h1>正文自己的首标题<\/h1>/);
  assert.match(html, /<h1>外层标题<\/h1>/);
});

test("default shared Markdown rendering keeps title headings", () => {
  const html = splitMarkdown("# 外层标题").map(part => part.kind === "html" ? part.value : "").join("");
  assert.match(html, /<h1>外层标题<\/h1>/);
});
