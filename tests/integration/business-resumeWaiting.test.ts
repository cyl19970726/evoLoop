import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";
import { WorkflowService, RuntimeWorkflowService } from "@evoloop/core";
import { OrchestrationService, OrchestrationError } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import { authorizeWorkerRequest } from "../../apps/coordinator/src/workers/guard.js";
import { workerGuardFacts } from "../../apps/coordinator/src/workers/facts.js";
import type { WorkerIdentity } from "../../apps/coordinator/src/workers/types.js";


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
if(!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname))
  throw new Error("dedicated evoloop_*_test database required");
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");

test("PG business waiting resumes from a signed outcome and fixed repaired basis while paused",async t=>{
  const schema=`el_business_resume_${randomUUID().replaceAll("-","").slice(0,16)}`;
  await migrate(url!,schema);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  t.after(async()=>{await pool.end();const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const projectId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),loopId=randomUUID();
  const otherGoalId=randomUUID(),otherStageId=randomUUID(),foreignStageId=randomUUID();
  const firstTask=randomUUID(),businessTask=randomUUID(),waitingTask=randomUUID(),newTask=randomUUID();
  const otherStageTask=randomUUID(),foreignTask=randomUUID(),basisDocumentId=randomUUID();
  const owner="business-resume-owner",cognition=fixtureRoleId("business-resume-cognition"),business=fixtureRoleId("business-resume-worker");
  const principal=(actorId:string)=>({actorId,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">});
  const uow=new PostgresUnitOfWork(pool),clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash}});
  const runtime=new RuntimeWorkflowService({uow,clock,ids});
  withPersistedResumeProfile(runtime,uow);
  let businessGrant=true;
  const store=new PgOrchestrationStore(pool,{
    getAuthorizationFact:async(p,scope)=>p===projectId&&["cognitive-scope","business-scope"].includes(scope)?{
      projectId,scopeId:scope,actorId:owner,roleId:scope==="cognitive-scope"?cognition:business,
      active:scope==="cognitive-scope"||businessGrant}:null,
    canActAsRole:async(p,actor,role)=>p===projectId&&actor===owner&&[cognition,business].includes(role),
    wasActorRole:async()=>false,
  });
  const orchestration=new OrchestrationService({store,now:clock.now,nextId:randomUUID,hash});
  const wf=async(command:Record<string,unknown>)=>{
    const result=await workflow.execute(principal(owner),{projectId,operationId:randomUUID(),...command} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result as Extract<typeof result,{status:"applied"}>;
  };
  const issue=(command:Record<string,unknown>,operationId=randomUUID())=>
    orchestration.execute(principal(owner),{projectId,operationId,...command} as never);
  const denied=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,
    error=>error instanceof OrchestrationError&&error.code===code);
  await wf({type:"project.create",title:"Business waiting recovery"});
  for (const roleId of [cognition,business]) await seedFixtureRole(pool,projectId,roleId);
  await wf({type:"goal.create",goalId,outcome:"One corrected report",constraints:"Fixed source",consumer:owner,authority:owner,scope:"test",owner});
  await wf({type:"goal.create",goalId:otherGoalId,outcome:"Other work",constraints:"Separate scope",consumer:owner,authority:owner,scope:"test",owner});
  for(const [id,goal] of [[stageId,goalId],[otherStageId,goalId],[foreignStageId,otherGoalId]]){
    await wf({type:"stage.propose",stageId:id,goalId:goal,deliverable:"Correct report",learningQuestion:"What changed?",reason:"Test"});
    await wf({type:"stage.accept",stageId:id,expectedVersion:1,reason:"Active test Stage"});
  }
  for(const [taskId,role] of [[firstTask,cognition],[businessTask,business],[waitingTask,cognition],[newTask,cognition]] as const)
    await wf({type:"task.create",taskId,stageId,title:"Work",content:`# Work ${taskId}`,
      acceptance:"Recorded",owner:role,consumer:owner,evidence:"Test",stopCondition:"One result"});
  for(const [taskId,stage] of [[otherStageTask,otherStageId],[foreignTask,foreignStageId]])
    await wf({type:"task.create",taskId,stageId:stage,title:"Out of scope",content:`# Work ${taskId}`,
      acceptance:"Recorded",owner:business,consumer:owner,evidence:"Test",stopCondition:"One result"});
  await wf({type:"task.start",taskId:firstTask,expectedVersion:1,reason:"Cognition input"});
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await issue({type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:cognition,
    allowedBusinessRoleIds:[business],sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},
    maxRuns:4,maxConcurrent:1,reason:"Bounded test"});
  const bootstrap=(await orchestration.getLoop(principal(owner),projectId,loopId))!.bootstrapEventId;
  const begin=async(sourceEventId:string,taskId:string,role:string,taskVersion:number,
    parentDispatchId:string|null,existingDispatchId?:string)=>{
    let dispatchId=existingDispatchId;
    if(!dispatchId){
      const purpose=role===cognition?"cognitive_review":"next_action";
      const inbox=await issue({type:"inbox.accept",loopId,sourceEventId,recipientRoleId:cognition,purpose});
      await issue({type:"inbox.ack",inboxId:inbox.entityId,expectedVersion:1,reason:"Read source"});
      dispatchId=randomUUID();
      await issue({type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,
        dispatchId,parentDispatchId,taskId,expectedTaskVersion:taskVersion,recipientRoleId:role,
        purpose:role===cognition?"cognition":"business",authorizationScopeId:role===cognition?"cognitive-scope":"business-scope",
        reason:"Bounded dispatch"});
    }
    const token=randomUUID();
    await issue({type:"dispatch.claim",dispatchId,claimToken:token,leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
    await issue({type:"dispatch.start",dispatchId,claimToken:token});
    let inputVersion=taskVersion;
    if(role===business){const started=await wf({type:"task.start",taskId,expectedVersion:taskVersion,reason:"Business Run input"});
      inputVersion=started.version;}
    const sessionId=randomUUID(),runId=randomUUID();
    await wf({type:"runtime.session.reserve",sessionId,roleId:role,cwd:"/tmp/evoloop-business-resume-test",
      authorizationScope:role===cognition?"cognitive-scope":"business-scope",model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
    await runtime.beginSessionCreate(projectId,sessionId);
    await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,roleId:role,
      cwd:"/tmp/evoloop-business-resume-test",authorizationScope:role===cognition?"cognitive-scope":"business-scope",
      nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
    await wf({type:"runtime.run.reserve",runId,taskId,sessionId,expectedVersion:inputVersion,input:"Fixed test input"});
    await issue({type:"dispatch.resolve",dispatchId,claimToken:token,result:"accepted",runtimeRunId:runId,reason:"Bound test Run"});
    return {dispatchId,runId,sessionId};
  };
  const settle=async(value:{dispatchId:string;runId:string},kind:"waiting"|"failed")=>{
    const decisionId=randomUUID(),reason=kind==="waiting"?"Wait for corrected business work":"Business report needs correction";
    await issue({type:"worker.decision",decisionId,dispatchId:value.dispatchId,runId:value.runId,kind,reason,evidenceRefs:[]});
    await runtime.rejectDispatch(projectId,value.runId,"Test terminal Run with signed decision");
    await issue({type:"worker.outcome",dispatchId:value.dispatchId,outcome:kind,deliveryId:null,decisionId,evidenceRef:null,reason});
    return decisionId;
  };
  const parent=await begin(bootstrap,firstTask,cognition,2,null);
  const childInbox=await issue({type:"inbox.accept",loopId,sourceEventId:bootstrap,
    recipientRoleId:cognition,purpose:"next_action"});
  await issue({type:"inbox.ack",inboxId:childInbox.entityId,expectedVersion:1,reason:"Read original source"});
  const childDispatchId=randomUUID();
  await issue({type:"dispatch.request",inboxId:childInbox.entityId,expectedInboxVersion:2,
    dispatchId:childDispatchId,parentDispatchId:parent.dispatchId,taskId:businessTask,expectedTaskVersion:1,
    recipientRoleId:business,purpose:"business",authorizationScopeId:"business-scope",reason:"Bounded child"});
  await settle(parent,"waiting");
  const child=await begin(bootstrap,businessTask,business,1,parent.dispatchId,childDispatchId);
  await settle(child,"failed");
  const source=(await orchestration.listSourceFacts(principal(owner),projectId,loopId)).items.find(x=>x.kind==="worker.outcome"&&x.originDispatchId===child.dispatchId)!;
  assert.ok(source);
  await wf({type:"task.start",taskId:waitingTask,expectedVersion:1,reason:"Feedback input"});
  const waiting=await begin(source.id,waitingTask,cognition,2,null);
  const waitingDecisionId=await settle(waiting,"waiting");
  const oldBusiness=(await workflow.getTask(principal(owner),projectId,businessTask)).task.version;
  const reopened=await wf({type:"task.reopen",taskId:businessTask,expectedVersion:oldBusiness,reason:"Correct report basis"});
  const basisDocument=await wf({type:"document.create",documentId:basisDocumentId,kind:"report",
    title:"Selected supporting report",body:"# Fixed supporting original"});
  await wf({type:"document.publish",documentId:basisDocumentId,expectedVersion:1,
    revisionId:basisDocument.revisionId,reason:"Review supporting input"});
  const current=await workflow.getTask(principal(owner),projectId,businessTask);
  const repaired=await wf({type:"task.update",taskId:businessTask,expectedVersion:reopened.version,
    title:current.task.title,content:"# Corrected report with exact fixed input",acceptance:current.task.acceptance,
    owner:business,documentIds:[basisDocumentId],basis:[{documentId:basisDocumentId,revisionId:basisDocument.revisionId}],
    reason:"Seal corrected Task basis"});
  const revised=await workflow.getTask(principal(owner),projectId,businessTask);
  const basisSetId=revised.basis!.id;
  const basisPath=`/api/projects/${projectId}/documents/${basisDocumentId}/revisions/${basisDocument.revisionId}/original`;
  const laterBasis=await wf({type:"document.revise",documentId:basisDocumentId,expectedVersion:2,
    body:"# Unselected later supporting report",reason:"Keep a later revision outside fixed basis"});
  const laterBasisPath=`/api/projects/${projectId}/documents/${basisDocumentId}/revisions/${laterBasis.revisionId}/original`;
  const stageTask=(await workflow.getTask(principal(owner),projectId,otherStageTask)).task;
  const foreign=(await workflow.getTask(principal(owner),projectId,foreignTask)).task;
  const outOfScopePaths=[stageTask,foreign].map(task=>`/api/projects/${projectId}/documents/${task.contentDocumentId}/revisions/${task.contentRevisionId}/original`);
  const waitingWorker:WorkerIdentity={principal:{actorId:`worker-${randomUUID()}`,projectIds:[projectId],
    permissions:["read","write","review"]},scope:{projectId,loopId,taskId:waitingTask,runId:waiting.runId,
      sessionId:waiting.sessionId,roleId:cognition,kind:"cognition",allowedRoleIds:[cognition,business]}};
  const assertCognitionReads=async(identity:WorkerIdentity)=>{
    const access=workerGuardFacts(pool,identity);
    assert.equal(await authorizeWorkerRequest(identity,{method:"GET",path:basisPath},access),true);
    assert.equal(await authorizeWorkerRequest(identity,{method:"GET",path:laterBasisPath},access),false);
    for(const path of outOfScopePaths)
      assert.equal(await authorizeWorkerRequest(identity,{method:"GET",path},access),false);
  };
  await assertCognitionReads(waitingWorker);
  const loop=(await orchestration.getLoop(principal(owner),projectId,loopId))!;
  await issue({type:"loop.state",loopId,expectedVersion:loop.version,state:"paused",reason:"Owner review before retry"});
  let before=(await orchestration.getLoop(principal(owner),projectId,loopId))!;
  const budget={type:"loop.extendBudget",loopId,expectedLoopVersion:before.version,
    expectedMaxRuns:before.maxRuns,maxRuns:before.maxRuns+1,evidenceRef:"owner:bounded-retry",
    reason:"One additional reviewed Run"};
  const budgetOps=[randomUUID(),randomUUID()];
  const budgetResults=await Promise.allSettled(budgetOps.map(id=>issue(budget,id)));
  assert.equal(budgetResults.filter(value=>value.status==="fulfilled").length,1);
  const winningBudgetOp=budgetOps[budgetResults.findIndex(value=>value.status==="fulfilled")]!;
  assert.equal((await issue(budget,winningBudgetOp)).replayed,true);
  const increased=(await orchestration.getLoop(principal(owner),projectId,loopId))!;
  assert.equal(increased.maxRuns,before.maxRuns+1);
  assert.equal(increased.dispatchCount,before.dispatchCount);
  assert.equal(increased.currentPolicyRevisionId,before.currentPolicyRevisionId);
  assert.equal(increased.state,"paused");
  assert.equal((await orchestration.listEvents(principal(owner),projectId,loopId)).items.filter(x=>x.kind==="loop.budgetExtended").length,1);
  before=increased;
  const command={type:"loop.resumeWaiting",loopId,expectedLoopVersion:before.version,
    decisionId:waitingDecisionId,dispatchId:waiting.dispatchId,
    businessRecovery:{expectedTaskVersion:repaired.version,basisSetId},
    evidenceRef:"review:repaired-basis",reason:"Retry after reviewed Task basis correction"};
  await denied(issue({...command,businessRecovery:{...command.businessRecovery,basisSetId:randomUUID()}}),"TASK_CHANGED");
  const operationId=randomUUID();
  assert.equal((await issue(command,operationId)).entityType,"loop");
  assert.equal((await issue(command,operationId)).replayed,true);
  const after=(await orchestration.getLoop(principal(owner),projectId,loopId))!;
  await denied(issue({...command,expectedLoopVersion:after.version}),"ALREADY_RESUMED");
  assert.equal(after.state,"paused");assert.equal(after.dispatchCount,before.dispatchCount);
  const event=(await orchestration.listEvents(principal(owner),projectId,loopId)).items.find(x=>x.kind==="waiting.resumed")!;
  const fixed=(await store.read(projectId,reader=>reader.getSourceFact(event.id)))!;
  assert.equal(fixed.businessRecovery?.sourceEventId,source.id);
  assert.equal(fixed.businessRecovery?.basisSetId,basisSetId);
  assert.equal(fixed.subjectId,businessTask);
  const forgedId=randomUUID();
  await pool.query(`INSERT INTO orchestration_event(project_id,event_id,loop_id,entity_type,entity_id,operation_id,kind,actor_id,detail,created_at_utc)
    VALUES($1,$2,$3,'decision',$4,$5,'waiting.resumed',$6,$7::jsonb,now())`,
    [projectId,forgedId,loopId,waitingDecisionId,winningBudgetOp,owner,JSON.stringify(event.detail)]);
  assert.equal(await store.read(projectId,reader=>reader.getSourceFact(forgedId)),null);
  assert.equal((await store.read(projectId,reader=>reader.getSourceFact(event.id)))?.kind,"waiting.resumed");
  const outcomeEvent=(await orchestration.listEvents(principal(owner),projectId,loopId)).items.find(x=>x.id===source.id)!;
  const forgedOutcomeId=randomUUID();
  await pool.query(`INSERT INTO orchestration_event(project_id,event_id,loop_id,entity_type,entity_id,operation_id,kind,actor_id,detail,created_at_utc)
    VALUES($1,$2,$3,'dispatch',$4,$5,'worker.outcome',$6,$7::jsonb,now())`,
    [projectId,forgedOutcomeId,loopId,child.dispatchId,winningBudgetOp,owner,JSON.stringify(outcomeEvent.detail)]);
  assert.equal(await store.transaction(projectId,tx=>tx.getVerifiedBusinessOutcome(forgedOutcomeId)),null);
  assert.equal((await store.transaction(projectId,tx=>tx.getVerifiedBusinessOutcome(source.id)))?.dispatchId,child.dispatchId);
  await denied(issue({type:"inbox.accept",loopId,sourceEventId:event.id,recipientRoleId:cognition,purpose:"cognitive_review"}),"LOOP_PAUSED");
  businessGrant=false;
  await issue({type:"loop.state",loopId,expectedVersion:after.version,state:"active",reason:"Test resumed admission"});
  await denied(issue({type:"inbox.accept",loopId,sourceEventId:event.id,recipientRoleId:cognition,purpose:"cognitive_review"}),"SCOPE_NOT_AUTHORIZED");
  businessGrant=true;
  const accepted=await issue({type:"inbox.accept",loopId,sourceEventId:event.id,recipientRoleId:cognition,purpose:"cognitive_review"});
  assert.equal(accepted.entityType,"inbox");
  await issue({type:"inbox.ack",inboxId:accepted.entityId,expectedVersion:1,reason:"Read repaired source"});
  await wf({type:"task.start",taskId:newTask,expectedVersion:1,reason:"New review input"});
  const newDispatch=await issue({type:"dispatch.request",inboxId:accepted.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:newTask,expectedTaskVersion:2,
    recipientRoleId:cognition,purpose:"cognition",authorizationScopeId:"cognitive-scope",reason:"New cognition review"});
  assert.equal(newDispatch.entityType,"dispatch");
  const claimToken=randomUUID(),newRunId=randomUUID(),newSessionId=randomUUID();
  await issue({type:"dispatch.claim",dispatchId:newDispatch.entityId,claimToken,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue({type:"dispatch.start",dispatchId:newDispatch.entityId,claimToken});
  await wf({type:"runtime.session.reserve",sessionId:newSessionId,roleId:cognition,
    cwd:"/tmp/evoloop-business-resume-test",authorizationScope:"cognitive-scope",model:"fixture",
    sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,newSessionId);
  await runtime.bindSession(projectId,newSessionId,{owner:"evoloop-codex-app-server",projectId,
    sessionId:newSessionId,roleId:cognition,cwd:"/tmp/evoloop-business-resume-test",
    authorizationScope:"cognitive-scope",nativeThreadId:`fixture-${newSessionId}`,
    nativeSessionId:`fixture-${newSessionId}`});
  await wf({type:"runtime.run.reserve",runId:newRunId,taskId:newTask,sessionId:newSessionId,
    expectedVersion:2,input:"Read repaired source through current scoped identity"});
  await issue({type:"dispatch.resolve",dispatchId:newDispatch.entityId,claimToken,
    result:"accepted",runtimeRunId:newRunId,reason:"New Run after waiting"});
  const worker:WorkerIdentity={principal:{actorId:`worker-${randomUUID()}`,projectIds:[projectId],
    permissions:["read","write","review"]},scope:{projectId,loopId,taskId:newTask,runId:newRunId,
      sessionId:newSessionId,roleId:cognition,kind:"cognition",allowedRoleIds:[cognition,business]}};
  const facts=workerGuardFacts(pool,worker);
  assert.equal(await authorizeWorkerRequest(worker,{method:"GET",path:`/api/projects/${projectId}/tasks/${businessTask}`},facts),true);
  const original=`/api/projects/${projectId}/documents/${revised.task.contentDocumentId}/revisions/${revised.task.contentRevisionId}/original`;
  assert.equal(await authorizeWorkerRequest(worker,{method:"GET",path:original},facts),true);
  await assertCognitionReads(worker);
  assert.equal(await authorizeWorkerRequest(worker,{method:"GET",path:original.replace(revised.task.contentRevisionId!,randomUUID())},facts),false);
  assert.equal(await authorizeWorkerRequest(worker,{method:"GET",path:`/api/projects/${projectId}/documents/${revised.task.contentDocumentId}`},facts),false);
  const nextInbox=await issue({type:"inbox.accept",loopId,sourceEventId:event.id,
    recipientRoleId:cognition,purpose:"next_action"});
  await issue({type:"inbox.ack",inboxId:nextInbox.entityId,expectedVersion:1,reason:"Read resumed source"});
  const nextBusinessDispatchId=randomUUID();
  await issue({type:"dispatch.request",inboxId:nextInbox.entityId,expectedInboxVersion:2,
    dispatchId:nextBusinessDispatchId,parentDispatchId:newDispatch.entityId,taskId:businessTask,
    expectedTaskVersion:repaired.version,recipientRoleId:business,purpose:"business",
    authorizationScopeId:"business-scope",reason:"Fixed repaired business Task"});
  await settle({dispatchId:newDispatch.entityId,runId:newRunId},"waiting");
  const nextBusiness=await begin(event.id,businessTask,business,repaired.version,newDispatch.entityId,nextBusinessDispatchId);
  const businessWorker:WorkerIdentity={principal:{actorId:`worker-${randomUUID()}`,projectIds:[projectId],
    permissions:["read","write","review"]},scope:{projectId,loopId,taskId:businessTask,runId:nextBusiness.runId,
      sessionId:nextBusiness.sessionId,roleId:business,kind:"business",allowedRoleIds:[business]}};
  assert.equal(await authorizeWorkerRequest(businessWorker,{method:"GET",path:original},workerGuardFacts(pool,businessWorker)),true);
  assert.equal(await authorizeWorkerRequest(businessWorker,{method:"GET",path:basisPath},workerGuardFacts(pool,businessWorker)),true);
  assert.equal((await store.read(projectId,reader=>reader.getSourceFact(event.id)))?.businessRecovery?.basisSetId,basisSetId);
  assert.ok(repaired.version>oldBusiness);
});
