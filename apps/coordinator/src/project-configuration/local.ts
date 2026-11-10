// What the coordinator's own configuration says about one project: its repositories, the capabilities configured
// for it, and its members. Pure derivations over loaded configuration, plus the source main.ts hands to the routes.
import type { ProjectCapability, ProjectCapabilityKey, ProjectRepository } from "@evoloop/contracts/project-configuration";
import { projectMembers, type AuthConfig } from "../auth.js";
import type { loadIntegrations } from "../configuration.js";
import type { ProjectConfigurationSource } from "./routes.js";

export type IntegrationConfiguration = Pick<Awaited<ReturnType<typeof loadIntegrations>>,
  "repositories" | "knowledge" | "scheduling" | "orchestration" | "runtime" | "feishu" | "messageConnectors" | "sessionMessages">;

/** What the running service has, beyond the integration file. */
export interface ServiceFacts {
  /** The identities the service authenticates with; the managed loop controller is one of them. */
  identities: AuthConfig;
  /** The runtime answered as available when read. */
  runtimeAvailable: boolean;
  /** Managed loops were set up at start. */
  managedLoops: boolean;
  /** The WeChat gateway client and its ingress were set up at start. */
  connectorIngress: boolean;
  /** Document originals and HTML reports are served. */
  documents: boolean;
}

/** Only the identity and readable paths; the checkout root on this server never leaves it. */
export function projectRepositories(repositories: IntegrationConfiguration["repositories"], projectId: string): ProjectRepository[] {
  return repositories.filter(repository => repository.projectId === projectId)
    .map(repository => ({ repositoryId: repository.repositoryId, allowedPaths: [...repository.allowedPaths] }));
}

const taskTimingScope = (scopeId: string) => scopeId.startsWith("task-timing:");

/**
 * Each capability as this configuration has it for one project. A capability the configuration keys by project is
 * judged for this project alone; one setting for the whole service is marked `service`. Only configured or not, and why.
 */
export function projectCapabilities(configuration: IntegrationConfiguration, facts: ServiceFacts, projectId: string): ProjectCapability[] {
  const forProject = (key: ProjectCapabilityKey, serviceEnabled: boolean, projectConfigured: boolean): ProjectCapability =>
    !serviceEnabled ? { key, scope: "project", state: "not_configured", reason: "service_not_enabled" }
      : !projectConfigured ? { key, scope: "project", state: "not_configured", reason: "project_not_configured" }
        : { key, scope: "project", state: "configured", reason: null };
  const runtime = configuration.runtime?.enabled ? configuration.runtime : null;
  const scheduling = configuration.scheduling?.enabled ? configuration.scheduling : null;
  const knowledge = configuration.knowledge?.enabled ? configuration.knowledge : null;
  const feishu = configuration.feishu?.enabled ? configuration.feishu : null;
  const orchestration = configuration.orchestration?.enabled ? configuration.orchestration : null;
  const sessionMessages = configuration.sessionMessages?.enabled ? configuration.sessionMessages : null;
  const runtimeForProject = !!runtime && (runtime.grants.some(grant => grant.projectId === projectId) ||
    runtime.delegationTemplates.some(template => template.projectId === projectId));
  // Managed loops act as the first identity named by the controller actor, in its projects, under its runtime grants.
  const controller = orchestration ? facts.identities.find(identity => identity.actorId === orchestration.controllerActorId) : undefined;
  const runtimeItem = forProject("runtime", !!runtime, runtimeForProject);
  return [
    forProject("gitSources", true, configuration.repositories.some(repository => repository.projectId === projectId)),
    forProject("knowledge", !!knowledge, !!knowledge?.projectIds.includes(projectId)),
    forProject("scheduling", !!scheduling, !!scheduling?.grants.some(grant => grant.projectId === projectId && !taskTimingScope(grant.scopeId))),
    forProject("taskTiming", !!scheduling, !!scheduling && (scheduling.taskTimingGrants.some(grant => grant.projectId === projectId) ||
      scheduling.grants.some(grant => grant.projectId === projectId && taskTimingScope(grant.scopeId)))),
    forProject("orchestration", !!orchestration && !!runtime && facts.managedLoops,
      !!controller?.projectIds.includes(projectId) && !!runtime && (runtime.grants.some(grant =>
        grant.projectId === projectId && grant.actorId === controller.actorId) ||
        runtime.delegationTemplates.some(template => template.projectId === projectId))),
    runtimeItem.state === "configured" && !facts.runtimeAvailable ? { ...runtimeItem, reason: "runtime_unavailable" } : runtimeItem,
    forProject("feishu", !!feishu, !!feishu?.grants.some(grant => grant.projectId === projectId)),
    forProject("wechat", facts.connectorIngress && !!configuration.messageConnectors?.enabled && !!sessionMessages && !!runtime,
      !!sessionMessages?.connectorReceivers.some(receiver => receiver.enabled && receiver.projectId === projectId)),
    { key: "documentOriginals", scope: "service", state: facts.documents ? "configured" : "not_configured",
      reason: facts.documents ? null : "service_not_enabled" },
  ];
}

/** Capabilities that do not depend on the integration file. */
const outsideConfiguration = new Set<ProjectCapabilityKey>(["documentOriginals"]);

/**
 * The running service loaded its configuration at start; some settings it reads again when used. Where the file on
 * disk now leads to another state than the loaded one, or cannot be read, the state is not known.
 */
export function observedProjectCapabilities(loaded: ProjectCapability[], current: ProjectCapability[] | null): ProjectCapability[] {
  return loaded.map(item => {
    if (outsideConfiguration.has(item.key)) return item;
    if (!current) return { ...item, state: "unknown", reason: "configuration_unreadable" };
    const now = current.find(value => value.key === item.key);
    return now?.state === item.state ? item : { ...item, state: "unknown", reason: "configuration_changed" };
  });
}

/** The source for a coordinator that authenticates with its local identity file. */
export function localProjectConfiguration(options: {
  /** The integration configuration loaded at start, which the running service uses. */
  loaded: IntegrationConfiguration;
  /** The integration file read again now; it rejects when the file cannot be read or is invalid. */
  current(): Promise<IntegrationConfiguration>;
  /** The identity snapshot HTTP authentication uses. */
  identities: AuthConfig;
  facts(): Omit<ServiceFacts, "identities">;
}): ProjectConfigurationSource {
  return {
    repositories: async projectId => projectRepositories(options.loaded.repositories, projectId),
    capabilities: async projectId => {
      const facts = { ...options.facts(), identities: options.identities };
      let current: IntegrationConfiguration | null = null;
      try { current = await options.current(); } catch { /* Reported per capability as unreadable. */ }
      return observedProjectCapabilities(projectCapabilities(options.loaded, facts, projectId),
        current ? projectCapabilities(current, facts, projectId) : null);
    },
    members: { kind: "local_identities", list: async projectId => projectMembers(options.identities, projectId) },
  };
}
