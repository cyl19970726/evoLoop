// What the coordinator's own configuration says about one project: its repositories, the capabilities configured for
// it, and its members. Every judgment calls the same check the service runs when it acts (named beside each one), over
// the same snapshot: what it loaded at start, or the file it reads again on use.
import { isValidRepositoryRegistration, repositoryRegistrationProblem } from "@evoloop/adapter-git-documents";
import type { Principal } from "@evoloop/contracts";
import type {
  ProjectCallerReason, ProjectCapability, ProjectCapabilityJudgment, ProjectCapabilityKey, ProjectCapabilityReason,
  ProjectCapabilityScope, ProjectConfigurationReadAt, ProjectIdentityFileState, ProjectMember, ProjectRepository,
} from "@evoloop/contracts/project-configuration";
import { credentialGrants, hasCurrentStudyReviewer, isProjectWriter, type AuthConfig } from "../auth.js";
import { activeTaskTimingGrants, hasFeishuActorGrant, isTaskTimingScope, knowledgeServesProject, schedulingGrantsFor,
  type loadIntegrations } from "../configuration.js";
import { collaborationPrincipal } from "../collaboration/runner.js";
import { standardReceiverGrants, standardReceiverSwitchOff } from "../message-connectors/qualification.js";
import { controllerAuthorized, managedControllerGrant, managedLoopController, usableDelegationTemplate } from "../orchestration/setup.js";
import { scheduleGrantCredential } from "../scheduling/pump.js";
import type { ProjectConfigurationSource } from "./routes.js";

export type Integrations = Awaited<ReturnType<typeof loadIntegrations>>;

/** One reading of the configuration and identity files; null where that file could not be read. */
interface Snapshot { integrations: Integrations | null; identities: AuthConfig | null }
interface Situation {
  /** What the service read at start. */
  start: Snapshot;
  /** What it reads again when it acts. */
  use: Snapshot;
  projectId: string;
  /** The calling identity: its actor, and the permissions of the token it signed in with. */
  caller: Pick<Principal, "actorId" | "permissions">;
  nowUtc: string;
  /** The runtime answered as available; null when not judged (after a restart). */
  runtimeAvailable: boolean | null;
  documents: boolean;
}

class Unreadable extends Error { constructor(readonly reason: "configuration_unreadable" | "identities_unreadable") { super(reason); } }
const config = (snapshot: Snapshot) => { if (!snapshot.integrations) throw new Unreadable("configuration_unreadable"); return snapshot.integrations; };
const identities = (snapshot: Snapshot) => { if (!snapshot.identities) throw new Unreadable("identities_unreadable"); return snapshot.identities; };
const on = (): ProjectCapabilityJudgment => ({ state: "configured", reason: null });
const off = (reason: ProjectCapabilityReason): ProjectCapabilityJudgment => ({ state: "not_configured", reason });
const available = (s: Situation): ProjectCapabilityJudgment =>
  s.runtimeAvailable === false ? { state: "configured", reason: "runtime_unavailable" } : on();

/** null when the caller may use it, else why not. */
type CallerJudgment = ProjectCallerReason | null;
/**
 * The caller's actor must hold a grant, and the token it signed in with must carry what the request needs: the
 * server rejects the request on the token's own permissions before any grant is consulted.
 */
const callerMay = (s: Situation, holdsGrant: boolean, needs: readonly ("write" | "review")[]): CallerJudgment => {
  if (!holdsGrant) return "caller_has_no_grant";
  const missing = needs.filter(permission => !s.caller.permissions.includes(permission));
  return missing.length === 0 ? null : missing.length === 2 ? "caller_lacks_write_and_review" :
    missing[0] === "write" ? "caller_lacks_write" : "caller_lacks_review";
};

interface CapabilitySpec {
  key: ProjectCapabilityKey; scope: ProjectCapabilityScope; readAt: ProjectConfigurationReadAt;
  /** Whether anyone in the project has it. */
  judge(s: Situation): Promise<ProjectCapabilityJudgment> | ProjectCapabilityJudgment;
  /** For capabilities granted per actor: whether the calling identity may use it. */
  caller?(s: Situation): Promise<CallerJudgment> | CallerJudgment;
}

/**
 * What every scheduling tick reads before it acts (main.ts taskTimingGrants, SchedulingPump.tickOnce): the integration
 * file, and the identity file when that file enables scheduling. A failed read throws, failing the tick.
 */
