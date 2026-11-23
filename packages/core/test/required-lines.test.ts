import assert from "node:assert/strict";
import test from "node:test";
import { assertRequiredLines, lineState } from "../src/required-lines.js";

const next = "下次同类工作先要知道的事", after = "关闭后下一步";

test("lineState reads the line, heading and list forms; 无 counts; empty and 待定 do not", () => {
  assert.equal(lineState("## 结论\n正文", next), "missing");
  assert.equal(lineState(`${next}：无`, next), "ok");
  assert.equal(lineState(`${next}: 先看 results.md`, next), "ok");
  assert.equal(lineState(`**${next}**：先看夹具`, next), "ok");
  assert.equal(lineState(`- ${after}：由 Leader 验收后发布`, after), "ok");
  assert.equal(lineState(`## ${next}\n\n先读夹具。`, next), "ok");
  assert.equal(lineState(`## ${next}\n`, next), "empty");
  assert.equal(lineState(`${after}：`, after), "empty");
  assert.equal(lineState(`${after}：待定`, after), "pending");
  assert.equal(lineState(`${after}: 待定。`, after), "pending");
  assert.equal(lineState(`## ${next}\n待定`, next), "pending");
  assert.equal(lineState("```\n" + `${after}：无` + "\n```", after), "missing", "fenced code is not read");
  assert.equal(lineState(`说到${after}的事`, after), "missing", "the label must start the line");
  assert.equal(lineState(`${after}：待定\n${after}：无`, after), "ok", "a later written line counts");
});

const reader = (body: string | null | undefined) => ({ findReportRevisionByContentHash: async () => body === undefined ? null : { documentId: "d", revisionId: "r", body } }) as never;

test("report delivery guard: missing, empty and 待定 refuse with the results.md code; 无, real content, HTML, non-report and unknown hash pass", async () => {
  const run = (body: string | null | undefined) => assertRequiredLines(() => reader(body), { type: "delivery.record", contentHash: "AB" });
  for (const bad of ["# 报告", `## ${next}\n`, `${next}：待定`])
    await assert.rejects(run(bad), (e: { code?: string; message: string }) => e.code === "REPORT_NEXT_TIME_LINE_REQUIRED" && /results\.md/.test(e.message));
  await run(`${next}：无`); await run(`## ${next}\n先看夹具`); await run(null); await run(undefined);
});

test("task and schedule guard: missing, empty and 待定 refuse with DEC-052; 无 and real content pass; other commands and paused revisions pass", async () => {
  const task = (content: string) => assertRequiredLines(() => reader(undefined), { type: "task.create", content });
  const sched = (type: string, content: string, state = "active") => assertRequiredLines(() => reader(undefined), { type, state, template: { content } });
  for (const bad of ["做事", `${after}：`, `${after}：待定`])
    for (const run of [task(bad), sched("schedule.create", bad), sched("schedule.revise", bad)])
      await assert.rejects(run, (e: { code?: string; message: string }) => e.code === "TASK_AFTER_CLOSE_LINE_REQUIRED" && /DEC-052/.test(e.message));
  for (const ok of [`${after}：无`, `${after}：需求 Session 读回下一次例行交付`]) { await task(ok); await sched("schedule.create", ok); await sched("schedule.revise", ok); }
  await sched("schedule.revise", "没有这一行", "paused");
  await assertRequiredLines(() => reader(undefined), { type: "task.cancel" });
});
