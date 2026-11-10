import assert from "node:assert/strict";
import { test } from "node:test";
import type { LeaderWorkPhase } from "@evoloop/contracts/work-index";
import {
  nameOnly, nameText, workNextStep, responsibleKind, responsibleSessionKey, responsibleText,
} from "../src/shared/workPresentation.ts";
import { roleStateLabel, roleStateText, roleTakesWork } from "../src/shared/rolePresentation.ts";

const roleId = "30000003-0000-4000-8000-000000000003";
const sessionId = "30000004-0000-4000-8000-000000000004";
const phases: LeaderWorkPhase[] = ["unknown", "rework", "blocked", "awaiting_delivery", "awaiting_acceptance", "ready",
  "awaiting_assignment", "running", "unassigned", "closed", "cancelled"];
// Words the server writes for agents (`nextAction`, `responsible.label`) that must not reach the page.
const internal = /Run|operation|Role|Session|HostLink|Leader|assignment|queue|nextAction/;

test("every phase has its own Chinese next step without internal words (统筹安排 and the overview)", () => {
  const steps = phases.map(workNextStep);
  assert.equal(new Set(steps).size, phases.length, "no two phases share a step");
  for (const [index, step] of steps.entries()) {
    assert.doesNotMatch(step, internal, phases[index]);
    assert.doesNotMatch(step, /[A-Za-z]/, `${phases[index]} has no English words`);
  }
  assert.equal(workNextStep("unknown"), "上次执行结果未知，先核对，不要重复派发");
  assert.equal(workNextStep("unassigned"), "等统筹指定承接的智能体");
  // The server's nextAction for these phases, word for word: written for agents, not for the page.
  assert.notEqual(workNextStep("unassigned"), "负责人选择真实 Role/Session 并按当前版本正式分派");
  assert.notEqual(workNextStep("unknown"), "先按原 Run 与 operation 对账；结果不明时不要重复派发");
  assert.equal(workNextStep("future_phase" as LeaderWorkPhase), "下一步待核对");
});

test("the next responsibility is a kind and a name, never the server label or the identifier", () => {
  const role = { kind: "role" as const, id: roleId };
  assert.equal(responsibleText(role, null, { state: "named", name: "开发职责" }), "职责 · 开发职责");
  assert.equal(responsibleText(role, null, { state: "reading" }), "职责（名称待读取）");
  assert.equal(responsibleText(role, null, { state: "failed" }), "职责（名称暂不可读）");
  const session = { kind: "session" as const, id: sessionId };
  assert.equal(responsibleText(session, { targetKind: "owned", targetId: sessionId }, { state: "named", name: "前端" }), "智能体 · 前端");
  assert.equal(responsibleText(session, { targetKind: "external", targetId: sessionId }, { state: "unnamed" }), "外部智能体（未登记名称）");
  assert.equal(responsibleText({ kind: "consumer", id: "acceptance-owner" }, null, { state: "failed" }), "指定验收者");
  assert.equal(responsibleText({ kind: "leader", id: "lead" }, null, { state: "failed" }), "项目统筹");
  assert.equal(responsibleText({ kind: "task", id: roleId }, null, { state: "named", name: "前置调研" }), "前置任务 · 前置调研");
  assert.equal(responsibleText({ kind: "unknown", id: null }, null, { state: "failed" }), "下一责任未登记");
  assert.equal(responsibleText({ kind: "role", id: null }, null, { state: "failed" }), "下一责任未登记");
  for (const kind of ["role", "session", "consumer", "leader", "publisher", "user", "task", "unknown"] as const)
    for (const state of [{ state: "reading" }, { state: "failed" }, { state: "unnamed" }] as const) {
      const text = responsibleText({ kind, id: roleId }, null, state);
      assert.doesNotMatch(text, internal);
      assert.equal(text.includes(roleId) || text.includes(roleId.slice(0, 8)), false);
    }
  assert.equal(responsibleKind({ kind: "publisher", id: "x" }, null), "发布维护者");
});

test("names stand alone where the kind is already said", () => {
  assert.equal(nameOnly("职责", { state: "named", name: "开发职责" }), "开发职责");
  assert.equal(nameOnly("职责", { state: "reading" }), "职责（名称待读取）");
  assert.equal(nameText("任务", { state: "failed" }), "任务（名称暂不可读）");
  // An agent named by its role and kind (agentDisplayName) is not prefixed with the kind again (N3).
  assert.equal(nameText("外部智能体", { state: "named", name: "功能开发 · 外部接入的智能体", describesKind: true }), "功能开发 · 外部接入的智能体");
  assert.equal(responsibleText({ kind: "session", id: sessionId }, { targetKind: "external", targetId: sessionId },
    { state: "named", name: "功能开发 · 外部接入的智能体", describesKind: true }), "功能开发 · 外部接入的智能体");
  assert.equal(nameText("外部智能体", { state: "named", name: "前端小王" }), "外部智能体 · 前端小王");
});

test("an agent's name is read by the session key the assignment names", () => {
  assert.equal(responsibleSessionKey({ kind: "session", id: sessionId }, { targetKind: "external", targetId: sessionId }), `external:${sessionId}`);
  assert.equal(responsibleSessionKey({ kind: "session", id: sessionId }, null), `owned:${sessionId}`);
  assert.equal(responsibleSessionKey({ kind: "role", id: roleId }, null), null);
});

test("role states read as words, and only established or trial roles take work normally", () => {
  assert.equal(roleStateText("retirement-pending"), "待交接关闭");
  assert.equal(roleStateText("candidate"), "待判断");
  assert.equal(roleStateText("deferred"), "待重看");
  assert.equal(roleStateText("something-new"), "状态待核对");
  for (const label of Object.values(roleStateLabel)) assert.doesNotMatch(label, /[A-Za-z]/);
  assert.equal(roleTakesWork("active"), true);
  assert.equal(roleTakesWork("trial"), true);
  assert.equal(roleTakesWork("retirement-pending"), false);
});
