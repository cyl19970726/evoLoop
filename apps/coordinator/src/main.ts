import { withObservedSources } from "./knowledge/observed-repository.js";
import { readExternalMaterials } from "./references/materials.js";
import { createReferenceDependencies } from "./references/routes.js";
import { GitDocumentSource } from "@evoloop/adapter-git-documents";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFixedSkill, readRoleSkillSource, roleSkillReferences, roleSkillSourceReferences } from "./session-preparation/skills.js";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { canonicalTaskInputJson, taskInputSignature } from "@evoloop/core/task-input";
import { PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { authConfigSchema, hasCurrentStudyReviewer } from "./auth.js";
import { buildServer } from "./server.js";
import { acquireCoordinatorLease } from "./lease.js";
import { RuntimeWorkflowService } from "@evoloop/core/runtime";
import { CodexAppServerAdapter } from "@evoloop/adapter-codex-app-server";
import { FeishuBitableConnector } from "@evoloop/connector-feishu";
import { PgOutboxDeliveryStore } from "@evoloop/adapter-postgres/delivery";
import { CollaborationRunner } from "./collaboration/runner.js";
import { PgSchedulingStore } from "@evoloop/adapter-postgres/scheduling";
import { SchedulingPump } from "./scheduling/pump.js";
import { readDocumentOriginal } from "./documents/read-original.js";
import { RuntimeRunner } from "./runtime/runner.js";
import { supportsFixedHandoff } from "./runtime/material-cli-capability.js";
import { PreflightError } from "./runtime/preflight-report.js";
import { parseQueueHandoff } from "@evoloop/contracts/runtime-handoff";
import { NativeInputBridge } from "./runtime/native-input.js";
import { NativeInputService } from "@evoloop/core/native-input";
import { NativeObservationService } from "@evoloop/core/native-observation";
import { NativeObservationBridge } from "./runtime/native-observation.js";
import { brokeredCliForRun } from "./runtime/brokered-cli.js";
import { staticRecoveryAuthority } from "./runtime/recovery-authority.js";
import { readEvaluationMaterial } from "./runtime/evaluation-sources.js";
import { evaluationPacketMediaType } from "./runtime/evaluation-materials.js";
import { hasExactEngineeringActionGrant, loadIntegrations, runtimeThreadConfigForSession, selectMaterialCli } from "./configuration.js";
import { OpenVikingKnowledgeRepository } from "@evoloop/adapter-wiki-openviking";
import { DomainError } from "@evoloop/contracts/ports";
import type { Principal } from "@evoloop/contracts";
import { LocalBlobStore } from "@evoloop/adapter-local-blobs";
import { setupManagedLoops } from "./orchestration/setup.js";
import type { WorkerCredentialBroker } from "./workers/credentials.js";
import { readWorkStatuses } from "./orchestration/work-status.js";
import { readPlanningSources } from "./orchestration/planning-sources.js";
import { managedRuntimeAdmission } from "./orchestration/admission.js";
import { workerGuardFacts } from "./workers/facts.js";
import { currentSessionGrant, dynamicRuntimeAdmission, isBoundDynamicSession } from "./orchestration/dynamic-admission.js";
import { staticRunSessionAvailable } from "./references/source-run.js";
import { BrowserReadBridge, createPlaywrightBrowserBackend, matchesBrowserRun, readerTokenForScope } from "./runtime/browser-read.js";
import type { BrowserReadScope } from "./runtime/browser-read.js";
import type { DynamicToolCall } from "@evoloop/adapter-codex-app-server";
import type { RuntimeBinding, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { loopIntentId } from "./orchestration/runner.js";
import { ResidentQueuePump } from "./resident-queue/pump.js";
import { SessionObservationService } from "@evoloop/core/session-observation";
import { AllocationRelationsService } from "@evoloop/core/allocation-relations";
import { SessionMessageService } from "@evoloop/core/session-messages";
import { SessionMessagePump } from "./session-messages/pump.js";
import { createMessageExecutionReader } from "./session-messages/execution-capability.js";
import { sessionMessageCanStart } from "./session-messages/scheduling.js";

const databaseUrl = process.env.EVOLOOP_DATABASE_URL;
const authFile = process.env.EVOLOOP_AUTH_FILE;
if (!databaseUrl || !authFile) throw new Error("Set EVOLOOP_DATABASE_URL and EVOLOOP_AUTH_FILE. Run migrations separately before starting.");
let credentials: ReturnType<typeof authConfigSchema.parse>;
try { credentials = authConfigSchema.parse(JSON.parse(await readFile(authFile, "utf8"))); }
catch { throw new Error("Invalid identity file: check its JSON and credential schema; values are not logged."); }
const currentStudyReviewer = async (projectId: string, actorId: string) =>
  hasCurrentStudyReviewer(credentials,projectId,actorId);
const port = Number(process.env.EVOLOOP_PORT ?? "4318");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid EVOLOOP_PORT.");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000, query_timeout: 15000 });
const skillSourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
pool.on("error", () => { /* Requests receive explicit unavailable responses; credentials are never logged. */ });
const lease = await acquireCoordinatorLease(pool);
const integrations = await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
const currentIdentity = async () => authConfigSchema.parse(JSON.parse(await readFile(authFile,"utf8")));
const currentProjectWriter = async (projectId:string,actorId:string) =>
  (await currentIdentity()).some(p=>p.actorId===actorId&&p.projectIds.includes(projectId)&&
    p.permissions.includes("read")&&p.permissions.includes("write"));
const currentQueueConfiguration = async () => (await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE)).residentQueue;
const uow = new PostgresUnitOfWork(pool, {
  input: async (reader,taskId) => {
    const task=await reader.getTask(taskId);
    if(!task)throw new DomainError("TASK_UNAVAILABLE","queue Task is missing");
    return canonicalTaskInputJson(await taskInputSignature(reader,task));
  },
  lead: async (_client,projectId,actorId) => !!(await currentQueueConfiguration())?.enabled &&
    hasCurrentStudyReviewer(await currentIdentity(),projectId,actorId),
  binding: async (client,projectId,roleId,sessionId) => {
    const queue=await currentQueueConfiguration();
    const business=queue?.enabled && queue.roleActors.find(x=>x.projectId===projectId&&x.roleId===roleId);
    if(!business || !await currentProjectWriter(projectId,business.actorId))return false;
    const r=await client.query(`SELECT 1 FROM role_session_binding b JOIN role_definition role ON role.project_id=b.project_id AND role.role_id=b.role_id
      JOIN runtime_session s ON s.project_id=b.project_id AND s.session_id=b.session_id
      WHERE b.project_id=$1 AND b.role_id=$2 AND b.session_id=$3 AND role.state IN ('trial','active')
        AND s.role_id=$2::text AND s.state='ready' LIMIT 1`,[projectId,roleId,sessionId]);
    return !!r.rows[0];
  },
  grant: async (client,projectId,roleId,sessionId,taskId) => {
    const current=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
    if(!current.residentQueue?.enabled||!current.runtime?.enabled)return false;
    const r=await client.query(`SELECT s.actor_id,s.authorization_scope,s.cwd,s.sandbox,s.model,s.approval_policy,t.owner
      FROM runtime_session s JOIN task t ON t.project_id=s.project_id AND t.task_id=$4
      WHERE s.project_id=$1 AND s.session_id=$2 AND s.role_id=$3 AND s.state='ready'`,
      [projectId,sessionId,roleId,taskId]);
    const s=r.rows[0];
    return !!s&&s.owner===roleId&&hasCurrentStudyReviewer(await currentIdentity(),projectId,s.actor_id)&&
      current.hasRuntimeGrant({projectId,actorId:s.actor_id,roleId,authorizationScope:s.authorization_scope,
        cwd:s.cwd,sandbox:s.sandbox,model:s.model,approvalPolicy:s.approval_policy})&&
      await current.allowedRuntimeCwd(projectId,s.cwd);
  },
});
const clock = { now: () => new Date().toISOString() };
const ids = { next: randomUUID };
const service = new WorkflowService({
  uow, clock, ids,
  hasher: { hash: value => createHash("sha256").update(value, "utf8").digest("hex") },
  recoveryAuthority: staticRecoveryAuthority(
    () => loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE), currentIdentity),
  collaborationAuthority: {
    actorForRole: async (projectId,roleId) => {
      const config=await currentQueueConfiguration();
      const binding=config?.enabled&&config.roleActors.find(x=>x.projectId===projectId&&x.roleId===roleId);
      return binding&&await currentProjectWriter(projectId,binding.actorId)?binding.actorId:null;
    },
    isAuthorizedRoleActor: async (projectId,actorId,roleId) => {
      const config=await currentQueueConfiguration();
      if(!config?.enabled)return false;
      if(!config.roleActors.some(x=>x.projectId===projectId&&x.actorId===actorId&&x.roleId===roleId)||
        !await currentProjectWriter(projectId,actorId))return false;
      const role=await pool.query(`SELECT 1 FROM role_definition WHERE project_id=$1 AND role_id=$2 AND state IN ('trial','active') LIMIT 1`,
        [projectId,roleId]);
      return role.rows.length>0;
    },
    isProjectActor: currentProjectWriter,
    hasEngineeringActionGrant: async (principal,action,actualProjectId) => {
      const config=await currentQueueConfiguration();
      return !!config?.enabled&&hasExactEngineeringActionGrant(config.actionGrants,principal,action,actualProjectId);
    },
  },
});
const trustedRuntime = new RuntimeWorkflowService({ uow, clock, ids });
const configuredBlobRoot = process.env.EVOLOOP_BLOB_ROOT;
if (configuredBlobRoot && !isAbsolute(configuredBlobRoot)) throw new Error("EVOLOOP_BLOB_ROOT must be an absolute external data directory.");
const blobRoot = resolve(configuredBlobRoot ?? `${homedir()}/.local/share/evoloop-pilot/blobs`);
if (blobRoot === process.cwd() || blobRoot.startsWith(process.cwd() + sep)) throw new Error("Document originals must stay outside the development checkout.");
const blobsForPrincipal = (principal: Principal) => new LocalBlobStore(blobRoot,
  async payload => principal.projectIds.includes(payload.projectId) && principal.permissions.includes("read"),
  async payload => {
    try {
      const record = await service.getRegisteredBlob(principal, payload.projectId, payload.id);
      if (record.projectId === payload.projectId && record.contentHash === payload.contentHash &&
          record.size === payload.size && record.mediaType === payload.mediaType) return true;
    } catch { /* Evaluation packets are registered on their immutable Run binding. */ }
    if (payload.mediaType !== evaluationPacketMediaType) return false;
    const runs = await service.listRuntimeRuns(principal, payload.projectId);
    return runs.some(run => run.projectId === payload.projectId && run.evaluationPacket?.payloadRef === payload.id &&
      run.evaluationPacket.contentHash === payload.contentHash);
  });
