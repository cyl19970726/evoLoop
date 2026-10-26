import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { WorkflowService, RuntimeWorkflowService } from "@evoloop/core";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import { OrchestrationService } from "@evoloop/core/orchestration";
import { workerGuardFacts } from "../../apps/coordinator/src/workers/facts.js";
import { authorizeWorkerRequest, authorizeWorkerCommand } from "../../apps/coordinator/src/workers/guard.js";
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
if(!url||!/evoloop.*test/.test(new URL(url).pathname))throw new Error("dedicated evoloop test DB required");
const schema=`el_workerfacts_${randomUUID().replaceAll("-","").slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),owner="fact-owner",worker="worker-fact-business",cognitiveActor="worker-fact-cognition";
const businessRole="fact-business",cognitiveRole="fact-cognition";
const principal=(actorId:string)=>({actorId,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">});
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const uow=new PostgresUnitOfWork(pool);
const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
const runtime=new RuntimeWorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
withPersistedResumeProfile(runtime,uow);
const issue=async(command:Record<string,unknown>,actorId=owner)=>{
  const result=await workflow.execute(principal(actorId),{projectId,operationId:randomUUID(),...command} as never);
  assert.equal(result.status,"applied",JSON.stringify(result));
  return result as Extract<typeof result,{status:"applied"}>;
};

test("worker PG facts bind fixed Run sources and current Goal/Stage scope",async t=>{
  await migrate(url!,schema);
  t.after(async()=>{await pool.end();const cleanup=new pg.Client({connectionString:url});await cleanup.connect();try{await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await cleanup.end();}});
  await issue({type:"project.create",title:"Worker fact boundaries"});
  const goalId=randomUUID(),otherGoalId=randomUUID(),stageId=randomUUID(),otherStageId=randomUUID(),foreignStageId=randomUUID();
  for(const id of [goalId,otherGoalId]) await issue({type:"goal.create",goalId:id,outcome:"Bounded fact verification",constraints:"Local",consumer:"owner",authority:"reviewer",scope:"test",owner});
  for(const [id,goal] of [[stageId,goalId],[otherStageId,goalId],[foreignStageId,otherGoalId]]){
    await issue({type:"stage.propose",stageId:id,goalId:goal,deliverable:"One fact",learningQuestion:"Is the boundary correct?",reason:"Test scope"});
    await issue({type:"stage.accept",stageId:id,expectedVersion:1,reason:"Use active stage"});
  }
  const basisId=randomUUID(),otherDocId=randomUUID();
  const basis=await issue({type:"document.create",documentId:basisId,title:"Frozen basis",body:"# Basis A"});
  await issue({type:"document.adopt",documentId:basisId,expectedVersion:1,revisionId:basis.revisionId,reason:"Use fixed source"});
  const otherDoc=await issue({type:"document.create",documentId:otherDocId,title:"Unrelated source",body:"# Other"});
  const taskId=randomUUID(),cognitiveTaskId=randomUUID(),newTaskId=randomUUID(),sameGoalOtherStageTaskId=randomUUID(),foreignGoalTaskId=randomUUID();
  for(const [id,stage,role,docs] of [
    [taskId,stageId,businessRole,[basisId]],[cognitiveTaskId,stageId,cognitiveRole,[]],
    [sameGoalOtherStageTaskId,otherStageId,businessRole,[]],
    [foreignGoalTaskId,foreignStageId,businessRole,[otherDocId]],
  ] as Array<[string,string,string,string[]]>) {
    await issue({type:"task.create",taskId:id,stageId:stage,title:`Task ${id}`,content:`# Work ${id}`,acceptance:"One result",owner:role,documentIds:docs,
      consumer:"owner",evidence:"Pending bounded result",stopCondition:"Stop after one result"});
    await issue({type:"task.start",taskId:id,expectedVersion:1,...(id===taskId?{basis:[{documentId:basisId,revisionId:basis.revisionId}]}:{}),reason:"Freeze Task"});
  }
  const task=(await workflow.getTask(principal(owner),projectId,taskId)).task;
  const foreignTask=(await workflow.getTask(principal(owner),projectId,foreignGoalTaskId)).task;
  const sourceRevisionId=task.currentRevisionId;
  const gitId=randomUUID(),wikiId=randomUUID(),gitDecision=randomUUID(),wikiDecision=randomUUID();
  for(const [kind,referenceId,revisionId,decisionId] of [
    ["git",gitId,"commit-fixed",gitDecision],["wiki",wikiId,"wiki-fixed",wikiDecision],
  ]) {
    const slotId=randomUUID();
    await pool.query(`INSERT INTO task_external_ref_decision(project_id,decision_id,task_id,origin_task_revision_id,slot_id,slot_version,decision,source_kind,reference_id,source_revision,content_hash,observed_current_revision,observed_current_hash,observed_current_validity,reason,action_impact,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,1,'adopt',$6,$7,$8,$9,$8,$9,'valid','Fixed source fixture','Verify worker source', $10,now())`,
      [projectId,decisionId,taskId,sourceRevisionId,slotId,kind,referenceId,revisionId,hash(`${kind}-body`),owner]);
    await pool.query("INSERT INTO task_external_ref_head(project_id,task_id,slot_id,slot_version,decision_id) VALUES($1,$2,$3,1,$4)",
      [projectId,taskId,slotId,decisionId]);
  }
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  const loopId=randomUUID(),store=new PgOrchestrationStore(pool,{
    getAuthorizationFact:async(project,scope)=>project===projectId&&scope==="fact-scope"?
      {projectId,scopeId:scope,actorId:cognitiveActor,roleId:cognitiveRole,active:true}:null,
    canActAsRole:async(project,actorId,role)=>project===projectId&&actorId===cognitiveActor&&role===cognitiveRole,
    wasActorRole:async()=>false,
  });
  const orchestration=new OrchestrationService({store,now:()=>new Date().toISOString(),nextId:randomUUID,hash});
  await orchestration.execute(principal(owner),{type:"loop.enroll",projectId,operationId:randomUUID(),loopId,goalId,stageId,
    cognitiveRoleId:cognitiveRole,allowedBusinessRoleIds:[businessRole],sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},
    maxRuns:2,maxConcurrent:1,reason:"Bounded facts trial"});
  await issue({type:"task.create",taskId:newTaskId,stageId,title:"New cognitive action",content:"# New action",acceptance:"One result",owner:businessRole,
    documentIds:[],consumer:"owner",evidence:"New loop proposal",stopCondition:"One result"},cognitiveActor);
  await issue({type:"task.start",taskId:newTaskId,expectedVersion:1,reason:"Freeze new action"},cognitiveActor);
  const newTask=(await workflow.getTask(principal(owner),projectId,newTaskId)).task;
  const reserve=async(id:string,role:string,actorId:string)=>{
    const sessionId=randomUUID(),runId=randomUUID();
    await issue({type:"runtime.session.reserve",sessionId,roleId:role,cwd:"/tmp/evoloop-worker-facts",authorizationScope:"fact-scope",model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"},actorId);
    await runtime.beginSessionCreate(projectId,sessionId);
    await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,roleId:role,
      cwd:"/tmp/evoloop-worker-facts",authorizationScope:"fact-scope",nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
    const run=await issue({type:"runtime.run.reserve",runId,taskId:id,sessionId,expectedVersion:2,input:"Read bounded facts"},actorId);
    return {sessionId,runId,revisionId:run.revisionId!};
  };
  const businessRun=await reserve(taskId,businessRole,worker);
  const cognitiveRun=await reserve(cognitiveTaskId,cognitiveRole,cognitiveActor);
  const newerBasis=await issue({type:"document.revise",documentId:basisId,expectedVersion:2,body:"# Basis B",reason:"Later unfrozen source"});
  const identity=(kind:"business"|"cognition",actorId:string,id:string,run:{sessionId:string;runId:string},role:string):WorkerIdentity=>({
    principal:principal(actorId),scope:{projectId,loopId,taskId:id,runId:run.runId,sessionId:run.sessionId,roleId:role,kind,allowedRoleIds:[businessRole,cognitiveRole]},
  });
  const business=workerGuardFacts(pool,identity("business",worker,taskId,businessRun,businessRole));
  const cognition=workerGuardFacts(pool,identity("cognition",cognitiveActor,cognitiveTaskId,cognitiveRun,cognitiveRole));
  assert.equal((await business.task(taskId))?.ownerRoleId,businessRole);
  assert.equal(await business.fixedDocument(taskId,task.contentDocumentId,task.contentRevisionId),true);
  assert.equal(await business.fixedDocument(taskId,basisId,basis.revisionId!),true);
  assert.equal(await business.fixedDocument(taskId,basisId,newerBasis.revisionId!),false);
  assert.equal(await business.fixedDocument(taskId,basisId,otherDoc.revisionId!),false);
  assert.equal(await business.fixedReference(taskId,"git",gitId,"commit-fixed"),true);
  assert.equal(await business.fixedReference(taskId,"wiki",wikiId,"wiki-fixed"),true);
  assert.equal(await business.fixedReference(taskId,"git",gitId,"wrong-commit"),false);
  assert.equal(await business.fixedReference(taskId,"wiki",randomUUID()),false);
  assert.equal(await cognition.fixedDocument(newTaskId,newTask.contentDocumentId,newTask.contentRevisionId),true);
  assert.ok(await cognition.task(newTaskId));
  assert.equal((await cognition.document(newTask.contentDocumentId))?.loopId,loopId);
  assert.equal(await cognition.task(sameGoalOtherStageTaskId),null);
  assert.equal(await cognition.task(foreignGoalTaskId),null);
  assert.equal(await cognition.document(foreignTask.contentDocumentId),null);
  assert.equal(await cognition.fixedDocument(foreignGoalTaskId,foreignTask.contentDocumentId,foreignTask.contentRevisionId),false);
  const ownOperation=randomUUID(),otherOperation=randomUUID();
  await workflow.execute(principal(worker),{type:"document.create",projectId,operationId:ownOperation,documentId:randomUUID(),title:"Own report",body:"# Own"});
  await workflow.execute(principal(owner),{type:"document.create",projectId,operationId:otherOperation,documentId:randomUUID(),title:"Owner report",body:"# Owner"});
  assert.equal((await business.operation(ownOperation))?.actorId,worker);
  assert.equal((await business.operation(otherOperation))?.actorId,owner);
  assert.equal(await business.operation(randomUUID()),null);
  const ownReportId=randomUUID(),otherReportId=randomUUID(),ownSpecId=randomUUID();
  const ownReport=await issue({type:"document.create",documentId:ownReportId,kind:"report",title:"Worker report",body:"# Worker report"},worker);
  const revisedReport=await issue({type:"document.revise",documentId:ownReportId,expectedVersion:1,body:"# Owner revision",reason:"Owner follow-up"},owner);
  const otherReport=await issue({type:"document.create",documentId:otherReportId,kind:"report",title:"Owner report",body:"# Owner report"},owner);
  const ownSpec=await issue({type:"document.create",documentId:ownSpecId,kind:"spec",title:"Worker spec",body:"# Worker spec"},worker);
  assert.equal(await business.ownedDocumentRevision(ownReportId,ownReport.revisionId!),true);
  assert.equal(await business.ownedDocumentRevision(ownReportId,revisedReport.revisionId!),false);
  assert.equal(await business.ownedDocumentRevision(otherReportId,otherReport.revisionId!),false);
  assert.equal(await business.ownedDocumentRevision(ownSpecId,ownSpec.revisionId!),false);

  const issueId=randomUUID(),issueOperation=randomUUID();
  const originalIssue=await workflow.execute(principal(worker),{type:"document.create",projectId,operationId:issueOperation,
    documentId:issueId,kind:"issue",title:"Fixed failed preflight",body:"# Initial evidence",origin:{taskId,runId:businessRun.runId}});
  assert.equal(originalIssue.status,"applied");
  const issueEvent=(await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2 AND kind='document'",[projectId,issueOperation])).rows[0].event_id;
  const accepted=await orchestration.execute(principal(cognitiveActor),{type:"inbox.accept",projectId,operationId:randomUUID(),
    loopId,sourceEventId:issueEvent,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await orchestration.execute(principal(cognitiveActor),{type:"inbox.ack",projectId,operationId:randomUUID(),
    inboxId:accepted.entityId,expectedVersion:1,reason:"Read original issue"});
  const dispatchId=randomUUID(),claimToken=randomUUID();
  await orchestration.execute(principal(cognitiveActor),{type:"dispatch.request",projectId,operationId:randomUUID(),
    inboxId:accepted.entityId,expectedInboxVersion:2,dispatchId,parentDispatchId:null,
    taskId:cognitiveTaskId,expectedTaskVersion:3,recipientRoleId:cognitiveRole,purpose:"cognition",
    authorizationScopeId:"fact-scope",reason:"Review exact issue"});
  await orchestration.execute(principal(cognitiveActor),{type:"dispatch.claim",projectId,operationId:randomUUID(),
    dispatchId,claimToken,leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await orchestration.execute(principal(cognitiveActor),{type:"dispatch.start",projectId,operationId:randomUUID(),dispatchId,claimToken});
  await orchestration.execute(principal(cognitiveActor),{type:"dispatch.resolve",projectId,operationId:randomUUID(),
    dispatchId,claimToken,result:"accepted",runtimeRunId:cognitiveRun.runId,reason:"Bound existing fixture Run"});
  const cognitiveIdentity=identity("cognition",cognitiveActor,cognitiveTaskId,cognitiveRun,cognitiveRole);
  const exact=`/api/projects/${projectId}/documents/${issueId}/revisions/${originalIssue.revisionId}/original`;
  assert.equal(await authorizeWorkerRequest(cognitiveIdentity,{method:"GET",path:exact},workerGuardFacts(pool,cognitiveIdentity)),true);
  assert.equal(await authorizeWorkerRequest(cognitiveIdentity,{method:"GET",path:`/api/projects/${projectId}/documents/${issueId}`},workerGuardFacts(pool,cognitiveIdentity)),false);
  assert.equal(await authorizeWorkerRequest(cognitiveIdentity,{method:"GET",path:`/api/projects/${projectId}/documents/${issueId}/revisions/${randomUUID()}/original`},workerGuardFacts(pool,cognitiveIdentity)),false);
  assert.equal(await authorizeWorkerCommand(cognitiveIdentity,{type:"document.adopt",projectId,operationId:randomUUID(),
    documentId:issueId,revisionId:originalIssue.revisionId},workerGuardFacts(pool,cognitiveIdentity)),true);
  const adopted=await workflow.execute(principal(cognitiveActor),{type:"document.adopt",projectId,operationId:randomUUID(),
    documentId:issueId,expectedVersion:1,revisionId:originalIssue.revisionId,reason:"Use fixed issue as input, not proof of repair"});
  assert.equal(adopted.status,"applied",JSON.stringify(adopted));
  assert.equal((await workflow.getDocument(principal(owner),projectId,issueId)).document.adoptedRevisionId,originalIssue.revisionId);
  const laterIssue=await issue({type:"document.revise",documentId:issueId,expectedVersion:2,
    body:"# Later evidence",reason:"Further review"},worker);
  assert.equal(await authorizeWorkerRequest(cognitiveIdentity,{method:"GET",path:`/api/projects/${projectId}/documents/${issueId}/revisions/${laterIssue.revisionId}/original`},workerGuardFacts(pool,cognitiveIdentity)),false);
  assert.equal(await authorizeWorkerRequest(cognitiveIdentity,{method:"GET",path:exact},workerGuardFacts(pool,cognitiveIdentity)),true);
});
