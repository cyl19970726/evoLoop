import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { Principal } from "@evoloop/contracts";
import type { DelegationTemplate } from "@evoloop/contracts/division";
import type { OrchestrationStore } from "@evoloop/contracts/orchestration";
import { WorkflowService, RuntimeWorkflowService } from "@evoloop/core";
import { OrchestrationService, OrchestrationError } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";


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
if (!url || !/evoloop.*test/.test(new URL(url).pathname)) throw new Error("dedicated PostgreSQL test database required");
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const projectId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),loopId=randomUUID();
const cognitionRole="cognition-role",cognition="researcher",controller="controller";
const parentTaskId=randomUUID(),firstTaskId=randomUUID(),documentId=randomUUID();
const principal=(actorId:string,review=false):Principal=>({actorId,projectIds:[projectId],permissions:review?["read","write","review"]:["read","write"]});

test("PG new Role creation commits with binding, rolls back on failure, and serializes competing choices",async t=>{
  const schema=`el_m3creation_${randomUUID().replaceAll("-","").slice(0,14)}`;
  await migrate(url!,schema);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  const allocationValidity=await pool.query(`SELECT
    valid_new_role_allocation('{"maxTotal":1,"requiredState":"trial"}'::jsonb) AS legacy,
    valid_new_role_allocation('{"maxTotal":1,"requiredState":"trial","creation":{"allowProposeAndAcceptTrial":true,"maxTrialDays":90}}'::jsonb) AS bounded,
    valid_new_role_allocation('{"maxTotal":1,"requiredState":"trial","creation":{"allowProposeAndAcceptTrial":true,"maxTrialDays":91}}'::jsonb) AS over_limit`);
  assert.deepEqual(allocationValidity.rows[0],{legacy:true,bounded:true,over_limit:false});
  t.after(async()=>{await pool.end();const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const uow=new PostgresUnitOfWork(pool),clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash:sha}});
  const runtime=new RuntimeWorkflowService({uow,clock,ids});
  withPersistedResumeProfile(runtime,uow);
  const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(p,id)=>p===projectId&&id==="cognition-scope"?
    {projectId,scopeId:id,actorId:cognition,roleId:cognitionRole,active:true}:null,
    canActAsRole:async(p,actor,role)=>p===projectId&&actor===cognition&&role===cognitionRole,
    wasActorRole:async()=>false});
  const wf=async(actor:string,command:Record<string,unknown>)=>{
    const result=await workflow.execute(principal(actor,true),{projectId,operationId:randomUUID(),...command} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result;
  };
  const issue=(service:OrchestrationService,actor:string,command:Record<string,unknown>)=>
    service.execute(principal(actor,actor===controller),{projectId,operationId:randomUUID(),...command} as never);
  await wf(controller,{type:"project.create",title:"Isolated trial creation"});
  await wf(controller,{type:"goal.create",goalId,outcome:"One trial",constraints:"Finite",consumer:"controller",authority:"reviewer",scope:"fixture",owner:controller});
  await wf(controller,{type:"stage.propose",stageId,goalId,deliverable:"One result",learningQuestion:"Useful?",reason:"Fixture"});
  await wf(controller,{type:"stage.accept",stageId,expectedVersion:1,reason:"Start"});
  await wf(controller,{type:"task.create",taskId:parentTaskId,stageId,title:"Research",content:"# Decide",acceptance:"Decision",owner:cognitionRole,consumer:controller,evidence:"Fixture",stopCondition:"One choice"});
  await wf(controller,{type:"task.start",taskId:parentTaskId,expectedVersion:1,reason:"Freeze"});
  await wf(controller,{type:"task.create",taskId:firstTaskId,stageId,title:"First work",content:"# Work",acceptance:"Result",owner:"prior-owner",consumer:controller,evidence:"Gap",stopCondition:"One trial"});
  const body="# Fixed diagnosis",document=await wf(controller,{type:"document.create",documentId,kind:"report",title:"Diagnosis",body});
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  const template:DelegationTemplate={id:randomUUID(),revision:1,projectId,goalId,loopId,existingRoleIds:[],
    cognitionRoleIds:[],newRoleAllocation:{maxTotal:1,requiredState:"trial",creation:{allowProposeAndAcceptTrial:true,maxTrialDays:1}},
    firstTaskId,actorId:controller,authorizationScopeId:"creation-trial",decisionActorIds:[cognition],
    allowedChoices:["new-role"],cwd:"/tmp/evoloop-m3-creation-fixture",model:"fixture",sandbox:"read-only",
    networkAccess:false,approvalPolicy:"on-request",expiresAtUtc:new Date(Date.now()+20*60_000).toISOString()};
  const templateHash=sha(JSON.stringify(template));
  const deps={now:clock.now,nextId:randomUUID,hash:sha,
    getDelegationTemplate:async(p:string,id:string)=>p===projectId&&id===template.id?{template,hash:templateHash}:null,
    getTrialController:async(p:string,actor:string)=>p===projectId&&actor===controller?principal(controller,true):null,
    verifyProposalMaterial:async(reader:Principal,p:string,id:string,revisionId:string,hash:string)=>{
      if (!reader.permissions.includes("read")) return false;
      const revision=await workflow.getDocumentPayloadRevision(reader,p,id,revisionId);
      return revision.body!==null&&sha(revision.body)===hash&&revision.contentHash===hash;
    }};
  const service=new OrchestrationService({...deps,store});
  const enrolled=await issue(service,controller,{type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:cognitionRole,
    allowedBusinessRoleIds:["static-role"],sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},
    maxRuns:2,maxConcurrent:1,reason:"Finite"});
  const loop=(await service.getLoop(principal(controller,true),projectId,loopId))!;
  assert.equal(enrolled.entityId,loopId);
  const inbox=await issue(service,cognition,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,
    recipientRoleId:cognitionRole,purpose:"cognitive_review"});
  await issue(service,cognition,{type:"inbox.ack",inboxId:inbox.entityId,expectedVersion:1,reason:"Read"});
  const parent=await issue(service,cognition,{type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:parentTaskId,expectedTaskVersion:2,
    recipientRoleId:cognitionRole,purpose:"cognition",authorizationScopeId:"cognition-scope",reason:"Choose"});
  const token=randomUUID();
  await issue(service,cognition,{type:"dispatch.claim",dispatchId:parent.entityId,claimToken:token,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue(service,cognition,{type:"dispatch.start",dispatchId:parent.entityId,claimToken:token});
  const sessionId=randomUUID(),runId=randomUUID(),cwd="/tmp/evoloop-m3-creation-fixture";
  await wf(cognition,{type:"runtime.session.reserve",sessionId,roleId:cognitionRole,cwd,
    authorizationScope:"cognition-scope",model:"fixture",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,sessionId);
  await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,roleId:cognitionRole,
    cwd,authorizationScope:"cognition-scope",nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
  await wf(cognition,{type:"runtime.run.reserve",runId,taskId:parentTaskId,sessionId,expectedVersion:2,input:"Decide"});
  await issue(service,cognition,{type:"dispatch.resolve",dispatchId:parent.entityId,claimToken:token,
    result:"accepted",runtimeRunId:runId,reason:"Fixture"});
  const proposal={title:"Trial specialist",goal:"Resolve bounded gap",independentResponsibility:"Own this recurring gap",
    ownerScope:"This project",inputs:["Fixed diagnosis"],writableAssets:[],deliverables:["One report"],
    triggers:["Repeated gap"],workflow:"Inspect, act, hand off",handoffBoundary:"Return unfinished work to prior owner",
    evidence:[{kind:"backlog",observation:"Unowned gap",sourceRef:`document:${documentId}`,observedAtUtc:clock.now()},
      {kind:"effect",observation:"Delay",sourceRef:`document:${documentId}`,observedAtUtc:clock.now()},
      {kind:"cost",observation:"One run",sourceRef:`document:${documentId}`,observedAtUtc:clock.now()}],
    alternatives:["method","knowledge","another-instance","temporary-assignment"].map(kind=>({kind,assessment:"Insufficient",estimatedCost:"One day"})),
    firstTaskId,baseline:"Delay",expectedEffect:"Reduce delay",costLimit:"Two runs",trialDays:1,
    reviewAtUtc:new Date(Date.now()+10*60_000).toISOString(),exitCriteria:"Stop without independent use"};
  const decision={type:"division.decide",projectId,operationId:randomUUID(),decisionId:randomUUID(),loopId,
    expectedLoopVersion:(await service.getLoop(principal(controller,true),projectId,loopId))!.version,
    sourceEventId:loop.bootstrapEventId,parentDispatchId:parent.entityId,documentId,
    documentRevisionId:document.revisionId,documentContentHash:sha(body),firstTaskId,
    expectedFirstTaskVersion:1,expectedFirstTaskOwner:"prior-owner",choice:"new-role",roleId:randomUUID(),
    proposedRole:proposal,templateId:template.id,templateRevision:template.revision,templateHash,reason:"Trial"};
  const lockClient=await pool.connect();
  try {
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",[projectId]);
    let settled=false;
    const blocked=service.execute(principal(cognition),{...decision,expectedFirstTaskOwner:"wrong"} as never)
      .then(()=>{settled=true;return null;},error=>{settled=true;return error;});
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(settled,false,"division waits behind the same project key as a Workflow Task update");
    await lockClient.query("COMMIT");
    const blockedError=await blocked;
    assert.ok(blockedError instanceof OrchestrationError&&blockedError.code==="CREATION_DENIED");
  } finally { await lockClient.query("ROLLBACK");lockClient.release(); }
  const denied=(command:Record<string,unknown>,code:string,active=service)=>assert.rejects(
    active.execute(principal(cognition),command as never),
    (e:unknown)=>e instanceof OrchestrationError&&e.code===code);
  await denied({...decision,proposedRole:{...proposal,reviewAtUtc:new Date(Date.now()+30*60_000).toISOString()}},
    "CREATION_DENIED");
  await denied({...decision,expectedFirstTaskOwner:"changed-owner"},"CREATION_DENIED");
  const unreadable=new OrchestrationService({...deps,store,verifyProposalMaterial:async()=>false});
  await denied(decision,"MATERIAL_UNREADABLE",unreadable);
  await pool.query("UPDATE project_stage SET state='reviewed' WHERE project_id=$1 AND stage_id=$2",[projectId,stageId]);
  await denied(decision,"STAGE_NOT_ACTIVE");
  for (const [table,condition,params] of [
    ["role_definition","project_id=$1",[projectId]],
    ["runtime_role_binding","project_id=$1",[projectId]],
    ["operation_journal","project_id=$1 AND command_type IN ('role.propose','role.decide')",[projectId]],
    ["orchestration_operation","project_id=$1 AND operation_id=$2",[projectId,decision.operationId]],
  ] as const) assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE ${condition}`,params)).rows[0].n,0,
    `${table} must remain empty after a non-active Stage rejection`);
  await pool.query("UPDATE project_stage SET state='active' WHERE project_id=$1 AND stage_id=$2",[projectId,stageId]);
  assert.equal((await pool.query("SELECT count(*)::int n FROM role_definition WHERE project_id=$1",[projectId])).rows[0].n,0);
  for (const failingMethod of ["insertWorkflowRoleOperation","insertBinding","insertPolicy","insertOperation"] as const) {
    const brokenStore:OrchestrationStore={read:(p,action)=>store.read(p,action),transaction:(p,action)=>store.transaction(p,
      tx=>action(new Proxy(tx,{get(target,key,receiver){if(key===failingMethod)return async()=>{throw new Error(`injected ${failingMethod} failure`)};
        return Reflect.get(target,key,receiver);}})))};
    await assert.rejects(new OrchestrationService({...deps,store:brokenStore}).execute(principal(cognition),decision as never),
      new RegExp(`injected ${failingMethod} failure`));
    assert.equal((await pool.query("SELECT count(*)::int n FROM role_definition WHERE project_id=$1",[projectId])).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM runtime_role_binding WHERE project_id=$1",[projectId])).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM orchestration_operation WHERE project_id=$1 AND operation_id=$2",[projectId,decision.operationId])).rows[0].n,0);
  }
  const rival={...decision,operationId:randomUUID(),decisionId:randomUUID(),roleId:randomUUID()};
  const race=await Promise.allSettled([service.execute(principal(cognition),decision as never),
    service.execute(principal(cognition),rival as never)]);
  assert.equal(race.filter(x=>x.status==="fulfilled").length,1,"project lock admits one proposed Role");
  const winner=race[0]?.status==="fulfilled"?decision:rival;
  const first=(race.find(x=>x.status==="fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof service.execute>>>).value;
  assert.equal(first.entityType,"binding");
  assert.equal((await service.execute(principal(cognition),winner as never)).replayed,true);
  await assert.rejects(service.execute(principal(cognition),{...winner,roleId:randomUUID()} as never),
    (e:unknown)=>e instanceof OrchestrationError&&e.code==="OPERATION_CONFLICT");
  const role=(await pool.query("SELECT state,version,proposed_by FROM role_definition WHERE project_id=$1 AND role_id=$2",[projectId,winner.roleId])).rows[0];
  assert.deepEqual(role,{state:"trial",version:2,proposed_by:cognition});
  const recorded=(await pool.query("SELECT actor_id FROM role_decision WHERE project_id=$1 AND role_id=$2",[projectId,winner.roleId])).rows[0];
  assert.equal(recorded.actor_id,controller);
  const roleOperations=await pool.query(`SELECT j.actor_id,j.command_type,j.result->>'entityId' AS role_id,o.kind,o.version
    FROM operation_journal j JOIN outbox_event o ON o.project_id=j.project_id AND o.operation_id=j.operation_id
    WHERE j.project_id=$1 AND j.command_type IN ('role.propose','role.decide') ORDER BY o.version`,[projectId]);
  assert.deepEqual(roleOperations.rows,[
    {actor_id:cognition,command_type:"role.propose",role_id:winner.roleId,kind:"role",version:1},
    {actor_id:controller,command_type:"role.decide",role_id:winner.roleId,kind:"role",version:2}]);
  const binding=await service.getBinding(principal(controller,true),projectId,first.entityId);
  assert.equal(binding?.roleId,winner.roleId);
  assert.equal((await pool.query("SELECT count(*)::int n FROM role_definition WHERE project_id=$1",[projectId])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM runtime_role_binding WHERE project_id=$1 AND choice='new-role'",[projectId])).rows[0].n,1);
  await pool.query("UPDATE project_stage SET state='reviewed' WHERE project_id=$1 AND stage_id=$2",[projectId,stageId]);
  assert.equal((await service.execute(principal(cognition),winner as never)).replayed,true,
    "a committed original operation must replay its history even after Stage review");
});
