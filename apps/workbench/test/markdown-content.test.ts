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
