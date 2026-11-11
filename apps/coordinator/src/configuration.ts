import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RuntimeSessionSpec } from "@evoloop/contracts/runtime";
import { delegationTemplateSchema, type DelegationTemplate } from "@evoloop/contracts/division";
import type { Principal } from "@evoloop/contracts";
import type { TaskCollaborationPayload } from "@evoloop/contracts/discussions";
import { directInputConfigurationSchema } from "./direct-input/configuration.js";
import { credentialGrants, type AuthConfig } from "./auth.js";

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const delegationTemplateHash = (template: DelegationTemplate): string => createHash("sha256").update(canonical(template)).digest("hex");

const absolute = z.string().min(1).max(1024).regex(/^\//);
/** A Codex CLI release as `codex --version` prints it, without the `codex-cli ` prefix. */
const codexVersion = z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const grant = z.strictObject({
  projectId: z.uuid(), actorId: z.string().min(1).max(100), roleId: z.string().min(1).max(4000),
  authorizationScope: z.string().min(1).max(4000), cwd: absolute,
  // Legacy grants remain readable for original-operation reconciliation. New reservations require full execution.
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("danger-full-access"),
  model: z.string().min(1).max(100).optional(),
  models: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/)).min(1).max(12).refine(values => new Set(values).size === values.length,
    "Runtime model choices must be unique").optional(),
  networkAccess: z.boolean().optional(),
  approvalPolicy: z.enum(["on-request", "untrusted", "never"]).optional(),
}).transform(value => ({...value,
  networkAccess:value.networkAccess ?? (value.sandbox === "danger-full-access"),
  approvalPolicy:value.approvalPolicy ?? (value.sandbox === "danger-full-access" ? "never" as const : "on-request" as const),
})).refine(value => value.sandbox !== "danger-full-access" ||
  value.networkAccess && value.approvalPolicy === "never",
  "Full execution requires normal networking and never approval");
export type RuntimeGrant = Omit<z.infer<typeof grant>, "networkAccess" | "approvalPolicy" | "model" | "models"> &
  Partial<Pick<z.infer<typeof grant>, "networkAccess" | "approvalPolicy">> & {model?: string | null | undefined; models?: string[] | undefined};
export const grantModels = (value: Pick<RuntimeGrant,"model"|"models">): string[] =>
  [...new Set([...(value.model ? [value.model] : []),...(value.models ?? [])])];
export const grantAllowsModel = (value: Pick<RuntimeGrant,"model"|"models">, model: string | null | undefined): boolean =>
  model == null ? !value.model && !value.models?.length : grantModels(value).includes(model);
