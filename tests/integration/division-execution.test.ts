import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { WorkflowService, RuntimeWorkflowService } from "@evoloop/core";
import { OrchestrationService, OrchestrationError } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import type { DelegationTemplate } from "@evoloop/contracts/division";
import { WorkerCredentialBroker } from "../../apps/coordinator/src/workers/credentials.js";
import { currentSessionGrant, dynamicRuntimeAdmission, isBoundDynamicSession } from "../../apps/coordinator/src/orchestration/dynamic-admission.js";
import { staticRunSessionAvailable } from "../../apps/coordinator/src/references/source-run.js";
import { loopIntentId } from "../../apps/coordinator/src/orchestration/runner.js";
import { ManagedLoopRunner } from "../../apps/coordinator/src/orchestration/runner.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { workerGuardFacts } from "../../apps/coordinator/src/workers/facts.js";
import { runtimeThreadConfigForSession } from "../../apps/coordinator/src/configuration.js";


function withPersistedResumeProfile(runtime: RuntimeWorkflowService, uow: PostgresUnitOfWork): RuntimeWorkflowService {
  const bind = runtime.bindSession.bind(runtime);
  runtime.bindSession = async (projectId, sessionId, binding) => {
    const saved = await uow.read(projectId, reader => reader.getRuntimeSession(sessionId));
    const profile = saved?.executionProfile;
    if (!saved || !profile) throw new Error("fixture Session execution profile unavailable");
    return bind(projectId, sessionId, { ...binding, resumeProfile: { actorId: saved.actorId, model: saved.model,
      sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: profile.revision.revisionId } });
  };
  return runtime;
}
const url=process.env.TEST_DATABASE_URL;
if (!url || !/evoloop.*test/.test(new URL(url).pathname))
  throw new Error("dedicated PostgreSQL test database required");
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const pid=randomUUID(),owner="controller",cognition="cognition-actor",cognitiveRole="cognition";
const roleId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),loopId=randomUUID();
const parentTaskId=randomUUID(),firstTaskId=randomUUID(),documentId=randomUUID();
const scope="m3-exact",cwd=join(tmpdir(),`evoloop-m3-execution-${randomUUID()}`);
const principal=(actorId:string)=>({actorId,projectIds:[pid],permissions:["read","write","review"] as Array<"read"|"write"|"review">});

