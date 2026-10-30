import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RuntimeSessionSpec } from "@evoloop/contracts/runtime";
import { delegationTemplateSchema, type DelegationTemplate } from "@evoloop/contracts/division";
import type { Principal } from "@evoloop/contracts";
import type { TaskCollaborationPayload } from "@evoloop/contracts/discussions";

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export const delegationTemplateHash = (template: DelegationTemplate): string => createHash("sha256").update(canonical(template)).digest("hex");

const absolute = z.string().min(1).max(1024).regex(/^\//);
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
  return current && spec.sandbox === "workspace-write"
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
    enabled: z.boolean(), grants: z.array(z.strictObject({ projectId: z.uuid(), actorId: z.string().min(1).max(100), scopeId: z.string().min(1).max(4000), roleId: z.string().min(1).max(4000) })).max(200),
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
      receiverRoleId: z.string().min(1).max(4000), cwd: absolute, maxTurns: z.number().int().min(1).max(100), enabled: z.boolean(),
    })).max(200).refine(values => new Set(values.map(g => `${g.projectId}:${g.sessionId}:${g.senderActorId}`)).size === values.length,
      "Ordinary conversation grants must be unique per project, recipient Session and sender"),
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
      paths:z.array(z.string().regex(/^\.agents\/skills\/[A-Za-z0-9_-]+\/SKILL\.md$/)).min(1).max(12)}))
      .max(200).refine(values=>new Set(values.map(value=>`${value.projectId}:${value.roleId}`)).size===values.length,
        "Role skill sources must be unique per project and Role").default([]),
    /** Fixed modern experimental Default-mode input, scoped to this owned child only. */
    nativeUserInput: z.boolean().default(false),
    /** Exact locally reviewed App Server protocol; new configurations use the reviewed 0.166 interface. */
    protocolVersion: z.enum(["0.154.0", "0.164.0-alpha.11.1", "0.166.0-alpha.5.1"]).default("0.166.0-alpha.5.1"),
    /** Optional local-only experimental bridge. Scope and reader credentials live outside this config. */
    browserRead: z.strictObject({scopePath:absolute,playwrightModulePath:absolute}).optional(),
    delegationTemplates: z.array(delegationTemplateSchema).max(200).refine(values =>
      new Set(values.map(value => value.id)).size === values.length, "Delegation template IDs must be unique" ).default([]),
    grants: z.array(grant).max(200).refine(values => new Set(values.map(value => JSON.stringify([
      value.projectId, value.actorId, value.roleId, value.authorizationScope, value.cwd, value.sandbox,
    ]))).size === values.length, "Runtime authorization profiles must be unique"),
  }).refine(value => !value.nativeUserInput ||
    value.protocolVersion === "0.164.0-alpha.11.1" || value.protocolVersion === "0.166.0-alpha.5.1",
  "Native user input requires a reviewed modern protocol").optional(),
  orchestration: z.strictObject({
    enabled: z.boolean(), controllerActorId: z.string().min(1).max(100), workerRoot: absolute,
    credentialTtlMs: z.number().int().min(60000).max(86400000).default(3600000),
    pollIntervalMs: z.number().int().min(500).max(60000).default(2000),
  }).optional(),
});
type EngineeringActionGrant=NonNullable<z.infer<typeof integrationSchema>["residentQueue"]>["actionGrants"][number];
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
  return { runtime, sessionMessages: configuration.sessionMessages, residentQueue: configuration.residentQueue, orchestration: configuration.orchestration, repositories: configuration.repositories, feishu: configuration.feishu, knowledge: configuration.knowledge, scheduling: configuration.scheduling, allowedRuntimeCwds, allowedRuntimeCwd, hasRuntimeGrant, getDelegationTemplate };
}
