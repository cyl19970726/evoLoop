import { registerReferenceRoutes, type ReferenceRouteOptions } from "./references/routes.js";
import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { commandSchema, capabilities, idSchema, documentKindSchema, type Command, type Principal, type RuntimeSessionRecord } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import { authenticate, authConfigSchema, type AuthConfig } from "./auth.js";
import { z } from "zod";
import type { RuntimeRunner } from "./runtime/runner.js";
import { runInputPage } from "./runtime/input-read.js";
import type { NativeInputBridge } from "./runtime/native-input.js";
import { publicNativeObservationView, type NativeObservationBridge } from "./runtime/native-observation.js";
import type { SessionObservationService } from "@evoloop/core/session-observation";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import type { OrdinaryMessageExecutionCapability } from "@evoloop/contracts/session-work";
import { registerSessionWorkRoutes } from "./session-work/routes.js";
import type { AllocationRelationsService } from "@evoloop/core/allocation-relations";
import { registerAllocationRelationRoutes } from "./allocation-relations/routes.js";
import type { SessionMessageService } from "@evoloop/core/session-messages";
import { registerSessionMessageRoutes } from "./session-messages/routes.js";
import { registerDirectInputRoutes } from "./direct-input/routes.js";
import type { DirectInputService } from "./direct-input/service.js";
import { registerConnectorRouteReads, type ConnectorRouteReader, type ConnectorDeliveryReader,
  type ConnectorSourceReader } from "./message-connectors/routes.js";
import type { VersionedConnectorRoute } from "@evoloop/contracts/message-connectors";
import type { ManualStopPreview } from "./session-messages/manual-stop.js";
import type { SessionMessageManualStopPreflight } from "@evoloop/contracts/session-messages";
import type { SessionTimelineService } from "./session-timeline/index.js";
import { registerSessionTimelineRoutes } from "./session-timeline/routes.js";
import { runtimeReconcileSchema, runtimeCompactionIntentSchema, preTurnContinueSchema, messagePreTurnContinueSchema, runtimeProviderSchema, sessionProvider } from "@evoloop/contracts/runtime";
import type { CompactionMaintenance } from "./runtime/compaction.js";
import { grantAllowsModel, grantModels, type RuntimeGrant } from "./configuration.js";
import { registerDocumentRoutes, type DocumentRouteOptions } from "./documents/routes.js";
import { registerTaskMaterialRoutes } from "./documents/task-materials.js";
import { registerCollaborationRoutes } from "./collaboration/routes.js";
import type { CollaborationRunner } from "./collaboration/runner.js";
import type { DeliveryStore } from "@evoloop/contracts/delivery";
import type { ScheduleGrant, SchedulingPump } from "./scheduling/pump.js";
import { registerKnowledgeRoutes, type KnowledgeRouteOptions } from "./knowledge/routes.js";
import { registerWorkManagementRoutes } from "./work-management/routes.js";
import { registerAcceptanceRelayRoutes } from "./acceptance-relay/routes.js";
import type { AcceptanceRelayService } from "./acceptance-relay/service.js";
import type { LeaderWorkIndexReader } from "./work-management/work-index.js";
import { registerLeaderNoticeRoutes, type LeaderNoticeReader } from "./work-management/leader-notice-routes.js";
import { registerTaskAttentionRoutes } from "./task-attention/routes.js";
import type { Pool } from "pg";
import { registerEvaluationRoutes, type ReadEvaluationPacket } from "./evaluation/routes.js";
import { OrchestrationError } from "@evoloop/core/orchestration";
import { registerOrchestrationRoutes, registerPlanningSourcesRoute, registerWorkStatusRoute,
  type WorkStatusesReader, type OrchestrationRouteOptions,
  type PlanningSourcesReader } from "./orchestration/routes.js";
import { authorizeWorkerRequest, type WorkerGuardFacts } from "./workers/guard.js";
import type { WorkerIdentity } from "./workers/types.js";
import { registerOrdinaryRunSubmissionRoutes, type OrdinaryRunSubmissionRoutes } from "./ordinary-run-submission/routes.js";
import { registerProjectConfigurationRoutes, type ProjectConfigurationSource } from "./project-configuration/routes.js";