test("PG bounded division reserves, transfers by Task CAS, starts once, and receives a brokered handoff",async t=>{
  const schema=`el_m3_${randomUUID().replaceAll("-","").slice(0,16)}`;
  await migrate(url!,schema);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  const workerRoot=await mkdtemp(join(tmpdir(),"evoloop-m3-receiver-"));
  await mkdir(cwd,{recursive:true});
  t.after(async()=>{await pool.end();await rm(workerRoot,{recursive:true,force:true});await rm(cwd,{recursive:true,force:true});
    const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const uow=new PostgresUnitOfWork(pool),clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash}}),runtime=new RuntimeWorkflowService({uow,clock,ids});
  withPersistedResumeProfile(runtime,uow);
  let broker:WorkerCredentialBroker;
  const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(p,id)=>p===pid&&id==="cognitive-scope"?
    {projectId:pid,scopeId:id,actorId:cognition,roleId:cognitiveRole,active:true}:null,
    canActAsRole:async(_p,actor,role)=>actor===cognition&&role===cognitiveRole ||
      (await broker.identityForActor(actor))?.scope.roleId===role,
    wasActorRole:async()=>false});
  const template:DelegationTemplate={id:randomUUID(),revision:1,projectId:pid,goalId,loopId,
    existingRoleIds:[roleId],cognitionRoleIds:[],newRoleAllocation:null,firstTaskId,
    actorId:owner,authorizationScopeId:scope,decisionActorIds:[cognition],
    allowedChoices:["temporary-assignment"],cwd,model:"fixture-model",sandbox:"danger-full-access",
    networkAccess:true,approvalPolicy:"never",expiresAtUtc:new Date(Date.now()+86_400_000).toISOString()};
  const templateHash=hash(JSON.stringify(template));let templateCurrent=true;
  const orchestration=new OrchestrationService({store,now:clock.now,nextId:randomUUID,hash,
    getDelegationTemplate:async(p,id)=>templateCurrent&&p===pid&&id===template.id?{template,hash:templateHash}:null,
    getWorkerScope:async actor=>(await broker.identityForActor(actor))?.scope??null});
  const wf=async(actor:string,command:Record<string,unknown>)=>{
    const result=await workflow.execute(principal(actor),{projectId:pid,operationId:randomUUID(),...command} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result;
  };
  const issue=(actor:string,command:Record<string,unknown>)=>orchestration.execute(principal(actor),
    {projectId:pid,operationId:randomUUID(),...command} as never);
  const denied=async(p:Promise<unknown>,code:string)=>assert.rejects(p,
    e=>e instanceof OrchestrationError&&e.code===code);
  await wf(owner,{type:"project.create",title:"M3 isolated execution"});
  await wf(owner,{type:"goal.create",goalId,outcome:"Bounded result",constraints:"Local",
    consumer:"owner",authority:"reviewer",scope:"fixture",owner});
  await wf(owner,{type:"stage.propose",stageId,goalId,deliverable:"One result",learningQuestion:"What changed?",reason:"Fixture"});
  await wf(owner,{type:"stage.accept",stageId,expectedVersion:1,reason:"Start"});
  await wf(owner,{type:"task.create",taskId:parentTaskId,stageId,title:"Cognition",content:"# Decide",acceptance:"Waiting intent",
    owner:cognitiveRole,consumer:"owner",evidence:"Fixture",stopCondition:"One decision"});
  await wf(owner,{type:"task.start",taskId:parentTaskId,expectedVersion:1,reason:"Freeze"});
  await wf(owner,{type:"task.create",taskId:firstTaskId,stageId,title:"First trial work",content:"# Execute",acceptance:"One check",
    owner:"prior-role",consumer:"owner",evidence:"Fixture",stopCondition:"One result"});
  // Workflow Task CAS takes this project advisory key. Division must not inspect
  // the first Task under a separate project-row lock while that CAS is in flight.
  let releaseTaskLock!:()=>void,signalTaskLock!:()=>void;
  const taskLockHeld=new Promise<void>(resolve=>{signalTaskLock=resolve;});
  const taskLockRelease=new Promise<void>(resolve=>{releaseTaskLock=resolve;});
  const holdingTaskTransaction=uow.transaction(pid,async()=>{signalTaskLock();await taskLockRelease;});
  await taskLockHeld;
  let divisionEntered=false;
  const divisionTransaction=store.transaction(pid,async tx=>{divisionEntered=true;return tx.getTaskFact(firstTaskId);});
  try {
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(divisionEntered,false,"division must wait for the Workflow Task project lock before observing version");
  } finally {
    releaseTaskLock();
    await holdingTaskTransaction;
    await divisionTransaction;
  }
  assert.equal(divisionEntered,true);
  const document=await wf(owner,{type:"document.create",documentId,kind:"report",title:"Fixed diagnosis",body:"# Fixed handoff"});
  const proposal={title:"Bounded specialist",goal:"One task",independentResponsibility:"Own first trial Task",
    ownerScope:"One task",inputs:["Fixed document"],writableAssets:[],deliverables:["One result"],
    triggers:["Observed gap"],workflow:"Inspect then deliver",handoffBoundary:"Return to owner",
    evidence:[{kind:"backlog",observation:"Unowned work",sourceRef:`task:${firstTaskId}`,observedAtUtc:clock.now()},
      {kind:"effect",observation:"Current owner delayed",sourceRef:`task:${firstTaskId}`,observedAtUtc:clock.now()},
      {kind:"cost",observation:"One trial",sourceRef:`task:${firstTaskId}`,observedAtUtc:clock.now()}],
    alternatives:[{kind:"method",assessment:"Could change method",estimatedCost:"One change"},
      {kind:"knowledge",assessment:"Could change guide",estimatedCost:"One update"},
      {kind:"another-instance",assessment:"Could add capacity",estimatedCost:"One instance"},
      {kind:"temporary-assignment",assessment:"Trial this Role",estimatedCost:"One trial"}],
    firstTaskId,baseline:"Delayed",expectedEffect:"One result",costLimit:"One trial",trialDays:7,
    reviewAtUtc:new Date(Date.now()+86_400_000).toISOString(),exitCriteria:"Review first result"};
  await wf(owner,{type:"role.propose",roleId,proposal});
  await wf(owner,{type:"role.decide",roleId,expectedVersion:1,decision:"accept-trial",reason:"Fixture accepted"});
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[pid])).rows[0];
  await issue(owner,{type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:cognitiveRole,
    allowedBusinessRoleIds:["static-role"],sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},
    maxRuns:2,maxConcurrent:1,reason:"Finite trial"});
  const loop=(await orchestration.getLoop(principal(owner),pid,loopId))!;
  const inbox=await issue(cognition,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await issue(cognition,{type:"inbox.ack",inboxId:inbox.entityId,expectedVersion:1,reason:"Read"});
  const parent=await issue(cognition,{type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:parentTaskId,expectedTaskVersion:2,
    recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:"cognitive-scope",reason:"Decide"});
  // The fixture has an exact cognitive static authorization only for its parent.
  const token=randomUUID();
  await issue(cognition,{type:"dispatch.claim",dispatchId:parent.entityId,claimToken:token,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue(cognition,{type:"dispatch.start",dispatchId:parent.entityId,claimToken:token});
  const cognitiveSession=randomUUID(),cognitiveRun=randomUUID();
  await wf(cognition,{type:"runtime.session.reserve",sessionId:cognitiveSession,roleId:cognitiveRole,cwd,
    authorizationScope:"cognitive-scope",model:"fixture-model",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(pid,cognitiveSession);
  await runtime.bindSession(pid,cognitiveSession,{owner:"evoloop-codex-app-server",projectId:pid,sessionId:cognitiveSession,
    roleId:cognitiveRole,cwd,authorizationScope:"cognitive-scope",nativeThreadId:`fixture-${cognitiveSession}`,
    nativeSessionId:`fixture-${cognitiveSession}`});
  await wf(cognition,{type:"runtime.run.reserve",runId:cognitiveRun,taskId:parentTaskId,sessionId:cognitiveSession,
    expectedVersion:2,input:"Decide bounded work"});
  await issue(cognition,{type:"dispatch.resolve",dispatchId:parent.entityId,claimToken:token,result:"accepted",
    runtimeRunId:cognitiveRun,reason:"Fixture Run"});
  const binding=await issue(cognition,{type:"division.decide",decisionId:randomUUID(),loopId,
    expectedLoopVersion:(await orchestration.getLoop(principal(owner),pid,loopId))!.version,
    sourceEventId:loop.bootstrapEventId,parentDispatchId:parent.entityId,documentId,
    documentRevisionId:document.revisionId,documentContentHash:hash("# Fixed handoff"),
    firstTaskId,expectedFirstTaskVersion:1,choice:"temporary-assignment",roleId,
    templateId:template.id,templateRevision:1,templateHash,reason:"Bounded trial"});
  const waiting=await issue(cognition,{type:"worker.decision",decisionId:randomUUID(),dispatchId:parent.entityId,
    runId:cognitiveRun,kind:"waiting",divisionDecisionId:binding.entityId,reason:"Hand over",evidenceRefs:[]});
  await runtime.beginDispatch(pid,cognitiveRun);
  const parentTurn=`fixture-turn-${cognitiveRun}`;
  await runtime.bindTurn(pid,cognitiveRun,{id:parentTurn,status:"running"} as never,
    {kind:"startReply",operationId:(await workflow.getRuntimeRun(principal(owner),pid,cognitiveRun)).operationId});
  await runtime.recordTurn(pid,cognitiveRun,parentTurn,"completed","Fixture completed");
  await issue(owner,{type:"worker.outcome",dispatchId:parent.entityId,outcome:"waiting",deliveryId:null,
    decisionId:waiting.entityId,evidenceRef:null,reason:"Hand over"});
  const childId=loopIntentId(binding.entityId,"division-child");
  let failTransferOnce=true,observedReservedBeforeTransfer=false;
  const runnerWorkflow=Object.create(workflow) as WorkflowService;
  runnerWorkflow.execute=async(p,command)=>{
    if (command.type==="task.update" && command.reason===`division-transfer:${binding.entityId}`) {
      const reserved=await orchestration.getDispatch(principal(owner),pid,childId);
      observedReservedBeforeTransfer=!!reserved && reserved.state==="pending";
      if (failTransferOnce) { failTransferOnce=false;throw new Error("FIXTURE_TRANSFER_CRASH"); }
    }
    return workflow.execute(p,command);
  };
  const runnerOrchestration=Object.create(orchestration) as OrchestrationService;
  runnerOrchestration.listDispatches=async(_p,_project,_loop)=>({items:[(await orchestration.getDispatch(principal(owner),pid,parent.entityId))!],nextCursor:null});
  const profile={principal:principal(owner),authorizationScopeId:scope,cwd,model:template.model,
    sandbox:template.sandbox,approvalPolicy:template.approvalPolicy};
  const cognitiveProfile={...profile,principal:principal(cognition),authorizationScopeId:"cognitive-scope"};
  const managed=new ManagedLoopRunner({projects:[pid],reader:()=>principal(owner),
    controller:async()=>cognitiveProfile,dynamicController:async()=>profile,
    workflow:runnerWorkflow,orchestration:runnerOrchestration,
    runtime:{pump:async()=>{}},credential:{lookup:async()=>null,issue:async()=>{throw new Error("Unexpected worker launch");}},
    sealSubmission:async()=>({status:"absent"}),now:clock.now,canWrite:()=>true} as never);
  await managed.pump();
  assert.equal(observedReservedBeforeTransfer,true,`budget and child must commit before Task owner CAS: ${JSON.stringify(managed.status().faults)}`);
  assert.ok(managed.status().faults.some(f=>f.code==="FIXTURE_TRANSFER_CRASH"));
  assert.equal((await orchestration.getDispatch(principal(owner),pid,childId))?.state,"pending");
  assert.equal((await workflow.getTask(principal(owner),pid,firstTaskId)).task.owner,"prior-role");
  await denied(issue(owner,{type:"dispatch.claim",dispatchId:childId,claimToken:randomUUID(),
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()}),"HANDOFF_NOT_CONFIRMED");
  await managed.pump();
  assert.equal(managed.status().faults.length,0,JSON.stringify(managed.status().faults));
  const taskVersion=(await workflow.getTask(principal(owner),pid,firstTaskId)).task.version;
  assert.equal((await workflow.getTask(principal(owner),pid,firstTaskId)).task.owner,roleId);
  assert.equal((await orchestration.getDispatch(principal(owner),pid,childId))?.taskVersion,taskVersion);
  const childToken=randomUUID();
  await issue(owner,{type:"dispatch.claim",dispatchId:childId,claimToken:childToken,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue(owner,{type:"dispatch.start",dispatchId:childId,claimToken:childToken});
  const admission=dynamicRuntimeAdmission(pool,async(p,id)=>templateCurrent&&p===pid&&id===template.id?
    {template,hash:templateHash}:null,clock.now);
  const sessionId=loopIntentId(childId,"session"),runId=loopIntentId(childId,"run");
  const sessionSpec={projectId:pid,id:sessionId,actorId:owner,roleId,authorizationScope:scope,cwd,
    model:template.model,sandbox:template.sandbox,approvalPolicy:template.approvalPolicy};
  assert.equal(await admission.isDynamicSession(pid,sessionId),true);
  assert.equal(await admission.canReserveSession({projectId:pid,sessionId,actorId:owner,roleId,
    authorizationScope:scope,cwd,model:template.model,sandbox:template.sandbox,
    approvalPolicy:template.approvalPolicy}),true);
  const collidingStatic=[{projectId:pid,actorId:owner,roleId,authorizationScope:scope,cwd,
    sandbox:"danger-full-access" as const,model:"other-model",networkAccess:true,approvalPolicy:"never" as const}];
  assert.equal(await runtimeThreadConfigForSession(collidingStatic,{projectId:pid,sessionId,actorId:owner,
    roleId,authorizationScope:scope,cwd,sandbox:template.sandbox,model:template.model,
    approvalPolicy:template.approvalPolicy},admission),undefined,
    "full-access native policy requires no workspace-only network override from a colliding static grant");
  await wf(owner,{type:"task.start",taskId:firstTaskId,expectedVersion:taskVersion,reason:"Start child"});
  await wf(owner,{type:"runtime.session.reserve",sessionId,roleId,cwd,authorizationScope:scope,
    model:template.model,sandbox:template.sandbox,approvalPolicy:template.approvalPolicy});
  await runtime.beginSessionCreate(pid,sessionId);
  await runtime.bindSession(pid,sessionId,{owner:"evoloop-codex-app-server",projectId:pid,sessionId,
    roleId,cwd,authorizationScope:scope,nativeThreadId:`fixture-${sessionId}`,
    nativeSessionId:`fixture-${sessionId}`});
  const run=await wf(owner,{type:"runtime.run.reserve",runId,taskId:firstTaskId,sessionId,
    expectedVersion:(await workflow.getTask(principal(owner),pid,firstTaskId)).task.version,input:"Fixed child handoff"});
  const sourceAuthority={runtimeEnabled:true,isBoundDynamicSession:(p:string,s:string)=>isBoundDynamicSession(pool,p,s),
    hasRuntimeGrant:(grant:{actorId:string;roleId:string;cwd:string;authorizationScope:string;sandbox:string})=>
      grant.cwd===cwd && ((grant.roleId===roleId && grant.actorId===owner &&
      grant.authorizationScope===scope && grant.sandbox===template.sandbox) ||
      (grant.roleId===cognitiveRole && grant.actorId===cognition)),
    allowedRuntimeCwd:async()=>true};
  assert.equal(await currentSessionGrant(pool,{projectId:pid,id:sessionId},()=>true),false,
    "orchestration disabled cannot turn a persisted dynamic Session into a static start grant");
  assert.equal(await currentSessionGrant(pool,{projectId:pid,id:cognitiveSession},()=>true),true,
    "ordinary static Sessions remain available without orchestration");
  assert.equal(await currentSessionGrant(pool,{projectId:pid,id:sessionId},()=>true,
    async () => admission.canCreateSession(await workflow.getRuntimeSession(principal(owner),pid,sessionId))),true,
    "enabled exact dynamic admission still permits its current binding");
  assert.equal(await staticRunSessionAvailable(pid,await workflow.getRuntimeRun(principal(owner),pid,runId),
    await workflow.getRuntimeSession(principal(owner),pid,sessionId),sourceAuthority),false,
    "a real persisted dynamic binding overrides an otherwise matching static source grant");
  assert.equal(await staticRunSessionAvailable(pid,await workflow.getRuntimeRun(principal(owner),pid,cognitiveRun),
    await workflow.getRuntimeSession(principal(owner),pid,cognitiveSession),sourceAuthority),true,
    "a separately owned static Session remains eligible");
  await issue(owner,{type:"dispatch.resolve",dispatchId:childId,claimToken:childToken,result:"accepted",
    runtimeRunId:runId,reason:"Durable child Run"});
  const app=await buildServer({service:workflow,credentials:[{token:"c".repeat(40),actorId:owner,
    projectIds:[pid],permissions:["read","write","review"]}] as never,
    orchestration:{service:orchestration,delegationChoices:async()=>({items:[{template,hash:templateHash}]})},
    documents:{uow,blobsForPrincipal:async()=>({read:async()=>({status:"unavailable",reason:"fixture"})}) as never},
    workers:{authenticate:header=>broker.authenticate(header),facts:identity=>workerGuardFacts(pool,identity)}});
  const apiUrl=await app.listen({host:"127.0.0.1",port:0});
  t.after(async()=>app.close());
  broker=new WorkerCredentialBroker({workerRoot,apiUrl,
    cliMain:fileURLToPath(new URL("../../apps/cli/dist/main.js",import.meta.url)),
    nodeExecutable:process.execPath,ttlMs:60_000});
  const receiptWorker=await broker.issue({projectId:pid,loopId,taskId:firstTaskId,runId,sessionId,roleId,
    kind:"business",allowedRoleIds:[roleId]});
  assert.ok((await readFile(receiptWorker.wrapperPath,"utf8")).includes(JSON.stringify(process.execPath)),
    "the broker wrapper must call the current host's Node executable");
  const receiver=receiptWorker.principal;
  const cli=async(args:string[],expected=0)=>{
    const result=await new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,[receiptWorker.wrapperPath,...args],{stdio:["ignore","pipe","pipe"]});
      let out="",err="";child.stdout.on("data",chunk=>out+=String(chunk));child.stderr.on("data",chunk=>err+=String(chunk));
      child.once("error",reject);child.once("close",code=>resolve({code,out,err}));
    });
    assert.equal(result.code,expected,`worker CLI ${args.join(" ")}: ${result.err}`);
    return JSON.parse(expected===0?result.out:result.err.trim().split("\n").at(-1)??"{}") as Record<string,unknown>;
  };
  const bindingRead=await cli(["get",`/api/projects/${pid}/orchestration/bindings/${binding.entityId}`]);
  assert.equal(bindingRead.id,binding.entityId);
  const originalRead=await cli(["get",`/api/projects/${pid}/documents/${documentId}/revisions/${document.revisionId}/original`]);
  assert.equal(originalRead.status,"available");
  assert.equal(originalRead.body,"# Fixed handoff");
  await cli(["get",`/api/projects/${pid}/orchestration/bindings/${randomUUID()}`],1);
  await denied(orchestration.execute(receiver,{projectId:pid,operationId:randomUUID(),type:"worker.decision",
    decisionId:randomUUID(),dispatchId:childId,runId,kind:"failed",reason:"Pre-ack",evidenceRefs:[]}),
    "HANDOFF_UNACKNOWLEDGED");
  const ack={projectId:pid,operationId:randomUUID(),type:"division.ackHandoff",dispatchId:childId,runId,
    documentRevisionId:document.revisionId,documentContentHash:hash("# Fixed handoff"),
    taskRevisionId:run.revisionId,reason:"I read the fixed original"};
  await denied(orchestration.execute(principal(owner),ack as never),"FORBIDDEN");
  await denied(orchestration.execute(receiver,{...ack,operationId:randomUUID()} as never),"HANDOFF_MISMATCH");
  await runtime.beginDispatch(pid,runId);
  const receiverTurn=`fixture-owned-turn-${runId}`;
  await runtime.bindTurn(pid,runId,{id:receiverTurn,status:"running"} as never,
    {kind:"startReply",operationId:(await workflow.getRuntimeRun(principal(owner),pid,runId)).operationId});
  const ackFile=join(cwd,`${ack.operationId}.json`);
  await writeFile(ackFile,JSON.stringify(ack),{mode:0o600});
  assert.equal((await cli(["command","run",ackFile])).entityId,childId);
  assert.equal((await orchestration.execute(receiver,ack as never)).replayed,true);
  const decision=await orchestration.execute(receiver,{projectId:pid,operationId:randomUUID(),type:"worker.decision",
    decisionId:randomUUID(),dispatchId:childId,runId,kind:"failed",reason:"Fixture delivery failed",
    evidenceRefs:[]} as never);
  assert.equal(decision.entityType,"decision");
  assert.equal(await admission.canStartConversation(await workflow.getRuntimeSession(principal(owner),pid,sessionId)),true,
    "a settled Dispatch keeps its exact full Session conversation authority while its template is current");
  await issue(owner,{type:"division.revoke",loopId,expectedLoopVersion:
    (await orchestration.getLoop(principal(owner),pid,loopId))!.version,bindingId:binding.entityId,
    reason:"Withdraw new starts"});
  templateCurrent=false;
  const session=(await workflow.getRuntimeSession(principal(owner),pid,sessionId));
  assert.equal(await admission.canCreateSession(session),false);
  assert.equal(await admission.canStartConversation(session),false,"conversation cannot bypass a withdrawn dynamic template");
  assert.equal(await currentSessionGrant(pool,session,()=>true,()=>admission.canCreateSession(session)),false,
    "revoked dynamic binding does not fall back to the colliding static grant");
  assert.equal(await admission.canStartRun((await workflow.getRuntimeRun(principal(owner),pid,runId)),session),false);
  assert.equal(await admission.canSettleOwned(session,(await workflow.getRuntimeRun(principal(owner),pid,runId))),true);
  assert.equal(await staticRunSessionAvailable(pid,await workflow.getRuntimeRun(principal(owner),pid,runId),
    session,sourceAuthority),false,"revocation cannot reclassify a historical dynamic Session as static");
  assert.equal(await runtimeThreadConfigForSession(collidingStatic,{projectId:pid,sessionId,actorId:owner,
    roleId,authorizationScope:scope,cwd,sandbox:template.sandbox,model:template.model,
    approvalPolicy:template.approvalPolicy},admission),undefined,
    "revocation cannot switch the same bound Session to static network permission");
});
