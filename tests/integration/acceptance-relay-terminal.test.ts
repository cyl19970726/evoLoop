import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import { SessionMessageService } from "@evoloop/core/session-messages";
import type { Principal } from "@evoloop/contracts";
import { AcceptanceRelayService } from "../../apps/coordinator/src/acceptance-relay/service.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database=process.env.TEST_DATABASE_URL;
if(!database||!/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("A dedicated evoloop_*_test database is required");

test("failed or cancelled acceptance is blocked once, reassignable and removable from retirement blockers",async t=>{
  const schema=`acceptance_terminal_${randomUUID().replaceAll("-","")}`;
  await migrate(database!,schema);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  t.after(async()=>{
    await pool.end();
    const admin=new pg.Client({connectionString:database});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`)}finally{await admin.end()}
  });
  const projectId=randomUUID(),taskId=randomUUID(),deliveryId=randomUUID();
  const reviewer:Principal={actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"]};
  const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},
    ids:{next:randomUUID},hasher:{hash:(s:string)=>createHash("sha256").update(s).digest("hex")}});
  const issue=async(command:Record<string,unknown>)=>{
    const result=await workflow.execute(reviewer,{...command,projectId,operationId:randomUUID()} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result;
  };
  await issue({type:"project.create",title:"Terminal acceptance test"});
  const owner=fixtureRoleId(reviewer.actorId),qaRole=fixtureRoleId("terminal-qa");
  await seedFixtureRole(pool,projectId,owner);await seedFixtureRole(pool,projectId,qaRole);
  const authorSession=randomUUID(),qaSession=randomUUID(),qaSession2=randomUUID();
  for(const [sessionId,roleId,actorId] of [
    [authorSession,owner,"author"],
    [qaSession,qaRole,"qa-recipient"],
    [qaSession2,qaRole,"qa-recipient"],
  ])
    await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/acceptance-terminal','project','danger-full-access','never','ready',1,$4,$5,$6,$7,now(),now())`,
      [projectId,sessionId,roleId,randomUUID(),randomUUID(),randomUUID(),actorId]);
  for(const sessionId of [qaSession,qaSession2]) {
    const revision=(await pool.query("SELECT current_revision_id FROM role_definition WHERE project_id=$1 AND role_id=$2",
      [projectId,qaRole])).rows[0].current_revision_id;
    await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,
      actor_id,note,created_at_utc) VALUES($1,$2,$3,$4,$5,'reviewer','fixture',now())`,
      [projectId,randomUUID(),qaRole,sessionId,revision]);
  }
  await issue({type:"task.create",taskId,title:"Terminal acceptance",content:"# Candidate",
    acceptance:"QA uses the fixed Delivery",owner,consumer:"qa-recipient",useRequired:true,
    acceptanceMode:"independent_agent",acceptanceTarget:"business_session"});
  await issue({type:"task.start",taskId,expectedVersion:1,basis:[],reason:"Test candidate"});
  const task=await workflow.getTask(reviewer,projectId,taskId);
  const basis=(await pool.query("SELECT basis_set_id FROM task_revision WHERE project_id=$1 AND task_id=$2 AND revision_id=$3",
    [projectId,taskId,task.task.currentRevisionId])).rows[0].basis_set_id;
  const runId=randomUUID();
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,
    session_id,operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'fixture',$8,'completed',2,$9,'author',now(),now())`,
    [projectId,runId,taskId,task.task.currentRevisionId,basis,authorSession,
      randomUUID(),"b".repeat(64),randomUUID()]);
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,
    artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'fixture:agent','r1',$6,'passed','isolated','candidate','author',now())`,
    [projectId,deliveryId,taskId,task.task.currentRevisionId,runId,"c".repeat(64)]);
  const messages=new SessionMessageService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},
    ids:{next:randomUUID},grantFor:async()=>null});
  const relay=new AcceptanceRelayService({pool,workflow,messages,principals:async()=>[reviewer],
    canWrite:()=>true,leaderSession:async()=>null,qualify:async()=>null,capabilities:async()=>[]});
  const input={projectId,taskId,deliveryId,expectedTaskVersion:task.task.version,operationId:randomUUID(),
    relayId:randomUUID(),stage:"candidate" as const,scopeKey:"terminal-use",
    scopeDescription:"QA uses the fixed Delivery",entrypoint:null,publicationRef:null,
    mode:"session" as const,recipientActorId:"qa-recipient",sessionId:qaSession,
    senderActorId:reviewer.actorId,messageId:randomUUID(),messageOperationId:randomUUID(),reason:"Task policy"};
  await relay.arrange(reviewer,input);
  await relay.tick([projectId]);
  const linked=(await relay.list(projectId,taskId))[0] as {state:string;version:number};
  assert.equal(linked.state,"linked");
  await pool.query(`UPDATE session_profile SET version=version+1,tenure='temporary',updated_at=now()
    WHERE project_id=$1 AND target_kind='owned' AND target_id=$2`,[projectId,qaSession]);
  await assert.rejects(relay.approveRetirement(reviewer,{projectId,sessionId:qaSession,decisionId:randomUUID(),
    closeOperationId:randomUUID(),expectedSessionVersion:1,reason:"Queued acceptance still owns work",
    handoffEvidence:"Not handed off"}),{code:"RETIREMENT_BLOCKED"});
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,failure,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'qa-recipient','failed','native failed',$6,1,now(),now())`,
    [projectId,randomUUID(),input.messageId,qaSession,randomUUID(),"f".repeat(64)]);
  await pool.query("UPDATE session_message SET state='processing',version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2",
    [projectId,input.messageId]);
  await pool.query("UPDATE session_message SET state='failed',version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2",
    [projectId,input.messageId]);

  await relay.tick([projectId]);
  const blocked=(await relay.list(projectId,taskId))[0] as {relayId:string;state:string;version:number;blockedReason:string|null};
  assert.equal(blocked.state,"blocked");
  assert.equal(blocked.blockedReason,"ACCEPTANCE_MESSAGE_FAILED");
  const notices=async()=>(await pool.query(`SELECT count(*)::int AS n FROM leader_result_notice
    WHERE project_id=$1 AND task_id=$2 AND kind='acceptance_blocked'`,[projectId,taskId])).rows[0].n;
  assert.equal(await notices(),1);
  assert.equal(await relay.messageAdmission(projectId,input.messageId!),false);
  assert.equal(await notices(),1);
  assert.equal(((await relay.list(projectId,taskId))[0] as {version:number}).version,blocked.version);

  const reassigned=await relay.arrange(reviewer,{...input,operationId:randomUUID(),relayId:randomUUID(),
    sessionId:qaSession2,messageId:randomUUID(),messageOperationId:randomUUID(),
    supersedesRelayId:blocked.relayId,expectedRelayVersion:blocked.version});
  assert.equal(reassigned.state,"pending");
  const history=(await relay.list(projectId,taskId)) as Array<{relayId:string;state:string}>;
  assert.equal(history.find(item=>item.relayId===input.relayId)?.state,"superseded");
  assert.equal((await messages.get(projectId,input.messageId!)).state,"failed");
  assert.equal(await notices(),1);

  await relay.tick([projectId]);
  await pool.query("UPDATE session_message SET state='cancelled',version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2",
    [projectId,reassigned.messageId]);
  assert.equal(await relay.messageAdmission(projectId,reassigned.messageId!),false);
  const cancelled=(await relay.list(projectId,taskId))[0] as {state:string;blockedReason:string|null};
  assert.equal(cancelled.state,"blocked");
  assert.equal(cancelled.blockedReason,"ACCEPTANCE_MESSAGE_CANCELLED");
  assert.equal(await notices(),2);
  assert.equal(await relay.messageAdmission(projectId,reassigned.messageId!),false);
  assert.equal(await notices(),2);

  const failedClose=randomUUID();
  const decision=await relay.approveRetirement(reviewer,{projectId,sessionId:qaSession,decisionId:randomUUID(),
    closeOperationId:failedClose,expectedSessionVersion:1,reason:"Failed acceptance is terminal",
    handoffEvidence:"No remaining obligation for this temporary QA"}) as Record<string,unknown>;
  assert.equal((decision.decision as Record<string,unknown>|null)!==null,true);
  assert.equal((decision.blockers as Record<string,number>).openAcceptance,0);
  const closeFailed=await workflow.execute(reviewer,{type:"runtime.session.close",projectId,operationId:failedClose,
    sessionId:qaSession,expectedVersion:1,reason:"Retire temporary QA after failed acceptance"});
  assert.equal(closeFailed.status,"applied",JSON.stringify(closeFailed));
  await pool.query(`UPDATE session_profile SET version=version+1,tenure='temporary',updated_at=now()
    WHERE project_id=$1 AND target_kind='owned' AND target_id=$2`,[projectId,qaSession2]);
  const cancelledClose=randomUUID();
  const cancelledDecision=await relay.approveRetirement(reviewer,{projectId,sessionId:qaSession2,decisionId:randomUUID(),
    closeOperationId:cancelledClose,expectedSessionVersion:1,reason:"Cancelled acceptance is terminal",
    handoffEvidence:"No remaining obligation for this temporary QA"}) as Record<string,unknown>;
  assert.equal((cancelledDecision.decision as Record<string,unknown>|null)!==null,true);
  assert.equal((cancelledDecision.blockers as Record<string,number>).openAcceptance,0);
  const closeCancelled=await workflow.execute(reviewer,{type:"runtime.session.close",projectId,operationId:cancelledClose,
    sessionId:qaSession2,expectedVersion:1,reason:"Retire temporary QA after cancelled acceptance"});
  assert.equal(closeCancelled.status,"applied",JSON.stringify(closeCancelled));
});