declare module "fastify" { interface FastifyRequest { principal: Principal | null; workerIdentity: WorkerIdentity | null } }
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: idSchema.optional() });
const errorStatus = (code: string) => code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : 409;
export async function buildServer(options: {
  service: WorkflowService; credentials: AuthConfig; webRoot?: string; canWrite?: () => boolean;
  runtime?: RuntimeRunner; allowedRuntimeCwds?: (projectId: string) => string[];
  compaction?: CompactionMaintenance;
  sessionWork?: SessionObservationService;
  allocationRelations?: AllocationRelationsService;
  sessionMessages?: SessionMessageService;
  directInput?: DirectInputService;
  connectorRoutes?: ConnectorRouteReader;
  connectorDeliveries?: ConnectorDeliveryReader;
  connectorSources?: ConnectorSourceReader;
  canActivateConnectorRoute?: (route:VersionedConnectorRoute)=>Promise<boolean>;
  sessionTimeline?: SessionTimelineService;
  nativeInputs?: NativeInputBridge;
  nativeObservation?: NativeObservationBridge;
  /** Read-only, snapshot-only projection. Must not initialize native processes or perform dispatch. */
  messageExecution?: (principal: Principal, projectId: string, session: ObservedSession) => Promise<OrdinaryMessageExecutionCapability>;
  allowedRuntimeCwd?: (projectId: string, cwd: string) => Promise<boolean>;
  hasRuntimeGrant?: (scope: RuntimeGrant) => boolean | Promise<boolean>;
  isDynamicSession?: (projectId: string, sessionId: string) => Promise<boolean>;
  authorizeDynamicSession?: (principal: Principal, command: Extract<Command,{type:"runtime.session.reserve"}>) => Promise<boolean>;
  authorizeDynamicRun?: (principal: Principal, command: Extract<Command,{type:"runtime.run.reserve"}>, session: RuntimeSessionRecord) => Promise<boolean>;
  authorizeDynamicMessageRecovery?: (principal: Principal, session: RuntimeSessionRecord) => Promise<boolean>;
  manualStop?: {
    execute(principal:Principal,command:Extract<Command,{type:"session.message.manualStop"}>):ReturnType<WorkflowService["execute"]>;
    preview(session: RuntimeSessionRecord, turnId: string): Promise<ManualStopPreview>;
    verify(command: Extract<Command,{type:"session.message.manualStop"}>, session: RuntimeSessionRecord,
      preview: ManualStopPreview,preflight:SessionMessageManualStopPreflight): Promise<void>;
  };
  runtimeGrants?: (projectId: string, actorId: string) => RuntimeGrant[];
  /** Live runtime binding and skills of a Role; absent when this coordinator cannot read them. */
  roleRuntimeView?: (principal: Principal, projectId: string, roleId: string) => Promise<import("@evoloop/contracts/role-skills").RoleRuntimeView>;
  /** Model choices of one driven runtime; absent provider means the default runtime. */
  listRuntimeModels?: (provider?: import("@evoloop/contracts/runtime").RuntimeProvider) => Promise<{status:"available"|"empty"|"unavailable";models:string[];
    options?:Array<{model:string;supportedReasoningEfforts:string[];defaultReasoningEffort:string|null}>;
    error:string|null;observedAtUtc:string}>;
  /** Send-time check of the ordinary-message grant for a post to this owned Session; null when the sender may send. */
  messageSendAuthority?: (principal: Principal, projectId: string, sessionId: string) => Promise<{ code: "MESSAGE_GRANT_MISSING"; message: string } | null>;
  sessionPreparation?: (input:{projectId:string;sessionId:string;roleId:string;sessionActorId:string;
    cwd:string;authorizationScope:string;model:string|null}) => Promise<{runtimeAvailable:boolean;grantReady:boolean;
    cwdReady:boolean;materialCli:{actorId:string;command:string;ready:boolean}|null;roleActorId:string|null;
    skills:Array<{path:string;commit:string;contentHash:string;readSubcommand:string}>}>;
  readRoleSkill?: (projectId:string,roleId:string,name:string,commit:string,hash:string) =>
    Promise<{path:string;commit:string;contentHash:string;body:string;
      references:Array<{path:string;commit:string;contentHash:string;readSubcommand:string}>}|null>;
  readRoleSkillSource?: (projectId:string,roleId:string,name:string,path:string,via:string,commit:string,hash:string) =>
    Promise<{path:string;commit:string;contentHash:string;body:string;
      references:Array<{path:string;commit:string;contentHash:string;readSubcommand:string}>;
      cycleReferencesOmitted:number;referenceLimitReached:boolean}|null>;
  references?: ReferenceRouteOptions;
  scheduling?: SchedulingPump;
  schedulingGrants?: (projectId: string, actorId: string) => ScheduleGrant[];
  collaboration?: {runner: CollaborationRunner; store: DeliveryStore; consumerId: string; hasGrant(projectId:string,actorId:string):boolean};
  documents?: Omit<DocumentRouteOptions, "workflow">;
  knowledge?: Omit<KnowledgeRouteOptions, "workflow">;
  readEvaluationPacket?: ReadEvaluationPacket;
  orchestration?: OrchestrationRouteOptions;
  workStatuses?: WorkStatusesReader;
  workIndex?: LeaderWorkIndexReader;
  acceptanceRelay?: AcceptanceRelayService;
  leaderNotices?: LeaderNoticeReader;
  taskAttentionPool?: Pool;
  planningSources?: PlanningSourcesReader;
  workers?: { authenticate(header: string | undefined): Promise<WorkerIdentity | null>; facts(identity: WorkerIdentity): WorkerGuardFacts };
  ordinarySubmissions?: OrdinaryRunSubmissionRoutes;
  sourceConfiguration?(principal: Principal | null): {git: boolean; wiki: boolean};
  /** This project's repositories, capabilities and members; a part left out answers `unavailable`. */
  projectConfiguration?: ProjectConfigurationSource;
}) {
  const credentials = authConfigSchema.parse(options.credentials);
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  app.decorateRequest("principal", null);
  app.decorateRequest("workerIdentity", null);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' blob:; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data:; frame-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!request.url.startsWith("/api/")) return;
    request.principal = authenticate(request.headers.authorization, credentials);
    if (!request.principal && options.workers) {
      request.workerIdentity = await options.workers.authenticate(request.headers.authorization);
      request.principal = request.workerIdentity?.principal ?? null;
    }
    if (!request.principal) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "需要有效的本机访问令牌。" });
    if (request.method !== "GET" && request.method !== "HEAD" && options.canWrite && !options.canWrite()) {
      return reply.code(503).send({ code: "UNAVAILABLE", message: "协调者资格不可用；请保留操作 ID 并回读。" });
    }
  });
  // Body-aware scope authorization applies to every worker API request, including plugin routes.
  app.addHook("preValidation", async (request, reply) => {
    if (request.workerIdentity && (!options.workers || !await authorizeWorkerRequest(request.workerIdentity,
      {method: request.method, path: request.url, body: request.body}, options.workers.facts(request.workerIdentity))))
      return reply.code(403).send({code: "FORBIDDEN", message: "当前执行身份没有此对象或操作的授权。"});
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ code: "INVALID_INPUT", message: "输入不符合当前接口合同。", issues: error.issues.map(x => ({ path: x.path, code: x.code })) });
    }
    if (error instanceof DomainError) return reply.code(errorStatus(error.code)).send({ code: error.code, message: error.message, ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
    if (error instanceof OrchestrationError) return reply.code(errorStatus(error.code)).send({ code: error.code, message: error.message, ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
    if (typeof error === "object" && error !== null && "statusCode" in error) {
      if (error.statusCode === 413) return reply.code(413).send({ code: "TOO_LARGE", message: "请求超过本片大小限制。" });
      if (error.statusCode === 400) return reply.code(400).send({ code: "INVALID_INPUT", message: "请求格式不合法。" });
    }
    // A failed connection/response is not proof that the database commit failed.
    return reply.code(503).send({ code: "RESULT_UNCONFIRMED", message: "暂时无法确认结果。写操作请保留原操作 ID 并查询记录。", requestId: request.id });
  });
  const who = (p: Principal | null) => { if (!p) throw new DomainError("FORBIDDEN", "未认证"); return p; };
  const messageRecoverySession = async (principal:Principal,projectId:string,sessionId:string,
    allowInactive=false) => {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "普通消息恢复需要本项目复核权限。");
    const session = await options.service.getRuntimeSession(principal, projectId, sessionId);
    const dynamic = await options.isDynamicSession?.(projectId, sessionId);
    const granted = dynamic ? await options.authorizeDynamicMessageRecovery?.(principal, session) :
      await options.hasRuntimeGrant?.({ projectId, actorId:principal.actorId, roleId:session.roleId,
        authorizationScope:session.authorizationScope,cwd:session.cwd,sandbox:session.sandbox,
        model:session.model,approvalPolicy:session.approvalPolicy });
    if ((!allowInactive && session.state !== "ready") || !granted)
      throw new DomainError("FORBIDDEN", "当前身份没有此原会话的精确执行恢复授权。");
    return session;
  };
  const params = (value: unknown) => z.record(z.string(), idSchema).parse(value);
  const callerGrants = (projectId:string,actorId:string) => (options.runtimeGrants?.(projectId,actorId) ?? []).filter(g=>g.projectId===projectId && g.actorId===actorId);
  const catalog = async (provider?: import("@evoloop/contracts/runtime").RuntimeProvider) => {
    if (!options.runtime?.status().available || !options.listRuntimeModels) return {status:"unavailable" as const,models:[] as string[],error:"模型目录暂不可读取",observedAtUtc:new Date().toISOString()};
    try { return await options.listRuntimeModels(provider); }
    catch { return {status:"unavailable" as const,models:[] as string[],error:"模型目录读取失败或超时",observedAtUtc:new Date().toISOString()}; }
  };
  const requireActiveModel = async (model:string|null, provider:import("@evoloop/contracts/runtime").RuntimeProvider) => {
    const current=await catalog(provider);
    if(current.status==="unavailable")throw new DomainError("MODEL_CATALOG_UNAVAILABLE","模型目录读取失败或超时，未创建会话或运行。请稍后重试。");
    if(current.status==="empty")throw new DomainError("MODEL_CATALOG_EMPTY","当前模型目录为空，未创建会话或运行。");
    if(model && !current.models.includes(model))throw new DomainError("MODEL_NOT_ACTIVE",`模型 ${model} 当前不在 App Server 可用目录中，未创建会话或运行。`);
  };
  const callerSchedulingGrants = (projectId: string, actorId: string) =>
    (options.schedulingGrants?.(projectId, actorId) ?? []).filter(g => g.projectId === projectId && g.actorId === actorId);
  const currentCapabilities = (principal: Principal | null = null) => ({ ...capabilities,
    ...(options.sourceConfiguration?.(principal) ?? {}), goalWorkflow: true, organizationReviewDocuments: true, html: !!options.documents,
    documentOriginals: !!options.documents, knowledge: !!options.knowledge, runtime: options.runtime?.status().available ?? false,
    sourceConfiguration: options.sourceConfiguration?.(principal) ?? {git: false, wiki: false},
  });
  app.get("/health", async () => ({ status: options.canWrite?.() === false ? "unavailable" : "ok", capabilities: currentCapabilities() }));
  app.get("/api/session", async request => ({ principal: who(request.principal), capabilities: currentCapabilities(request.principal) }));
  app.post("/api/commands", async (request, reply) => {
    const command = commandSchema.parse(request.body);
    if (command.type === "runtime.session.reserve" && !command.model) {
      const principal = who(request.principal);
      if (!principal.projectIds.includes(command.projectId) || !principal.permissions.includes("review"))
        throw new DomainError("FORBIDDEN", "执行操作需要本项目复核权限。");
      // An already recorded legacy intent must reach core's actor/hash guarded idempotency path.
      // A missing operation remains a new request and goes through the exact-model requirement below.
      if (await options.service.getOperation(principal, command.projectId, command.operationId)) {
        const result = await options.service.execute(principal, command);
        return reply.code(result.status === "applied" ? 200 : errorStatus(result.code)).send(result);
      }
    }
    if (command.type === "session.message.post" && command.target.kind === "owned" && options.messageSendAuthority) {
      const principal = who(request.principal);
      // A replay of an operation already journaled goes through execute's own actor/hash check.
      if (!await options.service.getOperation(principal, command.projectId, command.operationId)) {
        const problem = await options.messageSendAuthority(principal, command.projectId, command.target.sessionId);
        if (problem) throw new DomainError(problem.code, problem.message);
      }
    }
    if (command.type === "session.input.reply") {
      const principal = who(request.principal);
      // Exact same-ID recovery still goes through execute's actor/hash journal check, even after RPC cleanup.
      if (!await options.service.getOperation(principal, command.projectId, command.operationId)) {
        if (!options.nativeInputs) throw new DomainError("NATIVE_INPUT_UNAVAILABLE", "此服务尚未启用原生提问回复。");
        await options.nativeInputs.requireReply(principal, command.projectId, command.inputRequestId);
      }
    }
    if (command.type === "session.message.reconcile" || command.type === "session.message.interrupt" ||
      command.type === "session.message.manualStop") {
      const principal = who(request.principal);
      // A replay of the original journalled intent remains readable after grant drift;
      // a new control decision must match the current exact Session environment.
      if (!await options.service.getOperation(principal, command.projectId, command.operationId)) {
        const session = await messageRecoverySession(principal,command.projectId,command.sessionId);
        if (command.type === "session.message.manualStop") {
          if (!options.manualStop || !options.sessionMessages)
            throw new DomainError("MANUAL_STOP_UNAVAILABLE", "当前 owner 未提供首次维护交接核验入口。");
          const detail = await options.sessionMessages.detail(command.projectId,command.messageId);
          const preflight = await options.sessionMessages.manualStopPreflight(command.projectId,command.messageId);
          if (!preflight) throw new DomainError("MANUAL_STOP_PREFLIGHT_MISSING", "停前原 owner 身份锚点不存在。");
          if (detail.message.target.kind !== "owned" || detail.message.target.sessionId !== command.sessionId ||
            detail.processing?.id !== command.processingId || detail.processing.nativeTurnId !== command.nativeTurnId ||
            detail.message.version !== command.expectedMessageVersion ||
            detail.processing.version !== command.expectedProcessingVersion)
            throw new DomainError("MANUAL_STOP_BINDING_CHANGED", "原消息、processing 或版本已变化；请重新预览。");
          const preview = await options.manualStop.preview(session,command.nativeTurnId);
          await options.manualStop.verify(command,session,preview,preflight);
        }
      }
    }
    if (command.type.startsWith("runtime.")) {
      if (command.type !== "runtime.handoff.record" && command.type !== "runtime.run.abandonReadOnly" &&
        command.type !== "runtime.session.executionProfile.revise" && command.type !== "runtime.session.recovery.resume" &&
        !options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "Codex 执行服务尚未配置或当前不可用；本次未登记派发。");
      const principal = who(request.principal);
      if (!principal.projectIds.includes(command.projectId) || (command.type === "runtime.handoff.record" ? !principal.permissions.includes("write") : !principal.permissions.includes("review"))) {
        throw new DomainError("FORBIDDEN", "执行操作需要本项目复核权限。");
      }
      if (command.type === "runtime.session.reserve") {
        const dynamic = await options.isDynamicSession?.(command.projectId,command.sessionId);
        if (!dynamic && !command.model)
          throw new DomainError("MODEL_SELECTION_REQUIRED","新建会话必须指定此环境明确授权的精确模型 slug。先用 models --project 查询；若无可选模型，请在 runtime.grants 的 model 或 models 中配置授权。");
        const sameEnvironment=callerGrants(command.projectId,principal.actorId).filter(g=>g.roleId===command.roleId&&
          g.authorizationScope===command.authorizationScope&&g.cwd===command.cwd&&g.sandbox===command.sandbox&&
          (g.approvalPolicy??(g.sandbox==="danger-full-access"?"never":"on-request"))===command.approvalPolicy);
        if(!dynamic&&sameEnvironment.length&&!sameEnvironment.some(g=>grantAllowsModel(g,command.model??null)))
          throw new DomainError("MODEL_NOT_AUTHORIZED",`模型 ${command.model??"默认模型"} 未获此环境授权，未创建会话。`);
        if (dynamic ? !await options.authorizeDynamicSession?.(principal,command) :
          !await options.hasRuntimeGrant?.({ projectId: command.projectId, actorId: principal.actorId,
          roleId: command.roleId, authorizationScope: command.authorizationScope, cwd: command.cwd,
          sandbox: command.sandbox, model: command.model ?? null, approvalPolicy: command.approvalPolicy }) ||
          !await options.allowedRuntimeCwd?.(command.projectId, command.cwd)) {
          throw new DomainError("FORBIDDEN", "执行职责、范围、目录与权限须与项目授权完全一致。");
        }
        if(!dynamic)await requireActiveModel(command.model!,
          await options.service.roleRuntimeProvider(principal,command.projectId,command.roleId));
      }
      // Closing is a reviewer request; the runner archives under the original Session grant.
      if (command.type === "runtime.session.executionProfile.revise" && command.reasoningEffort &&
        !await options.service.getOperation(principal,command.projectId,command.operationId)) {
        if(!options.runtime)throw new DomainError("RUNTIME_READ_UNAVAILABLE","原生执行服务不可读，未保存新配置；请恢复连接后重试。");
        await options.runtime.preflightExecutionProfileRevision(principal,command);
        const current=await catalog(sessionProvider(await options.service.getRuntimeSession(principal,command.projectId,command.sessionId)));
        if(current.status!=="available")throw new DomainError("MODEL_CATALOG_UNAVAILABLE","原生模型目录不可用，未保存新配置。");
        if(!current.options?.find(option=>option.model===command.model)?.supportedReasoningEfforts.includes(command.reasoningEffort??""))
          throw new DomainError("REASONING_EFFORT_UNSUPPORTED","该模型当前未列出所选思考强度，未保存新配置。");
      }
      if (command.type === "runtime.run.reserve") {
        const session = await options.service.getRuntimeSession(principal, command.projectId, command.sessionId);
        const dynamic = await options.isDynamicSession?.(command.projectId,command.sessionId);
        if (dynamic ? !await options.authorizeDynamicRun?.(principal,command,session) :
          !await options.hasRuntimeGrant?.({ projectId: command.projectId, actorId: principal.actorId,
          roleId: session.roleId, authorizationScope: session.authorizationScope, cwd: session.cwd,
          sandbox: session.sandbox, model: session.executionProfile?.revision.model??session.model,
          approvalPolicy: session.approvalPolicy })) {
          if (!await options.authorizeDynamicRun?.(principal, command, session))
          throw new DomainError("FORBIDDEN", "当前请求者未获该职责和范围的执行授权。");
        }
        if(!dynamic)await requireActiveModel(session.executionProfile?.revision.model??session.model,sessionProvider(session));
      }
    }
    if (command.type === "schedule.create" || (command.type === "schedule.revise" && command.state === "active")) {
      const principal = who(request.principal);
      if (!principal.projectIds.includes(command.projectId) || !principal.permissions.includes("review") ||
        !callerSchedulingGrants(command.projectId, principal.actorId).some(grant =>
          grant.scopeId === command.authorization.scopeId && grant.roleId === command.authorization.roleId)) {
        throw new DomainError("FORBIDDEN", "当前身份没有此项目、范围和职责的日程授权。");
      }
    }
    const result = command.type === "session.message.manualStop"
      ? await options.manualStop!.execute(who(request.principal),command)
      : await options.service.execute(who(request.principal), command);
    return reply.code(result.status === "applied" ? 200 : errorStatus(result.code)).send(result);
  });
  app.get("/api/projects/:projectId", async request => options.service.getProject(who(request.principal), params(request.params).projectId!));
  app.get("/api/projects/:projectId/session-preparation/:sessionId", async request => {
    const p=z.strictObject({projectId:z.uuid(),sessionId:z.uuid()}).parse(request.params);
    const q=z.strictObject({roleId:z.uuid(),cwd:z.string().optional(),authorizationScope:z.string().optional(),
      model:z.string().optional()}).parse(request.query);
    const principal=who(request.principal);
    if(!principal.permissions.includes("review"))throw new DomainError("FORBIDDEN","Session preparation requires project review permission");
    await options.service.getProject(principal,p.projectId);
    const role=await options.service.getRole(principal,p.projectId,q.roleId);
    let session:RuntimeSessionRecord|null=null;
    try { session=await options.service.getRuntimeSession(principal,p.projectId,p.sessionId); }
    catch(error){ if(!(error instanceof DomainError && error.code==="NOT_FOUND"))throw error; }
    if(session && (session.roleId!==q.roleId||session.actorId!==principal.actorId))
      throw new DomainError("SESSION_SCOPE_MISMATCH","Existing Session belongs to another Role or requester");
    const cwd=session?.cwd??q.cwd,authorizationScope=session?.authorizationScope??q.authorizationScope;
    if(!cwd||!authorizationScope)throw new DomainError("PREPARATION_PROFILE_REQUIRED","New Session needs cwd and authorizationScope");
    const config=await options.sessionPreparation?.({projectId:p.projectId,sessionId:p.sessionId,roleId:q.roleId,
      sessionActorId:principal.actorId,cwd,authorizationScope,model:session?.model??q.model??null});
    if(!config)throw new DomainError("PREPARATION_UNAVAILABLE","Session preparation is unavailable");
    const selectedModel=session?.model??q.model??null;
    const matchingEnvironment=callerGrants(p.projectId,principal.actorId).filter(g=>g.roleId===q.roleId&&
      g.authorizationScope===authorizationScope&&g.cwd===cwd&&g.sandbox==="danger-full-access"&&
      (g.approvalPolicy??"never")==="never");
    const modelAuthorized=!matchingEnvironment.length||matchingEnvironment.some(g=>grantAllowsModel(g,selectedModel));
    const runtimeProvider=session?sessionProvider(session):await options.service.roleRuntimeProvider(principal,p.projectId,q.roleId);
    const modelCatalog=await catalog(runtimeProvider);
    const bindings=await options.service.listRoleSessionBindings(principal,p.projectId,q.roleId);
    const bound=bindings.some(value=>value.sessionId===p.sessionId);
    const profile=session?await options.service.getRuntimeSessionProfile(principal,p.projectId,p.sessionId):null;
    let recovery:Awaited<ReturnType<WorkflowService["getSessionRecovery"]>>|null=null;
    let recoveryUnavailable=false;
    if(session)try {recovery=await options.service.getSessionRecovery(principal,p.projectId,p.sessionId);}
    catch(error){if(error instanceof DomainError&&error.code==="RECOVERY_UNAVAILABLE")recoveryUnavailable=true;else throw error;}
    const executionProfile=session?.executionProfile??recovery?.executionProfile??null;
    const actualFull=!!session&&session.sandbox==="danger-full-access"&&session.approvalPolicy==="never";
    const activationReady=!executionProfile||executionProfile.activationState==="active"&&
      executionProfile.activeRevisionId===executionProfile.revision.revisionId&&
      executionProfile.revision.sandbox==="danger-full-access"&&executionProfile.revision.approvalPolicy==="never"&&
      executionProfile.revision.cwd===session?.cwd&&
      executionProfile.revision.authorizationScope===session.authorizationScope&&
      executionProfile.revision.model===session.model;
    const recoveryReady=!!recovery&&!recovery.partial&&recovery.gate?.phase==="open";
    const missing=[...(!config.runtimeAvailable?["runtime_unavailable"]:[]),
      ...(!session&&!selectedModel?["model_selection_required"]:[]),
      ...(!config.grantReady?[modelAuthorized?"runtime_grant":"model_not_authorized"]:[]),...(!config.cwdReady?["cwd"]:[]),
      ...(!session&&modelCatalog.status==="unavailable"?["model_catalog_unavailable"]:[]),
      ...(!session&&modelCatalog.status==="empty"?["model_catalog_empty"]:[]),
      ...(!session&&selectedModel&&modelCatalog.status==="available"&&!modelCatalog.models.includes(selectedModel)?["model_not_active"]:[]),
      ...(!config.roleActorId?["role_actor"]:[]),...(!config.materialCli?["material_cli"]:
        !config.materialCli.ready?["material_cli_incompatible"]:[]),
      ...(config.materialCli&&config.roleActorId&&config.materialCli.actorId!==config.roleActorId?["material_cli_actor_mismatch"]:[]),
      ...(!config.skills.length?["role_skill"]:[]),
      ...(!["trial","active"].includes(role.state)?["role_inactive"]:[]),
      ...(session&&!actualFull?["session_execution_profile_restricted"]:[]),
      ...(session&&!activationReady?[`execution_profile_${executionProfile!.activationState}`]:[]),
      ...(session&&!recoveryReady?[recoveryUnavailable||!recovery?.gate?"recovery_unavailable":
        recovery.partial?"recovery_partial":`recovery_${recovery.gate.phase}`]:[]),
      ...(session?.state==="unknown"?["session_unknown"]:[]),
      ...(session&&session.state==="ready"&&!bound?["role_binding"]:[]),
      ...(session&&session.state==="ready"&&!profile?.displayName?.trim()?["display_profile"]:[])];
    return {projectId:p.projectId,sessionId:p.sessionId,roleId:q.roleId,roleVersion:role.version,roleRevisionId:role.currentRevisionId,runtimeProvider,
      roleState:role.state,responsibility:{goal:role.proposal.goal,independentResponsibility:role.proposal.independentResponsibility,
        workflow:role.proposal.workflow,handoffBoundary:role.proposal.handoffBoundary},
      session:session?{state:session.state,version:session.version,actorId:session.actorId,cwd:session.cwd,
        authorizationScope:session.authorizationScope,model:session.model,observedModel:session.observedModel??null,
        observedProvider:session.observedProvider??null,sandbox:session.sandbox,
        approvalPolicy:session.approvalPolicy,nativeThreadId:session.nativeThreadId,nativeSessionId:session.nativeSessionId,
        operationId:session.operationId}:null,
      profile:profile?{version:profile.version,displayName:profile.displayName,purpose:profile.purpose}:null,
      bound,config,modelCatalog:{status:modelCatalog.status,error:modelCatalog.error,observedAtUtc:modelCatalog.observedAtUtc},
      missing,recovery:recovery?{gate:recovery.gate,partial:recovery.partial,nextAction:recovery.nextAction}:null,
      executionProfile:executionProfile?{revision:executionProfile.revision,activationState:executionProfile.activationState,
        activeRevisionId:executionProfile.activeRevisionId,activationOperationId:executionProfile.activationOperationId}:null,
      readyForTasks:!!session&&session.state==="ready"&&bound&&!!profile?.displayName?.trim()&&missing.length===0,
      communication:{taskDiscussion:"available",nativeLeadMessage:"unverified",nextAction:"Use the Task discussion and confirm native communication in the actual host"},
      nameSync:"Saved profile is visible; native Thread name requires the runner's independent sync check",
      emptyThreadVisibility:"Native Desktop list may filter Threads without a first message; no message is created by preparation"};
  });
  app.get("/api/projects/:projectId/roles/:roleId/runtime", async request => {
    const p=z.strictObject({projectId:z.uuid(),roleId:z.uuid()}).parse(request.params);
    if(!options.roleRuntimeView)throw new DomainError("CAPABILITY_UNAVAILABLE","Role runtime view is unavailable");
    return options.roleRuntimeView(who(request.principal),p.projectId,p.roleId.toLowerCase());
  });
  app.get("/api/projects/:projectId/roles/:roleId/skills/:name", async request => {
    const p=z.strictObject({projectId:z.uuid(),roleId:z.uuid(),name:z.string().regex(/^[A-Za-z0-9_-]+$/)}).parse(request.params);
    const q=z.strictObject({commit:z.string().regex(/^[a-f0-9]{40}$/),hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.query);
    const principal=who(request.principal);
    await options.service.getRole(principal,p.projectId,p.roleId);
    let skill;
    try {skill=await options.readRoleSkill?.(p.projectId,p.roleId,p.name,q.commit,q.hash);}
    catch {throw new DomainError("FIXED_SOURCE_UNAVAILABLE","Fixed Role skill or its linked source is unavailable");}
    if(!skill)throw new DomainError("NOT_FOUND","Role skill is not configured");
    return skill;
  });
  app.get("/api/projects/:projectId/roles/:roleId/skills/:name/source",async request=>{
    const p=z.strictObject({projectId:z.uuid(),roleId:z.uuid(),name:z.string().regex(/^[A-Za-z0-9_-]+$/)}).parse(request.params);
    const q=z.strictObject({path:z.string().min(1).max(512),via:z.string().min(1).max(4096),
      commit:z.string().regex(/^[a-f0-9]{40}$/),
      hash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.query);
    const principal=who(request.principal);
    await options.service.getRole(principal,p.projectId,p.roleId);
    let source;
    try {source=await options.readRoleSkillSource?.(p.projectId,p.roleId,p.name,q.path,q.via,q.commit,q.hash);}
    catch {throw new DomainError("FIXED_SOURCE_UNAVAILABLE","Fixed linked source or its source trail is unavailable");}
    if(!source)throw new DomainError("NOT_FOUND","Role skill source is not configured");
    return source;
  });
  app.get("/api/projects/:projectId/scheduling/status", async request => {
    const projectId = params(request.params).projectId!;
    const principal = who(request.principal);
    await options.service.getProject(principal, projectId);
    const status = options.scheduling?.status() ?? { state: "disabled", lastTickAt: null, lastError: null, lastCreated: 0 };
    return { ...status, grants: status.state === "disabled" ? [] : callerSchedulingGrants(projectId, principal.actorId) };
  });
  app.get("/api/projects/:projectId/runtime", async request => {
    const projectId = params(request.params).projectId!;
    await options.service.getProject(who(request.principal), projectId);
    return { ...(options.runtime?.status(projectId) ?? { available: false, error: "尚未配置 Codex 执行服务", faults: [] }), allowedCwds: [...new Set(callerGrants(projectId,who(request.principal).actorId).map(g=>g.cwd))], grants: callerGrants(projectId,who(request.principal).actorId) };
  });
  app.get("/api/projects/:projectId/runtime/models", async request => {
    const projectId=params(request.params).projectId!,principal=who(request.principal);
    const query=z.strictObject({provider:runtimeProviderSchema.optional()}).parse(request.query);
    await options.service.getProject(principal,projectId);
    const provider=query.provider??options.service.runtimeProviderSettings().defaultProvider;
    const current=await catalog(provider);
    const fullGrants=callerGrants(projectId,principal.actorId).filter(g=>g.sandbox==="danger-full-access"&&
      (g.approvalPolicy??"never")==="never"&&g.networkAccess!==false);
    const allowed=new Set(fullGrants.flatMap(grantModels));
    return {...current,provider,models:current.status==="available"?current.models.filter(model=>allowed.has(model)):[],
      options:current.status==="available"?current.options?.filter(option=>allowed.has(option.model))??[]:[],
      authorizedModels:[...allowed],environments:fullGrants.map(g=>({roleId:g.roleId,authorizationScope:g.authorizationScope,
        cwd:g.cwd,configuredModel:g.model??null,models:current.status==="available"?
          current.models.filter(model=>grantAllowsModel(g,model)):[]}))};
  });
  app.get("/api/projects/:projectId/runtime/sessions", async request => options.service.listRuntimeSessions(who(request.principal), params(request.params).projectId!));
  app.get("/api/projects/:projectId/runtime/sessions/:id/recovery", async request => {
    const p=params(request.params);
    return options.service.getSessionRecovery(who(request.principal),p.projectId!,p.id!);
  });
  app.post("/api/projects/:projectId/runtime/sessions/:id/compactions", async request => {
    const p=z.strictObject({projectId:z.uuid(),id:z.uuid()}).parse(request.params);
    if(!options.compaction)throw new DomainError('CAPABILITY_UNAVAILABLE','Compaction maintenance is unavailable');
    return options.compaction.start(who(request.principal),p.projectId,p.id,runtimeCompactionIntentSchema.parse(request.body));
  });
  app.get("/api/projects/:projectId/runtime/compactions/:id", async request => {
    const p=z.strictObject({projectId:z.uuid(),id:z.uuid()}).parse(request.params);
    if(!options.compaction)throw new DomainError('CAPABILITY_UNAVAILABLE','Compaction maintenance is unavailable');
    return options.compaction.read(who(request.principal),p.projectId,p.id);
  });
  app.post("/api/projects/:projectId/runtime/compactions/:id/reconcile", async request => {
    const p=z.strictObject({projectId:z.uuid(),id:z.uuid()}).parse(request.params);
    z.strictObject({}).parse(request.body??{});
    if(!options.compaction)throw new DomainError('CAPABILITY_UNAVAILABLE','Compaction maintenance is unavailable');
    return options.compaction.reconcile(who(request.principal),p.projectId,p.id);
  });
  if (options.allocationRelations) registerAllocationRelationRoutes(app, options.allocationRelations);
  if (options.sessionWork) registerSessionWorkRoutes(app, options.sessionWork, (principal, session) => ({
    ...session, capabilities: { ...session.capabilities,
      send: options.sessionMessages && principal.permissions.includes("write") ? session.capabilities.send : {
        available: false, mode: "unavailable", reason: !principal.permissions.includes("write")
          ? "当前身份只有读取权限，不能保存消息。" : "此服务尚未启用消息持久化入口。",
      } },
  }), async (principal, projectId, session) => ({
    ...session, capabilities: { ...session.capabilities,
      ordinaryExecution: options.messageExecution
        ? await options.messageExecution(principal, projectId, session)
        : { state: "unknown", reasonCode: "EXECUTION_STATUS_UNAVAILABLE",
          reason: "此服务未提供普通消息执行状态；可保存不代表能够自动回复。", observedAt: new Date().toISOString() },
    },
  }), async (principal, projectId, snapshot) => {
    const nativeObservation = options.nativeObservation && snapshot.session.target.kind === "owned"
      ? publicNativeObservationView(await options.nativeObservation.get(projectId, snapshot.session.target.sessionId),
        principal.permissions.includes("read") && principal.permissions.includes("review")) : null;
    const usage = nativeObservation?.usage;
    const metric = (name: "inputTokens" | "outputTokens") => ({ ...snapshot.resources[name],
      value: usage!.total[name], source: "owned-native-event:thread/tokenUsage/updated", unit: "tokens", scope: "session" as const,
      observedAt: usage!.observedAt, interval: null,
      unavailableReason: usage!.total[name] === null ? "原生未提供该用量。" :
        nativeObservation!.freshness === "stale" ? "原生观察已过期，保留最后累计读数。" : null });
    return { ...snapshot,
    ...(options.nativeObservation ? { nativeObservation } : {}),
    ...(usage ? { resources: { ...snapshot.resources, inputTokens: metric("inputTokens"), outputTokens: metric("outputTokens") } } : {}),
    ...(options.nativeInputs && snapshot.session.target.kind === "owned" ? {
      nativeInputRequests: await options.nativeInputs.views(principal, projectId, snapshot.session.target.sessionId),
    } : {}),
    };
  });
  if (options.sessionWork && options.sessionMessages) registerSessionMessageRoutes(app, {
    workflow: options.service, observation: options.sessionWork, messages: options.sessionMessages,
  });
  if (options.directInput) registerDirectInputRoutes(app, options.directInput);
  if (options.connectorRoutes) registerConnectorRouteReads(app, options.service, options.connectorRoutes,
    options.canWrite ?? (() => true), options.connectorDeliveries, options.connectorSources,
    options.canActivateConnectorRoute);
  app.get("/api/projects/:projectId/session-messages/:id/manual-stop-preview", async request => {
    const {projectId,id}=z.strictObject({projectId:z.uuid(),id:z.uuid()}).parse(request.params);
    const principal=who(request.principal);
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "普通消息恢复需要本项目复核权限。");
    if (!options.manualStop || !options.sessionMessages)
      throw new DomainError("MANUAL_STOP_UNAVAILABLE", "当前 owner 未提供首次维护交接核验入口。");
    const detail=await options.sessionMessages.detail(projectId,id);
    if (detail.message.target.kind!=="owned" || !detail.processing?.nativeTurnId)
      throw new DomainError("MANUAL_STOP_BINDING_CHANGED", "原消息未精确绑定可读取的原生 Turn。");
    const session=await messageRecoverySession(principal,projectId,detail.message.target.sessionId);
    return {messageId:id,messageVersion:detail.message.version,processingId:detail.processing.id,
      processingVersion:detail.processing.version,
      preview:await options.manualStop.preview(session,detail.processing.nativeTurnId)};
  });
  if (options.sessionTimeline) registerSessionTimelineRoutes(app,options.sessionTimeline,options.runtime);
  app.get("/api/projects/:projectId/runtime/sessions/:id/inputs", async request => {
    const p = z.strictObject({ projectId: z.uuid(), id: z.uuid() }).parse(request.params);
    const principal = who(request.principal);
    await options.service.getRuntimeSession(principal, p.projectId, p.id);
    if (!options.nativeInputs) throw new DomainError("NATIVE_INPUT_UNAVAILABLE", "此服务尚未启用原生提问观察。");
    return { items: await options.nativeInputs.views(principal, p.projectId, p.id), limit: 20 };
  });
  app.get("/api/projects/:projectId/runtime/sessions/:id/observation", async request => {
    const p = z.strictObject({ projectId: z.uuid(), id: z.uuid() }).parse(request.params);
    const principal=who(request.principal);
    await options.service.getRuntimeSession(principal, p.projectId, p.id);
    if (!options.nativeObservation) throw new DomainError("NATIVE_OBSERVATION_UNAVAILABLE", "此服务尚未启用原生进度观察。");
    return publicNativeObservationView(await options.nativeObservation.get(p.projectId, p.id),
      principal.permissions.includes("read") && principal.permissions.includes("review"));
  });
  app.get("/api/projects/:projectId/session-inputs/:id", async request => {
    const p = z.strictObject({ projectId: z.uuid(), id: z.uuid() }).parse(request.params);
    const principal = who(request.principal);
    await options.service.getProject(principal, p.projectId);
    if (!options.nativeInputs) throw new DomainError("NATIVE_INPUT_UNAVAILABLE", "此服务尚未启用原生提问观察。");
    return options.nativeInputs.one(principal, p.projectId, p.id);
  });
  app.get("/api/projects/:projectId/runtime/sessions/:id/history", async request => {
    const p = params(request.params);
    if (!options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务不可用，无法声称历史完整。");
    return options.runtime.history(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/runtime/sessions/:id/events", async request => {
    const p = params(request.params); return options.service.listRuntimeSessionEvents(who(request.principal), p.projectId!, p.id!);
  });
  app.post("/api/projects/:projectId/runtime/recover", async request => {
    const projectId = params(request.params).projectId!;
    const principal = who(request.principal);
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("review")) throw new DomainError("FORBIDDEN", "恢复执行服务需要本项目复核权限。");
    await options.service.getProject(principal, projectId);
    if (!options.runtime) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务尚未配置。");
    if (!callerGrants(projectId, principal.actorId).length) throw new DomainError("FORBIDDEN", "当前身份没有本项目的执行恢复授权。");
    if (options.runtime.status().available) return options.runtime.status(projectId);
    await options.runtime.recover();
    return options.runtime.status(projectId);
  });
  app.get("/api/projects/:projectId/runtime/runs", async request => {
    const projectId = params(request.params).projectId!;
    const query = z.object({ taskId: idSchema.optional() }).parse(request.query);
    return options.service.listRuntimeRuns(who(request.principal), projectId, query.taskId);
  });
  app.get("/api/projects/:projectId/runtime/runs/:id", async request => {
    const p = params(request.params), principal = who(request.principal);
    if (request.workerIdentity && p.id !== request.workerIdentity.scope.runId) {
      const gap = await options.workers?.facts(request.workerIdentity).recoveryGap?.();
      if (gap && gap.projectId === p.projectId && gap.loopId === request.workerIdentity.scope.loopId && gap.runId === p.id)
        return options.service.getRuntimeRun(principal, p.projectId!, p.id!);
      if (!options.runtime?.workerFixedRunMetadata) throw new DomainError("FORBIDDEN", "受管固定运行读取不可用。");
      return options.runtime.workerFixedRunMetadata(principal, p.projectId!, p.id!, request.workerIdentity);
    }
    return options.service.getRuntimeRun(principal, p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/runtime/runs/:id/input", async request => {
    const p = params(request.params), principal = who(request.principal);
    const { cursor, limit } = z.strictObject({ cursor: z.coerce.number().int().safe().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(8192).optional() }).parse(request.query);
    const run = await options.service.getRuntimeRun(principal, p.projectId!, p.id!);
    return runInputPage(run, cursor, limit);
  });
  app.get("/api/projects/:projectId/runtime/runs/:id/events", async request => {
    const p = params(request.params); return options.service.listRuntimeEvents(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/runtime/runs/:id/result", async request => {
    const p = params(request.params);
    if (!options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务不可用；已保存的运行状态仍可读取。");
    return options.runtime.result(who(request.principal), p.projectId!, p.id!);
  });
  app.post("/api/projects/:projectId/runtime/runs/:id/pre-turn-continue",async request=>{
    const p=params(request.params),principal=who(request.principal);
    const body=preTurnContinueSchema.parse(request.body);
    const session=await options.service.getRuntimeSession(principal,p.projectId!,body.sessionId);
    if(!principal.permissions.includes("review")||!principal.projectIds.includes(p.projectId!)||
      !await options.hasRuntimeGrant?.({projectId:p.projectId!,actorId:principal.actorId,roleId:session.roleId,
        authorizationScope:session.authorizationScope,cwd:session.cwd,sandbox:session.sandbox,
        model:session.model,approvalPolicy:session.approvalPolicy}))
      throw new DomainError("FORBIDDEN","exact Session execution review grant required");
    const prior=await options.runtime?.readPreTurnContinuationDecision(p.projectId!,p.id!,principal,body);
    if(prior)return prior;
    if(!options.runtime?.nativeStartsAvailable())throw new DomainError("RUNTIME_UNAVAILABLE","native owner unavailable");
    return options.runtime.approvePreTurnContinuation(p.projectId!,p.id!,principal,body);
  });
  app.post("/api/projects/:projectId/session-messages/:id/pre-turn-continue",async request=>{
    const p=params(request.params),principal=who(request.principal);
    const body=messagePreTurnContinueSchema.parse(request.body);
    if(!options.sessionMessages)
      throw new DomainError("RUNTIME_UNAVAILABLE","message service unavailable");
    await messageRecoverySession(principal,p.projectId!,body.sessionId,true);
    const prior=await options.sessionMessages.readPreTurnContinuationDecision(p.projectId!,p.id!,principal,body);
    if(prior)return prior;
    if(!options.runtime?.nativeStartsAvailable())
      throw new DomainError("RUNTIME_UNAVAILABLE","native owner unavailable");
    await messageRecoverySession(principal,p.projectId!,body.sessionId);
    return options.sessionMessages.approvePreTurnContinuation(p.projectId!,p.id!,principal,body);
  });
  app.get("/api/projects/:projectId/runtime/runs/:id/trace", async request => {
    const p = params(request.params);
    const principal = who(request.principal);
    if (!principal.projectIds.includes(p.projectId!) || !principal.permissions.includes("read") ||
        !request.workerIdentity && !principal.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "读取工作轨迹需要本项目读取和复核权限。");
    if (!options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务不可用，无法读取原生工作轨迹。");
    const query = z.object({ cursor: z.string().min(1).max(2048).optional(), turnCursor: z.string().min(1).max(2048).optional() }).parse(request.query);
    return options.runtime.trace(principal, p.projectId!, p.id!, query.cursor, request.workerIdentity ?? undefined, query.turnCursor);
  });
  app.post("/api/projects/:projectId/runtime/runs/:id/reconcile", async request => {
    const p = params(request.params);
    const principal = who(request.principal);
    if (!principal.projectIds.includes(p.projectId!) || !principal.permissions.includes("review")) {
      throw new DomainError("FORBIDDEN", "重新核对运行需要本项目复核权限。");
    }
    if (!options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务不可用，无法重新读取原生运行。");
    const body = runtimeReconcileSchema.parse(request.body);
    const run = await options.service.getRuntimeRun(principal, p.projectId!, p.id!);
    const session = await options.service.getRuntimeSession(principal, p.projectId!, run.sessionId);
    if (!callerGrants(p.projectId!, principal.actorId).some(grant => grant.roleId === session.roleId &&
      grant.authorizationScope === session.authorizationScope && grant.cwd === session.cwd && grant.sandbox === session.sandbox)) {
      throw new DomainError("FORBIDDEN", "当前身份没有此运行所属会话的执行授权。");
    }
    return options.runtime.reconcile(principal, p.projectId!, p.id!, body.expectedVersion, body.reason, body.turnCursor);
  });
  app.get("/api/projects/:projectId/goals", async request => {
    const p = params(request.params); const q = pageSchema.parse(request.query);
    return options.service.listGoals(who(request.principal), p.projectId!, q.limit, q.cursor);
  });
  app.get("/api/projects/:projectId/goals/:id", async request => {
    const p = params(request.params); return options.service.getGoal(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/goals/:id/revisions", async request => {
    const p = params(request.params); return options.service.listGoalRevisions(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/stages/:id/revisions", async request => {
    const p = params(request.params); return options.service.listStageRevisions(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/stages", async request => options.service.listStages(who(request.principal), params(request.params).projectId!));
  app.get("/api/projects/:projectId/stages/:id", async request => {
    const p = params(request.params); return options.service.getStage(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/stages/:id/reviews", async request => {
    const p = params(request.params); return options.service.listStageReviews(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/tasks/:id/revisions", async request => {
    const p = params(request.params); return options.service.listTaskRevisions(who(request.principal), p.projectId!, p.id!);
  });
  // Metadata only, newest first; bodies stay behind the fixed single-revision reads. Workers are refused by the guard.
  app.get("/api/projects/:projectId/documents/:id/revisions", async request => {
    const p = params(request.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().min(1).max(512).optional() }).parse(request.query);
    return options.service.listDocumentRevisions(who(request.principal), p.projectId!, p.id!, q.limit, q.cursor);
  });
  app.get("/api/projects/:projectId/discussions", async request => {
    const p = params(request.params);
    const q = pageSchema.extend({ kind: z.enum(["allocation", "direction", "task_collaboration"]).optional() }).parse(request.query);
    return options.service.listDiscussions(who(request.principal), p.projectId!, q.limit, q.cursor, q.kind);
  });
  app.get("/api/projects/:projectId/discussions/:id", async request => {
    const p = params(request.params); return options.service.getDiscussion(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/discussions/:id/events", async request => {
    const p = params(request.params); return options.service.listDiscussionEvents(who(request.principal), p.projectId!, p.id!);
  });
  for (const entity of ["documents", "tasks"] as const) {
    app.get(`/api/projects/:projectId/${entity}`, async request => {
      const p = params(request.params); const q = pageSchema.parse(request.query);
      const kind = entity === "documents" ? z.object({ kind: documentKindSchema.optional() }).parse(request.query).kind : undefined;
      return entity === "documents" ? options.service.listDocuments(who(request.principal), p.projectId!, q.limit, q.cursor, kind) : options.service.listTasks(who(request.principal), p.projectId!, q.limit, q.cursor);
    });
    app.get(`/api/projects/:projectId/${entity}/:id`, async request => {
      const p = params(request.params);
      return entity === "documents" ? options.service.getDocument(who(request.principal), p.projectId!, p.id!) : options.service.getTask(who(request.principal), p.projectId!, p.id!);
    });
    app.get(`/api/projects/:projectId/${entity}/:id/revisions/:revisionId`, async request => {
      const p = params(request.params);
      return entity === "documents" ? options.service.getDocumentRevision(who(request.principal), p.projectId!, p.id!, p.revisionId!) : options.service.getTaskRevision(who(request.principal), p.projectId!, p.id!, p.revisionId!);
    });
  }
  app.get("/api/projects/:projectId/impacts", async request => options.service.listImpacts(who(request.principal), params(request.params).projectId!));
  app.get("/api/projects/:projectId/operations/:id", async (request, reply) => {
    const p = params(request.params);
    const operation = await options.service.getOperation(who(request.principal), p.projectId!, p.id!);
    return operation ?? reply.code(404).send({ code: "OPERATION_NOT_FOUND", message: "尚无已确认记录；这不能证明仍在进行的请求未提交。" });
  });
  if (options.references) registerReferenceRoutes(app, options.references);
  if (options.orchestration) registerOrchestrationRoutes(app, options.orchestration);
  if (options.ordinarySubmissions) registerOrdinaryRunSubmissionRoutes(app, options.ordinarySubmissions);
  const workStatuses = options.workStatuses ?? options.orchestration?.workStatuses;
  if (workStatuses) registerWorkStatusRoute(app, workStatuses);
  if (options.planningSources) registerPlanningSourcesRoute(app, options.planningSources);
  if (options.collaboration) registerCollaborationRoutes(app, { ...options.collaboration, workflow: options.service });
  await registerWorkManagementRoutes(app, options.service, options.workIndex);
  if (options.acceptanceRelay) registerAcceptanceRelayRoutes(app, options.service, options.acceptanceRelay, options.workIndex);
  if (options.leaderNotices) registerLeaderNoticeRoutes(app, options.service, options.leaderNotices);
  if (options.taskAttentionPool) registerTaskAttentionRoutes(app, options.service, options.taskAttentionPool);
  registerEvaluationRoutes(app, options.service, options.readEvaluationPacket);
  registerProjectConfigurationRoutes(app, options.service, options.projectConfiguration);
  if (options.knowledge) registerKnowledgeRoutes(app, { workflow: options.service, ...options.knowledge });
  if (options.documents) {
    registerDocumentRoutes(app, { workflow: options.service, ...options.documents });
    registerTaskMaterialRoutes(app, { workflow: options.service, documents: options.documents.uow,
      ...(options.references ? { references: options.references.uow } : {}) });
  }
  if (options.webRoot) {
    await app.register(staticPlugin, { root: options.webRoot, index: "index.html", wildcard: true, cacheControl: false });
    // The workbench uses path addresses (/p/{project}/…, /ui); each loads the same page, which routes in the browser.
    const workbenchPage = (_request: unknown, reply: { sendFile(name: string): unknown }) => reply.sendFile("index.html");
    app.get("/p/*", workbenchPage);
    app.get("/ui", workbenchPage);
  }
  return app;
}
