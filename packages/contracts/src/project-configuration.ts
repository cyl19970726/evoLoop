/**
 * Read-only views of one project's configuration: the repositories it may read fixed Git sources from, the
 * capabilities configured for it, and its member identities. Every conclusion is the one the service itself reaches
 * when it acts. They describe configuration only: no server path, token, key, address credential or any value derived
 * from a token.
 */

/**
 * The service has no source for this view (`not_provided`, for example a host that does not supply members yet) or
 * its source failed (`read_failed`). It is never an empty list standing in for "none".
 */
export interface ProjectConfigurationUnavailable {
  projectId: string;
  status: "unavailable";
  reason: "not_provided" | "read_failed";
}

/**
 * A repository configured for the project, as the running service's Git source accepts it. Entries the Git source
 * would refuse (for example an absolute allowed path) are left out. Its server checkout path and any address are not
 * part of the view.
 */
export interface ProjectRepository {
  /** The identity a fixed Git source names when it is registered. */
  repositoryId: string;
  /** Repository-relative paths a fixed Git source may read. */
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
/**
 * When the service reads the configuration this capability depends on. `start`: once, at start; a changed file takes
 * effect after a restart. `start_and_use`: part at start (such as the service switch), the rest again on each use.
 */
export type ProjectConfigurationReadAt = "start" | "start_and_use";
export type ProjectCapabilityState = "configured" | "not_configured" | "unknown";
/**
 * Why a capability is not simply configured, precise enough to say in words.
 * - `repository_registration_invalid`: the service's repository list has an entry its Git source refuses (an allowed
 *   path that is absolute or leaves the repository, or a duplicate), so it reads no fixed Git source for any project.
 * - `knowledge_disabled`, `scheduling_disabled`, `orchestration_disabled`, `runtime_disabled`, `feishu_disabled`,
 *   `message_connectors_disabled`, `session_messages_disabled`, `documents_disabled`: that switch is off.
 * - `gateway_not_configured`: no WeChat gateway was configured when the service started.
 * - `project_not_configured`: the service has it, with nothing configured for this project.
 * - `grant_holder_not_authorized`: this project has grants, but no holder has the permissions the service requires.
 * - `grant_directory_unavailable`: this project's runtime grants name a working directory the service does not accept.
 * - `controller_not_in_project`: the managed loop controller identity does not include this project.
 * - `controller_not_authorized`: the controller identity lacks read, write or review, so managed loops do not start.
 * - `controller_grants_ambiguous`: the controller has several runtime grants for each of this project's Roles, and
 *   acts for a Role only through exactly one.
 * - `runtime_unavailable`: configured, but the runtime was not available when read.
 * - `configuration_unreadable`: the integration file cannot be read now.
 * - `identities_unreadable`: the identity file cannot be read now.
 */
export type ProjectCapabilityReason =
  | "repository_registration_invalid" | "knowledge_disabled" | "scheduling_disabled" | "orchestration_disabled"
  | "runtime_disabled" | "feishu_disabled" | "message_connectors_disabled" | "session_messages_disabled"
  | "documents_disabled" | "gateway_not_configured" | "project_not_configured" | "grant_holder_not_authorized"
  | "grant_directory_unavailable" | "controller_not_in_project" | "controller_not_authorized"
  | "controller_grants_ambiguous" | "runtime_unavailable"
  | "configuration_unreadable" | "identities_unreadable";
export interface ProjectCapabilityJudgment {
  state: ProjectCapabilityState;
  reason: ProjectCapabilityReason | null;
  /**
   * Only for capabilities granted per actor (scheduling, taskTiming, runtime, feishu): whether the calling identity
   * holds a grant the service accepts in this project. `state` says whether anyone in the project does. null: unknown.
   */
  callerGranted?: boolean | null;
}
export interface ProjectCapability extends ProjectCapabilityJudgment {
  key: ProjectCapabilityKey;
  scope: ProjectCapabilityScope;
  readAt: ProjectConfigurationReadAt;
  /**
   * The judgment after the next restart, when the configuration or identity file now leads to another one than what
   * is in effect; null when a restart would change nothing.
   */
  pending: ProjectCapabilityJudgment | null;
}
export type ProjectCapabilitiesView =
  | { projectId: string; status: "available"; items: ProjectCapability[] }
  | ProjectConfigurationUnavailable;

/** `local_identities`: the identity file the coordinator authenticates with. `hub`: Hub accounts (#219). */
export type ProjectMemberSourceKind = "local_identities" | "hub";
/** What an actor may do in this project, each as the service's own check decides it now. */
export interface ProjectMemberAbilities {
  identityKind: "agent" | "human";
  /** Sign in and read: HTTP authentication accepts one credential, which must grant read here. */
  canRead: boolean;
  /** The business writer check: one credential with read and write here. null when the identity file is unreadable. */
  canWrite: boolean | null;
  /** The reviewer check: every credential of the actor here grants read, write and review; partial grants never add up. */
  canReview: boolean;
}
export interface ProjectMember extends ProjectMemberAbilities {
  actorId: string;
  /** What a restart would change for this actor, when the identity file differs from what is in effect; else null. */
  pending: Pick<ProjectMemberAbilities, "identityKind" | "canRead" | "canReview"> | null;
}
/**
 * `unchanged`: the identity file still says what the service loaded. `changed`: it was edited since start; sign-in and
 * review follow it after a restart. `unreadable`: it cannot be read now. null: the source is not an identity file.
 */
export type ProjectIdentityFileState = "unchanged" | "changed" | "unreadable";
export type ProjectMembersView =
  | { projectId: string; status: "available"; source: ProjectMemberSourceKind; identityFile: ProjectIdentityFileState | null; items: ProjectMember[] }
  | ProjectConfigurationUnavailable;