const gitForPrincipal = (principal:Principal) => new GitDocumentSource(integrations.repositories, async ref => principal.projectIds.includes(ref.projectId) && principal.permissions.includes("read"));
const knowledge = integrations.knowledge;
const repositoryForPrincipal = (principal: Principal, projectId: string) => {
  if (!knowledge?.enabled || !knowledge.projectIds.includes(projectId)) throw new DomainError("KNOWLEDGE_NOT_CONFIGURED", "当前项目尚未配置外置知识后端。");
  const allowed = (permission: "read" | "write" | "review") => principal.projectIds.includes(projectId) && principal.permissions.includes(permission);
  const raw = new OpenVikingKnowledgeRepository({ baseUrl: knowledge.baseUrl, manifestRoot: knowledge.manifestRoot,
    maintainerId: knowledge.maintainerId,
    mayRead: async p => p === projectId && allowed("read"),
    mayPropose: async candidate => candidate.projectId === projectId && candidate.actorId === principal.actorId && allowed("write"),
    mayReview: async (p, actor) => p === projectId && actor === principal.actorId && allowed("review"),
    mayPublish: async (p, actor) => lease.canWrite() && p === projectId && actor === principal.actorId && allowed("review"),
    mayReconcile: async (p, actor) => lease.canWrite() && p === projectId && actor === principal.actorId && allowed("review"),
  });
  return withObservedSources(raw, async (p, source) => {
    if (p !== projectId || !source.sourceKey.startsWith("document:") || source.state !== "reachable") return false;
    try {
      const documentId = source.sourceKey.slice(9);
      const detail = await service.getDocument(principal, projectId, documentId);
      if (detail.document.adoptedRevisionId !== source.originRevision) return false;
      const fixed = await service.getDocumentPayloadRevision(principal, projectId, documentId, source.originRevision);
      if (fixed.contentHash !== source.contentHash) return false;
      return (await readDocumentOriginal({uow,blobsForPrincipal},principal,fixed)).status === "available";
    } catch { return false; }
  });
};
const runtimeConfig = integrations.runtime;
const runSessionAvailable = async (projectId: string, run: import("@evoloop/contracts").RuntimeRunRecord,
  session: import("@evoloop/contracts").RuntimeSessionRecord) => staticRunSessionAvailable(projectId,run,session,{
    runtimeEnabled:!!runtimeConfig?.enabled,
    isBoundDynamicSession:(projectId,sessionId)=>isBoundDynamicSession(pool,projectId,sessionId),
    hasRuntimeGrant:integrations.hasRuntimeGrant,allowedRuntimeCwd:integrations.allowedRuntimeCwd,
  });
