import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscussionEvent, DiscussionRecord, Document, Goal, Stage, Task } from "@evoloop/contracts";
import { commandSchema } from "@evoloop/contracts";
import {
  acceptanceGapSentence, decisionHistory, discussionAddress, limitationText, listRow, nameOr, statusSentence, statusTag,
} from "../src/features/discussions/discussionPresentation.ts";
import {
  discussionHandoffPayload, discussionLinkPayload, discussionPreparePayload, safeSessionReference, type PrepareValues,
} from "../src/features/discussions/commands.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const record = (patch: Partial<DiscussionRecord>) => ({ projectId, id: id(1), version: 3, kind: "allocation", status: "prepared", documentId: id(2),
  preparedDocumentRevisionId: id(3), currentDocumentRevisionId: id(3), latestDecisionEventId: null, goal: { id: id(4), version: 2 }, stage: null, task: null,
  adoptedDocuments: [], question: "谁来接手前端改版？", options: ["甲", "乙"], authorizationBoundary: "不改后端", targetSessionLabel: "前端", targetSessionRef: null,
  actorId: "owner", createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z", ...patch }) as DiscussionRecord;

test("the address selects one discussion or the prepare form, and other addresses leave the page alone", () => {
  assert.deepEqual(discussionAddress(`/p/${projectId}/discussions?discussion=${id(1)}`, projectId), { onPage: true, discussionId: id(1), preparing: false });
  assert.deepEqual(discussionAddress(`/p/${projectId}/discussions?new=1`, projectId), { onPage: true, discussionId: "", preparing: true });
  assert.deepEqual(discussionAddress(`/p/${projectId}/discussions?discussion=${id(1)}&discussion=${id(2)}`, projectId).discussionId, "");
  assert.deepEqual(discussionAddress(`/p/${projectId}/discussions?discussion=not-an-id`, projectId).discussionId, "");
  assert.equal(discussionAddress(`/p/${projectId}/roles?discussion=${id(1)}`, projectId).onPage, false);
});

test("status wording says what is recorded and what is still open", () => {
  assert.deepEqual(statusTag("prepared"), { label: "待交接", tone: "waiting" });
  assert.match(statusSentence(record({ status: "prepared" }), false), /还没有登记有人承接/);
  assert.match(statusSentence(record({ status: "decided" }), true), /决定已纠正/);
  assert.match(statusSentence(record({ status: "linked" }), false), /执行与实际使用/);
  assert.match(statusSentence(record({ kind: "task_collaboration" }), false), /任务页/);
});

test("list rows read by question or by task name, never by ID", () => {
  assert.deepEqual(listRow(record({}), undefined, false), { title: "谁来接手前端改版？", meta: "待交接" });
  assert.deepEqual(listRow(record({ kind: "direction", status: "handed_off" }), undefined, false), { title: "谁来接手前端改版？", meta: "下一阶段 · 待决定" });
  const thread = record({ kind: "task_collaboration", task: { id: id(9), revisionId: id(10) } });
  assert.equal(listRow(thread, "改版首页", true).title, "任务协作 · 改版首页");
  assert.equal(listRow(thread, undefined, true).title, "任务协作 · 任务名称暂不可读");
  assert.equal(nameOr("  ", "职责"), "职责名称暂不可读");
});

test("decision history keeps corrected decisions and names the current one", () => {
  const event = (n: number, patch: Partial<DiscussionEvent>) => ({ id: id(n), kind: "decision", supersedesDecisionEventId: null, ...patch }) as DiscussionEvent;
  const events = [event(20, { kind: "handoff" }), event(21, {}), event(22, { supersedesDecisionEventId: id(21) })];
  const history = decisionHistory(events, id(22));
  assert.equal(history.latest?.id, id(22));
  assert.deepEqual(history.earlier.map(item => item.id), [id(21)]);
  assert.ok(history.corrected.has(id(21)));
});

