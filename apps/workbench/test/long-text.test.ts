import assert from "node:assert/strict";
import { test } from "node:test";
import { foldAtBlock, foldMessage, messageSegments } from "../src/features/sessions/longText.ts";
import { splitMarkdown } from "../src/shared/ui/markdownContent.ts";
import { holdCauseLabel, holdLine, holdSummary } from "../src/shared/providerHoldPresentation.ts";

const table = "| 列 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |";

test("a cut reply folds back to the last whole block, never inside a code fence", () => {
  const body = `第一段。\n\n第二段。\n\n\`\`\`js\nconst a = 1;\n\nconst b = 2;\nconst c = `;
  const { shown, folded } = foldAtBlock(body);
  assert.equal(folded, true);
  assert.equal(shown, "第一段。\n\n第二段。");
});

test("a cut inside a table drops the cut block, and a reply of one block stays as it is", () => {
  const cut = `前言。\n\n${table}\n| c | `;
  assert.equal(foldAtBlock(cut).shown, "前言。");
  assert.deepEqual(foldAtBlock("只有一段，被截断在这里"), { shown: "只有一段，被截断在这里", folded: false });
  // an earlier whole table stays whole
  assert.equal(foldAtBlock(`${table}\n\n后面的一段被截`).shown, table);
});

test("a long message folds after a few lines, or after many characters of one line, and never inside a fence", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`).join("\n");
  const a = foldMessage(lines);
  assert.equal(a.folded, true); assert.equal(a.hiddenLines, 18); assert.equal(a.head.split("\n").length, 12);
  const path = `/Users/${"a".repeat(240)}/x`;
  const b = foldMessage(`${path}\n${"b".repeat(900)}\n再一行`);
  assert.equal(b.folded, true);
  assert.equal(foldMessage("短消息\n两行").folded, false);
  const fenced = `${Array.from({ length: 10 }, (_, index) => `行${index}`).join("\n")}\n\`\`\`\n${Array.from({ length: 10 }, (_, index) => `code${index}`).join("\n")}\n\`\`\``;
  const c = foldMessage(fenced);
  assert.equal(c.folded, true); assert.equal(c.head.includes("```"), false);
});

test("message segments separate a fenced block from the text around it", () => {
  assert.deepEqual(messageSegments("前\n```sh\nls -la\n```\n后"), [
    { kind: "text", value: "前" }, { kind: "code", value: "ls -la" }, { kind: "text", value: "后" }]);
  assert.deepEqual(messageSegments("没有围栏"), [{ kind: "text", value: "没有围栏" }]);
});

test("chat text links a complete address and nothing else; documents keep their written links only", () => {
  const html = (source: string, linkify: boolean) => splitMarkdown(source, { linkify }).map(part => part.value).join("");
  const text = "见 https://example.com/a/b?x=1，以及 www.example.org 和 a@b.com 与 192.168.0.1。";
  const chat = html(text, true);
  assert.match(chat, /<a href="https:\/\/example\.com\/a\/b\?x=1"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.equal((chat.match(/<a /g) ?? []).length, 1);
  assert.equal(html(text, false).includes("<a "), false);
  // an unsafe scheme is not linked
  assert.equal(html("javascript:alert(1) 与 ftp://x.org/f", true).includes("<a "), false);
  // an address inside code stays code
  assert.equal(html("`https://example.com`", true).includes("<a "), false);
});

test("an agent's own page names a pause in the banner's words", () => {
  const summary = holdSummary({ items: [{ projectId: "p", id: "h", provider: "claude", state: "held", category: "authentication_failed", causeSessionId: null,
    causeMessageId: null, reason: "x", version: 1, openedAt: "2026-11-11T02:03:00.000Z", releasedAt: null, releasedBy: null, releaseReason: null, releaseSummary: null,
    impact: [], queuedMessages: 0 }] } as never)!;
  assert.equal(holdCauseLabel(summary.holds[0]!), "Claude 鉴权失败");
  assert.match(holdLine(summary), /Claude 鉴权失败/);
  assert.equal(holdCauseLabel({ provider: "codex", category: "quota_exhausted" }), "Codex 额度用完");
});
