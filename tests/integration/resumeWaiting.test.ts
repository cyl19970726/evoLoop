import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { WorkflowService, RuntimeWorkflowService } from "@evoloop/core";
import { OrchestrationService, OrchestrationError } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";

const url=process.env.TEST_DATABASE_URL;
if(!url || !/evoloop.*test/.test(new URL(url).pathname))throw new Error("dedicated evoloop test DB required");
const schema=`el_resume_${randomUUID().replaceAll("-","").slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),reviewer="resume-reviewer",cognition="resume-cognition",reporter="independent-reporter";
const cognitiveRole="resume-cognitive-role",businessRole="resume-business-role",scope="resume-cognitive-scope";
const principal=(actorId:string,permissions:Array<"read"|"write"|"review">=["read","write","review"])=>({actorId,projectIds:[projectId],permissions});
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const uow=new PostgresUnitOfWork(pool);
const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
const runtime=new RuntimeWorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
const store=new PgOrchestrationStore(pool,{
  getAuthorizationFact:async(_project,id)=>id===scope?{projectId,scopeId:scope,actorId:cognition,roleId:cognitiveRole,active:true}:null,
  canActAsRole:async(_project,actor,role)=>actor===cognition&&role===cognitiveRole,
  wasActorRole:async()=>false,
});
const orchestration=new OrchestrationService({store,now:()=>new Date().toISOString(),nextId:randomUUID,hash});
const official=async(actorId:string,command:Record<string,unknown>)=>{
  const result=await workflow.execute(principal(actorId),{projectId,operationId:randomUUID(),...command} as never);
  assert.equal(result.status,"applied",JSON.stringify(result));return result as Extract<typeof result,{status:"applied"}>;
};
const managed=(actorId:string,command:Record<string,unknown>,operationId=randomUUID())=>
  orchestration.execute(principal(actorId),{projectId,operationId,...command} as never);
const fails=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,error=>error instanceof OrchestrationError&&error.code===code);

test("PG waiting resume keeps signed history and exposes only verified fixed Issue source once",async t=>{
  await migrate(url!,schema);
  t.after(async()=>{await pool.end();const client=new pg.Client({connectionString:url});await client.connect();try{await client.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await client.end();}});
  const goalId=randomUUID(),stageId=randomUUID(),businessTask=randomUUID(),cognitiveTask=randomUUID(),loopId=randomUUID();
  await official(reviewer,{type:"project.create",title:"Waiting resume fixture"});
  await official(reviewer,{type:"goal.create",goalId,outcome:"One bounded review",constraints:"Fixed Issue",consumer:"owner",authority:"reviewer",scope:"local",owner:reviewer});
  await official(reviewer,{type:"stage.propose",stageId,goalId,deliverable:"Fixed decision",learningQuestion:"What next?",reason:"Fixture"});
  await official(reviewer,{type:"stage.accept",stageId,expectedVersion:1,reason:"Activate"});
  await official(reviewer,{type:"task.create",taskId:businessTask,stageId,title:"Original work",content:"# Original",acceptance:"One Issue",owner:businessRole,consumer:"owner",evidence:"Pending",stopCondition:"One report"});
  await official(reviewer,{type:"task.start",taskId:businessTask,expectedVersion:1,reason:"Fix input"});
  await official(reviewer,{type:"task.create",taskId:cognitiveTask,stageId,title:"Review Issue",content:"# Review",acceptance:"One decision",owner:cognitiveRole,consumer:"owner",evidence:"Pending",stopCondition:"One decision"});
  await official(reviewer,{type:"task.start",taskId:cognitiveTask,expectedVersion:1,reason:"Fix input"});
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await managed(reviewer,{type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:cognitiveRole,allowedBusinessRoleIds:[businessRole],sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},maxRuns:2,maxConcurrent:1,reason:"Bounded"});
  const issueId=randomUUID(),issueOp=randomUUID();
  const created=await workflow.execute(principal(reporter),{type:"document.create",projectId,operationId:issueOp,documentId:issueId,kind:"issue",title:"Original issue",body:"# Fixed issue",origin:{taskId:businessTask}});
  assert.equal(created.status,"applied",JSON.stringify(created));
  const issueEvent=(await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2 AND kind='document'",[projectId,issueOp])).rows[0].event_id;
  const inbox=await managed(cognition,{type:"inbox.accept",loopId,sourceEventId:issueEvent,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await managed(cognition,{type:"inbox.ack",inboxId:inbox.entityId,expectedVersion:1,reason:"Read fixed Issue"});
  const dispatchId=randomUUID(),decisionId=randomUUID();
  await managed(cognition,{type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,dispatchId,parentDispatchId:null,taskId:cognitiveTask,expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:scope,reason:"Review Issue"});
  const token=randomUUID();
  await managed(cognition,{type:"dispatch.claim",dispatchId,claimToken:token,leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await managed(cognition,{type:"dispatch.start",dispatchId,claimToken:token});
  const sessionId=randomUUID(),runId=randomUUID();
  await official(reviewer,{type:"runtime.session.reserve",sessionId,roleId:cognitiveRole,cwd:"/tmp/evoloop-resume-test",authorizationScope:scope,model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,sessionId);
  await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,roleId:cognitiveRole,cwd:"/tmp/evoloop-resume-test",authorizationScope:scope,nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
  await official(reviewer,{type:"runtime.run.reserve",runId,taskId:cognitiveTask,sessionId,expectedVersion:2,input:"Review fixed Issue"});
  await managed(cognition,{type:"dispatch.resolve",dispatchId,claimToken:token,result:"accepted",runtimeRunId:runId,reason:"Bound fixture Run"});
  await managed(cognition,{type:"worker.decision",decisionId,dispatchId,runId,kind:"waiting",reason:"Waiting on independent evidence",evidenceRefs:[]});
  await runtime.rejectDispatch(projectId,runId,"Fixture terminal with signed waiting");
  await managed(cognition,{type:"worker.outcome",dispatchId,outcome:"waiting",deliveryId:null,decisionId,evidenceRef:null,reason:"Waiting on independent evidence"});
  const beforeLoop=(await orchestration.getLoop(principal(reviewer),projectId,loopId))!;
  const beforeDecision=await orchestration.getDecision(principal(reviewer),projectId,decisionId);
  const operationId=randomUUID(),command={type:"loop.resumeWaiting",loopId,expectedLoopVersion:beforeLoop.version,decisionId,dispatchId,evidenceRef:"review:evidence",reason:"Resume original Issue"};
  await fails(orchestration.execute(principal(cognition,["read","write"]),{projectId,operationId:randomUUID(),...command} as never),"FORBIDDEN");
  const secondOperationId=randomUUID();
  const [one,two]=await Promise.allSettled([managed(reviewer,command,operationId),managed(reviewer,command,secondOperationId)]);
  assert.equal([one,two].filter(x=>x.status==="fulfilled").length,1,"only one distinct operation may resume a Decision");
  const winningOperationId=one.status==="fulfilled"?operationId:secondOperationId;
  assert.equal((await managed(reviewer,command,winningOperationId)).replayed,true);
  const resumed=(await orchestration.listEvents(principal(reviewer),projectId,loopId)).items.filter(x=>x.kind==="waiting.resumed");
  assert.equal(resumed.length,1);
  const fact=(await store.transaction(projectId,tx=>tx.getSourceFact(resumed[0]!.id)))!;
  assert.equal(fact.kind,"waiting.resumed");assert.equal(fact.subjectId,issueId);assert.equal(fact.issueRevisionId,created.revisionId);
  assert.equal(fact.originalSourceEventId,issueEvent);assert.equal(fact.waitingDecisionId,decisionId);
  assert.equal((await orchestration.listSourceFacts(principal(reviewer),projectId,loopId)).items.some(x=>x.id===resumed[0]!.id),true);
  assert.equal((await orchestration.getLoop(principal(reviewer),projectId,loopId))!.dispatchCount,beforeLoop.dispatchCount);
  assert.deepEqual(await orchestration.getDecision(principal(reviewer),projectId,decisionId),beforeDecision);
  const next=await managed(cognition,{type:"inbox.accept",loopId,sourceEventId:resumed[0]!.id,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  assert.equal(next.entityType,"inbox");
  const changed=await official(reviewer,{type:"document.revise",documentId:issueId,expectedVersion:1,body:"# Later revision",reason:"Preserve old source"});
  assert.equal(changed.status,"applied");
  assert.equal((await store.transaction(projectId,tx=>tx.getSourceFact(resumed[0]!.id)))?.issueContentHash,hash("# Fixed issue"));
  const forgedId=randomUUID();
  await pool.query(`INSERT INTO orchestration_event(project_id,event_id,loop_id,entity_type,entity_id,operation_id,kind,actor_id,detail,created_at_utc)
    VALUES($1,$2,$3,'decision',$4,$5,'waiting.resumed',$6,$7::jsonb,now())`,
    [projectId,forgedId,loopId,decisionId,winningOperationId,reviewer,
      JSON.stringify({...resumed[0]!.detail,issueContentHash:"0".repeat(64)})]);
  assert.equal(await store.transaction(projectId,tx=>tx.getSourceFact(forgedId)),null,"a forged same-operation event cannot become a source");
  assert.equal((await orchestration.listSourceFacts(principal(reviewer),projectId,loopId)).items.some(x=>x.id===forgedId),false);
});
