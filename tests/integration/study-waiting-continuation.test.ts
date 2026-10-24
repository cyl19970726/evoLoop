import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test,{type TestContext} from "node:test";
import pg from "pg";
import {migrate,PostgresUnitOfWork} from "@evoloop/adapter-postgres";
import {PgOrchestrationStore} from "@evoloop/adapter-postgres/orchestration";
import {WorkflowService,RuntimeWorkflowService} from "@evoloop/core";
import {OrchestrationService,OrchestrationError} from "@evoloop/core/orchestration";
import {decideTaskExternalReference,applyDeclaredStudyReference} from "@evoloop/core/references";
import {ManagedLoopRunner,loopIntentId} from "../../apps/coordinator/src/orchestration/runner.js";
import {RuntimeRunner} from "../../apps/coordinator/src/runtime/runner.js";
import {WorkerCredentialBroker} from "../../apps/coordinator/src/workers/credentials.js";
import {workerGuardFacts} from "../../apps/coordinator/src/workers/facts.js";
import {buildServer} from "../../apps/coordinator/src/server.js";
import {readTaskContext} from "../../apps/cli/src/materials.js";

const url=process.env.TEST_DATABASE_URL;
if(!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname))
  throw new Error("isolated evoloop test database required");
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const failed=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,
  error=>error instanceof OrchestrationError&&error.code===code);