export function runtimeThreadConfig(grants: RuntimeGrant[], spec: RuntimeSessionSpec): Record<string, unknown> | undefined {
  const current=grants.find(value => value.actorId === spec.actorId && value.projectId === spec.projectId &&
    value.roleId === spec.roleId && value.authorizationScope === spec.authorizationScope && value.cwd === spec.cwd &&
    value.sandbox === spec.sandbox && grantAllowsModel(value,spec.model) &&
    (value.approvalPolicy ?? (value.sandbox === "danger-full-access" ? "never" : "on-request")) === spec.approvalPolicy);
  if (!current) return undefined;
  // Restricted receiver creation does not inherit project host tools or config.
  // Native execution stays blocked until a separately proven host boundary exists.
  if (spec.authorizationScope.startsWith("connector-receiver:")) return undefined;
  return spec.sandbox === "workspace-write"
    ? {"sandbox_workspace_write.network_access": current.networkAccess === true} : undefined;
}
/** A dynamic Session's exact binding takes precedence over every static or other-template profile. */
export async function runtimeThreadConfigForSession(grants: RuntimeGrant[], spec: RuntimeSessionSpec,
  dynamic: {isDynamicSession(projectId:string,sessionId:string):Promise<boolean>;
    networkAccessForSession(value: {projectId:string;sessionId:string;actorId:string;roleId:string;
      authorizationScope:string;cwd:string;sandbox:string;model:string|null;approvalPolicy:string}):Promise<boolean|null>} | null) {
  if (dynamic && await dynamic.isDynamicSession(spec.projectId,spec.sessionId)) {
    if (!spec.actorId) return undefined;
    const network=await dynamic.networkAccessForSession({projectId:spec.projectId,sessionId:spec.sessionId,
      actorId:spec.actorId,roleId:spec.roleId,authorizationScope:spec.authorizationScope,
      cwd:spec.cwd,sandbox:spec.sandbox,model:spec.model??null,approvalPolicy:spec.approvalPolicy});
    return network!==null && spec.sandbox==="workspace-write"
      ? {"sandbox_workspace_write.network_access":network===true} : undefined;
  }
  return runtimeThreadConfig(grants,spec);
}
const integrationSchema = z.strictObject({
  directInputs: directInputConfigurationSchema.optional(),
  repositories: z.array(z.strictObject({ projectId:z.uuid(), repositoryId:z.string().min(1).max(100), root:absolute, allowedPaths:z.array(z.string().min(1).max(1024)).min(1).max(200) })).max(200).default([]),
  feishu: z.strictObject({
    enabled: z.boolean(), appId: z.string().min(1), appSecret: z.string().min(1), appToken: z.string().min(1), tableId: z.string().min(1),
    fields: z.strictObject({ entityId: z.string().min(1), localVersion: z.string().min(1), operationId: z.string().min(1), title: z.string().min(1), status: z.string().min(1) }),
    grants: z.array(z.strictObject({ projectId: z.uuid(), actorId: z.string().min(1).max(100), scope: z.literal("project") })).max(200),
    pollEnabled: z.boolean().default(false), pollIntervalMs: z.number().int().min(30000).max(86400000).default(60000),
  }).optional(),
  knowledge: z.strictObject({
    enabled: z.boolean(), baseUrl: z.url(), manifestRoot: absolute, maintainerId: z.string().min(1).max(100), projectIds: z.array(z.uuid()).max(200),
  }).optional(),
  scheduling: z.strictObject({
    enabled: z.boolean(), grants: z.array(z.strictObject({ projectId: z.uuid(), actorId: z.string().min(1).max(100), scopeId: z.string().min(1).max(4000).refine(value => value !== "task-timing:*"), roleId: z.string().min(1).max(4000) })).max(200),
    /** Create and continue ordinary daily Task series for this exact project, actor and Role. */
    taskTimingGrants: z.array(z.strictObject({ projectId: z.uuid(), actorId: z.string().min(1).max(100), roleId: z.uuid() }))
      .max(200).refine(values => new Set(values.map(value => `${value.projectId}:${value.actorId}:${value.roleId}`)).size === values.length,
        "Task timing grants must be unique per project, actor and Role").default([]),
  }).optional(),
  residentQueue: z.strictObject({
    enabled: z.boolean(), pollIntervalMs: z.number().int().min(500).max(60000).default(2000),
    roleActors: z.array(z.strictObject({projectId:z.uuid(),roleId:z.uuid(),actorId:z.string().min(1).max(100)})).max(200)
      .refine(values=>new Set(values.map(value=>JSON.stringify([value.projectId,value.roleId]))).size===values.length,
        'Resident queue business actor bindings must be unique per project and Role'),
    actionGrants: z.array(z.strictObject({projectId:z.uuid(),actorId:z.string().min(1).max(100),
      actionType:z.enum(["worktree.write","git.commit","git.push","pr.create","pr.review","pr.merge","deployment"]),
      repository:z.string().min(1).max(240),worktree:absolute,
      commit:z.string().min(1).max(240).optional(),pullRequest:z.string().min(1).max(240).optional(),
      inputHash:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.iso.datetime({offset:true}),
      paths:z.array(z.string().min(1).max(1024)).min(1).max(100)})).max(200).default([]),
  }).optional(),
  sessionMessages: z.strictObject({
    enabled: z.boolean(), pollIntervalMs: z.number().int().min(500).max(60000).default(2000),
    /** Deprecated compatibility key; conversation execution uses the Session's full profile. */
    readOnlyProtocolVerified: z.boolean().optional(),
    grants: z.array(z.strictObject({ projectId: z.uuid(), sessionId: z.uuid(), senderActorId: z.string().min(1).max(100),
      receiverActorId: z.string().min(1).max(100),
      receiverRoleId: z.string().min(1).max(4000), cwd: absolute, maxTurns: z.number().int().positive().safe().optional(), enabled: z.boolean(),
    })).max(200).refine(values => new Set(values.map(g => `${g.projectId}:${g.sessionId}:${g.senderActorId}`)).size === values.length,
      "Ordinary conversation grants must be unique per project, recipient Session and sender"),
    /** Separate from full-access ordinary grants; each entry names one reviewed conversation route. */
    connectorReceivers: z.array(z.strictObject({projectId:z.uuid(),bindingId:z.uuid(),sessionId:z.uuid(),
      mode:z.enum(["standard","restricted"]).default("restricted"),
      senderActorId:z.string().min(1).max(100),receiverActorId:z.string().min(1).max(100),
      receiverRoleId:z.uuid(),cwd:absolute,policyHash:z.string().regex(/^[a-f0-9]{64}$/),
      maxTurns:z.number().int().min(1).max(1000),enabled:z.boolean()})).max(200).default([])
      .refine(values=>new Set(values.map(g=>`${g.projectId}:${g.bindingId}`)).size===values.length,
        "Connector receiver grants must be unique per project and route"),
  }).optional(),
  messageConnectors: z.strictObject({
    enabled: z.boolean().default(false), pollIntervalMs: z.number().int().min(500).max(60000).default(2000),
    gateway: z.strictObject({executable:absolute,configPath:absolute}),
  }).optional(),
  leaderResultNotices: z.strictObject({
    enabled: z.boolean(), pollIntervalMs: z.number().int().min(500).max(60000).default(2000),
    /** DEC-045 W1: notices created from now on travel in Leader notice packets. Default off: new notices keep the one-notice-one-message path. */
    packets: z.boolean().default(false),
    targets: z.array(z.strictObject({
      projectId: z.uuid(), sessionId: z.uuid(), receiverRoleId: z.uuid(),
      receiverActorId: z.string().trim().min(1).max(100), senderActorId: z.string().trim().min(1).max(100),
    }).refine(value=>value.receiverActorId!==value.senderActorId,
      "Leader result sender and receiver must be different actors")).max(200)
      .refine(values=>new Set(values.map(value=>value.projectId)).size===values.length,
        "Only one managed Leader result target may be configured per project"),
  }).optional(),
  runtime: z.strictObject({
    enabled: z.boolean(), executable: absolute.optional(),
    /** Explicit read-capable CLI bound to a Session requester and Task recipient; no secret is stored here. */
    materialCli: z.array(z.strictObject({projectId:z.uuid(),sessionId:z.uuid().optional(),roleId:z.uuid().optional(),sessionActorId:z.string().min(1).max(100),
      cliActorId:z.string().min(1).max(100),
      taskId:z.uuid().optional(),command:z.string().min(1).max(1024).regex(/^\/[A-Za-z0-9_./-]+(?: \/[A-Za-z0-9_./-]+)?$/)})
      .refine(value=>!!value.sessionId!==!!value.roleId && (!value.roleId||!value.taskId),
        "Material CLI binding requires one Session or Role; Task override requires a Session"))
      .max(200).refine(values=>new Set(values.map(value=>`${value.projectId}:${value.sessionId??`role:${value.roleId}`}:${value.taskId??"*"}`)).size===values.length,
        "Material CLI bindings must be unique per project and Session/Role scope").default([]),
    roleSkills: z.array(z.strictObject({projectId:z.uuid(),roleId:z.uuid(),
      paths:z.array(z.string().regex(/^\.agents\/skills\/[A-Za-z0-9_-]+\/SKILL\.md$/)).min(1).max(12),
      /**
       * Superseded by the Role's own skill selection (`role.runtime.set`), which covers built-in skills for both
       * runtimes. Still accepted so older files load; it has no effect.
       */
      builtinSkills:z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(32).default([])}))
      .max(200).refine(values=>new Set(values.map(value=>`${value.projectId}:${value.roleId}`)).size===values.length,
        "Role skill sources must be unique per project and Role").default([]),
    /** Fixed modern experimental Default-mode input, scoped to this owned child only. */
    nativeUserInput: z.boolean().default(false),
    /** Exact locally reviewed App Server protocol; new configurations keep the reviewed 0.166 default. */
    protocolVersion: z.enum(["0.154.0", "0.164.0-alpha.11.1", "0.166.0-alpha.5.1", "0.166.0-alpha.6", "0.167.0-alpha.3.2"]).default("0.166.0-alpha.5.1"),
    /**
     * Runtime a Role is bound to when its first Session is reserved and it has no binding yet. A bound Role
     * keeps its runtime; a Session keeps the runtime it was created with.
     */
    provider: z.enum(["codex", "claude"]).default("codex"),
    /**
     * Runtimes this coordinator drives at the same time; absent means only `provider`. Sessions of a runtime
     * not listed stay readable but are not driven, and Roles bound to it cannot reserve new Sessions.
     */
    providers: z.array(z.enum(["codex", "claude"])).min(1).max(2)
      .refine(values => new Set(values).size === values.length, "Runtime providers must be unique").optional(),
    /**
     * Codex version policy. `exact` (default) requires protocolVersion and its reviewed schema hash.
     * `surface` accepts minimumVersion or newer, never a blocked version, when the generated schema still
     * carries every method and parameter evoLoop sends; optional features follow that schema.
     */
    protocolCheck: z.enum(["exact", "surface"]).default("exact"),
    minimumVersion: codexVersion.optional(),
    blockedVersions: z.array(codexVersion).max(50).default([]),
    /** Dedicated Codex state directory; absent means the inherited CODEX_HOME or ~/.codex is shared. */
    codexHome: absolute.optional(),
    /**
     * `owned: true` keeps evoLoop's owner-requested compaction maintenance. `false` leaves compaction to the
     * native runtime's own automatic behaviour and disables the maintenance endpoints.
     */
    compaction: z.strictObject({ owned: z.boolean().default(true) }).default({ owned: true }),
    /**
     * Daily admission guard for ordinary message Turns and Leader result notices. It never blocks
     * a business Task Run. Absent or disabled means unlimited; a maintainer sets the private limits.
     */
    dailyBudget: z.strictObject({
      enabled: z.boolean().default(false),
      maxInputTokens: z.number().int().positive().max(1_000_000_000_000).optional(),
      maxCostUsd: z.number().positive().max(1_000_000).optional(),
      warningRatio: z.number().min(0.1).max(0.99).default(0.8),
      pauseOrdinaryTurns: z.boolean().default(true),
      timeZone: z.string().min(1).max(100).refine(value => {
        try { new Intl.DateTimeFormat("en-CA", { timeZone: value }); return true; } catch { return false; }
      }, "dailyBudget.timeZone must be an IANA time zone").default("UTC"),
    }).refine(value => !value.enabled || value.maxInputTokens !== undefined || value.maxCostUsd !== undefined,
      "Enabled dailyBudget requires maxInputTokens or maxCostUsd").optional(),
    /**
     * Context admission for long-lived Sessions. At the ceiling an ordinary result notice is left for a
     * maintainer to hand off to a new thread; a business Task Run is never blocked by this guard.
     */
    contextBudget: z.strictObject({
      enabled: z.boolean().default(false),
      maxInputTokens: z.number().int().positive().max(10_000_000).default(150_000),
      warningRatio: z.number().min(0.1).max(0.99).default(0.8),
      pauseOrdinaryTurns: z.boolean().default(true),
    }).optional(),
    /** Claude Agent SDK runtime; required when this coordinator drives claude. No credential is stored here. */
    claude: z.strictObject({
      /** Claude Code executable; absent uses the one bundled with the pinned SDK. */
      executable: absolute.optional(),
      /**
       * Dedicated CLAUDE_CONFIG_DIR for this coordinator: transcripts, settings, login and the adapter's Turn
       * ledger stay out of ~/.claude. It needs its own login, or a credential the coordinator's environment provides.
       */
      configRoot: absolute,
      maxTurns: z.number().int().positive().max(1000).optional(),
      maxBudgetUsd: z.number().positive().max(1000).optional(),
      /**
       * How many Claude Turns run at once across all Sessions (adapter default 4); each is one Claude Code process.
       * A Turn past the limit waits: its message stays queued, its Run stays requested. Size it to the Sessions that
       * should work at the same time and to the host's memory.
       */
      maxConcurrentTurns: z.number().int().min(1).max(64).optional(),
      /**
       * true: each Turn loads the skills the Role's selection picks (its evoLoop business skills, and project,
       * personal and built-in skills by switch) and turns the rest off. false: the CLI's own discovery.
       */
      skillBundle: z.boolean().default(true),
      /**
       * project: the CLI reads the work directory's project settings (CLAUDE.md, `.claude/` skills, agents, commands
       * and hooks, which it runs). explicit: it reads none and evoLoop passes the directory's AGENTS.md (else CLAUDE.md).
       */
      contextMode: z.enum(["project", "explicit"]).default("project"),
    }).optional(),
    /** Optional local-only experimental bridge. Scope and reader credentials live outside this config. */
    browserRead: z.strictObject({scopePath:absolute,playwrightModulePath:absolute}).optional(),
    delegationTemplates: z.array(delegationTemplateSchema).max(200).refine(values =>
      new Set(values.map(value => value.id)).size === values.length, "Delegation template IDs must be unique" ).default([]),
    grants: z.array(grant).max(200).refine(values => new Set(values.map(value => JSON.stringify([
      value.projectId, value.actorId, value.roleId, value.authorizationScope, value.cwd, value.sandbox,
    ]))).size === values.length, "Runtime authorization profiles must be unique"),
  }).refine(value => !value.nativeUserInput ||
    value.protocolVersion === "0.164.0-alpha.11.1" || value.protocolVersion === "0.166.0-alpha.5.1" || value.protocolVersion === "0.166.0-alpha.6" || value.protocolVersion === "0.167.0-alpha.3.2",
  "Native user input requires a reviewed modern protocol")
    .refine(value => !value.providers || value.providers.includes(value.provider), "runtime.provider must be one of runtime.providers")
    .refine(value => !drivenRuntimeProviders(value).includes("claude") || !!value.claude, "The claude provider requires runtime.claude settings")
    .refine(value => drivenRuntimeProviders(value).includes("codex") || (!value.nativeUserInput && !value.browserRead),
      "Native user input and the browser read bridge are Codex-only")
    .refine(value => value.protocolCheck === "surface" || (value.minimumVersion === undefined && value.blockedVersions.length === 0),
      "minimumVersion and blockedVersions apply only to the surface protocol check").optional(),
  orchestration: z.strictObject({
    enabled: z.boolean(), controllerActorId: z.string().min(1).max(100), workerRoot: absolute,
    credentialTtlMs: z.number().int().min(60000).max(86400000).default(3600000),
    pollIntervalMs: z.number().int().min(500).max(60000).default(2000),
  }).optional(),
});
/** Runtimes a coordinator drives: the configured list, else only the default provider. */
export function drivenRuntimeProviders(runtime: { provider: "codex" | "claude"; providers?: ("codex" | "claude")[] | undefined }): ("codex" | "claude")[] {
  return runtime.providers?.length ? [...runtime.providers] : [runtime.provider];
}
type EngineeringActionGrant=NonNullable<z.infer<typeof integrationSchema>["residentQueue"]>["actionGrants"][number];
type SchedulingConfiguration = NonNullable<z.infer<typeof integrationSchema>["scheduling"]>;
type IntegrationFile = z.infer<typeof integrationSchema>;
/** A scope that names one Task timing: `task-timing:` followed by a UUID. */
export const isTaskTimingScope = (scopeId: string): boolean =>
  scopeId.startsWith("task-timing:") && z.uuid().safeParse(scopeId.slice("task-timing:".length)).success;
