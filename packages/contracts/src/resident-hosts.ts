import { z } from "zod";

const id = z.uuid();
const note = z.string().trim().min(1).max(4000);
const title = z.string().trim().min(1).max(240);
export const hostCapabilitySchema = z.enum(["open", "read", "manual-claim", "start", "send", "interrupt"]);
export type HostCapability = z.infer<typeof hostCapabilitySchema>;
export const residentCommands = [
  z.strictObject({ type: z.literal("domain.create"), projectId: id, operationId: id, domainId: id, title,
    roleId: id.nullable(), observedRoleVersion: z.number().int().positive().optional(), routingReason: note, authorizationEvidence: note }),
  z.strictObject({ type: z.literal("domain.update"), projectId: id, operationId: id, domainId: id,
    expectedVersion: z.number().int().positive(), title, roleId: id.nullable(), observedRoleVersion: z.number().int().positive().optional(),
    routingReason: note, authorizationEvidence: note, state: z.enum(["active", "retired"]), reason: note }),
  z.strictObject({ type: z.literal("host.register"), projectId: id, operationId: id, linkId: id,
    roleId: id, expectedRoleVersion: z.number().int().positive(),
    host: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("owned"), sessionId: id }),
      z.strictObject({ kind: z.literal("external"), provider: z.literal("codex-desktop"), ref: note }),
    ]), claimedCapabilities: z.array(hostCapabilitySchema).max(6), reason: note }),
  z.strictObject({ type: z.literal("host.verify"), projectId: id, operationId: id, linkId: id,
    expectedVersion: z.number().int().positive(), expectedRoleVersion: z.number().int().positive(),
    verifiedCapabilities: z.array(hostCapabilitySchema).max(6), evidence: note, observedAtUtc: z.iso.datetime(), reason: note }),
  z.strictObject({ type: z.literal("host.revoke"), projectId: id, operationId: id, linkId: id,
    expectedVersion: z.number().int().positive(), reason: note }),
] as const;
export type ResidentCommand = z.infer<(typeof residentCommands)[number]>;
export interface BusinessDomain {
  projectId: string; id: string; version: number; currentRevisionId: string; title: string;
  roleId: string | null; routingReason: string; authorizationEvidence: string;
  state: "active" | "retired"; actorId: string; createdAtUtc: string;
}
export interface BusinessDomainRevision extends BusinessDomain { reason: string }
export type Host = { kind: "owned"; sessionId: string } | { kind: "external"; provider: "codex-desktop"; ref: string };
export interface HostLink {
  projectId: string; id: string; roleId: string; version: number; host: Host;
  claimedCapabilities: HostCapability[]; verifiedCapabilities: HostCapability[];
  evidence: string | null; observer: string | null; observedAtUtc: string | null;
  state: "registered" | "verified" | "revoked"; actorId: string; createdAtUtc: string;
}
export interface HostLinkRevision extends HostLink { reason: string }
export type DomainRoute = { domain: BusinessDomain; role: import("./roles.js").RoleRecord | null;
  status: "unassigned" | "role-unavailable" | "unlinked" | "owned-ready" | "external-manual" | "host-unverified";
  link: HostLink | null; session: import("./runtime.js").RuntimeSessionRecord | null;
  automaticStart: false };
export interface ResidentReader {
  getBusinessDomain(id: string): Promise<BusinessDomain | null>;
  listBusinessDomains(): Promise<BusinessDomain[]>;
  listBusinessDomainRevisions(id: string): Promise<BusinessDomainRevision[]>;
  getHostLink(id: string): Promise<HostLink | null>;
  listHostLinks(roleId: string): Promise<HostLink[]>;
  listHostLinkRevisions(id: string): Promise<HostLinkRevision[]>;
}
export interface ResidentTransaction extends ResidentReader {
  createBusinessDomain(value: BusinessDomain, revision: BusinessDomainRevision): Promise<void>;
  advanceBusinessDomain(value: BusinessDomain, expectedVersion: number, revision: BusinessDomainRevision): Promise<void>;
  createHostLink(value: HostLink, revision: HostLinkRevision): Promise<void>;
  advanceHostLink(value: HostLink, expectedVersion: number, revision: HostLinkRevision): Promise<void>;
}
