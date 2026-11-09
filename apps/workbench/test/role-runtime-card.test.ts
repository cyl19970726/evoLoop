import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRoleSkillSelection, type RoleRuntimeView } from "@evoloop/contracts/role-skills";
import { presentRoleRuntime, runtimeCommand, runtimeFields } from "../src/roles/roleRuntimePresentation";

const projectId = "30000001-0000-4000-8000-000000000001", roleId = "30000002-0000-4000-8000-000000000002";
const view = (overrides: Partial<RoleRuntimeView> = {}): RoleRuntimeView => ({
  projectId, roleId, binding: null, history: [], provider: "codex", providerSource: "default", availableProviders: ["codex", "claude"],
  providerAvailable: true, selection: defaultRoleSkillSelection(), selectionSource: "default",
  workDirectory: { cwd: "/work/repo", source: "grant" }, skillsReportedBy: "files", plugins: [], mcpServers: [], missing: [], notes: [],
  observedAtUtc: "2026-11-09T01:00:00.000Z",
  skills: [
    { name: "evoloop-workflow", source: "evoloop", selected: true, reason: "business", description: "业务流程", location: ".agents/skills/evoloop-workflow", contentHash: null, delivery: "role_context" },
    { name: "repo-agents", source: "project", selected: true, reason: "switch", description: null, location: ".agents/skills/repo-agents", contentHash: null, delivery: "native" },
    { name: "mine", source: "personal", selected: false, reason: "switch_off", description: null, location: "~/.agents/skills/mine", contentHash: null, delivery: "none" },
  ],
  ...overrides,
});

test("the card names the runtime, whether it is bound, where skills were read and what loads", () => {
  const shown = presentRoleRuntime(view());
  assert.equal(shown.provider, "Codex");
  assert.match(shown.binding, /未绑定.*默认的 Codex/);
  assert.equal(shown.reportedBy, "按文件推断，运行时尚未确认");
  assert.equal(shown.workDirectory, "/work/repo（授权目录）");
  assert.equal(shown.loadedCount, 2);
  assert.deepEqual(shown.groups.map(group => [group.label, group.loaded, group.skills.length]), [["业务", 1, 1], ["项目", 1, 1], ["个人", 0, 1]]);
  assert.equal(shown.groups[2]!.skills[0]!.detail, "来源已关 · 不加载");
  const bound = presentRoleRuntime(view({ provider: "claude", skillsReportedBy: "claude.init",
    binding: { projectId, roleId, revision: 3, provider: "claude", skills: defaultRoleSkillSelection(), actorId: "lead", reason: "x", operationId: null, createdAtUtc: "2026-11-09T00:00:00.000Z" } }));
  assert.match(bound.binding, /已绑定 · 第 3 次修订；运行时不可更换/);
  assert.equal(bound.reportedBy, "最近一次 Claude Turn 上报");
});

test("the form offers a runtime only before binding and keeps the bound one afterwards", () => {
  const unbound = view();
  assert.deepEqual(runtimeFields(unbound).map(field => field.name), ["provider", "project", "personal", "builtin", "add", "remove", "reason"]);
  assert.deepEqual(runtimeCommand(unbound, { provider: "claude", project: "on", personal: "off", builtin: "off", add: "a, project:b", remove: "", reason: "首次绑定" }), {
    type: "role.runtime.set", roleId, expectedRevision: 0, provider: "claude",
    skills: { project: true, personal: false, builtin: false, add: ["a", "project:b"], remove: [] }, reason: "首次绑定" });
  const bound = view({ binding: { projectId, roleId, revision: 2, provider: "codex", skills: defaultRoleSkillSelection(), actorId: "lead", reason: "x",
    operationId: null, createdAtUtc: "2026-11-09T00:00:00.000Z" } });
  assert.ok(!runtimeFields(bound).some(field => field.name === "provider"));
  const command = runtimeCommand(bound, { provider: "claude", project: "off", personal: "on", builtin: "on", add: "none", remove: "simplify", reason: "调整" });
  assert.equal(command.provider, "codex", "a bound Role never sends another runtime");
  assert.equal(command.expectedRevision, 2);
  assert.deepEqual(command.skills, { project: false, personal: true, builtin: true, add: [], remove: ["simplify"] });
});
