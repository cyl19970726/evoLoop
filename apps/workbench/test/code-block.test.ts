import test from "node:test";
import assert from "node:assert/strict";
import { codeBlockHtml, diffLineKind, fenceLanguage } from "../src/shared/ui/codeBlockHtml";
import { splitMarkdown } from "../src/shared/ui/markdownContent";
import { fileLabel, noticeFor, dragHasFiles } from "../src/features/sessions/fileGuard";

const html = (source: string) => splitMarkdown(source, { topHeading: 2 }).map(part => part.value).join("");
const textOf = (value: string) => value.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

test("a fence with a language shows its name; one without shows none (Task 5415aed3)", () => {
  assert.match(html("```ts\nconst a = 1;\n```"), /<span class="code-lang">ts<\/span>/);
  assert.match(html("```\nplain\n```"), /<span class="code-lang"><\/span>/);
  assert.equal(fenceLanguage("typescript title=x"), "typescript");
  assert.equal(fenceLanguage("<script>"), "", "a name that is not a word is not shown");
});

test("every block has a named copy button and a wrap toggle; the code inside stays the original text", () => {
  const code = "a < b && c > \"d\"\n  indented\n";
  const out = codeBlockHtml(code, "sh");
  assert.match(out, /data-code-copy aria-label="复制代码"/);
  assert.match(out, /data-code-wrap aria-pressed="false" aria-label="自动换行"/);
  const body = out.slice(out.indexOf("<pre>"));
  assert.equal(textOf(body), code, "what the copy button reads is the source text");
});

test("a diff or patch block colours added, removed and hunk lines; context lines stay plain", () => {
  const out = html("```diff\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n```");
  assert.equal((out.match(/class="diff-add"/g) ?? []).length, 1);
  assert.equal((out.match(/class="diff-del"/g) ?? []).length, 1);
  assert.equal((out.match(/class="diff-hunk"/g) ?? []).length, 3);
  assert.doesNotMatch(out, /<span class="diff-[a-z]+"> context/);
  assert.match(html("```patch\n+x\n```"), /diff-add/);
  assert.doesNotMatch(html("```js\n+x\n-y\n```"), /diff-add|diff-del/, "only diff and patch are coloured");
  assert.equal(diffLineKind(" context\n"), null);
});

test("a mermaid fence is still a diagram, not a code block", () => {
  const parts = splitMarkdown("```mermaid\nflowchart LR\n  A --> B\n```", { topHeading: 2 });
  assert.deepEqual(parts.map(part => part.kind), ["diagram"]);
});

test("a pasted or dropped file is named in the notice; nothing says it was sent (Task 5415aed3)", () => {
  assert.equal(fileLabel({ name: "image.png", type: "image/png" }), "剪贴板里的图片");
  assert.equal(fileLabel({ name: "报告.pdf", type: "application/pdf" }), "报告.pdf");
  assert.equal(noticeFor([{ name: "a.txt", type: "text/plain" }]), "现在还不能附图片或文件，a.txt没有发送。可以把内容贴成文字，或让智能体去读工作区里的路径。");
  assert.match(noticeFor([1, 2, 3, 4, 5].map(n => ({ name: `f${n}.txt`, type: "" }))), /f1\.txt、f2\.txt、f3\.txt 等 5 项没有发送/);
  assert.equal(dragHasFiles({ types: ["Files"] }), true);
  assert.equal(dragHasFiles({ types: ["text/plain"] }), false, "text dragged into the box is left alone");
});