test("relation limits and acceptance gaps are said in Chinese; unknown limits keep the original", () => {
  assert.deepEqual(limitationText("Fixed target revision unavailable").original, null);
  assert.deepEqual(limitationText("Something new"), { text: "关系来源给出了一条限制，原文如下。", original: "Something new" });
  assert.equal(acceptanceGapSentence(undefined), "");
  assert.match(acceptanceGapSentence(null), /已有接受记录/);
  assert.match(acceptanceGapSentence("not-accepted"), /还没有接受记录/);
});

const goal = { projectId, id: id(4), version: 2, outcome: "改版上线" } as Goal;
const stage = { projectId, id: id(5), goalId: id(4), version: 1, deliverable: "首页" } as Stage;
const otherStage = { projectId, id: id(6), goalId: id(99), version: 1, deliverable: "别的" } as Stage;
const task = { projectId, id: id(7), version: 4, currentRevisionId: id(8), title: "改首页" } as Task;
const adopted = { projectId, id: id(11), title: "需求", version: 2, currentRevisionId: id(12), adoptedRevisionId: id(13) } as Document;
const draft = { id: id(14), title: "草稿", adoptedRevisionId: null } as Document;
const values: PrepareValues = { kind: "allocation", title: " 前端分工 ", goalId: goal.id, stageId: stage.id, taskId: task.id, documentIds: [adopted.id],
  question: "谁来做？", options: "甲\n\n乙\n", authorizationBoundary: "不改后端", targetSessionLabel: "前端", targetSessionRef: "", body: "" };
const choices = { goals: [goal], stages: [stage, otherStage], tasks: [task], documents: [adopted, draft] };

test("prepare fixes the goal version, stage, task revision and adopted document revisions, and passes the command schema", () => {
  const payload = discussionPreparePayload(choices, values, { discussionId: id(30), documentId: id(31) }, projectId);
  assert.deepEqual(payload.goal, { id: goal.id, version: 2 });
  assert.deepEqual(payload.task, { id: task.id, revisionId: id(8) });
  assert.deepEqual(payload.adoptedDocuments, [{ documentId: adopted.id, revisionId: id(13) }]);
  assert.deepEqual(payload.options, ["甲", "乙"]);
  assert.equal(payload.title, "前端分工");
  const parsed = commandSchema.parse({ ...payload, projectId, operationId: id(32) });
  assert.equal(parsed.type, "discussion.prepare");
});

test("prepare refuses a stage of another goal, an unadopted document, an unsafe reference and too many options", () => {
  const ids = { discussionId: id(30), documentId: id(31) };
  assert.throws(() => discussionPreparePayload(choices, { ...values, stageId: otherStage.id }, ids, projectId), /重新选择/);
  assert.throws(() => discussionPreparePayload(choices, { ...values, documentIds: [draft.id] }, ids, projectId), /重新选择/);
  assert.throws(() => discussionPreparePayload(choices, { ...values, targetSessionRef: "javascript:alert(1)" }, ids, projectId), /codex/);
  assert.throws(() => discussionPreparePayload(choices, { ...values, options: Array.from({ length: 11 }, (_, i) => `做法 ${i}`).join("\n") }, ids, projectId), /一到十项/);
  assert.ok(safeSessionReference(`codex://threads/${id(40)}`, projectId));
});

test("handoff and link are recorded at the version the reader saw", () => {
  const seen = record({ version: 5, currentDocumentRevisionId: id(15) });
  const handoff = commandSchema.parse({ ...discussionHandoffPayload(seen, { evidence: "看到对方确认", reason: "已交接" }), projectId, operationId: id(33) });
  assert.equal(handoff.type, "discussion.handoff.record");
  if (handoff.type === "discussion.handoff.record") { assert.equal(handoff.expectedVersion, 5); assert.equal(handoff.documentRevisionId, id(15)); }
  const decision = { id: id(21) } as DiscussionEvent;
  const link = commandSchema.parse({ ...discussionLinkPayload(seen, decision, { kind: "task", id: task.id, revisionId: id(8) }, "后续任务"), projectId, operationId: id(34) });
  assert.equal(link.type, "discussion.action.link");
  if (link.type === "discussion.action.link") { assert.equal(link.decisionEventId, id(21)); assert.deepEqual(link.target, { kind: "task", id: task.id, revisionId: id(8) }); }
});
