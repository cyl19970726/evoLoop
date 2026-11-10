import assert from "node:assert/strict";
import { test } from "node:test";
import { queuedMessageSummary } from "../src/features/sessions/queuedMessagePresentation.ts";

const task = "98000000-0000-4000-8000-000000000001";
const notice = (head: string) => `${head}.\nSource event: 98000000-0000-4000-8000-000000000002 at 2026-11-10T13:21:00.000Z\nSource Task revision: ${task}@98000000-0000-4000-8000-000000000003\nSource actor: a; source Session: b\nSource: task:${task}\nThis is a historical source event.`;

test("every Leader notice kind is said in Chinese with its task and time; the original stays out of the line", () => {
  const kinds: Array<[string, string]> = [
    ["A Task was created for Leader triage", "新 Task 待安排"], ["A fixed Delivery was recorded", "交付已提交"],
    ["An independent use observation was recorded", "独立使用观察已记录"], ["A Task recipient asked a question", "承接者提了问题"],
    ["A Task recipient reported a blocker", "承接者报告了阻塞"], ["A terminal Run has no signed submission", "Run 已结束但没有签名提交"],
    ["A signed Run submission cannot be sealed", "签名提交无法封存"], ["A current Task attention item needs a Leader follow-up", "Task 关注项待跟进"],
    ["An acceptance handoff is blocked and needs a Leader decision", "验收交接受阻，待决定"],
  ];
  for (const [head, label] of kinds) {
    const summary = queuedMessageSummary(notice(head));
    assert.deepEqual([summary.label, summary.taskId, summary.occurredAt], [label, task, "2026-11-10T13:21:00.000Z"], head);
  }
});

test("a message that is not a notice keeps its own first line, shortened; a notice without a task or time still gets its kind", () => {
  assert.deepEqual(queuedMessageSummary("顺便看一下 390 宽。"), { label: null, occurredAt: null, taskId: null, preview: "顺便看一下 390 宽。" });
  const long = queuedMessageSummary(`${"很长的一句".repeat(30)}\n第二行`);
  assert.equal(long.preview.length, 81);
  assert.ok(long.preview.endsWith("…"));
  assert.equal(queuedMessageSummary("").preview, "（没有可公开的正文）");
  const bare = queuedMessageSummary("A fixed Delivery was recorded.", "98000000-0000-4000-8000-000000000009");
  assert.deepEqual([bare.label, bare.taskId, bare.occurredAt], ["交付已提交", "98000000-0000-4000-8000-000000000009", null]);
  // Not a known notice: never invent a kind, a task or a time.
  const other = queuedMessageSummary(`Something else.\nSource Task revision: ${task}@x`, task);
  assert.deepEqual([other.label, other.taskId, other.occurredAt], [null, null, null]);
});