const tickReads = (s: Situation): void => { if (config(s.use).scheduling?.enabled) identities(s.use); };

/** Runtime grants a static Session reservation accepts in this project (server.ts `runtime.session.reserve`). */
async function staticRuntimeGrants(s: Situation, actorId?: string) {
  const start = config(s.start), use = config(s.use);
  // hasRuntimeGrant reads the file again on each use; allowedRuntimeCwd keeps the directories loaded at start.
  const grants = (use.runtime?.enabled ? use.runtime.grants : [])
    .filter(grant => grant.projectId === s.projectId && (actorId === undefined || grant.actorId === actorId));
  let accepted = 0;
  for (const grant of grants) if (await start.allowedRuntimeCwd(s.projectId, grant.cwd)) accepted++;
  return { candidates: grants.length, accepted };
}
/** Delegation templates a dynamic binding can use here (main.ts dynamicAdmission, setup.ts dynamicController). */
async function usableTemplates(s: Situation): Promise<{ controllerActorId: string; count: number } | null> {
  const start = config(s.start);
  const orchestration = start.orchestration;
  if (!orchestration?.enabled || !start.runtime?.enabled) return null;
  const { entry } = managedLoopController(identities(s.start), orchestration.controllerActorId, start.runtime.grants);
  if (!entry?.projectIds.includes(s.projectId) || !controllerAuthorized(entry)) return null;
  let count = 0;
  for (const template of start.runtime.delegationTemplates.filter(value => value.projectId === s.projectId))
    if (usableDelegationTemplate(template, entry.actorId, s.nowUtc) && await start.getDelegationTemplate(s.projectId, template.id)) count++;
  return { controllerActorId: entry.actorId, count };
}

