import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMarkdown } from "../src/shared/ui/markdownContent.ts";
import { legacyWorkbenchRoute } from "../src/shared/ui/legacyWorkbenchLink.ts";

const migrationProject = "dfb56cce-4ecd-452d-94dc-bf9611babf11";
const migrationTask = "21199600-fb2b-4d32-a540-7a03da8de4e8";
const migrationDoc = "26b5d939-fc55-479f-8f48-619a8a0c2fbe";
const oldLink = `http://127.0.0.1:55431/#/p/${migrationProject}/tasks/${migrationTask}`;

test("fixed Markdown links from the former workbench use the reader's current origin", () => {
  const fixed = `http://127.0.0.1:55431/#/p/${migrationProject}/documents/${migrationDoc}?revision=02a1fcc9-f3a3-4b2b-918b-7ecf7c74d4f0`;
  const rendered = splitMarkdown(`[任务](${oldLink}) [报告](${fixed})`, { projectId: migrationProject }).map(part => part.value).join("");
  assert.match(rendered, new RegExp(`href="/p/${migrationProject}/tasks/${migrationTask}"`));
  assert.match(rendered, new RegExp(`href="/p/${migrationProject}/documents/${migrationDoc}\\?revision=02a1fcc9-f3a3-4b2b-918b-7ecf7c74d4f0"`));
  assert.doesNotMatch(rendered, /href="http:\/\/127\.0\.0\.1:55431/);
  assert.match(splitMarkdown(`[任务](${oldLink})`).map(part => part.value).join(""), /href="http:\/\/127\.0\.0\.1:55431/,
    "without a verified project context the source link is left alone");
});

test("only exact former-origin same-project Task and Document routes become trusted internal links", () => {
  const other = "11111111-1111-4111-8111-111111111111";
  for (const invalid of [
    oldLink.replace("55431", "55432"), oldLink.replace("127.0.0.1", "localhost"),
    oldLink.replace(migrationProject, other), oldLink.replace("/#/", "/other#/"),
    oldLink.replace("/#/", "/?x=1#/"), oldLink.replace("http://", "https://"),
    oldLink.replace("127.0.0.1", "user:pass@127.0.0.1"),
    oldLink.replace("/tasks/", "/tasks/not-a-uuid/"),
    `${oldLink}#https://evil.example`, `${oldLink}?return=https%3A%2F%2Fevil.example`,
    "javascript:alert(1)", "data:text/html,evil", "https://example.com/#/p/" + migrationProject + "/tasks/" + migrationTask,
  ]) assert.equal(legacyWorkbenchRoute(invalid, migrationProject), null, invalid);
  assert.equal(legacyWorkbenchRoute(oldLink, migrationProject), `/p/${migrationProject}/tasks/${migrationTask}`);
});

test("migration retains valid route context and rejects forged nested returns", () => {
  // Former-workbench links carry nested `#/p/` addresses; the link and its nested addresses open as paths.
  const source = `/p/${migrationProject}/sessions?session=owned%3A${migrationTask}`;
  const path = oldLink.slice("http://127.0.0.1:55431/#".length);
  const valid = `${oldLink}?${new URLSearchParams({ tab: "history", return: `#${source}`, actor: "product-docs-owner", returnTitle: "原 Session" })}`;
  assert.equal(legacyWorkbenchRoute(valid, migrationProject), `${path}?${new URLSearchParams({ tab: "history", return: source, actor: "product-docs-owner", returnTitle: "原 Session" })}`);
  const list = `${oldLink}?${new URLSearchParams({ list: `#/p/${migrationProject}/work?search=report` })}`;
  assert.equal(legacyWorkbenchRoute(list, migrationProject), `${path}?${new URLSearchParams({ list: `/p/${migrationProject}/work?search=report` })}`);
  for (const value of [`#/p/${migrationProject}/not-a-route`, `#/p/${migrationProject}/work#https://evil.example`,
    `#/p/${migrationProject}/work\nnext`]) {
    assert.equal(legacyWorkbenchRoute(`${oldLink}?${new URLSearchParams({ return: value })}`, migrationProject), null);
  }
  assert.equal(legacyWorkbenchRoute(`${oldLink}?tab=unknown`, migrationProject), null);
  assert.equal(legacyWorkbenchRoute(`${oldLink}?list=${encodeURIComponent(`#/p/${migrationProject}/evil`)}`, migrationProject), null);
});

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

test("candidate Markdown preview keeps sections, tables and lists after title deduplication", () => {
  const title = "固定知识标题";
  const body = `# ${title}\n\n## 验收范围\n\n| 项目 | 状态 |\n| --- | --- |\n| 来源 | 固定 |\n\n- 保留的候选事实`;
  const rendered = splitMarkdown(body, { omitLeadingTitle: title })
    .map(part => part.kind === "html" ? part.value : "").join("");
  assert.doesNotMatch(rendered, /<h1>固定知识标题<\/h1>/);
  assert.match(rendered, /<h2>验收范围<\/h2>/);
  assert.match(rendered, /<table>[\s\S]*<td>固定<\/td>[\s\S]*<\/table>/);
  assert.match(rendered, /<li>保留的候选事实<\/li>/);
});

test("fixed Wiki links render only in the owning project, including an exact bare canonical reference", () => {
  const project = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const knowledge = "33333333-3333-4333-8333-333333333333";
  const revision = "44444444-4444-4444-8444-444444444444";
  const target = `/p/${project}/knowledge?knowledgeId=${knowledge}&knowledgeRevision=${revision}`;
  const html = (source: string, projectId = project) => splitMarkdown(source, {projectId})
    .map(part => part.value).join("");
  assert.match(html(`[固定知识](${target})`), /<a href="\/p\/11111111[^\"]+knowledgeRevision=44444444[^\"]+">固定知识<\/a>/);
  assert.match(html(`来源 ${target}`), /<a href="\/p\/11111111[^\"]+">\/p\/11111111/);
  for (const invalid of [target.replace(project, other), `${target}&unexpected=x`,
    target.replace(`knowledgeRevision=${revision}`, `knowledgeRevision=${revision}&knowledgeRevision=${revision}`),
    target.replace(revision, "invalid"), target.replace("/knowledge?", `/knowledge/${knowledge}?`),
    `${target}/extra`]) {
    assert.doesNotMatch(html(`[不可信](${invalid})`), /<a href=/);
    assert.doesNotMatch(html(`来源 ${invalid}`), /<a href=/);
  }
  assert.doesNotMatch(html(`[无上下文](${target})`, ""), /<a href=/);
});