const mayStartManaged = integrations.orchestration?.enabled ? managedRuntimeAdmission(pool) : async () => true;
const dynamicAdmission = integrations.orchestration?.enabled && runtimeConfig?.enabled
  ? dynamicRuntimeAdmission(pool, integrations.getDelegationTemplate, clock.now) : null;
const sessionOrigin = {
  isDynamicSession:(projectId:string,sessionId:string)=>isBoundDynamicSession(pool,projectId,sessionId),
  networkAccessForSession:(spec:Parameters<NonNullable<typeof dynamicAdmission>["networkAccessForSession"]>[0]) =>
    dynamicAdmission?.networkAccessForSession(spec) ?? Promise.resolve(null),
};
const browserRead = runtimeConfig?.enabled && runtimeConfig.browserRead ? new BrowserReadBridge({
  scopePath:runtimeConfig.browserRead.scopePath,
  backend:()=>createPlaywrightBrowserBackend(runtimeConfig.browserRead!.playwrightModulePath,runtimeConfig.browserRead!.scopePath),
  authorize:async (scope:BrowserReadScope,binding:RuntimeBinding,call:DynamicToolCall) => {
    try {
      const currentIntegrations=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
      if (!currentIntegrations.runtime?.enabled ||
        currentIntegrations.runtime.browserRead?.scopePath!==runtimeConfig.browserRead?.scopePath ||
        currentIntegrations.runtime.browserRead?.playwrightModulePath!==runtimeConfig.browserRead?.playwrightModulePath) return null;
      const currentAuth=authConfigSchema.parse(JSON.parse(await readFile(authFile,"utf8")));
      const readerToken=readerTokenForScope(scope,currentAuth);
      if (!readerToken) return null;
      const reader={actorId:scope.readerActorId,projectIds:[scope.projectId],permissions:["read"] as ("read"|"write"|"review")[]};
      const session=await service.getRuntimeSession(reader,scope.projectId,scope.sessionId);
      const run=await service.getRuntimeRun(reader,scope.projectId,scope.runId);
      const currentTask=await service.getTask(reader,scope.projectId,scope.taskId);
      if (!matchesBrowserRun(scope,binding,call,session,run,currentTask.task,currentTask.revision)) return null;
      const registeredRole=await pool.query(`SELECT state FROM role_definition WHERE project_id=$1 AND role_id::text=$2`,
        [scope.projectId,scope.roleId]);
      if (registeredRole.rows.length && !["trial","active"].includes(registeredRole.rows[0].state)) return null;
      const isDynamic=await isBoundDynamicSession(pool,scope.projectId,scope.sessionId);
      if (scope.authorizationKind==="dynamic") {
        if (!isDynamic) return null;
        const rows=await pool.query(`SELECT d.dispatch_id,d.data AS dispatch,l.data AS loop,p.data AS policy,b.data AS binding,
          EXISTS(SELECT 1 FROM role_definition role JOIN role_decision decision ON
            decision.project_id=role.project_id AND decision.role_id=role.role_id AND decision.decision='accept-trial'
            WHERE role.project_id=d.project_id AND role.role_id=b.role_id AND role.state IN ('trial','active')) AS role_accepted
          FROM orchestration_dispatch d JOIN orchestration_loop l ON l.project_id=d.project_id AND l.loop_id=d.loop_id
          JOIN runtime_role_binding b ON b.project_id=d.project_id AND b.binding_id=d.binding_id
          LEFT JOIN loop_policy_revision p ON p.project_id=l.project_id AND p.policy_id=l.current_policy_revision_id
          WHERE d.project_id=$1 AND d.task_id=$2 AND EXISTS (
            SELECT 1 FROM orchestration_event e JOIN orchestration_operation o
              ON o.project_id=e.project_id AND o.operation_id=e.operation_id AND o.actor_id=e.actor_id
            WHERE e.project_id=d.project_id AND e.kind='division.consumed' AND e.entity_type='dispatch'
              AND e.entity_id=d.dispatch_id AND o.result->>'entityType'='dispatch'
              AND o.result->>'entityId'=d.dispatch_id::text)
            AND EXISTS (SELECT 1 FROM orchestration_event e WHERE e.project_id=d.project_id
              AND e.kind='division.transferConfirmed' AND e.entity_type='dispatch' AND e.entity_id=d.dispatch_id)`,
          [scope.projectId,scope.taskId]);
        const row=rows.rows.find(value=>loopIntentId(value.dispatch_id as string,"session")===scope.sessionId &&
          loopIntentId(value.dispatch_id as string,"run")===scope.runId &&
          loopIntentId(value.dispatch_id as string,"run.reserve")===scope.runOperationId);
        if (!row || !row.role_accepted) return null;
        const dispatch=row.dispatch as {state:string;id:string;projectId:string;loopId:string;taskId:string;
          parentDispatchId:string|null;bindingId:string;recipientRoleId:string;authorizationScopeId:string;runtimeRunId:string|null};
        const loop=row.loop as {state:string};
        const policy=row.policy as {bindingByRole:Record<string,string>}|null;
        const grant=row.binding as {id:string;projectId:string;loopId:string;firstTaskId:string;
          parentDispatchId:string;roleId:string;actorId:string;authorizationScopeId:string;
          template:{id:string;revision:number;hash:string};runtime:{cwd:string;model:string;sandbox:string;networkAccess:boolean;approvalPolicy:string;expiresAtUtc:string}};
        const template=await currentIntegrations.getDelegationTemplate(scope.projectId,grant.template.id);
        if (dispatch.state!=="accepted" || loop.state!=="active" ||
          dispatch.projectId!==scope.projectId || dispatch.taskId!==scope.taskId ||
          dispatch.runtimeRunId!==scope.runId || dispatch.loopId!==grant.loopId ||
          dispatch.taskId!==grant.firstTaskId || dispatch.parentDispatchId!==grant.parentDispatchId ||
          grant.projectId!==scope.projectId || dispatch.bindingId!==grant.id || dispatch.recipientRoleId!==scope.roleId ||
          dispatch.authorizationScopeId!==scope.authorizationScope || policy?.bindingByRole[scope.roleId]!==grant.id ||
          grant.roleId!==scope.roleId || grant.actorId!==session.actorId || grant.authorizationScopeId!==scope.authorizationScope ||
          grant.runtime.cwd!==scope.cwd || grant.runtime.sandbox!==scope.sandbox ||
          grant.runtime.model!==session.model || grant.runtime.approvalPolicy!==session.approvalPolicy ||
          Date.parse(grant.runtime.expiresAtUtc)<=Date.now() || !template ||
          template.hash!==grant.template.hash || template.template.revision!==grant.template.revision ||
          template.template.actorId!==session.actorId || template.template.authorizationScopeId!==scope.authorizationScope ||
          template.template.cwd!==scope.cwd || template.template.sandbox!==scope.sandbox ||
          template.template.model!==session.model || template.template.approvalPolicy!==session.approvalPolicy ||
          template.template.networkAccess!==grant.runtime.networkAccess ||
          Date.parse(template.template.expiresAtUtc)<=Date.now()) return null;
      } else if (isDynamic || !currentIntegrations.hasRuntimeGrant({projectId:scope.projectId,actorId:session.actorId,
        roleId:scope.roleId,authorizationScope:scope.authorizationScope,cwd:scope.cwd,sandbox:scope.sandbox}) ||
        !await currentIntegrations.allowedRuntimeCwd(scope.projectId,scope.cwd)) return null;
      return readerToken;
    } catch { return null; }
  },
}) : null;
const currentSessionExecutionAuthority = async (session:RuntimeSessionRecord) => {
  const current=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
  if(!current.runtime?.enabled||session.sandbox!=="danger-full-access"||session.approvalPolicy!=="never"||
    !hasCurrentStudyReviewer(await currentIdentity(),session.projectId,session.actorId)||
    !await current.allowedRuntimeCwd(session.projectId,session.cwd))return false;
  return currentSessionGrant(pool,session,()=>current.hasRuntimeGrant({projectId:session.projectId,
    actorId:session.actorId,roleId:session.roleId,authorizationScope:session.authorizationScope,
    cwd:session.cwd,sandbox:session.sandbox,model:session.model,approvalPolicy:session.approvalPolicy}),
    dynamicAdmission?()=>dynamicAdmission.canStartConversation(session):undefined);
};
const nativeInputService = new NativeInputService({ uow, clock, ids });
const nativeObservation = new NativeObservationBridge({ service: new NativeObservationService({ uow, clock }),
  canWrite: lease.canWrite, now: clock.now,
  session: (projectId, sessionId) => uow.read(projectId, reader => reader.getRuntimeSession(sessionId)),
  projects: async () => [...new Set((await currentIdentity()).flatMap(p => p.projectIds))],
});
const nativeInputs = new NativeInputBridge({ service: nativeInputService, canWrite: lease.canWrite,
  now: clock.now,
  projects: async () => [...new Set((await currentIdentity()).flatMap(p => p.projectIds))],
  principal: async (projectId, actorId) => (await currentIdentity()).find(p => p.actorId === actorId && p.projectIds.includes(projectId)) ?? null,
  session: (projectId, sessionId) => uow.read(projectId, reader => reader.getRuntimeSession(sessionId)),
  executionAuthorized: async (session, actorId) => await currentProjectWriter(session.projectId, actorId) &&
    await currentSessionExecutionAuthority(session),
});
const runtimeFactory = runtimeConfig?.enabled ? () => {
  const adapter = new CodexAppServerAdapter({
  ...(runtimeConfig.executable ? { executable: runtimeConfig.executable } : {}),
  expectedVersion: `codex-cli ${runtimeConfig.protocolVersion}`,
  nativeUserInput: runtimeConfig.nativeUserInput,
  verifyBinding: async binding => {
    try { await trustedRuntime.verifyBinding(binding.projectId, binding); return true; } catch { return false; }
  },
  authorizeExecutionProfileActivation: async (current,target,revisionId,operationId) => {
    const configured=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
    return !!configured.runtime?.enabled&&!await isBoundDynamicSession(pool,current.projectId,current.sessionId)&&
      !!target.actorId&&configured.hasRuntimeGrant({projectId:current.projectId,actorId:target.actorId,
        roleId:current.roleId,authorizationScope:current.authorizationScope,cwd:current.cwd,
        sandbox:target.sandbox,model:target.model??null,approvalPolicy:target.approvalPolicy})&&
      await configured.allowedRuntimeCwd(current.projectId,current.cwd)&&
      await trustedRuntime.verifyExecutionProfileActivation(current.projectId,current,target,revisionId,operationId);
  },
  threadConfig: async spec => {
    const current=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
    return current.runtime?.enabled ? runtimeThreadConfigForSession(current.runtime.grants,spec,sessionOrigin) : undefined;
  },
  ...(browserRead ? {dynamicTools:(spec:import("@evoloop/contracts/runtime").RuntimeSessionSpec)=>browserRead.tools(spec),
    callDynamicTool:(call:DynamicToolCall,binding:RuntimeBinding)=>browserRead.call(call,binding),
    cancelDynamicTool:()=>browserRead.close()} : {}),
  });
  if (browserRead) adapter.onDisconnect(() => { void browserRead.close(); });
  return adapter;
} : null;
let managedCliBroker: WorkerCredentialBroker | null = null;
const runner = runtimeFactory ? new RuntimeRunner({ runtimeFactory, workflow: service, trusted: trustedRuntime, nativeInputs, nativeObservation,
  profileForSession: (_principal, session) => uow.read(session.projectId, async reader => {
    if (!reader.sessionAssignments) throw new Error("Session profile storage unavailable");
    return reader.sessionAssignments.getSessionProfile({ kind: "owned", sessionId: session.id });
  }),
  cliEntryForRun: async (session, run) => {
    if (!session || session.id !== run.sessionId || session.projectId !== run.projectId || session.state !== "ready") return null;
    const brokered = await brokeredCliForRun(managedCliBroker, session, run);
    if (brokered) return brokered;
    const current = await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
    const entry = current.runtime?.enabled ? selectMaterialCli(current.runtime.materialCli,
      run.projectId, session.id, session.actorId, run.taskId, session.roleId) : null;
    if (!entry) return null;
    const channels = await pool.query(`SELECT collaboration_recipient_actor_id AS recipient FROM discussion
      WHERE project_id=$1 AND kind='task_collaboration' AND task_id=$2
        AND collaboration_run_id=$3 AND collaboration_session_id=$4`,
      [run.projectId, run.taskId, run.id, run.sessionId]);
    if (channels.rows.length > 1 || channels.rows.length === 1 && channels.rows[0].recipient !== entry.cliActorId ||
        channels.rows.length === 0 && entry.cliActorId !== session.actorId ||
        !await currentProjectWriter(run.projectId, entry.cliActorId)) return null;
    const paths = entry.command.split(" ");
    try {
      const executable = await stat(paths[0]!);
      if (!executable.isFile() || !(executable.mode & 0o111)) return null;
      if (paths[1] && !(await stat(paths[1])).isFile()) return null;
    }
    catch { return null; }
    if (parseQueueHandoff(run.input) &&
      !await supportsFixedHandoff(entry.command, entry.cliActorId, run.projectId))
      throw new PreflightError("CLI_HANDOFF_UNAVAILABLE", {kind:"task",id:run.taskId,revisionId:run.taskRevisionId});
    return {command: entry.command, actorId: entry.cliActorId};
  },
  roleContextForRun: async (session,run) => {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.roleId))return null;
    const principal=(await currentIdentity()).find(value=>value.projectIds.includes(run.projectId)&&value.permissions.includes("read"));
    if(!principal)throw new Error("Role source authority is unavailable");
    const role=await service.getRole(principal,run.projectId,session.roleId);
    const current=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
    const configured=current.runtime?.roleSkills.find(value=>value.projectId===run.projectId&&value.roleId===session.roleId);
    const paths=configured?.paths??[".agents/skills/evoloop-workflow/SKILL.md"];
    const skills=await roleSkillReferences(skillSourceRoot,paths);
    return {roleId:role.id,revisionId:role.currentRevisionId,skills};
  },
  workerTraceAuthority: (identity, targetRunId) =>
    workerGuardFacts(pool, identity,currentStudyReviewer).fixedRunTrace!(targetRunId),
  readExternalMaterials: (principal, projectId, taskId, revisionId) => readExternalMaterials(principal, projectId, taskId, revisionId, {uow,gitForPrincipal,knowledgeForPrincipal: repositoryForPrincipal,runSessionAvailable}),
  readDocumentOriginal: (principal, revision) => readDocumentOriginal({ uow, blobsForPrincipal }, principal, revision),
  readEvaluationMaterial: (principal, projectId, source) => readEvaluationMaterial(principal, projectId, source, {
    workflow: service, gitForPrincipal, knowledgeForPrincipal: repositoryForPrincipal,
    readDocumentOriginal: (reader, revision) => readDocumentOriginal({ uow, blobsForPrincipal }, reader, revision),
  }),
  blobsForPrincipal,
  principals: credentials, canWrite: lease.canWrite, allowedCwd: integrations.allowedRuntimeCwd,
  mayCreateSession: async session => {
    if(!await mayStartManaged(session.projectId,"session",session.id))return false;
    const current=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
    return currentSessionGrant(pool,session,
      () => current.hasRuntimeGrant({projectId:session.projectId,actorId:session.actorId,roleId:session.roleId,
        authorizationScope:session.authorizationScope,cwd:session.cwd,sandbox:session.sandbox,model:session.model,
        approvalPolicy:session.approvalPolicy}),
      dynamicAdmission ? () => dynamicAdmission.canCreateSession(session) : undefined);
  },
  mayDispatchRun: async run => {
    if (!await mayStartManaged(run.projectId, "run", run.id)) return false;
    const current=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
    if(!hasCurrentStudyReviewer(await currentIdentity(),run.projectId,run.actorId))return false;
    const queueInstalled=(await pool.query("SELECT to_regclass('resident_queue_attempt') IS NOT NULL AS installed")).rows[0]?.installed;
    const queueAttempt=queueInstalled?await pool.query(`SELECT c.claim_id,c.released_at,e.role_id,e.session_id FROM resident_queue_attempt a
      JOIN resident_queue_claim c ON c.project_id=a.project_id AND c.claim_id=a.claim_id
      JOIN resident_queue_entry e ON e.project_id=c.project_id AND e.queue_id=c.queue_id AND e.entry_id=c.entry_id
      WHERE a.project_id=$1 AND a.run_id=$2 AND a.operation_id=$3`,[run.projectId,run.id,run.operationId]):{rows:[]};
    if(queueAttempt.rows[0]){
      const attempt=queueAttempt.rows[0];
      if(attempt.released_at||attempt.session_id!==run.sessionId||!current.residentQueue?.enabled)return false;
      const business=current.residentQueue.roleActors.find(x=>x.projectId===run.projectId&&x.roleId===attempt.role_id);
      if(!business||!await currentProjectWriter(run.projectId,business.actorId))return false;
      if(!await uow.read(run.projectId,reader=>reader.queue?.queueBindingCurrent(attempt.role_id,run.sessionId)??Promise.resolve(false)))return false;
    }
    const reader = credentials.find(p => p.projectIds.includes(run.projectId) && p.permissions.includes("read"));
    if (!reader) return false;
    const session = await service.getRuntimeSession(reader, run.projectId, run.sessionId);
    return currentSessionGrant(pool,session,
      () => current.hasRuntimeGrant({projectId:session.projectId,actorId:run.actorId,roleId:session.roleId,
        authorizationScope:session.authorizationScope,cwd:session.cwd,sandbox:session.sandbox,model:session.model,
        approvalPolicy:session.approvalPolicy}),
      dynamicAdmission ? () => dynamicAdmission.canStartRun(run,session) : undefined);
  },
  hasGrant: async (scope,session) => {
    const current=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
    return session
      ? currentSessionGrant(pool,session,() => current.hasRuntimeGrant(scope),
        dynamicAdmission ? () => dynamicAdmission.canCreateSession(session) : undefined)
      : current.hasRuntimeGrant(scope);
  },
  canSettleOwned: (session,run) => dynamicAdmission?.canSettleOwned(session,run) ?? Promise.resolve(false),
  ownedCwd: async (_projectId,cwd) => { try { return await realpath(cwd) === cwd; } catch { return false; } },
  }) : null;
