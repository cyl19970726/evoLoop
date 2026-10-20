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
