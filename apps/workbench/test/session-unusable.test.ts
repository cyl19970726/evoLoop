// Task 6612e287 rework: the workbench does not turn the stored "ready" into "free": a Session the coordinator judged unable to start a Run is labelled
// 不可用 with its reason wherever a status is written and is never spare capacity. A Session without a judgement (older server) reads as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentStatusLabel, sessionStatusLabel, unusableLabel } from "../src/features/sessions/sessionStatusPresentation";
import { agentLoad, buildArrangement, freeCapacity } from "../src/features/sessions/arrangementModel";

const session = (id: string, extra: Record<string, unknown> = {}) => ({ key: `owned:${id}`, target: { kind: "owned", sessionId: id }, aliases: [], title: id, profile: null, identity: null,
  kind: "owned", roles: [{ id: "r", title: "开发", state: "active", roleClass: "business", templateKey: null, responsibility: "x" }], membership: "current", membershipReason: "x",
  runtimeState: "ready", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: null, ...extra }) as never;
const unusable = { usable: false, reasons: [{ code: "BUSINESS_IDENTITY_UNBOUND", reason: "没有绑定业务身份：Session x 没有自己的 materialCli 条目" }] };

test("a Session judged unusable is labelled 不可用 with its first reason in every status label; usable and unjudged Sessions keep their labels", () => {
  const bad = session("a", { dispatch: unusable }), good = session("b", { dispatch: { usable: true, reasons: [] } }), unjudged = session("c");
  assert.match(unusableLabel(bad)!, /^不可用 · 没有绑定业务身份/); assert.equal(unusableLabel(good), null); assert.equal(unusableLabel(unjudged), null);
  assert.match(agentStatusLabel(bad), /^不可用/); assert.match(sessionStatusLabel(bad), /^项目记录：不可用/);
  assert.equal(agentStatusLabel(good), "无在途工作", "a bound Session reads as before"); assert.equal(agentStatusLabel(unjudged), "无在途工作");
  assert.ok(!/无在途工作|就绪|空闲/.test(agentStatusLabel(bad)), "never ready / free");
  assert.ok(unusableLabel(session("d", { dispatch: { usable: false, reasons: [{ code: "X", reason: "很长".repeat(50) }] } }))!.length < 60, "a long reason is cut");
  assert.equal(unusableLabel(session("e", { kind: "external", dispatch: unusable })), null, "an external agent has no Run to start here");
});

test("an unusable Session is not spare capacity: its load is `unusable`, it is not in the free list, and a bound idle Session still is", () => {
  const evidence = { tasksComplete: true, queuesRead: true, directoryComplete: true };
  assert.equal(agentLoad(session("a", { dispatch: unusable }), 0, evidence), "unusable");
  assert.equal(agentLoad(session("b", { dispatch: { usable: true, reasons: [] } }), 0, evidence), "idle");
  assert.equal(agentLoad(session("c"), 0, evidence), "idle", "no judgement: as before");
  assert.equal(agentLoad(session("d", { dispatch: unusable, busy: true }), 1, evidence), "busy", "work in hand is still reported");
  const board = buildArrangement([session("a", { dispatch: unusable }), session("b", { dispatch: { usable: true, reasons: [] } })], [], [], Date.now(), evidence);
  const free = freeCapacity(board).free.map(row => row.session.key);
  assert.deepEqual(free, ["owned:b"], "only the usable idle Session is free");
  assert.equal(board.rows.find(row => row.session.key === "owned:a")!.load, "unusable");
});