/** The schedule grants of one actor in one project while scheduling is enabled (schedule.create authorization). */
export const schedulingGrantsFor = (configuration: SchedulingConfiguration | undefined, projectId: string, actorId: string) =>
  configuration?.enabled ? configuration.grants.filter(grant => grant.projectId === projectId && grant.actorId === actorId) : [];
/** Daily-copy grants the scheduling pump acts on: enabled, and held by an actor with read, write and review. */
export const activeTaskTimingGrants = (configuration: SchedulingConfiguration | undefined, identities: AuthConfig) =>
  configuration?.enabled ? configuration.taskTimingGrants.filter(grant =>
    credentialGrants(identities, grant.projectId, grant.actorId, ["read", "write", "review"])) : [];
/** The external knowledge backend serves this project. */
export const knowledgeServesProject = (knowledge: IntegrationFile["knowledge"], projectId: string): boolean =>
  !!knowledge?.enabled && knowledge.projectIds.includes(projectId);
/** Feishu collaboration is granted to this actor in this project. */
export const hasFeishuActorGrant = (feishu: IntegrationFile["feishu"], projectId: string, actorId: string): boolean =>
  !!feishu?.enabled && feishu.grants.some(g => g.projectId === projectId && g.actorId === actorId && g.scope === "project");
export function hasTaskTimingGrant(configuration: SchedulingConfiguration | undefined,
  projectId: string, actorId: string, roleId: string, scopeId: string): boolean {
  if (!configuration?.enabled || !isTaskTimingScope(scopeId)) return false;
  return configuration.grants.some(grant => grant.projectId === projectId && grant.actorId === actorId &&
    grant.roleId === roleId && grant.scopeId === scopeId) ||
    configuration.taskTimingGrants.some(grant => grant.projectId === projectId &&
      grant.actorId === actorId && grant.roleId === roleId);
}
export type MaterialCliBinding = NonNullable<z.infer<typeof integrationSchema>["runtime"]>["materialCli"][number];
export function selectMaterialCli(entries: MaterialCliBinding[], projectId: string, sessionId: string,
  sessionActorId: string, taskId?: string, roleId?: string): MaterialCliBinding | null {
  const matching = entries.filter(value => value.projectId === projectId && value.sessionActorId === sessionActorId);
  return (taskId ? matching.find(value => value.sessionId === sessionId && value.taskId === taskId) : undefined) ??
    matching.find(value => value.sessionId === sessionId && value.taskId === undefined) ??
    matching.find(value => value.roleId === roleId && value.taskId === undefined) ?? null;
}
type EngineeringActionRequest=Extract<TaskCollaborationPayload,{type:"action_request"}>;
export function hasExactEngineeringActionGrant(grants:EngineeringActionGrant[],principal:Principal,
  action:EngineeringActionRequest,actualProjectId:string,nowMs=Date.now()):boolean {
  return principal.projectIds.includes(actualProjectId)&&grants.some(g=>g.projectId===actualProjectId&&
    g.actorId===principal.actorId&&
    g.actionType===action.actionType&&g.repository===action.scope.repository&&g.worktree===action.scope.worktree&&
    (g.commit??null)===(action.scope.commit??null)&&(g.pullRequest??null)===(action.scope.pullRequest??null)&&
    g.inputHash===action.inputHash&&Date.parse(g.expiresAt)>=Date.parse(action.expiresAt)&&Date.parse(g.expiresAt)>nowMs&&
    g.paths.length===action.scope.paths.length&&g.paths.every((p,i)=>p===action.scope.paths[i]));
}
export async function loadIntegrations(path?: string) {
  let configuration: z.infer<typeof integrationSchema>;
  try { configuration = integrationSchema.parse(path ? JSON.parse(await readFile(path, "utf8")) : {}); }
  catch { throw new Error("Invalid integration configuration: check the external file and schema; values are not logged."); }
  const runtime = configuration.runtime;
  const grants = runtime?.enabled ? runtime.grants : [];
  const allowedRuntimeCwds = (projectId: string): string[] => [...new Set(grants.filter(g => g.projectId === projectId).map(g => g.cwd))];
  const hasRuntimeGrant = (scope: RuntimeGrant): boolean => grants.some(g =>
    g.projectId === scope.projectId && g.actorId === scope.actorId && g.roleId === scope.roleId &&
    g.authorizationScope === scope.authorizationScope && g.cwd === scope.cwd && g.sandbox === scope.sandbox &&
    (scope.model === undefined || grantAllowsModel(g,scope.model)) &&
    (scope.approvalPolicy === undefined || (g.approvalPolicy ?? (g.sandbox === "danger-full-access" ? "never" : "on-request")) === scope.approvalPolicy));
  const allowedRuntimeCwd = async (projectId: string, cwd: string): Promise<boolean> => {
    if (!allowedRuntimeCwds(projectId).includes(cwd) &&
      !(runtime?.enabled && runtime.delegationTemplates.some(t => t.projectId === projectId && t.cwd === cwd))) return false;
    try { return await realpath(cwd) === cwd; } catch { return false; }
  };
  const getDelegationTemplate = async (projectId: string, templateId: string) => {
    const template = runtime?.enabled ? runtime.delegationTemplates.find(value => value.projectId === projectId && value.id === templateId) : undefined;
    if (!template) return null;
    try { if (await realpath(template.cwd) !== template.cwd) return null; } catch { return null; }
    return { template, hash: delegationTemplateHash(template) };
  };
  return { runtime, sessionMessages: configuration.sessionMessages, directInputs: configuration.directInputs,
    messageConnectors: configuration.messageConnectors, leaderResultNotices: configuration.leaderResultNotices,
    residentQueue: configuration.residentQueue, orchestration: configuration.orchestration,
    repositories: configuration.repositories, feishu: configuration.feishu, knowledge: configuration.knowledge,
    scheduling: configuration.scheduling, allowedRuntimeCwds, allowedRuntimeCwd, hasRuntimeGrant,
    getDelegationTemplate };
}