async function studyScenario(t:TestContext,ending:"child"|"no_action"){
  const schema=`el_study_wait_${randomUUID().replaceAll("-","").slice(0,16)}`;
  await migrate(url!,schema);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  t.after(async()=>{await pool.end();const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const projectId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),loopId=randomUUID();
  const controllerId="study-controller",reviewerId="study-reviewer",role="cognition",business="business";
  const scope="study-cognition-scope",cwd="/tmp/evoloop-waiting-study-fixture";
  const principal=(actorId:string)=>({actorId,projectIds:[projectId],
    permissions:["read","write","review"] as Array<"read"|"write"|"review">});
  const controller=principal(controllerId),reviewer=principal(reviewerId);
  const uow=new PostgresUnitOfWork(pool),clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash}}),runtime=new RuntimeWorkflowService({uow,clock,ids});
  let grant=true,reviewerCurrent=true;
  const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(project,id)=>project===projectId&&id===scope?
    {projectId,scopeId:scope,actorId:controllerId,roleId:role,active:true}:
    project===projectId&&id==="business-scope"?{projectId,scopeId:id,actorId:controllerId,roleId:business,active:true}:null,
    canActAsRole:async(project,actor,required)=>project===projectId&&actor===controllerId&&[role,business].includes(required),
    wasActorRole:async()=>false});
  const orchestration=new OrchestrationService({store,now:clock.now,nextId:randomUUID,hash,
    getTrialController:async(project,actor)=>project===projectId&&actor===controllerId?controller:null,
    hasCurrentStudyReviewer:async(project,actor)=>project===projectId&&actor===reviewerId&&reviewerCurrent,
    canReadStudySourceRun:async()=>grant});
  const wf=async(input:Record<string,unknown>)=>{const result=await workflow.execute(controller,
    {projectId,operationId:randomUUID(),...input} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result;};
  const run=async(actor:ReturnType<typeof principal>,input:Record<string,unknown>,operationId=randomUUID())=>
    orchestration.execute(actor,{projectId,operationId,...input} as never);
  await wf({type:"project.create",title:"Waiting study continuation"});
  await wf({type:"goal.create",goalId,outcome:"Decide from fixed Runs",constraints:"Bounded",consumer:controllerId,
    authority:reviewerId,scope:"fixture",owner:controllerId});
  await wf({type:"stage.propose",stageId,goalId,deliverable:"Study",learningQuestion:"What changed?",reason:"Fixture"});
  await wf({type:"stage.accept",stageId,expectedVersion:1,reason:"Study"});
  const sourceTaskId=randomUUID(),carrierTaskId=randomUUID();
  await wf({type:"task.create",taskId:sourceTaskId,stageId,title:"Observed work",content:"# Source",
    acceptance:"One comparison",owner:business,consumer:controllerId,evidence:"Fixture",stopCondition:"Observed"});
  await wf({type:"task.start",taskId:sourceTaskId,expectedVersion:1,reason:"Fixed source"});
  const sourceTask=await workflow.getTask(controller,projectId,sourceTaskId);
  const sourceRuns:string[]=[];
  for(let index=0;index<3;index++){
    const sessionId=randomUUID(),runId=randomUUID(),input=`source ${index}`;
    await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,
      approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'source-scope','read-only','on-request','ready',1,$5,$6,$7,$8,now(),now())`,
      [projectId,sessionId,business,cwd,randomUUID(),randomUUID(),randomUUID(),controllerId]);
    await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,
      operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',1,$10,$11,now(),now())`,
      [projectId,runId,sourceTaskId,sourceTask.task.currentRevisionId,sourceTask.basis!.id,
        sessionId,randomUUID(),input,hash(input),randomUUID(),controllerId]);
    sourceRuns.push(runId);
  }
  await wf({type:"task.create",taskId:carrierTaskId,stageId,title:"Source carrier",content:"# Three Runs",
    acceptance:"One study",owner:role,kind:"research",consumer:role,evidence:"Fixture",stopCondition:"Study"});
  const referenceDeps={uow,git:{read:async()=>({status:"unavailable" as const,reason:"unused",observedAt:clock.now()})},
    hashText:hash,nextId:randomUUID,now:clock.now,hasCurrentStudyReviewer:async()=>reviewerCurrent,
    observeExternal:async(_actor:unknown,_project:string,_kind:string,_id:string,revision:string,contentHash:string)=>({
      status:grant?"reachable" as const:"unavailable" as const,revision,contentHash,
      currentRevision:revision,currentHash:contentHash,currentValidity:grant?"valid" as const:"unavailable" as const})};
  const decisions:string[]=[];
  let carrier=await workflow.getTask(controller,projectId,carrierTaskId);
  for(const [index,runId] of sourceRuns.entries()){
    const decisionId=randomUUID(),slotId=randomUUID(),input=`source ${index}`;
    const result=await decideTaskExternalReference(referenceDeps as never,reviewer,{projectId,
      operationId:randomUUID(),actorId:reviewerId,decisionId,taskId:carrierTaskId,
      taskRevisionId:carrier.task.currentRevisionId,expectedTaskVersion:carrier.task.version,
      slotId,expectedHeadVersion:0,decision:"adopt",kind:"run",referenceId:runId,
      revision:sourceTask.task.currentRevisionId,contentHash:hash(input),reason:"Compare fixed Run",
      actionImpact:"Decide bounded study"});
    assert.equal(result.status,"applied",JSON.stringify(result));decisions.push(decisionId);
    carrier=await workflow.getTask(controller,projectId,carrierTaskId);
  }
  const loopResult=await run(reviewer,{type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:role,
    allowedBusinessRoleIds:[business],sourceAfter:{createdAtUtc:"2020-01-01T00:00:00.000Z",eventId:null},
    maxRuns:12,maxConcurrent:1,reason:"Original finite budget"});
  assert.equal(loopResult.entityType,"loop");
  const declarationId=randomUUID(),enrolled=(await orchestration.getLoop(controller,projectId,loopId))!;
  await run(reviewer,{type:"loop.studyMaterial.declare",loopId,expectedLoopVersion:enrolled.version,
    declarationId,controllerActorId:controllerId,sourceTaskId:carrierTaskId,
    sourceTaskRevisionId:carrier.task.currentRevisionId,sourceDecisionIds:decisions,reason:"Three fixed Runs"});
  const credentials:string[]=[];
  const runner=new ManagedLoopRunner({projects:[projectId],reader:()=>controller,
    orchestration,workflow,runtime:{pump:async()=>{}},canWrite:()=>true,now:clock.now,
    controller:async(_project,requiredRole)=>[role,business].includes(requiredRole)?{principal:controller,
      authorizationScopeId:requiredRole===role?scope:"business-scope",cwd,model:"fixture",
      sandbox:"read-only",approvalPolicy:"on-request"}:null,
    credential:{lookup:async()=>null,issue:async(identity)=>{credentials.push(identity.runId);
      return {principal:principal(`worker-${identity.runId}`),wrapperPath:"/fixture/wrapper"};}},
    applyStudyReference:async(actor,command,provenance)=>
      applyDeclaredStudyReference(referenceDeps as never,actor,command,provenance),
    sealSubmission:async()=>({status:"absent"})});
  await runner.pump();
  const firstInbox=(await orchestration.listInbox(controller,projectId,loopId)).items[0]!;
  const taskId=loopIntentId(loopId,firstInbox.id,"cognition-task");
  const original=(await orchestration.listDispatches(controller,projectId,loopId)).items[0]!;
  assert.equal(original.taskId,taskId);
  assert.equal((await workflow.getTask(controller,projectId,taskId)).task.version,4);
  const claim=randomUUID();
  await run(controller,{type:"dispatch.claim",dispatchId:original.id,claimToken:claim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await run(controller,{type:"dispatch.start",dispatchId:original.id,claimToken:claim});
  await wf({type:"task.start",taskId,expectedVersion:4,reason:"Fix original Run"});
  const oldSession=randomUUID(),oldRun=randomUUID();
  await wf({type:"runtime.session.reserve",sessionId:oldSession,roleId:role,cwd,authorizationScope:scope,
    model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,oldSession);
  await runtime.bindSession(projectId,oldSession,{owner:"evoloop-codex-app-server",projectId,sessionId:oldSession,
    roleId:role,cwd,authorizationScope:scope,nativeThreadId:`fixture-${oldSession}`,
    nativeSessionId:`fixture-${oldSession}`});
  await wf({type:"runtime.run.reserve",runId:oldRun,taskId,sessionId:oldSession,expectedVersion:5,input:"Original study"});
  await run(controller,{type:"dispatch.resolve",dispatchId:original.id,claimToken:claim,result:"accepted",
    runtimeRunId:oldRun,reason:"Original study Run bound"});
  const waitingId=randomUUID();
  await run(controller,{type:"worker.decision",decisionId:waitingId,dispatchId:original.id,runId:oldRun,
    kind:"waiting",divisionDecisionId:null,reason:"Fixed references need repair",evidenceRefs:[]});
  await runtime.rejectDispatch(projectId,oldRun,"Fixture terminal, no native Turn");
  await run(controller,{type:"worker.outcome",dispatchId:original.id,outcome:"waiting",deliveryId:null,
    decisionId:waitingId,evidenceRef:null,reason:"Fixed references need repair"});
  const repairedVersion=(await workflow.getTask(controller,projectId,taskId)).task.version;
  assert.equal((await workflow.getTask(controller,projectId,taskId)).task.version,repairedVersion);
  let loop=(await orchestration.getLoop(controller,projectId,loopId))!;
  await failed(run(reviewer,{type:"loop.resumeWaiting",loopId,expectedLoopVersion:loop.version,
    decisionId:waitingId,dispatchId:original.id,evidenceRef:"repair:reviewed",
    reason:"A bootstrap study cannot follow the Issue-only recovery route"}),"SOURCE_UNAVAILABLE");
  await run(reviewer,{type:"loop.state",loopId,expectedVersion:loop.version,state:"paused",reason:"Review repair"});
  loop=(await orchestration.getLoop(controller,projectId,loopId))!;
  const resume=(change:Record<string,unknown>={},operationId=randomUUID())=>run(reviewer,{
    type:"loop.resumeWaiting",loopId,expectedLoopVersion:loop.version,decisionId:waitingId,
    dispatchId:original.id,evidenceRef:"repair:reviewed",reason:"Fixed source is reviewable",
    continuation:{kind:"same-task-study",declarationId,expectedTaskVersion:repairedVersion},...change},operationId);
  await failed(resume({continuation:undefined}),"LOOP_PAUSED");
  await failed(resume({continuation:{kind:"same-task-study",declarationId,expectedTaskVersion:repairedVersion-1}}),"TASK_CHANGED");
  await failed(resume({continuation:{kind:"same-task-study",declarationId:randomUUID(),expectedTaskVersion:repairedVersion}}),"STUDY_AUTHORITY_DENIED");
  await pool.query("UPDATE runtime_run SET state='unknown',version=version+1 WHERE project_id=$1 AND run_id=$2",[projectId,oldRun]);
  await failed(resume(),"RUN_NOT_TERMINAL");
  await pool.query("UPDATE runtime_run SET state='failed',version=version+1 WHERE project_id=$1 AND run_id=$2",[projectId,oldRun]);
  const competingInbox=randomUUID(),competingDispatch=randomUUID();
  await pool.query(`INSERT INTO orchestration_inbox(project_id,inbox_id,loop_id,source_event_id,
    recipient_role_id,purpose,version,state,data)
    SELECT project_id,$3::uuid,loop_id,$4::uuid,'business','next_action',1,'acknowledged',
      jsonb_set(jsonb_set(data,'{id}',to_jsonb($3::text)),'{sourceEventId}',to_jsonb($4::text))
    FROM orchestration_inbox WHERE project_id=$1 AND inbox_id=$2`,
    [projectId,original.inboxId,competingInbox,randomUUID()]);
  await pool.query(`INSERT INTO orchestration_dispatch(project_id,dispatch_id,loop_id,inbox_id,task_id,
    task_version,version,state,data,policy_revision_id,binding_id)
    SELECT project_id,$3::uuid,loop_id,$4::uuid,task_id,task_version,1,'completed',
      jsonb_set(jsonb_set(jsonb_set(data,'{id}',to_jsonb($3::text)),
        '{inboxId}',to_jsonb($4::text)),'{parentDispatchId}',to_jsonb($2::text)),
      policy_revision_id,binding_id FROM orchestration_dispatch WHERE project_id=$1 AND dispatch_id=$2::uuid`,
    [projectId,original.id,competingDispatch,competingInbox]);
  await failed(resume(),"WAITING_UNAVAILABLE");
  await pool.query("DELETE FROM orchestration_dispatch WHERE project_id=$1 AND dispatch_id=$2",[projectId,competingDispatch]);
  await pool.query("DELETE FROM orchestration_inbox WHERE project_id=$1 AND inbox_id=$2",[projectId,competingInbox]);
  grant=false;await failed(resume(),"STUDY_SOURCE_UNAVAILABLE");grant=true;
  reviewerCurrent=false;await failed(resume(),"STUDY_AUTHORITY_DENIED");reviewerCurrent=true;
  const op=randomUUID(),second=randomUUID();
  const results=await Promise.allSettled([resume({},op),resume({},second)]);
  assert.equal(results.filter(value=>value.status==="fulfilled").length,1);
  const winning=results[0]!.status==="fulfilled"?op:second;
  assert.equal((await resume({},winning)).replayed,true);
  const resumed=(await orchestration.listEvents(controller,projectId,loopId)).items.filter(x=>x.kind==="waiting.resumed");
  assert.equal(resumed.length,1);
  const source=(await store.read(projectId,reader=>reader.getSourceFact(resumed[0]!.id)))!;
  assert.equal(source.continuation?.originalTaskId,taskId);
  assert.equal(source.continuation?.expectedTaskVersion,repairedVersion);
  assert.equal(source.continuation?.rootSourceEventId,enrolled.bootstrapEventId);
  assert.equal((await orchestration.getLoop(controller,projectId,loopId))?.dispatchCount,1);
  await runner.pump();
  assert.equal((await orchestration.listDispatches(controller,projectId,loopId)).items.length,1,
    "paused Loop records the signed source but starts no second dispatch");
  loop=(await orchestration.getLoop(controller,projectId,loopId))!;
  await run(reviewer,{type:"loop.state",loopId,expectedVersion:loop.version,state:"active",reason:"Review accepted"});
  await runner.pump();
  const dispatches=(await orchestration.listDispatches(controller,projectId,loopId)).items;
  const next=dispatches.find(item=>item.id!==original.id)!;
  assert.ok(next,`runner must dispatch the original Task once: ${JSON.stringify(runner.status())}`);
  assert.equal(next.taskId,taskId);assert.equal(next.taskVersion,repairedVersion);
  assert.equal((await orchestration.getLoop(controller,projectId,loopId))?.dispatchCount,2);
  assert.equal((await workflow.getTask(controller,projectId,taskId)).task.state,"in_progress");
  const newSession=loopIntentId(next.id,"session"),newRun=loopIntentId(next.id,"run");
  await wf({type:"runtime.session.reserve",sessionId:newSession,roleId:role,cwd,authorizationScope:scope,
    model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,newSession);
  await runtime.bindSession(projectId,newSession,{owner:"evoloop-codex-app-server",projectId,sessionId:newSession,
    roleId:role,cwd,authorizationScope:scope,nativeThreadId:`fixture-${newSession}`,
    nativeSessionId:`fixture-${newSession}`});
  await runner.pump();
  const continued=(await orchestration.getDispatch(controller,projectId,next.id))!;
  assert.equal(continued.state,"accepted");assert.equal(continued.runtimeRunId,newRun);
  assert.notEqual(newRun,oldRun);
  const reserved=await workflow.getRuntimeRun(controller,projectId,newRun);
  assert.equal(reserved.taskId,taskId);
  assert.match(reserved.input,new RegExp(oldRun));
  assert.match(reserved.input,/Read this Run's fixed Task context and all three declared references/);
  const persistedSource=await store.read(projectId,reader=>reader.getSourceFact(resumed[0]!.id));
  assert.equal(persistedSource?.continuation?.expectedTaskVersion,repairedVersion,
    "valid consumed history stays readable after the new Run freezes a later Task revision");
  await runtime.beginDispatch(projectId,newRun);
  await runtime.bindTurn(projectId,newRun,{id:`fixture-${newRun}`,status:"inProgress"},
    {kind:"startReply",operationId:loopIntentId(next.id,"run.reserve")});
  const workerRoot=await mkdtemp(join(tmpdir(),"evoloop-waiting-study-worker-"));
  t.after(async()=>rm(workerRoot,{recursive:true,force:true}));
  const broker=new WorkerCredentialBroker({workerRoot,apiUrl:"http://127.0.0.1:1",
    cliMain:"/fixture/cli.js",nodeExecutable:process.execPath,ttlMs:60_000});
  const newScope={projectId,loopId,taskId,runId:newRun,sessionId:newSession,roleId:role,
    kind:"cognition" as const,allowedRoleIds:[role,business]};
  await broker.issue(newScope);
  const token=await readFile(join(workerRoot,newRun,"credential"),"utf8");
  const identity=await broker.authenticate(`Bearer ${token}`);
  assert.ok(identity);
  const facts=workerGuardFacts(pool,identity,async(_project,actor)=>actor===reviewerId&&reviewerCurrent);
  for(const sourceRun of sourceRuns)assert.equal(await facts.fixedRunTrace!(sourceRun),true);
  const metadataRunner=new RuntimeRunner({runtimeFactory:()=>({isReady:()=>true}) as never,
    workflow,trusted:runtime,principals:[controller],canWrite:()=>true,allowedCwd:async()=>true,
    hasGrant:()=>grant,
    workerTraceAuthority:(who,target)=>workerGuardFacts(pool,who,async(_project,actor)=>
      actor===reviewerId&&reviewerCurrent).fixedRunTrace!(target)});
  const app=await buildServer({service:workflow,credentials:[{token:"o".repeat(40),actorId:controllerId,
    projectIds:[projectId],permissions:["read","write","review"]}],
    references:{uow,gitForPrincipal:async()=>referenceDeps.git,knowledgeForPrincipal:async()=>({})} as never,
    documents:{uow,blobsForPrincipal:async()=>({}) as never},
    workers:{authenticate:header=>broker.authenticate(header),facts:who=>workerGuardFacts(pool,who,
      async(_project,actor)=>actor===reviewerId&&reviewerCurrent)},
    runtime:{status:()=>({available:true,error:null}),trace:async()=>({source:"fixture"}),
      workerFixedRunMetadata:metadataRunner.workerFixedRunMetadata.bind(metadataRunner)} as never});
  t.after(async()=>app.close());
  const address=await app.listen({host:"127.0.0.1",port:0});
  const signedClient={get:async(path:string)=>{const response=await fetch(new URL(path,address),
    {headers:{authorization:`Bearer ${token}`}});
    const body=await response.json() as {code?:string};
    if(!response.ok)throw new Error(`${body.code??"HTTP"} HTTP${response.status}`);
    return body;}};
  const context=await readTaskContext(signedClient as never,projectId,taskId);
  assert.equal(context.status,"complete",JSON.stringify(context.failures));
  assert.deepEqual(context.externalReferences.map(item=>item.reference.referenceId).sort(),[...sourceRuns].sort());
  assert.equal((await workflow.getTask(controller,projectId,taskId)).task.version,repairedVersion+1,
    "normal Run reserve freezes the same Task at its next revision");
  assert.equal(await workflow.getOperation(controller,projectId,loopIntentId(next.id,"task.start")),null,
    "same-Task continuation must not call task.start");
  assert.equal((await orchestration.getDecision(controller,projectId,waitingId))?.kind,"waiting");
  assert.equal(credentials.filter(value=>value===newRun).length,1);
  await runner.pump();
  assert.equal((await orchestration.listDispatches(controller,projectId,loopId)).items.length,2);
  assert.equal((await orchestration.getLoop(controller,projectId,loopId))?.dispatchCount,2);
  const secondWaiting=randomUUID();
  await run(controller,{type:"worker.decision",decisionId:secondWaiting,dispatchId:next.id,runId:newRun,
    kind:"waiting",divisionDecisionId:null,reason:"Continue the same study",evidenceRefs:[]});
  await runtime.recordTurn(projectId,newRun,`fixture-${newRun}`,"failed","Study requires one more review");
  await run(controller,{type:"worker.outcome",dispatchId:next.id,outcome:"waiting",deliveryId:null,
    decisionId:secondWaiting,evidenceRef:null,reason:"Continue the same study"});
  loop=(await orchestration.getLoop(controller,projectId,loopId))!;
  await run(reviewer,{type:"loop.resumeWaiting",loopId,expectedLoopVersion:loop.version,
    decisionId:secondWaiting,dispatchId:next.id,evidenceRef:"repair:second-review",
    reason:"Continue after verified review",continuation:{kind:"same-task-study",
      declarationId,expectedTaskVersion:repairedVersion+1}});
  const secondResume=(await orchestration.listEvents(controller,projectId,loopId)).items
    .filter(event=>event.kind==="waiting.resumed").find(event=>event.entityId===secondWaiting)!;
  const secondSource=(await store.read(projectId,reader=>reader.getSourceFact(secondResume.id)))!;
  assert.equal(secondSource.continuation?.rootInboxId,original.inboxId);
  await runner.pump();
  const third=(await orchestration.listDispatches(controller,projectId,loopId)).items
    .find(item=>item.id!==original.id&&item.id!==next.id)!;
  assert.ok(third,`second continuation must dispatch the root Task: ${JSON.stringify(runner.status())}`);
  assert.equal(third.taskId,taskId);
  assert.equal(third.taskVersion,repairedVersion+1);
  assert.equal((await orchestration.getLoop(controller,projectId,loopId))?.dispatchCount,3);
  const thirdSession=loopIntentId(third.id,"session"),thirdRun=loopIntentId(third.id,"run");
  await wf({type:"runtime.session.reserve",sessionId:thirdSession,roleId:role,cwd,
    authorizationScope:scope,model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,thirdSession);
  await runtime.bindSession(projectId,thirdSession,{owner:"evoloop-codex-app-server",projectId,
    sessionId:thirdSession,roleId:role,cwd,authorizationScope:scope,nativeThreadId:`fixture-${thirdSession}`,
    nativeSessionId:`fixture-${thirdSession}`});
  await runner.pump();
  assert.equal((await orchestration.getDispatch(controller,projectId,third.id))?.runtimeRunId,thirdRun);
  assert.equal((await workflow.getTask(controller,projectId,taskId)).task.version,repairedVersion+2);
  await runtime.beginDispatch(projectId,thirdRun);
  await runtime.bindTurn(projectId,thirdRun,{id:`fixture-${thirdRun}`,status:"inProgress"},
    {kind:"startReply",operationId:loopIntentId(third.id,"run.reserve")});
  if(ending==="no_action"){
    const finalDecision=randomUUID();
    await run(controller,{type:"worker.decision",decisionId:finalDecision,dispatchId:third.id,runId:thirdRun,
      kind:"no_action",divisionDecisionId:null,reason:"Study found no further bounded work",evidenceRefs:[]});
    await runtime.recordTurn(projectId,thirdRun,`fixture-${thirdRun}`,"failed","Decision complete");
    await run(controller,{type:"worker.outcome",dispatchId:third.id,outcome:"no_action",deliveryId:null,
      decisionId:finalDecision,evidenceRef:null,reason:"Study found no further bounded work"});
    const stale=await workflow.execute(controller,{projectId,operationId:randomUUID(),type:"task.close",
      taskId,expectedVersion:repairedVersion+2,decisionId:secondWaiting,acceptanceResult:"met",
      acceptanceEvidence:"Cannot close the new revision with old waiting",reason:"Stale decision"});
    assert.equal(stale.status,"rejected");
    const closed=await wf({type:"task.close",taskId,expectedVersion:repairedVersion+2,
      decisionId:finalDecision,acceptanceResult:"met",
      acceptanceEvidence:"Verified signed no-action decision",reason:"Study complete"});
    assert.equal(closed.status,"applied");
    assert.equal((await workflow.getTask(controller,projectId,taskId)).task.state,"done");
    return;
  }
  const businessTask=randomUUID();
  await wf({type:"task.create",taskId:businessTask,stageId,title:"Bounded follow-up",content:"# Follow-up",
    acceptance:"One result",owner:business,consumer:controllerId,evidence:"Study",stopCondition:"One run"});
  const nextInbox=await run(controller,{type:"inbox.accept",loopId,sourceEventId:secondResume.id,
    recipientRoleId:role,purpose:"next_action"});
  await run(controller,{type:"inbox.ack",inboxId:nextInbox.entityId,expectedVersion:1,
    reason:"Current study chose follow-up"});
  const child=await run(controller,{type:"dispatch.request",inboxId:nextInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:third.id,taskId:businessTask,
    expectedTaskVersion:1,recipientRoleId:business,purpose:"business",
    authorizationScopeId:"business-scope",reason:"Study chose existing Role"});
  assert.equal(child.entityType,"dispatch");
  const finalWaiting=randomUUID();
  await run(controller,{type:"worker.decision",decisionId:finalWaiting,dispatchId:third.id,runId:thirdRun,
    kind:"waiting",divisionDecisionId:null,reason:"Child owns the follow-up",evidenceRefs:[]});
  await runtime.recordTurn(projectId,thirdRun,`fixture-${thirdRun}`,"failed","Follow-up delegated");
  await run(controller,{type:"worker.outcome",dispatchId:third.id,outcome:"waiting",deliveryId:null,
    decisionId:finalWaiting,evidenceRef:null,reason:"Child owns the follow-up"});
  const close=await wf({type:"task.close",taskId,expectedVersion:repairedVersion+2,
    decisionId:finalWaiting,handoffDispatchId:child.entityId,acceptanceResult:"met",
    acceptanceEvidence:"Verified signed child handoff",reason:"Cognition delivered bounded decision"});
  assert.equal(close.status,"applied");
  assert.equal((await workflow.getTask(controller,projectId,taskId)).task.state,"done");
}
test("bootstrap study waiting continues twice on one Task and hands off a signed child",t=>studyScenario(t,"child"));
test("same-Task resumed study closes on its own signed no-action Decision, not an old waiting",t=>studyScenario(t,"no_action"));
