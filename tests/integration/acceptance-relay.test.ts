import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import { SessionMessageService } from "@evoloop/core/session-messages";
import type { Principal } from "@evoloop/contracts";
import { AcceptanceRelayService } from "../../apps/coordinator/src/acceptance-relay/service.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database=process.env.TEST_DATABASE_URL;
if(!database||!/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("A dedicated evoloop_*_test database is required");

test("human and agent acceptance preserve exact Delivery, recipient and temporary Session retirement",async t=>{
  const schema=`acceptance_${randomUUID().replaceAll("-","")}`;
  await migrate(database!,schema);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  t.after(async()=>{
    await pool.end();
    const admin=new pg.Client({connectionString:database});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`)}finally{await admin.end()}
  });
  const projectId=randomUUID(),taskId=randomUUID(),deliveryId=randomUUID();
  const reviewer:Principal={actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"]};
  const human:Principal={actorId:"named-human",identityKind:"human",projectIds:[projectId],permissions:["read","write","review"]};
  const agent:Principal={actorId:"named-human",identityKind:"agent",projectIds:[projectId],permissions:["read","write"]};
  const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},
    ids:{next:randomUUID},hasher:{hash:(s:string)=>createHash("sha256").update(s).digest("hex")}});
  const issue=async(command:Record<string,unknown>)=>{
    const result=await workflow.execute(reviewer,{...command,projectId,operationId:randomUUID()} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result;
  };
  await issue({type:"project.create",title:"Human acceptance test"});
  const owner=fixtureRoleId(reviewer.actorId);
  await seedFixtureRole(pool,projectId,owner);
  await issue({type:"task.create",taskId,title:"Check fixed delivery",content:"# Fixed work",
    acceptance:"Named human uses this delivery",owner,consumer:human.actorId,
    useRequired:true,acceptanceMode:"human_required",acceptanceTarget:"human"});
  const task=await workflow.getTask(reviewer,projectId,taskId);
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,
    artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'fixture:report','r1',$5,'passed','isolated fixture','candidate','author',now())`,
    [projectId,deliveryId,taskId,task.task.currentRevisionId,"a".repeat(64)]);
  const relay=new AcceptanceRelayService({pool,workflow,messages:{} as never,principals:async()=>[],
    canWrite:()=>false,leaderSession:async()=>null,qualify:async()=>null});
  const input={projectId,taskId,deliveryId,expectedTaskVersion:task.task.version,operationId:randomUUID(),
    relayId:randomUUID(),stage:"candidate" as const,scopeKey:"human-use",scopeDescription:"Use the fixed report",
    entrypoint:null,publicationRef:null,mode:"human" as const,recipientActorId:human.actorId,
    sessionId:null,senderActorId:null,messageId:null,messageOperationId:null,reason:"Task policy"};
  const reviewerToken="q".repeat(40),humanToken="h".repeat(40);
  const app=await buildServer({service:workflow,acceptanceRelay:relay,credentials:[
    {token:reviewerToken,actorId:reviewer.actorId,projectIds:[projectId],permissions:reviewer.permissions},
    {token:humanToken,actorId:human.actorId,identityKind:"human",projectIds:[projectId],permissions:human.permissions},
  ]});
  t.after(async()=>{await app.close()});
  const route=`/api/projects/${projectId}/tasks/${taskId}/acceptance-relay`;
  assert.equal((await app.inject({url:route})).statusCode,401);
  const arrangedResponse=await app.inject({method:"POST",url:route,headers:{authorization:`Bearer ${reviewerToken}`},payload:input});
  assert.equal(arrangedResponse.statusCode,200,arrangedResponse.body);
  const saved=arrangedResponse.json().arranged;
  assert.equal(saved.state,"pending");
  const humanList=await app.inject({url:`/api/projects/${projectId}/acceptance-relay/mine`,
    headers:{authorization:`Bearer ${humanToken}`}});
  assert.equal(humanList.statusCode,200,humanList.body);
  assert.equal(humanList.json().items[0].relayId,saved.relayId);
  const retries=await Promise.all([relay.arrange(reviewer,input),relay.arrange(reviewer,input)]);
  assert.deepEqual(retries.map(value=>value.relayId),[saved.relayId,saved.relayId]);
  await assert.rejects(relay.arrange(reviewer,{...input,reason:"changed intent"}),{code:"OPERATION_REUSED"});
  await assert.rejects(relay.arrange(reviewer,{...input,operationId:randomUUID(),relayId:randomUUID()}),
    {code:"ACCEPTANCE_ALREADY_ASSIGNED"});
  assert.equal((await relay.mine(human,projectId)).length,1);
  await assert.rejects(relay.humanRead(agent,projectId,taskId,saved.relayId,randomUUID(),1,"read"),
    {code:"TRUSTED_HUMAN_REQUIRED"});
  const readOperation=randomUUID();
  await relay.humanRead(human,projectId,taskId,saved.relayId,readOperation,1,"Read fixed r1");
  await relay.humanRead(human,projectId,taskId,saved.relayId,readOperation,1,"Read fixed r1");
  const observationId=randomUUID();
  await pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,
    observer_kind,result,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'human','used','Read and checked','Matches', $5,now())`,
    [projectId,observationId,taskId,deliveryId,human.actorId]);
  await assert.rejects(relay.linkObservation(agent,projectId,taskId,saved.relayId,observationId,
    randomUUID(),2),{code:"HUMAN_READ_REQUIRED"});
  const linkOperation=randomUUID();
  await relay.linkObservation(human,projectId,taskId,saved.relayId,observationId,linkOperation,2);
  await relay.linkObservation(human,projectId,taskId,saved.relayId,observationId,linkOperation,2);
  const item=(await relay.list(projectId,taskId))[0] as Record<string,unknown>;
  assert.equal(item.observationId,observationId);
  assert.equal(item.humanReadAt!==null,true);

  const qaRole=fixtureRoleId("relay-qa"),agentTaskId=randomUUID();
  await seedFixtureRole(pool,projectId,qaRole);
  await issue({type:"task.create",taskId:agentTaskId,title:"Agent QA",content:"# Current candidate",
    acceptance:"Independent QA",owner,consumer:"qa-recipient",useRequired:true,
    acceptanceMode:"independent_agent",acceptanceTarget:"business_session"});
  await issue({type:"task.start",taskId:agentTaskId,expectedVersion:1,basis:[],reason:"Test candidate"});
  const agentTask=await workflow.getTask(reviewer,projectId,agentTaskId);
  const authorSession=randomUUID(),qaSession=randomUUID(),runId=randomUUID(),agentDelivery=randomUUID();
  for(const [sessionId,roleId,actorId] of [[authorSession,owner,"author"],[qaSession,qaRole,"qa-recipient"]])
    await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/relay-qa','project','danger-full-access','never','ready',1,$4,$5,$6,$7,now(),now())`,
      [projectId,sessionId,roleId,randomUUID(),randomUUID(),randomUUID(),actorId]);
  const qaRevision=(await pool.query("SELECT current_revision_id FROM role_definition WHERE project_id=$1 AND role_id=$2",
    [projectId,qaRole])).rows[0].current_revision_id;
  await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,
    actor_id,note,created_at_utc) VALUES($1,$2,$3,$4,$5,'reviewer','fixture',now())`,
    [projectId,randomUUID(),qaRole,qaSession,qaRevision]);
  const basis=(await pool.query("SELECT basis_set_id FROM task_revision WHERE project_id=$1 AND task_id=$2 AND revision_id=$3",
    [projectId,agentTaskId,agentTask.task.currentRevisionId])).rows[0].basis_set_id;
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,
    session_id,operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'fixture',$8,'completed',2,$9,'author',now(),now())`,
    [projectId,runId,agentTaskId,agentTask.task.currentRevisionId,basis,authorSession,
      randomUUID(),"b".repeat(64),randomUUID()]);
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,
    artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'fixture:agent','r1',$6,'passed','isolated','candidate','author',now())`,
    [projectId,agentDelivery,agentTaskId,agentTask.task.currentRevisionId,runId,"c".repeat(64)]);
  const messages=new SessionMessageService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},
    ids:{next:randomUUID},grantFor:async()=>null});
  const agentRelay=new AcceptanceRelayService({pool,workflow,messages,principals:async()=>[reviewer],
    canWrite:()=>true,leaderSession:async()=>randomUUID(),qualify:async()=>null});
  const agentInput={...input,taskId:agentTaskId,deliveryId:agentDelivery,
    expectedTaskVersion:agentTask.task.version,operationId:randomUUID(),relayId:randomUUID(),
    scopeKey:"agent-qa",mode:"session" as const,recipientActorId:"qa-recipient",
    sessionId:qaSession,senderActorId:reviewer.actorId,messageId:randomUUID(),messageOperationId:randomUUID()};
  await assert.rejects(agentRelay.arrange(reviewer,{...agentInput,sessionId:authorSession,
    operationId:randomUUID(),relayId:randomUUID()}),{code:"INDEPENDENT_SESSION_REQUIRED"});
  const arranged=await agentRelay.arrange(reviewer,agentInput);
  await Promise.all([agentRelay.tick([projectId]),agentRelay.tick([projectId])]);
  await agentRelay.tick([projectId]);
  assert.equal((await messages.get(projectId,agentInput.messageId!)).state,"queued");
  assert.equal((await agentRelay.list(projectId,agentTaskId))[0] &&
    ((await agentRelay.list(projectId,agentTaskId))[0] as {state:string}).state,"linked");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM session_message WHERE project_id=$1 AND message_id=$2",
    [projectId,agentInput.messageId])).rows[0].n,1);
  const processingSql=`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at,role_context)
    VALUES($1,$2,$3,$4,$5,'qa-recipient','dispatching',$6,1,now(),now(),$7)`;
  const probe=await pool.connect();
  try {
    await probe.query("BEGIN");
    await probe.query(processingSql,[projectId,randomUUID(),agentInput.messageId,qaSession,randomUUID(),"e".repeat(64),"fixed role@revision"]);
    assert.equal((await probe.query("SELECT role_context FROM session_message_processing WHERE project_id=$1 AND message_id=$2",
      [projectId,agentInput.messageId])).rows[0].role_context,"fixed role@revision");
    await probe.query("ROLLBACK");
  } finally { probe.release(); }
  const replacement=randomUUID();
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,
    artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'fixture:replacement','r2',$6,'passed','isolated','replacement','author',now()+interval '1 second')`,
    [projectId,replacement,agentTaskId,agentTask.task.currentRevisionId,runId,"d".repeat(64)]);
  await assert.rejects(pool.query(processingSql,
    [projectId,randomUUID(),agentInput.messageId,qaSession,randomUUID(),"e".repeat(64),"fixed role@revision"]),
    {code:"23514",constraint:"acceptance_source_current"});
  assert.equal(await agentRelay.messageAdmission(projectId,agentInput.messageId!),false);
  assert.equal((await messages.get(projectId,agentInput.messageId!)).state,"cancelled");
  assert.equal(((await agentRelay.list(projectId,agentTaskId))[0] as {state:string}).state,"superseded");
  assert.equal(arranged.deliveryId,agentDelivery);
  const nextInput={...agentInput,deliveryId:replacement,operationId:randomUUID(),relayId:randomUUID(),
    messageId:randomUUID(),messageOperationId:randomUUID()};
  await agentRelay.arrange(reviewer,nextInput);
  await agentRelay.tick([projectId]);
  const nextProcessing=randomUUID();
  await pool.query(processingSql,[projectId,nextProcessing,nextInput.messageId,qaSession,randomUUID(),"e".repeat(64),"fixed role@revision"]);
  await pool.query("UPDATE session_message SET state='processing',version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2",
    [projectId,nextInput.messageId]);
  await pool.query("UPDATE session_message_processing SET state='running',native_turn_id='fixture-turn',version=version+1,updated_at=now() WHERE project_id=$1 AND processing_id=$2",
    [projectId,nextProcessing]);
  const earlyObservation=randomUUID();
  await pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,
    observer_kind,result,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'qa-recipient','agent','used','fixture early','before completion','qa-recipient',now())`,
    [projectId,earlyObservation,agentTaskId,replacement]);
  await pool.query("UPDATE session_message_processing SET state='completed',version=version+1,updated_at=now() WHERE project_id=$1 AND processing_id=$2",
    [projectId,nextProcessing]);
  await pool.query(`INSERT INTO session_message_read_receipt(project_id,message_id,actor_id,evidence,recorded_at)
    VALUES($1,$2,'qa-recipient','fixture receipt',now())`,[projectId,nextInput.messageId]);
  const qaPrincipal:Principal={actorId:"qa-recipient",identityKind:"agent",projectIds:[projectId],permissions:["read","write"]};
  await assert.rejects(agentRelay.linkObservation(qaPrincipal,projectId,agentTaskId,nextInput.relayId,
    earlyObservation,randomUUID(),2),{code:"ACCEPTANCE_NOT_USED"});
  const lateObservation=randomUUID();
  await pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,
    observer_kind,result,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'qa-recipient','agent','used','fixture after Turn','after receipt','qa-recipient',now())`,
    [projectId,lateObservation,agentTaskId,replacement]);
  await agentRelay.linkObservation(qaPrincipal,projectId,agentTaskId,nextInput.relayId,lateObservation,randomUUID(),2);
  await pool.query("UPDATE session_message SET state='completed_without_reply',version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2",
    [projectId,nextInput.messageId]);
  await pool.query("UPDATE session_profile SET tenure='temporary',version=version+1 WHERE project_id=$1 AND target_kind='owned' AND target_id=$2",
    [projectId,qaSession]);
  const decision={projectId,sessionId:qaSession,decisionId:randomUUID(),closeOperationId:randomUUID(),
    expectedSessionVersion:1,reason:"All acceptance responsibility settled",handoffEvidence:"New Delivery has a separate owner"};
  const approved=await agentRelay.approveRetirement(reviewer,decision) as {decision:unknown};
  assert.ok(approved.decision);
  await assert.rejects(pool.query("UPDATE runtime_session SET state='closing',version=version+1,close_operation_id=$3 WHERE project_id=$1 AND session_id=$2",
    [projectId,qaSession,randomUUID()]),{code:"23514"});
  await pool.query("UPDATE runtime_session SET state='closing',version=version+1,close_operation_id=$3 WHERE project_id=$1 AND session_id=$2",
    [projectId,qaSession,decision.closeOperationId]);
  assert.equal((await agentRelay.retirementStatus(reviewer,projectId,qaSession) as {state:string}).state,"closing");
});
