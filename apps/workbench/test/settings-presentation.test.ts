// 项目设置 and 仓库规范: the identity read again against the one read at login, when it was read, and the server's declared
// capabilities in words; a declaration made for all of an identity's projects never claims one project.
import assert from "node:assert/strict";
import test from "node:test";
import type { Principal } from "@evoloop/contracts";
import { capabilityRows, identityChanges, identityReadText } from "../src/features/settings/settingsPresentation.ts";

const projectId = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const login: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write"], identityKind: "human" };

test("nothing differs when the identity read again is the one signed in", () => {
  assert.deepEqual(identityChanges(login, { ...login, permissions: ["write", "read"] }, projectId), []);
});

test("changed permissions, kind, identity and access are each said", () => {
  assert.deepEqual(identityChanges(login, { ...login, permissions: ["read", "review"] }, projectId),
    ["新增权限：审阅与复核", "不再有的权限：提交业务变更"]);
  assert.deepEqual(identityChanges(login, { ...login, identityKind: "agent" }, projectId), ["身份类型由人变为智能体"]);
  assert.deepEqual(identityChanges(login, { ...login, identityKind: undefined }, projectId), ["身份类型由人变为未报告"]);
  assert.deepEqual(identityChanges(login, { ...login, actorId: "other", projectIds: [other] }, projectId),
    ["读回的身份是 other，登录时是 lead", "读回的身份已不能访问本项目"]);
});

test("the identity's read time says whether what is shown is current", () => {
  assert.equal(identityReadText({ hasData: true, fetching: false, failed: false, readAt: "2026/11/10 10:00:00" }), "2026/11/10 10:00:00");
  assert.equal(identityReadText({ hasData: true, fetching: true, failed: false, readAt: "t" }), "t · 正在重新核对");
  assert.equal(identityReadText({ hasData: true, fetching: false, failed: true, readAt: "t" }), "t · 上次读回，当前待核对");
  assert.equal(identityReadText({ hasData: false, fetching: true, failed: false, readAt: "" }), "正在读取；下面先显示登录时读回的内容");
  assert.equal(identityReadText({ hasData: false, fetching: false, failed: true, readAt: "" }), "本次读取失败；下面是登录时读回的内容，当前待核对");
});

test("capabilities nobody reported are unknown, never 未配置", () => {
  const rows = capabilityRows({}, [projectId], projectId);
  assert.deepEqual(rows.map(row => [row.label, row.state]), [
    ["Git 固定来源", "unknown"], ["外部知识库", "unknown"], ["受管智能体运行", "unknown"], ["文档原件与 HTML 报告", "unknown"]]);
});

test("a source declared for an identity's projects is this project's only when it is the only one", () => {
  const declared = { git: false, sourceConfiguration: { git: true, wiki: false }, runtime: true, documentOriginals: false, html: true };
  const alone = capabilityRows(declared, [projectId], projectId);
  assert.deepEqual(alone.map(row => row.state), ["yes", "no", "yes", "no"], "sourceConfiguration and documentOriginals win over the older flags");
  assert.equal(alone[0]!.text, "已为本项目配置。");
  assert.match(alone[1]!.text, /没有为你能访问的任何项目接入外部知识库/);
  const shared = capabilityRows(declared, [projectId, other], projectId);
  assert.equal(shared[0]!.state, "unknown");
  assert.match(shared[0]!.text, /至少有一个已配置；是否包括本项目.*无法判断/);
  assert.equal(capabilityRows({ git: true }, [other, projectId], projectId)[0]!.state, "unknown", "the older flag reads the same way");
  assert.equal(capabilityRows({ git: false }, [other, projectId], projectId)[0]!.state, "no", "none anywhere is none here");
});