const specs: CapabilitySpec[] = [
  { key: "gitSources", scope: "project", readAt: "start", judge: s => {
    const repositories = config(s.start).repositories;
    // main.ts gitForPrincipal: GitDocumentSource over the list loaded at start refuses the whole list on one bad entry.
    if (repositoryRegistrationProblem(repositories)) return off("repository_registration_invalid");
    return repositories.some(repository => repository.projectId === s.projectId) ? on() : off("project_not_configured");
  } },
  { key: "knowledge", scope: "project", readAt: "start", judge: s => {
    // main.ts repositoryForPrincipal, over `knowledge` loaded at start.
    const knowledge = config(s.start).knowledge;
    if (!knowledge?.enabled) return off("knowledge_disabled");
    return knowledgeServesProject(knowledge, s.projectId) ? on() : off("project_not_configured");
  } },
  { key: "scheduling", scope: "project", readAt: "start_and_use", judge: s => {
    // SchedulingPump: enabled() and grants() loaded at start; a grant acts through scheduleGrantCredential over the
    // identities loaded at start. Every tick also reads the integration file again, and the identity file when that
    // enables scheduling (main.ts taskTimingGrants); a failed read fails the whole tick, schedules included.
    const scheduling = config(s.start).scheduling;
    if (!scheduling?.enabled) return off("scheduling_disabled");
    tickReads(s);
    const grants = scheduling.grants.filter(grant => grant.projectId === s.projectId);
    if (!grants.length) return off("project_not_configured");
    const loaded = identities(s.start);
    return grants.some(grant => scheduleGrantCredential(loaded, grant)) ? on() : off("grant_holder_not_authorized");
  },
  // server.ts schedule.create: the token needs review, and callerSchedulingGrants (the grants loaded at start).
  caller: s => callerMay(s, schedulingGrantsFor(config(s.start).scheduling, s.projectId, s.caller.actorId).length > 0, ["review"]) },
  { key: "taskTiming", scope: "project", readAt: "start_and_use", judge: s => {
    // SchedulingPump: enabled() loaded at start. It copies under schedule grants loaded at start whose scope names one
    // Task timing (isTaskTimingScope, as hasTaskTimingGrant), and under taskTimingGrants() read again on use, where
    // main.ts keeps those whose actor now has read, write and review (activeTaskTimingGrants). Each acts through
    // scheduleGrantCredential over the identities loaded at start.
    const start = config(s.start);
    if (!start.scheduling?.enabled) return off("scheduling_disabled");
    tickReads(s);
    const use = config(s.use);
    const fixed = start.scheduling.grants.filter(grant => grant.projectId === s.projectId && isTaskTimingScope(grant.scopeId));
    const daily = use.scheduling?.enabled ? use.scheduling.taskTimingGrants.filter(grant => grant.projectId === s.projectId) : [];
    if (!fixed.length && !daily.length) return off(use.scheduling?.enabled ? "project_not_configured" : "scheduling_disabled");
    const loaded = identities(s.start);
    const active = use.scheduling?.enabled
      ? activeTaskTimingGrants(use.scheduling, identities(s.use)).filter(grant => grant.projectId === s.projectId) : [];
    return [...fixed, ...active].some(grant => scheduleGrantCredential(loaded, grant)) ? on() : off("grant_holder_not_authorized");
  },
  // core execute: a daily copy (task.create or task.timing.set) needs write and review on the token; then main.ts
  // taskTimingAuthority: hasTaskTimingGrant over the file read again, and currentProjectWriter (isProjectWriter).
  // Grants are per Role; any Role of the caller counts here.
  caller: s => {
    const scheduling = config(s.use).scheduling, actorId = s.caller.actorId;
    const holds = !!scheduling?.enabled && (scheduling.taskTimingGrants.some(grant => grant.projectId === s.projectId && grant.actorId === actorId) ||
      scheduling.grants.some(grant => grant.projectId === s.projectId && grant.actorId === actorId && isTaskTimingScope(grant.scopeId)));
    return callerMay(s, holds, ["write", "review"]) ??
      (isProjectWriter(identities(s.use), s.projectId, actorId) ? null : "caller_not_current_writer");
  } },
  { key: "orchestration", scope: "project", readAt: "start", judge: async s => {
    // setupManagedLoops, over the configuration and identities loaded at start: the controller (managedLoopController)
    // must hold read, write and review; ManagedLoopRunner acts in its projects through exactly one grant per Role
    // (managedControllerGrant) whose directory is accepted (allowedRuntimeCwd).
    const start = config(s.start);
    const orchestration = start.orchestration;
    if (!orchestration?.enabled) return off("orchestration_disabled");
    if (!start.runtime?.enabled) return off("runtime_disabled");
    const { entry, grants } = managedLoopController(identities(s.start), orchestration.controllerActorId, start.runtime.grants);
    // Membership first, so a project the controller is not in reveals nothing about the controller's permissions.
    if (!entry?.projectIds.includes(s.projectId)) return off("controller_not_in_project");
    if (!controllerAuthorized(entry)) return off("controller_not_authorized");
    const roles = [...new Set(grants.filter(grant => grant.projectId === s.projectId).map(grant => grant.roleId))];
    if (!roles.length) return off("project_not_configured");
    let single = false;
    for (const roleId of roles) {
      const grant = managedControllerGrant(grants, s.projectId, roleId);
      if (!grant) continue;
      single = true;
      if (await start.allowedRuntimeCwd(s.projectId, grant.cwd)) return on();
    }
    return off(single ? "grant_directory_unavailable" : "controller_grants_ambiguous");
  } },
  { key: "runtime", scope: "project", readAt: "start_and_use", judge: async s => {
    // main.ts creates the runtime only when `runtime.enabled` at start. A Session is then reserved under a static grant
    // (staticRuntimeGrants) or a usable delegation template of the managed loop controller (usableTemplates).
    if (!config(s.start).runtime?.enabled) return off("runtime_disabled");
    const fixed = await staticRuntimeGrants(s), templates = await usableTemplates(s);
    if (fixed.accepted || templates?.count) return available(s);
    if (fixed.candidates) return off("grant_directory_unavailable");
    return off(config(s.use).runtime?.enabled || templates ? "project_not_configured" : "runtime_disabled");
  },
  // server.ts runtime.session.reserve: the token needs review; then the caller's own static grant, or, as the
  // controller, a template (authorizeDynamicSession).
  caller: async s => callerMay(s, !!config(s.start).runtime?.enabled && ((await staticRuntimeGrants(s, s.caller.actorId)).accepted > 0 ||
    (await usableTemplates(s).then(value => value?.controllerActorId === s.caller.actorId && value.count > 0))), ["review"]) },
  { key: "feishu", scope: "project", readAt: "start", judge: s => {
    // CollaborationRunner.status(projectId).configured over `feishu` and the identities loaded at start: a connector
    // exists while enabled, and collaborationPrincipal finds a read-write credential whose actor holds the grant.
    const feishu = config(s.start).feishu;
    if (!feishu?.enabled) return off("feishu_disabled");
    if (!feishu.grants.some(grant => grant.projectId === s.projectId && grant.scope === "project")) return off("project_not_configured");
    return collaborationPrincipal(identities(s.start), s.projectId, (project, actorId) => hasFeishuActorGrant(feishu, project, actorId))
      ? on() : off("grant_holder_not_authorized");
  },
  // collaboration/routes.ts: acting (poll, review, retry, reconcile) needs write and review on the token, and main.ts
  // hasFeishuGrant, which every collaboration request checks.
  caller: s => callerMay(s, hasFeishuActorGrant(config(s.start).feishu, s.projectId, s.caller.actorId), ["write", "review"]) },
  { key: "wechat", scope: "project", readAt: "start_and_use", judge: s => {
    // main.ts builds the gateway client only when `messageConnectors` is present at start, and its ingress only with
    // the runtime. qualifyStandardConnectorRoute then reads the file again: every switch (standardReceiverSwitchOff)
    // and an enabled `standard` receiver grant of this project (standardReceiverGrants); a restricted one never activates.
    const start = config(s.start);
    if (!start.messageConnectors) return off("gateway_not_configured");
    if (!start.runtime?.enabled) return off("runtime_disabled");
    const use = config(s.use);
    const switchOff = standardReceiverSwitchOff(use);
    if (switchOff) return off(switchOff);
    return standardReceiverGrants(use, s.projectId).length ? available(s) : off("project_not_configured");
  } },
  { key: "documentOriginals", scope: "service", readAt: "start", judge: s => s.documents ? on() : off("documents_disabled") },
];

