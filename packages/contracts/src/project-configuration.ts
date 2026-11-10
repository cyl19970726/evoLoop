/**
 * Read-only views of one project's configuration: the repositories it may read fixed Git sources from, the
 * capabilities configured for it, and its member identities. They describe configuration only: no server path,
 * token, key, address credential or any value derived from a token.
 */
import type { Permission } from "./index.js";

/**
 * The service has no source for this view (`not_provided`, for example a host that does not supply members yet) or
 * its source failed (`read_failed`). It is never an empty list standing in for "none".
 */
export interface ProjectConfigurationUnavailable {
  projectId: string;
  status: "unavailable";
  reason: "not_provided" | "read_failed";
}

/** A repository configured for the project. Its server checkout path and any address are not part of the view. */
export interface ProjectRepository {
  /** The identity a fixed Git source names when it is registered. */
  repositoryId: string;
  /** Repository paths a fixed Git source may read. */
  allowedPaths: string[];
}
export type ProjectRepositoriesView =
  | { projectId: string; status: "available"; items: ProjectRepository[] }
  | ProjectConfigurationUnavailable;

export const projectCapabilityKeys = [
  "gitSources", "knowledge", "scheduling", "taskTiming", "orchestration", "runtime", "feishu", "wechat", "documentOriginals",
] as const;
export type ProjectCapabilityKey = typeof projectCapabilityKeys[number];
/** `project`: configured per project, judged for this one. `service`: one setting for the whole service. */
export type ProjectCapabilityScope = "project" | "service";
export type ProjectCapabilityState = "configured" | "not_configured" | "unknown";
/**
 * Why a capability is not simply configured.
 * - `service_not_enabled`: the service has it switched off or absent, for every project.
 * - `project_not_configured`: the service has it, with nothing configured for this project.
 * - `runtime_unavailable`: configured, but the runtime was not available when read.
 * - `configuration_changed`: the integration file now says otherwise than what the running service loaded.
 * - `configuration_unreadable`: the integration file cannot be read now, so the current setting is not known.
 */
export type ProjectCapabilityReason =
  | "service_not_enabled" | "project_not_configured" | "runtime_unavailable"
  | "configuration_changed" | "configuration_unreadable";
export interface ProjectCapability {
  key: ProjectCapabilityKey;
  scope: ProjectCapabilityScope;
  state: ProjectCapabilityState;
  reason: ProjectCapabilityReason | null;
}
export type ProjectCapabilitiesView =
  | { projectId: string; status: "available"; items: ProjectCapability[] }
  | ProjectConfigurationUnavailable;

/** `local_identities`: the identity file the coordinator authenticates with. `hub`: Hub accounts (#219). */
export type ProjectMemberSourceKind = "local_identities" | "hub";
export interface ProjectMember {
  actorId: string;
  identityKind: "agent" | "human";
  /**
   * Permissions every credential of this actor grants in this project. During token rotation one actor can have
   * several credentials; incomplete grants are never combined into a fuller one, so this is their common part.
   */
  permissions: Permission[];
}
export type ProjectMembersView =
  | { projectId: string; status: "available"; source: ProjectMemberSourceKind; items: ProjectMember[] }
  | ProjectConfigurationUnavailable;
