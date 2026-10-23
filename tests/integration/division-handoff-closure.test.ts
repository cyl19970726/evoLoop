import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { WorkflowService, RuntimeWorkflowService } from "@evoloop/core";
import { OrchestrationService } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import type { DelegationTemplate } from "@evoloop/contracts/division";

const url=process.env.TEST_DATABASE_URL;
if(!url || !/evoloop.*test/.test(new URL(url).pathname))throw new Error("dedicated PostgreSQL test DB required");
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const pid=randomUUID(),controller="controller",researcher="researcher",cognitiveRole="cognition-role";
const receiver=`worker-${randomUUID()}`,roleId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),loopId=randomUUID();
const parentTaskId=randomUUID(),firstTaskId=randomUUID(),documentId=randomUUID();
const principal=(actorId:string)=>({actorId,projectIds:[pid],permissions:["read","write","review"] as Array<"read"|"write"|"review">});

 test("a real acknowledged Division handoff closes its original waiting cognition Task",async t=>{
  const schema=`el_divclosure_${randomUUID().replaceAll("-","").slice(0,16)}`;
  const migrationsDir=fileURLToPath(new URL("../../packages/adapter-postgres/migrations/",import.meta.url));
  const beforeClosureCount=readdirSync(migrationsDir).filter(name=>name.endsWith(".mjs") && name<"023_").length;
  await runner({databaseUrl:url!,dir:migrationsDir,
    migrationsTable:"pgmigrations",schema,createSchema:true,createMigrationsSchema:true,
    direction:"up",singleTransaction:true,count:beforeClosureCount,log:()=>{}});
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  t.after(async()=>{await pool.end();const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const uow=new PostgresUnitOfWork(pool),clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash}}),runtime=new RuntimeWorkflowService({uow,clock,ids});
  const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(p,id)=>p===pid&&id==="cognition-scope"?
    {projectId:pid,scopeId:id,actorId:researcher,roleId:cognitiveRole,active:true}:null,
    canActAsRole:async(_p,actor,role)=>actor===researcher&&role===cognitiveRole,
    wasActorRole:async()=>false});
  const template:DelegationTemplate={id:randomUUID(),revision:1,projectId:pid,goalId,loopId,
    existingRoleIds:[roleId],cognitionRoleIds:[],newRoleAllocation:null,firstTaskId,
    actorId:controller,authorizationScopeId:"division-scope",decisionActorIds:[researcher],
    allowedChoices:["temporary-assignment"],cwd:"/tmp/evoloop-division-closure-fixture",model:"fixture",
    sandbox:"read-only",networkAccess:false,approvalPolicy:"on-request",expiresAtUtc:new Date(Date.now()+86_400_000).toISOString()};
  const templateHash=hash(JSON.stringify(template));
  let scope:{projectId:string;loopId:string;taskId:string;runId:string;roleId:string;kind:string}|null=null;
  const orchestration=new OrchestrationService({store,now:clock.now,nextId:randomUUID,hash,
    getDelegationTemplate:async(p,id)=>p===pid&&id===template.id?{template,hash:templateHash}:null,
    getWorkerScope:async actor=>actor===receiver?scope:null});
  const wf=(actor:string,command:Record<string,unknown>)=>workflow.execute(principal(actor),{projectId:pid,operationId:randomUUID(),...command} as never);
  const applied=async(actor:string,command:Record<string,unknown>)=>{const result=await wf(actor,command);
    assert.equal(result.status,"applied",JSON.stringify(result));return result;};
  const issue=async(actor:string,command:Record<string,unknown>)=>orchestration.execute(principal(actor),
    {projectId:pid,operationId:randomUUID(),...command} as never);
  await applied(controller,{type:"project.create",title:"Division closure"});
  await applied(controller,{type:"goal.create",goalId,outcome:"Bounded",constraints:"One trial",consumer:controller,authority:"reviewer",scope:"fixture",owner:controller});
  await applied(controller,{type:"stage.propose",stageId,goalId,deliverable:"One result",learningQuestion:"Useful?",reason:"Fixture"});
  await applied(controller,{type:"stage.accept",stageId,expectedVersion:1,reason:"Start"});
  await applied(controller,{type:"task.create",taskId:parentTaskId,stageId,title:"Decide",content:"# Decide",acceptance:"One signed choice",
    owner:cognitiveRole,consumer:controller,evidence:"Fixture",stopCondition:"One choice"});
  await applied(controller,{type:"task.start",taskId:parentTaskId,expectedVersion:1,reason:"Freeze"});
  await applied(controller,{type:"task.create",taskId:firstTaskId,stageId,title:"First work",content:"# First",acceptance:"Result",
    owner:"prior-role",consumer:controller,evidence:"Gap",stopCondition:"One trial"});
  const doc=await applied(controller,{type:"document.create",documentId,kind:"report",title:"Diagnosis",body:"# Fixed diagnosis"});
  const proposal={title:"Trial specialist",goal:"One result",independentResponsibility:"Own one task",ownerScope:"This project",
    inputs:["Fixed diagnosis"],writableAssets:[],deliverables:["One result"],triggers:["Gap"],workflow:"Read and act",
    handoffBoundary:"Return unfinished work",evidence:["backlog","effect","cost"].map(kind=>({kind,observation:"Gap",sourceRef:`task:${firstTaskId}`,observedAtUtc:clock.now()})),
    alternatives:["method","knowledge","another-instance","temporary-assignment"].map(kind=>({kind,assessment:"Insufficient",estimatedCost:"One day"})),
    firstTaskId,baseline:"Delay",expectedEffect:"One result",costLimit:"One run",trialDays:1,
    reviewAtUtc:new Date(Date.now()+60_000).toISOString(),exitCriteria:"Review result"};
  await applied(controller,{type:"role.propose",roleId,proposal});
  await applied(controller,{type:"role.decide",roleId,expectedVersion:1,decision:"accept-trial",reason:"Fixture"});
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[pid])).rows[0];
  await issue(controller,{type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:cognitiveRole,allowedBusinessRoleIds:["static-role"],
    sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},maxRuns:2,maxConcurrent:1,reason:"Bounded"});
  const loop=(await orchestration.getLoop(principal(controller),pid,loopId))!;
  const inbox=await issue(researcher,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await issue(researcher,{type:"inbox.ack",inboxId:inbox.entityId,expectedVersion:1,reason:"Read"});
  const parent=await issue(researcher,{type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:parentTaskId,expectedTaskVersion:2,
    recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:"cognition-scope",reason:"Choose"});
  const parentToken=randomUUID();
  await issue(researcher,{type:"dispatch.claim",dispatchId:parent.entityId,claimToken:parentToken,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue(researcher,{type:"dispatch.start",dispatchId:parent.entityId,claimToken:parentToken});
  const cognitiveSession=randomUUID(),cognitiveRun=randomUUID(),cwd=template.cwd;
  await applied(researcher,{type:"runtime.session.reserve",sessionId:cognitiveSession,roleId:cognitiveRole,cwd,
    authorizationScope:"cognition-scope",model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(pid,cognitiveSession);
  await runtime.bindSession(pid,cognitiveSession,{owner:"evoloop-codex-app-server",projectId:pid,sessionId:cognitiveSession,
    roleId:cognitiveRole,cwd,authorizationScope:"cognition-scope",nativeThreadId:`fixture-${cognitiveSession}`,nativeSessionId:`fixture-${cognitiveSession}`});
  await applied(researcher,{type:"runtime.run.reserve",runId:cognitiveRun,taskId:parentTaskId,sessionId:cognitiveSession,expectedVersion:2,input:"Choose"});
  await issue(researcher,{type:"dispatch.resolve",dispatchId:parent.entityId,claimToken:parentToken,result:"accepted",runtimeRunId:cognitiveRun,reason:"Fixture"});
  const binding=await issue(researcher,{type:"division.decide",decisionId:randomUUID(),loopId,
    expectedLoopVersion:(await orchestration.getLoop(principal(controller),pid,loopId))!.version,
    sourceEventId:loop.bootstrapEventId,parentDispatchId:parent.entityId,documentId,
    documentRevisionId:doc.revisionId,documentContentHash:hash("# Fixed diagnosis"),firstTaskId,
    expectedFirstTaskVersion:1,choice:"temporary-assignment",roleId,templateId:template.id,
    templateRevision:1,templateHash,reason:"Trial"});
  const waiting=await issue(researcher,{type:"worker.decision",decisionId:randomUUID(),dispatchId:parent.entityId,
    runId:cognitiveRun,kind:"waiting",divisionDecisionId:binding.entityId,reason:"Hand over",evidenceRefs:[]});
  await runtime.beginDispatch(pid,cognitiveRun);
  const turn=`fixture-turn-${cognitiveRun}`;
  await runtime.bindTurn(pid,cognitiveRun,{id:turn,status:"running"} as never,
    {kind:"startReply",operationId:(await workflow.getRuntimeRun(principal(controller),pid,cognitiveRun)).operationId});
  await runtime.recordTurn(pid,cognitiveRun,turn,"completed","Fixture terminal");
  await issue(controller,{type:"worker.outcome",dispatchId:parent.entityId,outcome:"waiting",deliveryId:null,
    decisionId:waiting.entityId,evidenceRef:null,reason:"Hand over"});
  const childId=randomUUID();
  for(const [label,changes] of [
    ["binding",{bindingId:randomUUID()}],
    ["parent",{parentDispatchId:randomUUID()}],
    ["decision",{waitingDecisionId:randomUUID()}],
  ] as const){
    await assert.rejects(issue(controller,{type:"division.consume",loopId,
      expectedLoopVersion:(await orchestration.getLoop(principal(controller),pid,loopId))!.version,
      bindingId:binding.entityId,waitingDecisionId:waiting.entityId,parentDispatchId:parent.entityId,
      dispatchId:randomUUID(),reason:`Wrong ${label}`,...changes}),error=>Boolean(error && typeof error==="object" && "code" in error),
    `${label} must not borrow this signed continuation`);
  }
  await issue(controller,{type:"division.consume",loopId,expectedLoopVersion:(await orchestration.getLoop(principal(controller),pid,loopId))!.version,
    bindingId:binding.entityId,waitingDecisionId:waiting.entityId,parentDispatchId:parent.entityId,dispatchId:childId,reason:"Consume"});
  const handoffFact=()=>uow.read(pid,reader=>reader.getChildHandoffFact!(childId));
  const close=async(handoffDispatchId:string,decisionId=waiting.entityId)=>wf(controller,{type:"task.close",taskId:parentTaskId,
    expectedVersion:(await workflow.getTask(principal(controller),pid,parentTaskId)).task.version,
    decisionId,handoffDispatchId,acceptanceResult:"met",acceptanceEvidence:"Verified handoff",reason:"Close cognition"});
  assert.equal(await handoffFact(),null,"consumption alone cannot close the parent");
  assert.equal((await close(childId)).status,"rejected");
  const transferOperationId=randomUUID();
  const transfer=await workflow.execute(principal(controller),{projectId:pid,operationId:transferOperationId,type:"task.update",
    taskId:firstTaskId,expectedVersion:1,title:"First work",content:"# First",acceptance:"Result",owner:roleId,
    stageId,consumer:controller,evidence:"Gap",stopCondition:"One trial",reason:`division-transfer:${binding.entityId}`});
  assert.equal(transfer.status,"applied",JSON.stringify(transfer));
  await issue(controller,{type:"division.confirmTransfer",dispatchId:childId,transferOperationId,
    transferredTaskVersion:2,reason:"Confirm formal Task CAS"});
  assert.equal(await handoffFact(),null,"formal transfer without receiver receipt cannot close the parent");
  const childToken=randomUUID();
  await issue(controller,{type:"dispatch.claim",dispatchId:childId,claimToken:childToken,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue(controller,{type:"dispatch.start",dispatchId:childId,claimToken:childToken});
  await applied(controller,{type:"task.start",taskId:firstTaskId,expectedVersion:2,reason:"Start receiving work"});
  const sessionId=randomUUID(),runId=randomUUID();
  await applied(controller,{type:"runtime.session.reserve",sessionId,roleId,cwd,authorizationScope:"division-scope",
    model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(pid,sessionId);
  await runtime.bindSession(pid,sessionId,{owner:"evoloop-codex-app-server",projectId:pid,sessionId,roleId,cwd,
    authorizationScope:"division-scope",nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
  const receivingRun=await applied(controller,{type:"runtime.run.reserve",runId,taskId:firstTaskId,sessionId,expectedVersion:3,input:"Receive"});
  await issue(controller,{type:"dispatch.resolve",dispatchId:childId,claimToken:childToken,result:"accepted",runtimeRunId:runId,reason:"Child Run"});
  scope={projectId:pid,loopId,taskId:firstTaskId,runId,roleId,kind:"business"};
  for(const [label,changes] of [
    ["run",{runId:randomUUID()}],
    ["document",{documentRevisionId:randomUUID()}],
    ["hash",{documentContentHash:"0".repeat(64)}],
    ["Task revision",{taskRevisionId:randomUUID()}],
  ] as const){
    await assert.rejects(issue(receiver,{type:"division.ackHandoff",dispatchId:childId,runId,
      documentRevisionId:doc.revisionId,documentContentHash:hash("# Fixed diagnosis"),
      taskRevisionId:receivingRun.revisionId,reason:`Wrong ${label}`,...changes}),
    error=>Boolean(error && typeof error==="object" && "code" in error),
    `${label} cannot be acknowledged as the fixed handoff`);
  }
  await issue(receiver,{type:"division.ackHandoff",dispatchId:childId,runId,documentRevisionId:doc.revisionId,
    documentContentHash:hash("# Fixed diagnosis"),taskRevisionId:receivingRun.revisionId,reason:"已读固定原件"});
  assert.equal((await workflow.getRuntimeRun(principal(controller),pid,runId)).state,"requested",
    "receiver receipt is bound to the known, reserved receiving Run before its own terminal outcome");
  await issue(controller,{type:"division.revoke",loopId,expectedLoopVersion:(await orchestration.getLoop(principal(controller),pid,loopId))!.version,
    bindingId:binding.entityId,reason:"No new starts"});
  const handoff=await uow.read(pid,reader=>reader.getChildHandoffFact!(childId));
  assert.equal(handoff?.division?.waitingDecisionId,waiting.entityId);
  assert.equal((await close(randomUUID())).status,"rejected","another child cannot borrow the handoff");
  assert.equal((await close(childId,randomUUID())).status,"rejected","another decision cannot borrow the handoff");
  await assert.rejects(close(childId),error=>Boolean(error && typeof error==="object" && "code" in error && error.code==="23514"),
    "the existing 022 trigger rejects the legitimate later Division continuation");
  const rowCounts=()=>pool.query(`SELECT
    (SELECT count(*)::int FROM task WHERE project_id=$1) AS tasks,
    (SELECT count(*)::int FROM runtime_run WHERE project_id=$1) AS runs,
    (SELECT count(*)::int FROM orchestration_operation WHERE project_id=$1) AS orchestration_operations,
    (SELECT count(*)::int FROM operation_journal WHERE project_id=$1) AS workflow_operations`,[pid]);
  const beforeMigration=(await rowCounts()).rows[0];
  await migrate(url!,schema);
  await migrate(url!,schema);
  assert.deepEqual((await rowCounts()).rows[0],beforeMigration,"023 and its rerun add no business facts");
  const intact=await pool.query("SELECT verified_division_closure_handoff($1,$2,$3) AS valid",[pid,childId,waiting.entityId]);
  assert.equal(intact.rows[0].valid,true);
  const unrelated=await pool.query("SELECT verified_division_closure_handoff($1,$2,$3) AS valid",[pid,childId,randomUUID()]);
  assert.equal(unrelated.rows[0].valid,false,"another waiting Decision cannot satisfy the trigger helper");
  const parentVersion=(await workflow.getTask(principal(controller),pid,parentTaskId)).task.version;
  const closure=await wf(controller,{type:"task.close",taskId:parentTaskId,expectedVersion:parentVersion,decisionId:waiting.entityId,
    handoffDispatchId:childId,acceptanceResult:"met",acceptanceEvidence:"Verified handoff",reason:"Close cognition"});
  assert.equal(closure.status,"applied",JSON.stringify(closure));
  const stored=(await workflow.getTask(principal(controller),pid,parentTaskId)).task;
  assert.equal(stored.state,"done");
});
