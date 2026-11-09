import type { Principal } from "@evoloop/contracts";
import { defaultRoleSkillSelection, type RoleRuntimeRevision, type RoleSkillSelection } from "@evoloop/contracts/role-skills";
import type { RoleCommand, RoleTransaction } from "@evoloop/contracts/roles";
import type { RuntimeProvider } from "@evoloop/contracts/runtime";
import { RoleRuleError } from "./index.js";

type RoleRuntimeCommand = Extract<RoleCommand, { type: "role.runtime.set" }>;
type RuntimeTx = Pick<RoleTransaction, "getRole" | "getRoleRuntime" | "addRoleRuntimeRevision" | "listOpenRuntimeSessions">;
const fail = (code: string, message: string, version?: number): never => { throw new RoleRuleError(code, message, version); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same selection regardless of the order names were listed in. */
export const canonicalSkillSelection = (value: RoleSkillSelection): RoleSkillSelection =>
  ({ project: value.project, personal: value.personal, builtin: value.builtin, add: [...value.add].sort(), remove: [...value.remove].sort() });
const sameSelection = (a: RoleSkillSelection, b: RoleSkillSelection): boolean =>
  JSON.stringify(canonicalSkillSelection(a)) === JSON.stringify(canonicalSkillSelection(b));

async function requireNoOtherRuntimeSessions(tx: RuntimeTx, roleId: string, provider: RuntimeProvider): Promise<void> {
  const others = (await tx.listOpenRuntimeSessions(roleId)).filter(session => (session.runtimeProvider ?? "codex") !== provider);
  if (others.length) fail("ROLE_RUNTIME_SESSIONS_OPEN", `Role 还有 ${others.length} 个其他运行时的未关闭 Session；关闭后才能绑定到 ${provider}`);
}

/**
 * Binds the Role to a runtime (revision 1) or changes its skill selection (later revisions). The runtime
 * never changes once bound; this is checked here and again by the store.
 */
export async function applyRoleRuntime(tx: RuntimeTx, principal: Principal, command: RoleRuntimeCommand,
  context: { nowUtc: string; availableProviders: readonly RuntimeProvider[] }): Promise<{ entityId: string; version: number }> {
  const role = await tx.getRole(command.roleId);
  if (!role) return fail("NOT_FOUND", "role not found");
  if (role.state === "retired" || role.state === "rejected") return fail("INVALID_STATE", "closed role cannot change its runtime");
  const current = await tx.getRoleRuntime(command.roleId);
  const currentRevision = current?.revision ?? 0;
  if (command.expectedRevision !== currentRevision) return fail("VERSION_CONFLICT", "role runtime revision changed", currentRevision);
  if (current && current.provider !== command.provider)
    return fail("ROLE_RUNTIME_BOUND", `Role 已绑定 ${current.provider} 运行时，不能改成 ${command.provider}；只能修改它的 skill`);
  if (!current) {
    if (!context.availableProviders.includes(command.provider))
      return fail("RUNTIME_PROVIDER_UNAVAILABLE", `本服务未启用 ${command.provider} 运行时`);
    await requireNoOtherRuntimeSessions(tx, command.roleId, command.provider);
  } else if (sameSelection(current.skills, command.skills)) return fail("ROLE_RUNTIME_UNCHANGED", "role runtime and skills are already current");
  const value: RoleRuntimeRevision = { projectId: command.projectId, roleId: command.roleId, revision: currentRevision + 1, provider: command.provider,
    skills: canonicalSkillSelection(command.skills), actorId: principal.actorId, reason: command.reason, operationId: command.operationId, createdAtUtc: context.nowUtc };
  await tx.addRoleRuntimeRevision(value);
  return { entityId: command.roleId, version: value.revision };
}

/**
 * Runtime of a Session being reserved for `roleId`. A bound Role uses its runtime; a Role that is not yet
 * bound is bound now to the service default, so its first Session fixes the runtime. Owners that are not
 * Roles of this project use the default without binding anything.
 */
export async function sessionRuntimeProvider(tx: RuntimeTx, input: { projectId: string; roleId: string; operationId: string;
  actorId: string; nowUtc: string; defaultProvider: RuntimeProvider; availableProviders: readonly RuntimeProvider[] }): Promise<{ provider: RuntimeProvider; bound: RoleRuntimeRevision | null }> {
  const unavailable = (provider: RuntimeProvider, why: string): never =>
    fail("RUNTIME_PROVIDER_UNAVAILABLE", `${why}的 ${provider} 运行时未在本服务启用`);
  if (uuid.test(input.roleId)) {
    const bound = await tx.getRoleRuntime(input.roleId);
    if (bound) {
      if (!input.availableProviders.includes(bound.provider)) unavailable(bound.provider, "Role 绑定");
      return { provider: bound.provider, bound: null };
    }
    if (await tx.getRole(input.roleId)) {
      if (!input.availableProviders.includes(input.defaultProvider)) unavailable(input.defaultProvider, "默认");
      await requireNoOtherRuntimeSessions(tx, input.roleId, input.defaultProvider);
      const value: RoleRuntimeRevision = { projectId: input.projectId, roleId: input.roleId, revision: 1, provider: input.defaultProvider,
        skills: defaultRoleSkillSelection(), actorId: input.actorId, reason: "首个 Session 预留时按默认运行时绑定",
        operationId: input.operationId, createdAtUtc: input.nowUtc };
      await tx.addRoleRuntimeRevision(value);
      return { provider: input.defaultProvider, bound: value };
    }
  }
  if (!input.availableProviders.includes(input.defaultProvider)) unavailable(input.defaultProvider, "默认");
  return { provider: input.defaultProvider, bound: null };
}