async function judged(spec: CapabilitySpec, s: Situation): Promise<ProjectCapabilityJudgment> {
  let base: ProjectCapabilityJudgment;
  try { base = await spec.judge(s); }
  catch (error) { if (!(error instanceof Unreadable)) throw error; base = { state: "unknown", reason: error.reason }; }
  if (!spec.caller) return base;
  try {
    const callerReason = await spec.caller(s);
    return { ...base, callerGranted: callerReason === null, callerReason };
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return { ...base, callerGranted: null, callerReason: null };
  }
}
const sameJudgment = (a: ProjectCapabilityJudgment, b: ProjectCapabilityJudgment) =>
  a.state === b.state && a.reason === b.reason && (a.callerGranted ?? null) === (b.callerGranted ?? null) &&
  (a.callerReason ?? null) === (b.callerReason ?? null);

/**
 * Each capability as it is in effect for this project and caller, and what a restart would change. In effect: parts
 * read at start come from the loaded configuration and identities, parts read on use from the files now. After a
 * restart: everything from the files now.
 */
export async function projectCapabilities(input: {
  loaded: { integrations: Integrations; identities: AuthConfig };
  current: Snapshot;
  projectId: string; caller: Pick<Principal, "actorId" | "permissions">; nowUtc: string; runtimeAvailable: boolean; documents: boolean;
}): Promise<ProjectCapability[]> {
  const base = { projectId: input.projectId, caller: input.caller, nowUtc: input.nowUtc, documents: input.documents };
  const effect: Situation = { ...base, start: input.loaded, use: input.current, runtimeAvailable: input.runtimeAvailable };
  const restart: Situation = { ...base, start: input.current, use: input.current, runtimeAvailable: null };
  const items: ProjectCapability[] = [];
  for (const spec of specs) {
    const now = await judged(spec, effect), after = await judged(spec, restart);
    items.push({ key: spec.key, scope: spec.scope, readAt: spec.readAt, ...now,
      // A restart does not change whether the runtime answers; only the configuration is compared.
      pending: sameJudgment(now.reason === "runtime_unavailable" ? { ...now, reason: null } : now, after) ? null : after });
  }
  return items;
}

/**
 * This project's repositories as the Git source sees them. main.ts gitForPrincipal builds GitDocumentSource over the
 * whole list loaded at start, which refuses every entry when one of any project is invalid or registered twice
 * (repositoryRegistrationProblem); `accepted` says whether it does. Entries the Git source would refuse on their own
 * (isValidRepositoryRegistration) and a repository registered twice for the project are left out. Only the identity
 * and readable paths are given; the checkout root on this server never leaves it.
 */
export function projectRepositories(repositories: Integrations["repositories"], projectId: string):
  { accepted: boolean; items: ProjectRepository[] } {
  const own = repositories.filter(repository => repository.projectId === projectId);
  return { accepted: !repositoryRegistrationProblem(repositories), items: own.filter(repository => isValidRepositoryRegistration(repository) &&
    own.filter(other => other.repositoryId === repository.repositoryId).length === 1)
    .map(repository => ({ repositoryId: repository.repositoryId, allowedPaths: [...repository.allowedPaths] })) };
}

