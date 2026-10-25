import type { Principal } from "@evoloop/contracts";
import type { Transaction } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";
import type { BusinessDomain, BusinessDomainRevision, HostLink, HostLinkRevision, ResidentCommand } from "@evoloop/contracts/resident-hosts";

const fail = (code: string, message: string, version?: number): never => { throw new DomainError(code, message, version); };
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const live = (state: string) => state === "trial" || state === "active";

export async function applyResident(tx: Transaction, principal: Principal, command: ResidentCommand,
  now: string, nextId: () => string): Promise<{ entityId: string; version: number; revisionId?: string; kind: "domain" | "host" }> {
  if (!principal.permissions.includes("review")) return fail("FORBIDDEN", "review permission required");
  if (command.type === "domain.create" || command.type === "domain.update") {
    const existing = await tx.getBusinessDomain(command.domainId);
    if (command.type === "domain.create" && existing) return fail("ALREADY_EXISTS", "domain already exists");
    if (command.type === "domain.update") {
      if (!existing) return fail("NOT_FOUND", "domain not found");
      if (existing.version !== command.expectedVersion) return fail("VERSION_CONFLICT", "domain version changed", existing.version);
      if (existing.state === "retired") return fail("INVALID_STATE", "retired domain cannot be changed");
    }
    if (command.roleId) {
      const role = await tx.getRole(command.roleId);
      if (!role || role.projectId !== command.projectId ||
        (command.type === "domain.create" || command.state === "active") && !live(role.state))
        return fail("ROLE_UNAVAILABLE", "active domain requires a current trial or active Role");
      if (role.version !== command.observedRoleVersion) return fail("VERSION_CONFLICT", "domain Role revision changed", role.version);
    }
    const value: BusinessDomain = { projectId: command.projectId, id: command.domainId,
      version: (existing?.version ?? 0) + 1, currentRevisionId: nextId(), title: command.title,
      roleId: command.roleId, routingReason: command.routingReason,
      authorizationEvidence: command.authorizationEvidence,
      state: command.type === "domain.update" ? command.state : "active",
      actorId: principal.actorId, createdAtUtc: now };
    const revision: BusinessDomainRevision = { ...value, reason: command.type === "domain.update" ? command.reason : "domain created" };
    if (existing) await tx.advanceBusinessDomain(value, existing.version, revision);
    else await tx.createBusinessDomain(value, revision);
    return { entityId: value.id, version: value.version, revisionId: value.currentRevisionId, kind: "domain" };
  }
  if (command.type === "host.register") {
    if (await tx.getHostLink(command.linkId)) return fail("ALREADY_EXISTS", "host link already exists");
    const role = await tx.getRole(command.roleId);
    if (!role || role.projectId !== command.projectId || !live(role.state)) return fail("ROLE_UNAVAILABLE", "host requires a trial or active Role");
    if (role.version !== command.expectedRoleVersion) return fail("VERSION_CONFLICT", "role version changed", role.version);
    if (!unique(command.claimedCapabilities)) return fail("INVALID_CAPABILITY", "duplicate host capability");
    if (command.host.kind === "owned") {
      const session = await tx.getRuntimeSession(command.host.sessionId);
      const bindings = await tx.listSessionBindings(role.id);
      if (!session || session.projectId !== command.projectId || session.roleId !== role.id ||
        session.state !== "ready" || !session.nativeThreadId || !bindings.some(item => item.sessionId === session.id))
        return fail("SESSION_UNOWNED", "owned host requires a ready project Role Session and formal binding");
    } else if (command.claimedCapabilities.some(cap => !["open", "read", "manual-claim"].includes(cap))) {
      return fail("INVALID_CAPABILITY", "Desktop claims are limited to open, read, and manual-claim");
    }
    const value: HostLink = { projectId: command.projectId, id: command.linkId, roleId: role.id,
      version: 1, host: command.host, claimedCapabilities: command.claimedCapabilities,
      verifiedCapabilities: [], evidence: null, observer: null, observedAtUtc: null,
      state: "registered", actorId: principal.actorId, createdAtUtc: now };
    await tx.createHostLink(value, { ...value, reason: command.reason });
    return { entityId: value.id, version: 1, kind: "host" };
  }
  const prior = await tx.getHostLink(command.linkId);
  if (!prior) return fail("NOT_FOUND", "host link not found");
  if (prior.version !== command.expectedVersion) return fail("VERSION_CONFLICT", "host link version changed", prior.version);
  if (prior.state === "revoked") return fail("INVALID_STATE", "host link was revoked");
  if (command.type === "host.verify") {
    const role = await tx.getRole(prior.roleId);
    if (!role || role.projectId !== command.projectId || !live(role.state)) return fail("ROLE_UNAVAILABLE", "host Role is unavailable");
    if (role.version !== command.expectedRoleVersion) return fail("VERSION_CONFLICT", "role version changed", role.version);
    if (!unique(command.verifiedCapabilities) || command.verifiedCapabilities.some(cap => !prior.claimedCapabilities.includes(cap)))
      return fail("INVALID_CAPABILITY", "verified capability must be a unique declared capability");
    if (Date.parse(command.observedAtUtc) > Date.parse(now)) return fail("INVALID_TIME", "observation cannot be in the future");
    if (prior.host.kind === "external" && command.verifiedCapabilities.some(cap => !["open", "read", "manual-claim"].includes(cap)))
      return fail("INVALID_CAPABILITY", "Desktop automation is unavailable");
    if (prior.host.kind === "owned") {
      const session = await tx.getRuntimeSession(prior.host.sessionId);
      const bindings = await tx.listSessionBindings(role.id);
      if (!session || session.projectId !== command.projectId || session.roleId !== role.id ||
        session.state !== "ready" || !session.nativeThreadId || !bindings.some(item => item.sessionId === session.id))
        return fail("SESSION_UNOWNED", "owned Session is no longer ready and bound");
    }
  }
  const value: HostLink = { ...prior, version: prior.version + 1,
    state: command.type === "host.revoke" ? "revoked" : "verified",
    verifiedCapabilities: command.type === "host.revoke" ? [] : command.verifiedCapabilities,
    evidence: command.type === "host.revoke" ? prior.evidence : command.evidence,
    observer: command.type === "host.revoke" ? prior.observer : principal.actorId,
    observedAtUtc: command.type === "host.revoke" ? prior.observedAtUtc : command.observedAtUtc,
    actorId: principal.actorId, createdAtUtc: now };
  await tx.advanceHostLink(value, prior.version, { ...value, reason: command.reason });
  return { entityId: value.id, version: value.version, kind: "host" };
}
