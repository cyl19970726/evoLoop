import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal } from "@evoloop/contracts";
import { defaultRoleSkillSelection, type RoleRuntimeRevision } from "@evoloop/contracts/role-skills";
import type { RoleCommand, RoleRecord, RoleRuntimeSessionSnapshot, RoleTransaction } from "@evoloop/contracts/roles";
import { RoleRuleError } from "../src/roles/index.js";
import { applyRoleRuntime, sessionRuntimeProvider } from "../src/roles/runtime.js";

const projectId = randomUUID();
const principal: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["write", "review"] };
const nowUtc = "2026-11-09T02:00:00.000Z";
const both = ["codex", "claude"] as const;

function store(options: { state?: RoleRecord["state"]; sessions?: RoleRuntimeSessionSnapshot[]; role?: boolean } = {}) {
  const roleId = randomUUID(), revisions: RoleRuntimeRevision[] = [];
  const tx = {
    getRole: async (id: string) => options.role === false || id !== roleId ? null : ({ id, projectId, state: options.state ?? "trial" } as RoleRecord),
    getRoleRuntime: async (id: string) => revisions.filter(item => item.roleId === id).at(-1) ?? null,
    addRoleRuntimeRevision: async (value: RoleRuntimeRevision) => { revisions.push(value); },
    listOpenRuntimeSessions: async () => options.sessions ?? [],
  } as unknown as RoleTransaction;
  return { roleId, revisions, tx };
}
type Set = Extract<RoleCommand, { type: "role.runtime.set" }>;
const set = (roleId: string, overrides: Partial<Set> = {}): Set => ({ type: "role.runtime.set", projectId, operationId: randomUUID(), roleId,
  expectedRevision: 0, provider: "claude", skills: defaultRoleSkillSelection(), reason: "绑定", ...overrides });
const rejectsWith = (code: string) => (error: unknown) => error instanceof RoleRuleError && error.code === code;

test("a Role binds once; later revisions change only its skills, in canonical order", async () => {
  const { roleId, revisions, tx } = store();
  const context = { nowUtc, availableProviders: both };
  assert.deepEqual(await applyRoleRuntime(tx, principal, set(roleId), context), { entityId: roleId, version: 1 });
  assert.equal(revisions[0]!.provider, "claude");
  assert.equal(revisions[0]!.actorId, "lead");
  await assert.rejects(() => applyRoleRuntime(tx, principal, set(roleId, { expectedRevision: 1, provider: "codex",
    skills: { ...defaultRoleSkillSelection(), personal: false } }), context), rejectsWith("ROLE_RUNTIME_BOUND"));
  await assert.rejects(() => applyRoleRuntime(tx, principal, set(roleId, { expectedRevision: 0, skills: { ...defaultRoleSkillSelection(), personal: false } }), context),
    rejectsWith("VERSION_CONFLICT"));
  await assert.rejects(() => applyRoleRuntime(tx, principal, set(roleId, { expectedRevision: 1 }), context), rejectsWith("ROLE_RUNTIME_UNCHANGED"));
  const changed = await applyRoleRuntime(tx, principal, set(roleId, { expectedRevision: 1,
    skills: { project: true, personal: false, builtin: true, add: ["zeta", "alpha"], remove: [] } }), context);
  assert.equal(changed.version, 2);
  assert.deepEqual(revisions[1]!.skills.add, ["alpha", "zeta"]);
  assert.equal(revisions[1]!.provider, "claude");
  await assert.rejects(() => applyRoleRuntime(tx, principal, set(roleId, { expectedRevision: 2,
    skills: { project: true, personal: false, builtin: true, add: ["alpha", "zeta"], remove: [] } }), context), rejectsWith("ROLE_RUNTIME_UNCHANGED"),
  "listing the same names in another order is not a change");
});

test("binding needs an enabled runtime, an open Role and no open Session on another runtime", async () => {
  const unbound = store();
  await assert.rejects(() => applyRoleRuntime(unbound.tx, principal, set(unbound.roleId), { nowUtc, availableProviders: ["codex"] }),
    rejectsWith("RUNTIME_PROVIDER_UNAVAILABLE"));
  const retired = store({ state: "retired" });
  await assert.rejects(() => applyRoleRuntime(retired.tx, principal, set(retired.roleId), { nowUtc, availableProviders: both }), rejectsWith("INVALID_STATE"));
  const busy = store({ sessions: [{ id: randomUUID(), roleId: "x", state: "idle", nativeThreadId: "t", runtimeProvider: "codex" }] });
  await assert.rejects(() => applyRoleRuntime(busy.tx, principal, set(busy.roleId), { nowUtc, availableProviders: both }), rejectsWith("ROLE_RUNTIME_SESSIONS_OPEN"));
  const legacy = store({ sessions: [{ id: randomUUID(), roleId: "x", state: "idle", nativeThreadId: "t" }] });
  assert.equal((await applyRoleRuntime(legacy.tx, principal, set(legacy.roleId, { provider: "codex" }), { nowUtc, availableProviders: both })).version, 1,
    "a Session from before providers existed counts as Codex");
  const missing = store();
  await assert.rejects(() => applyRoleRuntime(missing.tx, principal, set(randomUUID()), { nowUtc, availableProviders: both }), rejectsWith("NOT_FOUND"));
});

test("the first Session of an unbound Role binds it to the default; bound Roles and other owners do not bind", async () => {
  const input = (roleId: string, defaultProvider: "codex" | "claude" = "codex", availableProviders: readonly ("codex" | "claude")[] = both) =>
    ({ projectId, roleId, operationId: randomUUID(), actorId: "lead", nowUtc, defaultProvider, availableProviders });
  const unbound = store();
  const first = await sessionRuntimeProvider(unbound.tx, input(unbound.roleId));
  assert.equal(first.provider, "codex");
  assert.equal(first.bound?.revision, 1);
  assert.deepEqual(first.bound?.skills, defaultRoleSkillSelection());
  const again = await sessionRuntimeProvider(unbound.tx, input(unbound.roleId, "claude"));
  assert.deepEqual(again, { provider: "codex", bound: null }, "the binding wins over a later default");
  await assert.rejects(() => sessionRuntimeProvider(unbound.tx, input(unbound.roleId, "codex", ["claude"])), rejectsWith("RUNTIME_PROVIDER_UNAVAILABLE"));
  const notRole = store({ role: false });
  assert.deepEqual(await sessionRuntimeProvider(notRole.tx, input(notRole.roleId, "claude")), { provider: "claude", bound: null });
  assert.equal(notRole.revisions.length, 0);
  assert.deepEqual(await sessionRuntimeProvider(notRole.tx, input("coordinator", "codex")), { provider: "codex", bound: null });
  await assert.rejects(() => sessionRuntimeProvider(notRole.tx, input("coordinator", "claude", ["codex"])), rejectsWith("RUNTIME_PROVIDER_UNAVAILABLE"));
});