/** What the identity file says about this project, without tokens: per actor, its kind and each credential's permissions. */
const projectIdentities = (credentials: AuthConfig, projectId: string) => JSON.stringify(
  credentials.filter(entry => entry.projectIds.includes(projectId))
    .map(entry => [entry.actorId, entry.identityKind ?? "agent", [...entry.permissions].sort()] as const)
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

/**
 * The actors of one project and what each may do, each by the check the service runs:
 * - canRead: HTTP authentication over the identities loaded at start accepts one credential, which must grant read.
 * - canWrite: a write request carries the token it signed in with, from the identities loaded at start (core
 *   requirePermission), and business writer checks such as main.ts currentProjectWriter read the identity file again.
 *   Both must hold (isProjectWriter on each); a write added only to the file is not in effect before a restart.
 * - canReview: main.ts currentStudyReviewer, hasCurrentStudyReviewer over the identities loaded at start; incomplete
 *   grants of several credentials never add up.
 * `pending` is what a restart would change: all three then follow the identity file as it is now.
 * Tokens, anything derived from them, other projects' actors and an actor's other projects stay out.
 */
export function projectMembers(loaded: AuthConfig, current: AuthConfig | null, projectId: string):
  { identityFile: ProjectIdentityFileState; items: ProjectMember[] } {
  const kind = (credentials: AuthConfig | null, actorId: string) => {
    const entry = credentials?.find(value => value.actorId === actorId && value.projectIds.includes(projectId));
    return entry ? entry.identityKind ?? "agent" : undefined;
  };
  const actors = new Set([...loaded, ...(current ?? [])].filter(entry => entry.projectIds.includes(projectId)).map(entry => entry.actorId));
  const items = [...actors].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map((actorId): ProjectMember => {
    const identityKind = kind(loaded, actorId) ?? kind(current, actorId) ?? "agent";
    const canRead = credentialGrants(loaded, projectId, actorId, ["read"]);
    const canWrite = !isProjectWriter(loaded, projectId, actorId) ? false : current ? isProjectWriter(current, projectId, actorId) : null;
    const canReview = hasCurrentStudyReviewer(loaded, projectId, actorId);
    const after = current ? { identityKind: kind(current, actorId) ?? identityKind,
      canRead: credentialGrants(current, projectId, actorId, ["read"]), canWrite: isProjectWriter(current, projectId, actorId),
      canReview: hasCurrentStudyReviewer(current, projectId, actorId) } : null;
    return { actorId, identityKind, canRead, canWrite, canReview,
      pending: after && (after.identityKind !== identityKind || after.canRead !== canRead || after.canWrite !== canWrite ||
        after.canReview !== canReview) ? after : null };
  });
  return { identityFile: !current ? "unreadable" : projectIdentities(loaded, projectId) === projectIdentities(current, projectId)
    ? "unchanged" : "changed", items };
}

/** The source for a coordinator that authenticates with its local identity file. */
export function localProjectConfiguration(options: {
  /** The integration configuration loaded at start, which the running service uses. */
  loaded: Integrations;
  /** The integration file read again now; it rejects when the file cannot be read or is invalid. */
  current(): Promise<Integrations>;
  /** The identity snapshot loaded at start, which HTTP authentication uses. */
  identities: AuthConfig;
  /** The identity file read again now; it rejects when the file cannot be read or is invalid. */
  currentIdentities(): Promise<AuthConfig>;
  facts(): { runtimeAvailable: boolean; documents: boolean };
  now?(): string;
}): ProjectConfigurationSource {
  const read = async <T>(value: () => Promise<T>): Promise<T | null> => { try { return await value(); } catch { return null; } };
  return {
    repositories: async projectId => projectRepositories(options.loaded.repositories, projectId),
    capabilities: async (principal, projectId) => projectCapabilities({
      loaded: { integrations: options.loaded, identities: options.identities },
      current: { integrations: await read(options.current), identities: await read(options.currentIdentities) },
      projectId, caller: principal, nowUtc: options.now?.() ?? new Date().toISOString(), ...options.facts() }),
    members: { kind: "local_identities", list: async projectId =>
      projectMembers(options.identities, await read(options.currentIdentities), projectId) },
  };
}