const scheduling = new SchedulingPump({ store: new PgSchedulingStore(pool), canWrite: lease.canWrite,
  credentials: () => credentials, grants: () => integrations.scheduling?.grants ?? [],
  enabled: () => integrations.scheduling?.enabled ?? false,
  onError: () => console.error("Scheduling tick failed; inspect the saved schedule status before retrying."),
});
try { await scheduling.start(); } catch { console.error("Scheduling startup check failed; schedules were not assumed successful."); }
const messageService = new SessionMessageService({ uow, clock, ids, grantFor: async (message, session) => {
  const current = (await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE)).sessionMessages;
  if (!current?.enabled || !await currentProjectWriter(message.projectId, message.senderActorId)||
    !await currentSessionExecutionAuthority(session)) return null;
  const grant = current.grants.find(g => g.enabled && g.projectId === message.projectId && g.sessionId === session.id &&
    g.senderActorId === message.senderActorId && g.receiverRoleId === session.roleId && g.cwd === session.cwd);
  if (!grant || !await currentProjectWriter(message.projectId, grant.receiverActorId)) return null;
  try { return await realpath(session.cwd) === session.cwd ? grant : null; } catch { return null; }
} });
const businessBeforeMessage = sessionMessageCanStart({ workflow: service, service: messageService, principals: currentIdentity,
  onError: () => console.error("Task answer continuation requires review; inspect the saved queue and message reason.") });
