// Task 586504eb: what the Session line says to the executing Session. A rework entry says it is a rework and quotes the observation; no text names a Task revision.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { confirmationRequest, reworkBlock, RUN_INPUT_LIMIT, runInstruction, type ReworkSource } from "../src/session-line/dispatch-text.js";

const projectId = randomUUID(), taskId = randomUUID(), deliveryId = randomUUID(), observationId = randomUUID();
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const source = (evidence: string, reason = "第四点没做到"): ReworkSource => ({ deliveryId, observationId,
  observation: { id: observationId, observer: "requirements-claude-agent", result: "failed", evidence, reason, createdAt: "2026-11-22T15:32:57.962Z" } });
const three = "第一行：暖调与现在并排几乎一样\n第二行：层次靠明度没做到\n第三行：圆角看不出";

test("a rework Run instruction and confirmation request say it is a rework with the delivery, the observation and its three lines", () => {
  for (const text of [runInstruction("配色", projectId, taskId, source(three)), confirmationRequest("配色", projectId, taskId, 6, 7, source(three))]) {
    assert.match(text, /返工/);
    assert.ok(text.includes(deliveryId) && text.includes(observationId), "delivery and observation ids");
    assert.ok(text.includes("requirements-claude-agent") && text.includes("failed"), "observer and result");
    for (const line of three.split("\n")) assert.ok(text.includes(line), line);
    assert.ok(text.includes("第四点没做到"), "reason");
  }
});

test("an ordinary entry's text has no rework wording", () => {
  for (const text of [runInstruction("配色", projectId, taskId, null), confirmationRequest("配色", projectId, taskId, 6, 7, null)]) {
    assert.doesNotMatch(text, /返工|退回的 evidence|观察/);
  }
});

test("neither text names a Task revision; the ids it does contain are the Task, the delivery and the observation", () => {
  const allowed = new Set([projectId, taskId, deliveryId, observationId]);
  for (const text of [runInstruction("配色", projectId, taskId, source(three)), runInstruction("配色", projectId, taskId, null),
    confirmationRequest("配色", projectId, taskId, 6, 7, source(three)), confirmationRequest("配色", projectId, taskId, 6, 7, null)]) {
    for (const found of text.match(uuid) ?? []) assert.ok(allowed.has(found), `unexpected id ${found}`);
    assert.match(text, /taskRevisionId|revision\.id/);
  }
});

test("a 4000-character observation is cut: the instruction stays under the limit, the start of the evidence is readable and the command to read the rest is given", () => {
  const evidence = `开头标记。${"很长的说明".repeat(800)}`;
  assert.ok(evidence.length > 3900);
  for (const text of [runInstruction("配色", projectId, taskId, source(evidence, "原因".repeat(1500))), confirmationRequest("配色", projectId, taskId, 6, 7, source(evidence, "原因".repeat(1500)))]) {
    assert.ok(text.length <= RUN_INPUT_LIMIT, `length ${text.length}`);
    assert.ok(text.includes("开头标记。"));
    assert.ok(text.includes("已截断") && text.includes(`evoloop task ${taskId} --project ${projectId}`) && text.includes(observationId));
  }
});

test("an observation that cannot be read still says it is a rework and where to read it", () => {
  const text = reworkBlock(projectId, taskId, { deliveryId, observationId, observation: null }, 1000);
  assert.ok(text.includes("返工") && text.includes(deliveryId) && text.includes(observationId) && text.includes("读全文"));
});

test("a short observation is quoted whole and not marked as cut", () => {
  const text = reworkBlock(projectId, taskId, source(three), 3000);
  assert.doesNotMatch(text, /已截断/);
});
