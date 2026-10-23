import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import { dynamicRuntimeAdmission } from "../../apps/coordinator/src/orchestration/dynamic-admission.js";
import { loopIntentId } from "../../apps/coordinator/src/orchestration/runner.js";
import { ManagedLoopRunner } from "../../apps/coordinator/src/orchestration/runner.js";

const url=process.env.TEST_DATABASE_URL;
if (!url || !/evoloop.*test/.test(new URL(url).pathname))
  throw new Error("dedicated PostgreSQL test database required");
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const pid=randomUUID(),owner="controller",cognition="cognition-actor",cognitiveRole="cognition";
const roleId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),loopId=randomUUID();
const parentTaskId=randomUUID(),firstTaskId=randomUUID(),documentId=randomUUID();
const scope="m3-exact",cwd="/tmp/evoloop-m3-execution-fixture";
const principal=(actorId:string)=>({actorId,projectIds:[pid],permissions:["read","write","review"] as Array<"read"|"write"|"review">});

test("PG bounded division reserves, transfers by Task CAS, starts once, and receives a brokered handoff",async t=>{
  const schema=`el_m3_${randomUUID().replaceAll("-","").slice(0,16)}`;
  await migrate(url!,schema);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  const workerRoot=await mkdtemp(join(tmpdir(),"evoloop-m3-receiver-"));
  t.after(async()=>{await pool.end();await rm(workerRoot,{recursive:true,force:true});
    const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const uow=new PostgresUnitOfWork(pool),clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash}}),runtime=new RuntimeWorkflowService({uow,clock,ids});
  const broker=new WorkerCredentialBroker({workerRoot,apiUrl:"http://127.0.0.1:4318",cliMain:"/fixture/cli.js",
    nodeExecutable:"/Users/hhh0x/.nvm/versions/node/v24.21.0/bin/node",ttlMs:60_000});
  const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(p,id)=>p===pid&&id==="cognitive-scope"?
    {projectId:pid,scopeId:id,actorId:cognition,roleId:cognitiveRole,active:true}:null,
    canActAsRole:async(_p,actor,role)=>actor===cognition&&role===cognitiveRole ||
      (await broker.identityForActor(actor))?.scope.roleId===role,
    wasActorRole:async()=>false});
  const template:DelegationTemplate={id:randomUUID(),revision:1,projectId:pid,goalId,loopId,
    existingRoleIds:[roleId],cognitionRoleIds:[],newRoleAllocation:null,firstTaskId,
    actorId:owner,authorizationScopeId:scope,decisionActorIds:[cognition],
    allowedChoices:["temporary-assignment"],cwd,model:"fixture-model",sandbox:"read-only",
    networkAccess:false,approvalPolicy:"on-request",expiresAtUtc:new Date(Date.now()+86_400_000).toISOString()};
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
    authorizationScope:"cognitive-scope",model:"fixture-model",sandbox:"read-only",approvalPolicy:"on-request"});
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
  await wf(owner,{type:"task.start",taskId:firstTaskId,expectedVersion:taskVersion,reason:"Start child"});
  await wf(owner,{type:"runtime.session.reserve",sessionId,roleId,cwd,authorizationScope:scope,
    model:template.model,sandbox:template.sandbox,approvalPolicy:template.approvalPolicy});
  await runtime.beginSessionCreate(pid,sessionId);
  await runtime.bindSession(pid,sessionId,{owner:"evoloop-codex-app-server",projectId:pid,sessionId,
    roleId,cwd,authorizationScope:scope,nativeThreadId:`fixture-${sessionId}`,
    nativeSessionId:`fixture-${sessionId}`});
  const run=await wf(owner,{type:"runtime.run.reserve",runId,taskId:firstTaskId,sessionId,
    expectedVersion:(await workflow.getTask(principal(owner),pid,firstTaskId)).task.version,input:"Fixed child handoff"});
  await issue(owner,{type:"dispatch.resolve",dispatchId:childId,claimToken:childToken,result:"accepted",
    runtimeRunId:runId,reason:"Durable child Run"});
  const receiptWorker=await broker.issue({projectId:pid,loopId,taskId:firstTaskId,runId,sessionId,roleId,
    kind:"business",allowedRoleIds:[roleId]});
  const receiver=receiptWorker.principal;
  await denied(orchestration.execute(receiver,{projectId:pid,operationId:randomUUID(),type:"worker.decision",
    decisionId:randomUUID(),dispatchId:childId,runId,kind:"failed",reason:"Pre-ack",evidenceRefs:[]}),
    "HANDOFF_UNACKNOWLEDGED");
  const ack={projectId:pid,operationId:randomUUID(),type:"division.ackHandoff",dispatchId:childId,runId,
    documentRevisionId:document.revisionId,documentContentHash:hash("# Fixed handoff"),
    taskRevisionId:run.revisionId,reason:"I read the fixed original"};
  await denied(orchestration.execute(principal(owner),ack as never),"FORBIDDEN");
  assert.equal((await orchestration.execute(receiver,ack as never)).entityId,childId);
  assert.equal((await orchestration.execute(receiver,ack as never)).replayed,true);
  const decision=await orchestration.execute(receiver,{projectId:pid,operationId:randomUUID(),type:"worker.decision",
    decisionId:randomUUID(),dispatchId:childId,runId,kind:"failed",reason:"Fixture delivery failed",
    evidenceRefs:[]} as never);
  assert.equal(decision.entityType,"decision");
  await issue(owner,{type:"division.revoke",loopId,expectedLoopVersion:
    (await orchestration.getLoop(principal(owner),pid,loopId))!.version,bindingId:binding.entityId,
    reason:"Withdraw new starts"});
  templateCurrent=false;
  const session=(await workflow.getRuntimeSession(principal(owner),pid,sessionId));
  assert.equal(await admission.canCreateSession(session),false);
  assert.equal(await admission.canStartRun((await workflow.getRuntimeRun(principal(owner),pid,runId)),session),false);
  assert.equal(await admission.canSettleOwned(session,(await workflow.getRuntimeRun(principal(owner),pid,runId))),true);
});
