// An agent's name without the identifier the service puts into a generated title (shared/agentNamePresentation).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDisplayName, agentNameHint, agentNameIsGenerated } from "../src/shared/agentNamePresentation";

const roles = [{ title: "功能开发" }];

test("a generated external title is said as role and kind; its eight-character identifier is gone", () => {
  const external = { title: "功能开发 · 外部 0aba35cb", kind: "external" as const, profile: null, roles };
  assert.equal(agentDisplayName(external), "功能开发 · 外部接入的智能体");
  assert.equal(agentNameIsGenerated(external), true);
  assert.equal(agentDisplayName({ ...external, title: "外部会话 · 外部 0aba35cb", roles: [] }), "外部接入的智能体",
    "no role title: the kind alone");
  assert.equal(agentDisplayName({ ...external, title: "外部会话 · 外部 0aba35cb" }), "功能开发 · 外部接入的智能体",
    "the role comes from the agent's roles when the title has none");
  assert.doesNotMatch(agentDisplayName(external), /[0-9a-f]{8}/);
});

test("a registered name and an ordinary title are kept as written", () => {
  assert.equal(agentDisplayName({ title: "功能开发 · 外部 0aba35cb", kind: "external", profile: { displayName: "前端评审" }, roles }), "前端评审");
  assert.equal(agentNameIsGenerated({ title: "x", kind: "external", profile: { displayName: "前端评审" }, roles }), false);
  assert.equal(agentDisplayName({ title: "测试 Session", kind: "owned", profile: null, roles }), "测试 Session");
  assert.equal(agentDisplayName({ title: "功能开发", kind: "owned", profile: null, roles }), "功能开发");
});

test("a project-run agent whose title is its role identifier is named by role and kind", () => {
  const owned = { title: "95000007-0000-4000-8000-000000000007", kind: "owned" as const, profile: null, roles };
  assert.equal(agentDisplayName(owned), "功能开发 · 受管智能体");
  assert.equal(agentDisplayName({ ...owned, roles: [] }), "受管智能体");
});

test("two agents of the same generated name are told apart by their last activity", () => {
  const external = { title: "功能开发 · 外部 0aba35cb", kind: "external" as const, profile: null, roles };
  assert.equal(agentNameHint(external, "2026/11/10 10:28:00"), "最近活动 2026/11/10 10:28:00");
  assert.equal(agentNameHint(external, null), "最近活动未记录", "no recorded activity is not “no activity”");
  assert.equal(agentNameHint({ ...external, profile: { displayName: "前端评审" } }, "x"), null, "a registered name needs no hint");
});
