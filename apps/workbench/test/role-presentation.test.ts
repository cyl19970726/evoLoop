// 职责 page wording: service values never reach the screen raw, and a linked Role is either found, still being looked
// for, or provably missing — never silently replaced by another Role.
import assert from "node:assert/strict";
import test from "node:test";
import type { HostLink } from "@evoloop/contracts/resident-hosts";
import {
  alternativeKindText, evidenceKindText, handoffText, hostTitle, reviewDecisionText, roleActions, roleClassText, roleStateText,
  roleTarget, routeStatusText, targetNotice, targetState,
} from "../src/features/roles/rolePresentation.ts";

const id = "30000002-0000-4000-8000-000000000002";
const read = (overrides: Partial<{ loading: boolean; error: string; more: boolean; pages: number }> = {}) =>
  ({ loading: false, error: "", more: false, pages: 1, maxPages: 20, ...overrides });

test("states, classes, evidence, alternatives, reviews and handoffs read as Chinese", () => {
  assert.equal(roleStateText["retirement-pending"], "待交接关闭");
  assert.equal(roleClassText({ roleClass: "system" }), "系统职责");
  assert.equal(roleClassText({}), "分类未登记");
  assert.equal(evidenceKindText("rework"), "反复返工");
  assert.equal(alternativeKindText("another-instance"), "同职责增实例");
  assert.equal(reviewDecisionText("activate"), "确认为持续职责");
  assert.equal(handoffText({ kind: "session", state: "prepared" }), "智能体现场 · 待接收确认");
  assert.equal(routeStatusText("owned-ready"), "受管智能体可承接");
  const link = { host: { kind: "external", provider: "codex-desktop", ref: "x" }, state: "registered" } as unknown as HostLink;
  assert.equal(hostTitle(link), "外部 Codex Desktop 聊天 · 仅登记");
  assert.equal(hostTitle({ ...link, host: { kind: "owned", sessionId: id }, state: "verified" } as HostLink), "项目受管智能体 · 已核实");
});

test("only the steps a Role's state allows are offered", () => {
  assert.deepEqual(roleActions("candidate"), { decide: true, review: false, handoff: false, bind: false, connect: false, retire: false });
  assert.deepEqual(roleActions("trial"), { decide: false, review: true, handoff: true, bind: true, connect: true, retire: false });
  assert.deepEqual(roleActions("retirement-pending"), { decide: false, review: false, handoff: true, bind: false, connect: false, retire: true });
  assert.deepEqual(Object.values(roleActions("retired")).some(Boolean), false);
});

test("the selection is read from the 职责 address only, and a repeated ?role= selects nothing", () => {
  assert.equal(roleTarget(`/p/a/roles?role=${id}`, "/p/a/roles"), id);
  assert.equal(roleTarget("/p/a/roles", "/p/a/roles"), null);
  assert.equal(roleTarget(`/p/a/schedules?role=${id}`, "/p/a/roles"), null, "another page's address never changes the selection");
  assert.equal(roleTarget(`/p/a/roles?role=${id}&role=${id}`, "/p/a/roles"), "");
});

test("a linked Role is found, searched page by page, or reported missing; never a guess", () => {
  assert.equal(targetState(null, false, read()).kind, "none");
  assert.equal(targetState("javascript:alert(1)", false, read()).kind, "invalid");
  assert.equal(targetState(id, true, read({ loading: true })).kind, "found");
  assert.equal(targetState(id, false, read({ loading: true })).kind, "searching");
  assert.equal(targetState(id, false, read({ more: true, pages: 3 })).kind, "searching");
  assert.equal(targetState(id, false, read({ more: true, pages: 20 })).kind, "limit");
  assert.equal(targetState(id, false, read()).kind, "missing");
  assert.deepEqual(targetState(id, false, read({ error: "503" })), { kind: "unreadable", error: "503" });
  assert.match(targetNotice({ kind: "missing" }, id)!.text, /已读完职责，未找到目标/);
  assert.match(targetNotice({ kind: "invalid" }, "x")!.text, /目标职责 ID 无效；没有定位到其他职责/);
  assert.equal(targetNotice({ kind: "found" }, id), null);
});
