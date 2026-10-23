import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import pg from "pg";
import {migrate,PostgresUnitOfWork} from "@evoloop/adapter-postgres";
import {PgOrchestrationStore} from "@evoloop/adapter-postgres/orchestration";
import {WorkflowService} from "@evoloop/core";
import {OrchestrationService,OrchestrationError} from "@evoloop/core/orchestration";
import {applyDeclaredStudyReference,decideTaskExternalReference} from "@evoloop/core/references";
import {loopIntentId} from "../../apps/coordinator/src/orchestration/runner.js";
import {workerGuardFacts} from "../../apps/coordinator/src/workers/facts.js";
import {WorkerCredentialBroker} from "../../apps/coordinator/src/workers/credentials.js";
import {buildServer} from "../../apps/coordinator/src/server.js";
import {hasCurrentStudyReviewer,type AuthConfig} from "../../apps/coordinator/src/auth.js";

const url=process.env.TEST_DATABASE_URL;
if(!url||!/evoloop.*test/.test(new URL(url).pathname))throw new Error("Dedicated test database required");
const schema=`el_study_${randomUUID().replaceAll("-","").slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const projectId=randomUUID(),controllerId="study-controller",reviewerId="study-reviewer",role="cognition",sourceRole="business";
const controllerCredential={token:"c".repeat(40),actorId:controllerId,projectIds:[projectId],
  permissions:["read","write","review"] as Array<"read"|"write"|"review">};
const reviewerCredentials:AuthConfig=[{token:"r".repeat(40),actorId:reviewerId,
  projectIds:[projectId],permissions:["read","write","review"]},controllerCredential];
const currentReviewer=async(project:string,actor:string)=>
  hasCurrentStudyReviewer(reviewerCredentials,project,actor);
const principal=(actorId:string,permissions:Array<"read"|"write"|"review">=["read","write","review"])=>( {actorId,projectIds:[projectId],permissions} );
const controller=principal(controllerId),reviewer=principal(reviewerId);
const uow=new PostgresUnitOfWork(pool);
const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
let sourceGrant=true;
const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(_project,scope)=>scope==="cognitive-scope"?{projectId,scopeId:scope,actorId:controllerId,roleId:role,active:true}:null,
  canActAsRole:async(_project,actor,requiredRole)=>actor===controllerId&&requiredRole===role,
  wasActorRole:async()=>false});
const orchestration=new OrchestrationService({store,now:()=>new Date().toISOString(),nextId:randomUUID,hash,
  getTrialController:async(_project,actor)=>actor===controllerId?controller:null,
  hasCurrentStudyReviewer:currentReviewer,
  canReadStudySourceRun:async(_principal,_project,_runId)=>sourceGrant});
const command=(who:ReturnType<typeof principal>,input:Record<string,unknown>)=>orchestration.execute(who,{projectId,operationId:randomUUID(),...input} as never);
const business=(input:Record<string,unknown>)=>workflow.execute(controller,{projectId,operationId:randomUUID(),...input} as never);
const referenceDeps={uow,git:{read:async()=>({status:"unavailable" as const,reason:"unused",observedAt:new Date().toISOString()})},
  hashText:hash,nextId:randomUUID,now:()=>new Date().toISOString(),hasCurrentStudyReviewer:currentReviewer,
  observeExternal:async(_who:unknown,_project:string,_kind:string,runId:string,revision:string,inputHash:string)=>({
    status:sourceGrant?"reachable" as const:"unavailable" as const,revision,contentHash:inputHash,
    currentRevision:revision,currentHash:inputHash,currentValidity:sourceGrant?"valid" as const:"unavailable" as const})};
const applied=(value:{status:string;[key:string]:unknown})=>{assert.equal(value.status,"applied",JSON.stringify(value));return value;};

test("declared finite Run study copies exact formal refs, dispatches once and revocation blocks fresh trace",async t=>{
  await migrate(url!,schema);
  t.after(async()=>{await pool.end();const admin=new pg.Client({connectionString:url});await admin.connect();try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const goalId=randomUUID(),stageId=randomUUID(),businessTaskId=randomUUID(),sourceTaskId=randomUUID(),loopId=randomUUID();
  applied(await business({type:"project.create",title:"Study"}));
  applied(await business({type:"goal.create",goalId,outcome:"Trace-informed choice",constraints:"Bounded",consumer:"owner",authority:"reviewer",scope:"trial",owner:controllerId}));
  applied(await business({type:"stage.propose",stageId,goalId,deliverable:"One study",learningQuestion:"How is work divided?",reason:"Trial"}));
  applied(await business({type:"stage.accept",stageId,expectedVersion:1,reason:"Study"}));
  applied(await business({type:"task.create",taskId:businessTaskId,stageId,title:"Actual work",content:"Actual work",acceptance:"Done",owner:sourceRole,consumer:"owner",evidence:"Trace",stopCondition:"One run"}));
  applied(await business({type:"task.start",taskId:businessTaskId,expectedVersion:1,reason:"Start"}));
  const source=(await workflow.getTask(controller,projectId,businessTaskId));
  const sourceSessionId=randomUUID(),sourceRunId=randomUUID(),inputHash=hash("source input");
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/fixture','source-scope','read-only','on-request','ready',1,$4,$5,$6,$7,now(),now())`,
    [projectId,sourceSessionId,sourceRole,randomUUID(),randomUUID(),randomUUID(),controllerId]);
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
    input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'source input',$8,'completed',1,$9,$10,now(),now())`,
    [projectId,sourceRunId,businessTaskId,source.task.currentRevisionId,source.basis!.id,sourceSessionId,randomUUID(),inputHash,randomUUID(),controllerId]);
  const businessDelivery=applied(await business({type:"delivery.record",taskId:businessTaskId,
    runId:sourceRunId,expectedVersion:source.task.version,artifactRef:"artifact:actual-work",
    artifactRevision:"v1",contentHash:hash("actual result"),technicalResult:"passed",
    technicalEvidence:"Result checked",reason:"Business delivered"}));
  applied(await business({type:"task.close",taskId:businessTaskId,expectedVersion:businessDelivery.version,
    deliveryId:businessDelivery.revisionId,acceptanceResult:"met",acceptanceEvidence:"Result inspected",
    reason:"Business accepted"}));
  assert.equal((await workflow.getTask(controller,projectId,businessTaskId)).task.state,"done");
  applied(await business({type:"task.create",taskId:sourceTaskId,stageId,title:"Source carrier",content:"Finite source",acceptance:"Choose",owner:role,kind:"research",consumer:role,evidence:"Run",stopCondition:"One comparison"}));
  const sourceCarrier=await workflow.getTask(controller,projectId,sourceTaskId),sourceDecisionId=randomUUID(),sourceSlotId=randomUUID();
  const sourceRef=await decideTaskExternalReference(referenceDeps as never,reviewer,{projectId,operationId:randomUUID(),actorId:reviewerId,
    decisionId:sourceDecisionId,taskId:sourceTaskId,taskRevisionId:sourceCarrier.task.currentRevisionId,
    expectedTaskVersion:1,slotId:sourceSlotId,expectedHeadVersion:0,decision:"adopt",kind:"run",
    referenceId:sourceRunId,revision:source.task.currentRevisionId,contentHash:inputHash,
    reason:"Review actual work",actionImpact:"Compare burden"});applied(sourceRef);
  const fixedSourceRevision=sourceRef.status==="applied"?sourceRef.revisionId!:"";
  const sourceStarted=applied(await business({type:"task.start",taskId:sourceTaskId,expectedVersion:2,
    reason:"Seal the source carrier"}));
  const sourceDelivered=applied(await business({type:"delivery.record",taskId:sourceTaskId,
    expectedVersion:sourceStarted.version,artifactRef:"artifact:source-study",artifactRevision:"v1",
    contentHash:hash("accepted source"),technicalResult:"passed",technicalEvidence:"Source checked",
    reason:"Carrier delivered"}));
  applied(await business({type:"task.close",taskId:sourceTaskId,expectedVersion:sourceDelivered.version,
    deliveryId:sourceDelivered.revisionId,acceptanceResult:"met",acceptanceEvidence:"Source inspected",
    reason:"Carrier accepted"}));
  assert.equal((await workflow.getTask(controller,projectId,sourceTaskId)).task.state,"done");
  const enrolled=await command(reviewer,{type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:role,
    allowedBusinessRoleIds:[sourceRole],sourceAfter:{createdAtUtc:"2020-01-01T00:00:00.000Z",eventId:null},
    maxRuns:2,maxConcurrent:1,reason:"Bounded study"});
  const firstLoop=(await orchestration.getLoop(controller,projectId,loopId))!;
  const declarationId=randomUUID();
  const declare=(overrides:Record<string,unknown>={})=>command(reviewer,{type:"loop.studyMaterial.declare",loopId,
    expectedLoopVersion:firstLoop.version,declarationId,controllerActorId:controllerId,sourceTaskId,
    sourceTaskRevisionId:fixedSourceRevision,sourceDecisionIds:[sourceDecisionId],reason:"Study",...overrides});
  await assert.rejects(command(principal("writer",["read","write"]),{type:"loop.studyMaterial.declare",loopId,
    expectedLoopVersion:firstLoop.version,declarationId,controllerActorId:controllerId,sourceTaskId,
    sourceTaskRevisionId:fixedSourceRevision,sourceDecisionIds:[sourceDecisionId],reason:"Study"}),
    (error:unknown)=>error instanceof OrchestrationError&&error.code==="FORBIDDEN");
  await assert.rejects(orchestration.execute({actorId:"foreign-reviewer",projectIds:[randomUUID()],
    permissions:["read","write","review"]},{type:"loop.studyMaterial.declare",projectId,
    operationId:randomUUID(),loopId,expectedLoopVersion:firstLoop.version,declarationId,
    controllerActorId:controllerId,sourceTaskId,sourceTaskRevisionId:fixedSourceRevision,
    sourceDecisionIds:[sourceDecisionId],reason:"Foreign project"}),
    (error:unknown)=>error instanceof OrchestrationError&&error.code==="FORBIDDEN");
  for(const [change,code] of [
    [{controllerActorId:"other-controller"},"STUDY_DECLARATION_DENIED"],
    [{sourceDecisionIds:[randomUUID()]},"STUDY_SOURCE_UNAVAILABLE"],
    [{sourceTaskRevisionId:sourceCarrier.task.currentRevisionId},"STUDY_SOURCE_UNAVAILABLE"],
    [{sourceTaskId:businessTaskId},"STUDY_SOURCE_UNAVAILABLE"],
  ] as const)await assert.rejects(declare(change),
    (error:unknown)=>error instanceof OrchestrationError&&error.code===code);
  sourceGrant=false;
  await assert.rejects(declare(),(error:unknown)=>error instanceof OrchestrationError&&error.code==="STUDY_SOURCE_UNAVAILABLE");
  sourceGrant=true;
  const declared=await declare();
  assert.equal(declared.entityId,declarationId);
  const declaration=(await orchestration.getStudyDeclaration(controller,projectId,declarationId))!;
  assert.deepEqual(declaration.items.map(item=>item.runId),[sourceRunId]);
  const accepted=await command(controller,{type:"inbox.accept",loopId,sourceEventId:firstLoop.bootstrapEventId,
    recipientRoleId:role,purpose:"cognitive_review"});
  await command(controller,{type:"inbox.ack",inboxId:accepted.entityId,expectedVersion:1,reason:"Ready"});
  const taskId=loopIntentId(loopId,accepted.entityId,"cognition-task"),createId=loopIntentId(taskId,"create");
  applied(await workflow.execute(controller,{type:"task.create",projectId,operationId:createId,taskId,stageId,
    title:"Cognition: enrolled loop",owner:role,kind:"research",content:"Study actual work",acceptance:"Choose next action",
    consumer:role,useRequired:false,evidence:"Bootstrap",stopCondition:"Decision"}));
  const before=await workflow.getTask(controller,projectId,taskId);
  const provenance={declarationId,loopId,inboxId:accepted.entityId,sourceDecisionId};
  const prefix=[declarationId,accepted.entityId,sourceDecisionId];
  const copy={projectId,operationId:loopIntentId(...prefix,"reference"),actorId:controllerId,
    decisionId:loopIntentId(...prefix,"decision"),taskId,taskRevisionId:before.task.currentRevisionId,
    expectedTaskVersion:before.task.version,slotId:loopIntentId(...prefix,"slot"),expectedHeadVersion:0,
    decision:"adopt",kind:"run",referenceId:sourceRunId,revision:source.task.currentRevisionId,
    contentHash:inputHash,reason:`Declared trace study ${declarationId}`,
    actionImpact:"Review the fixed Run trace to compare actual work and choose a bounded next action."};
  const copied=await applyDeclaredStudyReference(referenceDeps as never,controller,copy,provenance);applied(copied);
  for(const change of [{taskId:randomUUID()},{referenceId:randomUUID()},
    {revision:randomUUID()},{contentHash:hash("wrong input")}])
    await assert.rejects(applyDeclaredStudyReference(referenceDeps as never,controller,
      {...copy,...change},provenance));
  assert.equal(await uow.transaction(projectId,tx=>tx.resolveStudyReferenceAuthority(
    provenance,randomUUID(),controllerId)),null,"arbitrary receiver has no copy authority");
  assert.equal(await uow.transaction(projectId,tx=>tx.resolveStudyReferenceAuthority(
    {...provenance,sourceDecisionId:randomUUID()},taskId,controllerId)),null,"undeclared source has no copy authority");
  await assert.rejects(applyDeclaredStudyReference(referenceDeps as never,controller,
    {...copy,slotId:randomUUID(),taskRevisionId:copied.revisionId,expectedTaskVersion:copied.version},provenance));
  await assert.rejects(applyDeclaredStudyReference(referenceDeps as never,controller,
    {...copy,decision:"replace",expectedHeadVersion:1,taskRevisionId:copied.revisionId,
      expectedTaskVersion:copied.version},provenance));
  const after=await workflow.getTask(controller,projectId,taskId);
  assert.equal(after.task.version,2);
  const snapshot=await uow.read(projectId,reader=>reader.listTaskExternalSnapshot(taskId,after.task.currentRevisionId));
  assert.equal(snapshot.length,1);assert.deepEqual(snapshot[0]!.studyProvenance,provenance);
  assert.deepEqual(await applyDeclaredStudyReference(referenceDeps as never,controller,copy,provenance),copied);
  await assert.rejects(command(controller,{type:"dispatch.request",inboxId:accepted.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId,expectedTaskVersion:1,recipientRoleId:role,
    purpose:"cognition",authorizationScopeId:"cognitive-scope",reason:"stale"}),
    (error:unknown)=>error instanceof OrchestrationError&&error.code==="TASK_CHANGED");
  sourceGrant=false;
  await assert.rejects(command(controller,{type:"dispatch.request",inboxId:accepted.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId,
    expectedTaskVersion:2,recipientRoleId:role,purpose:"cognition",
    authorizationScopeId:"cognitive-scope",reason:"revoked source grant"}),
    (error:unknown)=>error instanceof OrchestrationError&&error.code==="STUDY_SOURCE_UNAVAILABLE");
  sourceGrant=true;
  const dispatched=await command(controller,{type:"dispatch.request",inboxId:accepted.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId,expectedTaskVersion:2,recipientRoleId:role,
    purpose:"cognition",authorizationScopeId:"cognitive-scope",reason:"Study"});
  assert.equal(dispatched.entityType,"dispatch");
  applied(await business({type:"task.start",taskId,expectedVersion:2,reason:"Seal study input"}));
  const runningTask=await workflow.getTask(controller,projectId,taskId);
  const readerSessionId=randomUUID(),readerRunId=randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/fixture','cognitive-scope','read-only','on-request','ready',1,$4,$5,$6,$7,now(),now())`,
    [projectId,readerSessionId,role,randomUUID(),randomUUID(),randomUUID(),controllerId]);
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
    input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'study input',$8,'running',1,$9,$10,now(),now())`,
    [projectId,readerRunId,taskId,runningTask.task.currentRevisionId,runningTask.basis!.id,
      readerSessionId,randomUUID(),hash("study input"),randomUUID(),controllerId]);
  const dispatch=(await store.read(projectId,reader=>reader.getDispatch(dispatched.entityId)))!;
  await store.transaction(projectId,tx=>tx.updateDispatch({...dispatch,version:dispatch.version+1,
    state:"accepted",runtimeRunId:readerRunId},dispatch.version));
  const facts=workerGuardFacts(pool,{principal:principal("worker-study",["read"]),scope:{projectId,
    loopId,taskId,runId:readerRunId,sessionId:readerSessionId,roleId:role,kind:"cognition",
    allowedRoleIds:[role]}},currentReviewer);
  assert.equal(await facts.fixedRunTrace!(sourceRunId),true);
  const credentialRoot=await mkdtemp(join(tmpdir(),"evoloop-trace-study-worker-"));
  const broker=new WorkerCredentialBroker({workerRoot:credentialRoot,apiUrl:"http://127.0.0.1:1",
    cliMain:"/fixture/cli.js",nodeExecutable:process.execPath,ttlMs:60_000});
  await broker.issue({projectId,loopId,taskId,runId:readerRunId,sessionId:readerSessionId,
    roleId:role,kind:"cognition",allowedRoleIds:[role]});
  const token=await readFile(join(credentialRoot,readerRunId,"credential"),"utf8");
  const app=await buildServer({service:workflow,credentials:[{token:"o".repeat(40),actorId:controllerId,
    projectIds:[projectId],permissions:["read","write","review"]}],
    workers:{authenticate:header=>broker.authenticate(header),facts:identity=>workerGuardFacts(pool,identity,currentReviewer)},
    runtime:{status:()=>({available:true,error:null}),trace:async (_principal:unknown,_project:string,target:string)=>({runId:target,source:"fixture-owned-trace"})} as never});
  t.after(async()=>{await app.close();await rm(credentialRoot,{recursive:true,force:true});});
  const traceUrl=`/api/projects/${projectId}/runtime/runs/${sourceRunId}/trace`;
  const readTrace=()=>app.inject({method:"GET",url:traceUrl,headers:{authorization:`Bearer ${token}`}});
  assert.equal((await readTrace()).statusCode,200);
  const originalReviewer={...reviewerCredentials[0]!,permissions:[...reviewerCredentials[0]!.permissions]};
  for(const withdrawn of [["read","write"],["write","review"],[]] as const){
    if(withdrawn.length)reviewerCredentials[0]!.permissions=[...withdrawn];
    else reviewerCredentials.splice(0,1);
    assert.equal(await currentReviewer(projectId,controllerId),true,
      "another same-project owner stays credentialed but cannot inherit the declaring actor's authority");
    assert.equal(await facts.fixedRunTrace!(sourceRunId),false,
      "current declaring reviewer authority is needed for new trace reads");
    assert.equal((await readTrace()).statusCode,403);
    reviewerCredentials.splice(0,reviewerCredentials.length,{...originalReviewer,
      permissions:[...originalReviewer.permissions]},controllerCredential);
    assert.equal((await readTrace()).statusCode,200);
  }
  const sourceNow=await workflow.getTask(controller,projectId,sourceTaskId);
  assert.equal(sourceNow.task.state,"done");
  applied(await business({type:"task.reopen",taskId:sourceTaskId,expectedVersion:sourceNow.task.version,
    reason:"Later source review"}));
  const sourceReopened=await workflow.getTask(controller,projectId,sourceTaskId);
  const replaced=await decideTaskExternalReference(referenceDeps as never,reviewer,{projectId,
    operationId:randomUUID(),actorId:reviewerId,decisionId:randomUUID(),taskId:sourceTaskId,
    taskRevisionId:sourceReopened.task.currentRevisionId,expectedTaskVersion:sourceReopened.task.version,
    slotId:sourceSlotId,expectedHeadVersion:1,decision:"replace",kind:"run",referenceId:sourceRunId,
    revision:source.task.currentRevisionId,contentHash:inputHash,reason:"Refresh current source head",
    actionImpact:"Current head is a new decision"});applied(replaced);
  assert.equal((await orchestration.getLoop(controller,projectId,loopId))!.currentStudyDeclarationId,declarationId);
  assert.equal((await readTrace()).statusCode,403,"replaced source decision cannot grant new trace reading");
  const loopAfter=(await orchestration.getLoop(controller,projectId,loopId))!;
  await command(reviewer,{type:"loop.studyMaterial.revoke",loopId,expectedLoopVersion:loopAfter.version,
    declarationId,reason:"Withdraw future trace reading"});
  assert.equal((await orchestration.getLoop(controller,projectId,loopId))!.currentStudyDeclarationId,null);
  assert.equal(await facts.fixedRunTrace!(sourceRunId),false);
  assert.equal((await readTrace()).statusCode,403);

  const secondLoopId=randomUUID(),secondDeclarationId=randomUUID();
  await command(reviewer,{type:"loop.enroll",loopId:secondLoopId,goalId,stageId,cognitiveRoleId:role,
    allowedBusinessRoleIds:[sourceRole],sourceAfter:{createdAtUtc:"2020-01-01T00:00:00.000Z",eventId:null},
    maxRuns:1,maxConcurrent:1,reason:"Revocation race"});
  const secondLoop=(await orchestration.getLoop(controller,projectId,secondLoopId))!;
  await command(reviewer,{type:"loop.studyMaterial.declare",loopId:secondLoopId,
    expectedLoopVersion:secondLoop.version,declarationId:secondDeclarationId,
    controllerActorId:controllerId,sourceTaskId,sourceTaskRevisionId:replaced.revisionId,
    sourceDecisionIds:[replaced.decisionId],reason:"Current replacement"});
  const secondAccepted=await command(controller,{type:"inbox.accept",loopId:secondLoopId,
    sourceEventId:secondLoop.bootstrapEventId,recipientRoleId:role,purpose:"cognitive_review"});
  await command(controller,{type:"inbox.ack",inboxId:secondAccepted.entityId,expectedVersion:1,reason:"Ready"});
  const secondTaskId=loopIntentId(secondLoopId,secondAccepted.entityId,"cognition-task");
  applied(await workflow.execute(controller,{type:"task.create",projectId,
    operationId:loopIntentId(secondTaskId,"create"),taskId:secondTaskId,stageId,
    title:"Second cognition",owner:role,kind:"research",content:"Review",acceptance:"Choose",
    consumer:role,useRequired:false,evidence:"Current source",stopCondition:"Decision"}));
  const secondBefore=await workflow.getTask(controller,projectId,secondTaskId);
  const secondPrefix=[secondDeclarationId,secondAccepted.entityId,replaced.decisionId];
  applied(await applyDeclaredStudyReference(referenceDeps as never,controller,{projectId,
    operationId:loopIntentId(...secondPrefix,"reference"),actorId:controllerId,
    decisionId:loopIntentId(...secondPrefix,"decision"),taskId:secondTaskId,
    taskRevisionId:secondBefore.task.currentRevisionId,expectedTaskVersion:1,
    slotId:loopIntentId(...secondPrefix,"slot"),expectedHeadVersion:0,decision:"adopt",
    kind:"run",referenceId:sourceRunId,revision:source.task.currentRevisionId,
    contentHash:inputHash,reason:"Declared",actionImpact:"Compare"},{
      declarationId:secondDeclarationId,loopId:secondLoopId,inboxId:secondAccepted.entityId,
      sourceDecisionId:replaced.decisionId}));
  for(const withdrawn of [["read","write"],["write","review"],[]] as const){
    if(withdrawn.length)reviewerCredentials[0]!.permissions=[...withdrawn];
    else reviewerCredentials.splice(0,1);
    await assert.rejects(command(controller,{type:"dispatch.request",inboxId:secondAccepted.entityId,
      expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId:secondTaskId,
      expectedTaskVersion:2,recipientRoleId:role,purpose:"cognition",
      authorizationScopeId:"cognitive-scope",reason:"Declaring reviewer withdrawn"}),
      (error:unknown)=>error instanceof OrchestrationError&&error.code==="STUDY_AUTHORITY_DENIED");
    reviewerCredentials.splice(0,reviewerCredentials.length,{...originalReviewer,
      permissions:[...originalReviewer.permissions]},controllerCredential);
  }
  const secondCurrent=(await orchestration.getLoop(controller,projectId,secondLoopId))!;
  await command(reviewer,{type:"loop.studyMaterial.revoke",loopId:secondLoopId,
    expectedLoopVersion:secondCurrent.version,declarationId:secondDeclarationId,
    reason:"Revoke after copy before dispatch"});
  await assert.rejects(command(controller,{type:"dispatch.request",inboxId:secondAccepted.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:null,taskId:secondTaskId,
    expectedTaskVersion:2,recipientRoleId:role,purpose:"cognition",
    authorizationScopeId:"cognitive-scope",reason:"Should not start"}),
    (error:unknown)=>error instanceof OrchestrationError&&error.code==="STUDY_DECLARATION_CHANGED");
  const secondDispatches=await orchestration.listDispatches(controller,projectId,secondLoopId,10);
  assert.equal(secondDispatches.items.length,0,"revocation after copy cannot start a Run");

  for(const withdrawn of [["read","write"],["write","review"],[]] as const){
    const copyLoopId=randomUUID(),copyDeclarationId=randomUUID();
    await command(reviewer,{type:"loop.enroll",loopId:copyLoopId,goalId,stageId,cognitiveRoleId:role,
      allowedBusinessRoleIds:[sourceRole],sourceAfter:{createdAtUtc:"2020-01-01T00:00:00.000Z",eventId:null},
      maxRuns:1,maxConcurrent:1,reason:"Reviewer withdrawal during copy"});
    const copyLoop=(await orchestration.getLoop(controller,projectId,copyLoopId))!;
    await command(reviewer,{type:"loop.studyMaterial.declare",loopId:copyLoopId,
      expectedLoopVersion:copyLoop.version,declarationId:copyDeclarationId,
      controllerActorId:controllerId,sourceTaskId,sourceTaskRevisionId:replaced.revisionId,
      sourceDecisionIds:[replaced.decisionId],reason:"Current replacement"});
    const copyInbox=await command(controller,{type:"inbox.accept",loopId:copyLoopId,
      sourceEventId:copyLoop.bootstrapEventId,recipientRoleId:role,purpose:"cognitive_review"});
    await command(controller,{type:"inbox.ack",inboxId:copyInbox.entityId,expectedVersion:1,reason:"Ready"});
    const copyTaskId=loopIntentId(copyLoopId,copyInbox.entityId,"cognition-task");
    applied(await workflow.execute(controller,{type:"task.create",projectId,
      operationId:loopIntentId(copyTaskId,"create"),taskId:copyTaskId,stageId,
      title:"Withdrawal cognition",owner:role,kind:"research",content:"Review",
      acceptance:"Choose",consumer:role,useRequired:false,evidence:"Current source",
      stopCondition:"Decision"}));
    const copyBefore=await workflow.getTask(controller,projectId,copyTaskId);
    const copyPrefix=[copyDeclarationId,copyInbox.entityId,replaced.decisionId];
    const copyCommand={projectId,operationId:loopIntentId(...copyPrefix,"reference"),
      actorId:controllerId,decisionId:loopIntentId(...copyPrefix,"decision"),taskId:copyTaskId,
      taskRevisionId:copyBefore.task.currentRevisionId,expectedTaskVersion:1,
      slotId:loopIntentId(...copyPrefix,"slot"),expectedHeadVersion:0,decision:"adopt",
      kind:"run",referenceId:sourceRunId,revision:source.task.currentRevisionId,
      contentHash:inputHash,reason:"Declared",actionImpact:"Compare"};
    const copyProvenance={declarationId:copyDeclarationId,loopId:copyLoopId,
      inboxId:copyInbox.entityId,sourceDecisionId:replaced.decisionId};
    if(withdrawn.length)reviewerCredentials[0]!.permissions=[...withdrawn];
    else reviewerCredentials.splice(0,1);
    const denied=await applyDeclaredStudyReference(referenceDeps as never,controller,
      copyCommand,copyProvenance);
    assert.equal(denied.status,"rejected");
    assert.equal(denied.code,"STUDY_AUTHORITY_DENIED");
    assert.equal((await workflow.getTask(controller,projectId,copyTaskId)).task.version,1);
    reviewerCredentials.splice(0,reviewerCredentials.length,{...originalReviewer,
      permissions:[...originalReviewer.permissions]},controllerCredential);
    assert.deepEqual(await applyDeclaredStudyReference(referenceDeps as never,controller,
      copyCommand,copyProvenance),denied,"historical rejected receipt cannot write after rights change");
    assert.equal((await workflow.getTask(controller,projectId,copyTaskId)).task.version,1);
  }
});