const messagePump = runner ? new SessionMessagePump({ service: messageService, runtime: () => runner.nativeAdapter(),
  projects: async () => [...new Set((await currentIdentity()).flatMap(p => p.projectIds))],
  canWrite: () => lease.canWrite() && runner.nativeStartsAvailable(),
  pollIntervalMs: integrations.sessionMessages?.pollIntervalMs ?? 2000,
  canStart: async message => {
    const current = (await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE)).sessionMessages;
    if (!current?.enabled) {
      await messageService.noteBlocked(message.projectId, message.id, "普通对话尚未启用，消息保留待处理。");
      return false;
    }
    return businessBeforeMessage(message);
  }, onError: () => console.error("Session message needs reconciliation; inspect its original saved processing record.") }) : null;
const residentQueue = new ResidentQueuePump({workflow:service,canWrite:lease.canWrite,
  messageBusy: (projectId, sessionId) => messageService.isBusy(projectId, sessionId),
  credentials:currentIdentity,enabled:async()=>!!(await currentQueueConfiguration())?.enabled,
  pollIntervalMs:integrations.residentQueue?.pollIntervalMs??2000,
  onError:()=>console.error("Resident queue tick failed; inspect persisted queue and Run state before retrying.")});
const deliveryStore = new PgOutboxDeliveryStore(pool);
const feishu = integrations.feishu;
const hasFeishuGrant = (projectId: string, actorId: string) => !!feishu?.enabled && feishu.grants.some(g => g.projectId === projectId && g.actorId === actorId && g.scope === "project");
const collaboration = new CollaborationRunner({ store: deliveryStore, workflow: service,
  connector: feishu?.enabled ? new FeishuBitableConnector(feishu) : null, consumerId: "feishu",
  principals: credentials, canWrite: lease.canWrite, hasGrant: hasFeishuGrant,
  allowProjection: async (projectId, principal, task) => hasFeishuGrant(projectId, principal.actorId) && principal.permissions.includes("read") && principal.permissions.includes("write") &&
    task.task.projectId === projectId,
  ...(feishu?.enabled && feishu.pollEnabled ? { pollIntervalMs: feishu.pollIntervalMs } : {}),
});
await collaboration.start();
const managed = setupManagedLoops({pool, workflow: service, runtime: runner, integrations, credentials,
  runSessionAvailable,
  referenceDependencies: principal => createReferenceDependencies({uow,gitForPrincipal,
    knowledgeForPrincipal: repositoryForPrincipal,runSessionAvailable,
    hasCurrentStudyReviewer:currentStudyReviewer},principal),
  canWrite: lease.canWrite, now: clock.now, apiUrl: `http://127.0.0.1:${port}`,
  verifyProposalMaterial: async (principal, projectId, documentId, revisionId, hash) => {
    try {
      const revision = await service.getDocumentPayloadRevision(principal,projectId,documentId,revisionId);
      return revision.contentHash === hash &&
        (await readDocumentOriginal({uow,blobsForPrincipal},principal,revision)).status === "available";
    } catch { return false; }
  },
  projectRoot: fileURLToPath(new URL("../../../", import.meta.url)),
  cliMain: fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url))});
