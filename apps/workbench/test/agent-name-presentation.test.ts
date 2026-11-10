// An agent's name without the identifier the service puts into a generated title (shared/agentNamePresentation), how
// same-named agents are told apart, and the 设置展示信息 form that must not register the generic name.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import { agentDisplayName, agentNameCollisions, agentNameHint, agentNameIsGenerated, agentShortId } from "../src/shared/agentNamePresentation";
import { mentionCandidates } from "../src/features/sessions/composerPresentation";
import { sessionProfileCommand, sessionProfileFields } from "../src/features/sessions/sessionProfilePresentation";

const roles = [{ title: "功能开发" }];
const time = (iso: string) => `T(${iso.slice(11, 16)})`;
// As the service gives an unregistered external agent: no lastProgressAt, its connection record's time in metadata.
const external = (id: string, observed: string | null = "2026-11-10T01:30:00.000Z") => ({
  key: `external:${id}-0000-4000-8000-000000000001`, title: `功能开发 · 外部 ${id}`, kind: "external" as const, profile: null, roles,
  lastProgressAt: null, metadata: { sourceObservedAt: observed } });

test("a generated external title is said as role and kind; its eight-character identifier is gone", () => {
  assert.equal(agentDisplayName(external("0aba35cb")), "功能开发 · 外部接入的智能体");
  assert.equal(agentNameIsGenerated(external("0aba35cb")), true);
  assert.equal(agentDisplayName({ ...external("0aba35cb"), title: "外部会话 · 外部 0aba35cb", roles: [] }), "外部接入的智能体", "no role title: the kind alone");
  assert.equal(agentDisplayName({ ...external("0aba35cb"), title: "外部会话 · 外部 0aba35cb" }), "功能开发 · 外部接入的智能体",
    "the role comes from the agent's roles when the title has none");
  assert.doesNotMatch(agentDisplayName(external("0aba35cb")), /[0-9a-f]{8}/);
  // The old form default saved the generated title back as a registered name; it is still a generated name.
  const savedBack = { ...external("0aba35cb"), profile: { displayName: "功能开发 · 外部 0aba35cb" } };
  assert.equal(agentNameIsGenerated(savedBack), true);
  assert.equal(agentDisplayName(savedBack), "功能开发 · 外部接入的智能体");
});

test("a registered name and an ordinary title are kept as written", () => {
  assert.equal(agentDisplayName({ ...external("0aba35cb"), profile: { displayName: "前端评审" } }), "前端评审");
  assert.equal(agentNameIsGenerated({ title: "x", kind: "external", profile: { displayName: "前端评审" }, roles }), false);
  assert.equal(agentDisplayName({ title: "测试 Session", kind: "owned", profile: null, roles }), "测试 Session");
  assert.equal(agentDisplayName({ title: "外部会话", kind: "external", profile: null, roles: [] }), "外部会话", "only the service's own generated format counts as generated");
  assert.equal(agentDisplayName({ title: "功能开发", kind: "owned", profile: null, roles }), "功能开发");
});

test("a project-run agent whose title is its role identifier is named by role and kind", () => {
  const owned = { title: "95000007-0000-4000-8000-000000000007", kind: "owned" as const, profile: null, roles };
  assert.equal(agentDisplayName(owned), "功能开发 · 受管智能体");
  assert.equal(agentDisplayName({ ...owned, roles: [] }), "受管智能体");
});

test("what the service records tells agents of a generated name apart; the hint never invents an activity", () => {
  assert.equal(agentNameHint(external("0aba35cb"), time), "接入更新于 T(01:30)", "an external agent: when its connection record was written");
  assert.equal(agentNameHint(external("0aba35cb", null), time), "接入时间未记录");
  const owned = { key: "owned:95000007-0000-4000-8000-000000000007", title: "95000007-0000-4000-8000-000000000007", kind: "owned" as const, profile: null, roles };
  assert.equal(agentNameHint({ ...owned, lastProgressAt: "2026-11-10T02:00:00.000Z" }, time), "最近活动 T(02:00)");
  assert.equal(agentNameHint({ ...owned, lastProgressAt: null }, time), "最近活动未记录");
  assert.equal(agentNameHint({ ...external("0aba35cb"), profile: { displayName: "前端评审" } }, time), null, "a registered name needs no hint");
});

test("two external agents of one role are told apart by their short identifier, in lists and in the @ menu", () => {
  const a = external("0aba35cb"), b = external("7f3e0c11"), other = { ...external("11112222"), title: "架构 · 外部 11112222", roles: [{ title: "架构" }] };
  assert.equal(agentDisplayName(a), agentDisplayName(b), "their shown names are the same");
  const collisions = agentNameCollisions([a, b, other]);
  assert.deepEqual([...collisions.entries()], [[a.key, "0aba35cb"], [b.key, "7f3e0c11"]], "only the colliding ones carry a short identifier");
  assert.equal(agentShortId(a), "0aba35cb");
  const self = { ...external("99998888"), title: "前端 · 外部 99998888", roles: [{ title: "前端" }] };
  const offered = mentionCandidates([self, a, b, other], self.key);
  assert.deepEqual(offered.map(entry => entry.name), ["功能开发 · 外部接入的智能体（标识 0aba35cb）", "功能开发 · 外部接入的智能体（标识 7f3e0c11）", "架构 · 外部接入的智能体"]);
  assert.equal(new Set(offered.map(entry => entry.name)).size, offered.length, "no two @ entries share a name, so the copy goes to the one picked");
});

test("设置展示信息 starts from the service's name and, when only 团队归属 changes, sends the same displayName as before", () => {
  const snapshot = { session: { ...external("0aba35cb"), target: { kind: "external", linkId: "0aba35cb-0000-4000-8000-000000000001" }, membership: "unclassified" } } as unknown as SessionSnapshot;
  const fields = sessionProfileFields(snapshot);
  const values = Object.fromEntries(fields.map(field => [field.name, field.value ?? ""]));
  assert.equal(values.displayName, "功能开发 · 外部 0aba35cb", "the form starts from the service's title, not the page's generic name");
  const command = sessionProfileCommand(snapshot, { ...values, membership: "current", reason: "归入当前团队" });
  assert.equal(command.displayName, "功能开发 · 外部 0aba35cb");
  assert.equal(command.membership, "current");
  assert.deepEqual(command.target, { kind: "external", linkId: "0aba35cb-0000-4000-8000-000000000001" });
  const registered = { session: { ...(snapshot.session as object), profile: { displayName: "前端评审", membership: "current", tenure: "resident", version: 3, purpose: "", target: { kind: "external", linkId: "x" } } } } as unknown as SessionSnapshot;
  assert.equal(Object.fromEntries(sessionProfileFields(registered).map(field => [field.name, field.value]))["displayName"], "前端评审");
  assert.equal(sessionProfileCommand(registered, { displayName: "前端评审", membership: "current" }).expectedVersion, 3);
});
