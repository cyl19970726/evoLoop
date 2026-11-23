import assert from "node:assert/strict";
import { test } from "node:test";
import { refHits, refTarget, type RefAnswer } from "../src/shared/refLinks.ts";
import { markdownRefKeys, splitMarkdown } from "../src/shared/ui/markdownContent.ts";

const project = "70000001-0000-4000-8000-000000000001";
const task = "70000202-0000-4000-8000-000000000202";
const one: RefAnswer = { kind: "one", match: { kind: "task", id: task, title: "任务列表", href: `/p/${project}/tasks/${task}` } };

test("candidates are full ids, 8-hex words, #number and PR #number, not parts of longer words or addresses", () => {
  assert.deepEqual(refHits(`任务 70000202，文档 ${task}，#12 和 PR #12，PR#7`).map(hit => [hit.text, hit.key]),
    [["70000202", "70000202"], [task, task], ["#12", "#12"], ["PR #12", "#12"], ["PR#7", "#7"]]);
  assert.deepEqual(refHits("ABCDEF12 abcdef1234 abcdef123 xabcdef12 https://x.test/abcdef12 v1.abcdef12 a#12 #12345678 &#39;").map(hit => hit.key), ["abcdef12"], "upper case is looked up lower case; longer words and addresses are not candidates");
  assert.deepEqual(refHits("没有编号的文字"), []);
});

test("a resolved candidate links to its object with a description; one that is not resolved stays text", () => {
  assert.deepEqual(refTarget(project, "70000202", one), { href: `/p/${project}/tasks/${task}`, description: "任务：任务列表" });
  assert.equal(refTarget(project, "70000202", { kind: "none" }), null);
  assert.equal(refTarget(project, "70000202", undefined), null, "not answered yet, or the read failed");
  assert.deepEqual(refTarget(project, "#12", one)?.description, "交付：任务列表");
  assert.equal(refTarget(project, "88888888", { kind: "many" })?.href, `/p/${project}/go/88888888`);
});

test("Markdown: inline code is a candidate, a fenced block and an existing link are not, and nothing links before an answer", () => {
  const source = "任务 70000202，`70000202`，[写好的](https://example.test/70000202) 和 https://example.test/x。\n\n```\n70000202\n```\n\n[x](javascript:alert(1)) 20261123";
  assert.deepEqual(markdownRefKeys(source, project), ["70000202", "20261123"]);
  assert.deepEqual(markdownRefKeys(source, undefined), []);
  const answers = (key: string) => key === "70000202" ? one : key === "20261123" ? ({ kind: "none" } as RefAnswer) : undefined;
  const html = splitMarkdown(source, { projectId: project, refs: answers }).map(part => part.value).join("");
  assert.equal([...html.matchAll(/<a href="\/p\/[^"]*\/tasks\/70000202[^"]*"/g)].length, 2, "the word and the inline code");
  assert.match(html, /<a [^>]*><code>70000202<\/code><\/a>/);
  assert.match(html, /<pre><code>70000202\n<\/code><\/pre>/, "the fenced block is untouched");
  assert.match(html, /<a href="https:\/\/example.test\/70000202">写好的<\/a>/, "a written link is not wrapped again");
  assert.doesNotMatch(html, /href="javascript:/i, "javascript: syntax gives no link");
  assert.doesNotMatch(html, /<a [^>]*>20261123/, "none stays text");
  assert.equal(splitMarkdown(source, { projectId: project }).map(part => part.value).join("").includes("/tasks/"), false, "without answers the text is as written");
});