managedCliBroker = managed?.broker ?? null;
if (runner) {
  try { await runner.start(); }
  catch { console.error("Codex runtime is unavailable; check the configured CLI version, protocol and project directories. No new dispatch was enabled."); }
}
const app = await buildServer({ service, credentials, canWrite: lease.canWrite,
  workStatuses: (principal, projectId, taskIds) => readWorkStatuses(pool, service, principal, projectId, taskIds),
  sessionWork: new SessionObservationService({ uow }),
  allocationRelations: new AllocationRelationsService({ uow }),
  sessionMessages: messageService, nativeInputs, nativeObservation,
  messageExecution: createMessageExecutionReader({
    loadConfiguration: () => loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE),
    runtimeAvailable: () => runner?.status().available === true,
    isProjectWriter: currentProjectWriter,
    canExecuteSession: currentSessionExecutionAuthority,
    readSession: (projectId, sessionId) => uow.read(projectId, reader => reader.getRuntimeSession(sessionId)),
    turnsUsed: (projectId, sessionId, senderActorId) => uow.read(projectId, async reader => {
      if (!reader.sessionMessages) throw new Error("Message persistence is unavailable");
      return reader.sessionMessages.countSessionMessageTurns(sessionId, senderActorId);
    }),
    cwdIsCurrent: async cwd => { try { return await realpath(cwd) === cwd; } catch { return false; } },
  }),
  planningSources: (principal, projectId, taskId, revisionId, loopId) =>
    readPlanningSources(pool, principal, projectId, taskId, revisionId, loopId),
  sourceConfiguration: principal => ({
    git: integrations.repositories.some(repository => !principal || principal.projectIds.includes(repository.projectId)),
    wiki: !!knowledge?.enabled && knowledge.projectIds.some(projectId => !principal || principal.projectIds.includes(projectId)),
  }),
  ...(managed ? {orchestration: managed.routes, workers: managed.workers} : {}),
  ...(runner ? { runtime: runner, readEvaluationPacket: (principal, projectId, runId) =>
    runner.readEvaluationPacket(principal, projectId, runId) } : {}), allowedRuntimeCwd: integrations.allowedRuntimeCwd,
  allowedRuntimeCwds: integrations.allowedRuntimeCwds,
  hasRuntimeGrant: async scope => (await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE)).hasRuntimeGrant(scope),
  isDynamicSession: sessionOrigin.isDynamicSession,
  authorizeDynamicSession: async (principal,command) => principal.permissions.includes("review") &&
    await dynamicAdmission?.canReserveSession({projectId:command.projectId,sessionId:command.sessionId,
      actorId:principal.actorId,roleId:command.roleId,authorizationScope:command.authorizationScope,
      cwd:command.cwd,sandbox:command.sandbox,model:command.model??null,
      approvalPolicy:command.approvalPolicy}) === true,
  authorizeDynamicRun: async (principal,command,session) => principal.permissions.includes("review") &&
    principal.actorId === session.actorId && await dynamicAdmission?.canReserveRun(session,command.runId,command.taskId) === true,
  runtimeGrants: (projectId, actorId) => runtimeConfig?.enabled ? runtimeConfig.grants.filter(g => g.projectId === projectId && g.actorId === actorId) : [],
  sessionPreparation: async input => {
    const current=await loadIntegrations(process.env.EVOLOOP_INTEGRATIONS_FILE);
    const cli=current.runtime?.enabled ? selectMaterialCli(current.runtime.materialCli,input.projectId,
      input.sessionId,input.sessionActorId,undefined,input.roleId) : null;
    const roleActor=current.residentQueue?.enabled ? current.residentQueue.roleActors.find(value=>
      value.projectId===input.projectId&&value.roleId===input.roleId) : null;
    const configured=current.runtime?.roleSkills.find(value=>value.projectId===input.projectId&&value.roleId===input.roleId);
    const paths=configured?.paths??[".agents/skills/evoloop-workflow/SKILL.md"];
    const skills=await roleSkillReferences(skillSourceRoot,paths).catch(()=>[]);
    return {runtimeAvailable:!!runner?.status().available,
      grantReady:!!current.runtime?.enabled&&current.hasRuntimeGrant({projectId:input.projectId,actorId:input.sessionActorId,
        roleId:input.roleId,authorizationScope:input.authorizationScope,cwd:input.cwd,sandbox:"danger-full-access",
        model:input.model,approvalPolicy:"never"}),
      cwdReady:await current.allowedRuntimeCwd(input.projectId,input.cwd),
      materialCli:cli?{actorId:cli.cliActorId,command:cli.command,
        ready:await supportsFixedHandoff(cli.command,cli.cliActorId,input.projectId)}:null,
      roleActorId:roleActor&&await currentProjectWriter(input.projectId,roleActor.actorId)?roleActor.actorId:null,
      skills:skills.map(value=>({...value,readSubcommand:`get '/api/projects/${input.projectId}/roles/${input.roleId}/skills/${value.path.split("/")[2]}?commit=${value.commit}&hash=${value.contentHash}'`}))};
  },
  readRoleSkill: async (projectId,roleId,name,commit,hash) => {
    // A Role may change its current skill list; an earlier fixed handoff remains readable.
    const path=`.agents/skills/${name}/SKILL.md`;
    const skill=await readFixedSkill(skillSourceRoot,path,commit,hash);
    const references=await roleSkillSourceReferences(skillSourceRoot,path,commit);
    return {...skill,references:references.map(value=>({...value,
      readSubcommand:`get '/api/projects/${projectId}/roles/${roleId}/skills/${name}/source?path=${encodeURIComponent(value.path)}&via=${encodeURIComponent(path)}&commit=${commit}&hash=${value.contentHash}'`}))};
  },
  readRoleSkillSource: async (projectId,roleId,name,path,via,commit,hash) => {
    const skillPath=`.agents/skills/${name}/SKILL.md`;
    const trail=via.split("|");
    const source=await readRoleSkillSource(skillSourceRoot,skillPath,path,commit,hash,trail);
    return {...source,references:source.references.map(value=>({...value,
      readSubcommand:`get '/api/projects/${projectId}/roles/${roleId}/skills/${name}/source?path=${encodeURIComponent(value.path)}&via=${encodeURIComponent([...trail,path].join("|"))}&commit=${commit}&hash=${value.contentHash}'`}))};
  },
  references: {uow, gitForPrincipal, knowledgeForPrincipal: (principal, projectId) => repositoryForPrincipal(principal, projectId), runSessionAvailable},
  scheduling,
  schedulingGrants: (projectId, actorId) => integrations.scheduling?.enabled
    ? integrations.scheduling.grants.filter(g => g.projectId === projectId && g.actorId === actorId)
    : [],
  collaboration: { runner: collaboration, store: deliveryStore, consumerId: "feishu", hasGrant: hasFeishuGrant },
  documents: { uow, blobsForPrincipal },
  knowledge: { repositoryForPrincipal, blobsForPrincipal },
  webRoot: fileURLToPath(new URL("../../workbench/dist/", import.meta.url)) });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  try { messagePump?.stop(); residentQueue.stop(); await managed?.stop(); await collaboration.stop(); await scheduling.stop(); await app.close(); }
  finally {
    // Keep the coordinator lease while a native child may still be alive.
    // stop() only succeeds after the owned child's actual exit is observed.
    if (runner) await runner.stop();
    try { await lease.release(); } finally { await pool.end(); }
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try { await app.listen({ host: "127.0.0.1", port }); managed?.start(); residentQueue.start(); messagePump?.start(); console.log(`evoLoop local workbench: http://127.0.0.1:${port}`); }
catch (error) { await shutdown(); throw error; }
