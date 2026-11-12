// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import pg from "pg";
import Fastify from "fastify";
import { migrate } from "../src/index.ts";
import { PgSessionMessages } from "../src/session-messages.ts";
import { PgDirectInputs } from "../src/direct-input.ts";
import { DirectInputService } from "../../../apps/coordinator/src/direct-input/service.ts";
import { registerDirectInputRoutes } from "../../../apps/coordinator/src/direct-input/routes.ts";

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname.slice(1)))
  throw new Error("Direct input PG tests require a dedicated evoloop_*_test database");
const schema=`el_direct_${randomUUID().replaceAll("-","").slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const store=new PgDirectInputs(pool);
const projectId=randomUUID(),sessionId=randomUUID(),otherSessionId=randomUUID(),httpSessionId=randomUUID(),
  recoverySessionId=randomUUID(),noticeSessionId=randomUUID(),raceSessionId=randomUUID(),
  contentionSessionId=randomUUID(),queueSessionId=randomUUID(),changedSessionId=randomUUID(),orderSessionId=randomUUID(),firstSessionId=randomUUID(),roleId=randomUUID();
const grant=(id=sessionId,maxTurns=2)=>({projectId,sessionId:id,senderActorId:"user",receiverRoleId:roleId,
  receiverActorId:"agent",cwd:"/tmp/direct-test",maxTurns,enabled:true,canSteer:true,canStart:true});
const input=(expectedTurnId:string|null=null)=>({inputId:randomUUID(),operationId:randomUUID(),content:"Additional authorized detail",expectedTurnId});
const hash="a".repeat(64);
/** A refusal that provably reached no runtime is saved as one queued message, not thrown at the person. */
const assertQueued=async(pending:Promise<{record:{state:string;queuedMessageId?:string|null}}>)=>{
  const result=await pending;assert.equal(result.record.state,"rejected");assert.ok(result.record.queuedMessageId);
};

before(async()=>{
  await migrate(url!,schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Direct test',now())",[projectId]);
  for(const id of [sessionId,otherSessionId,httpSessionId,recoverySessionId,noticeSessionId,raceSessionId,contentionSessionId,queueSessionId,changedSessionId,orderSessionId,firstSessionId])await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,
    authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,
    created_at,updated_at) VALUES($1,$2,$3,'/tmp/direct-test','project','danger-full-access','never',
    'ready',1,$4,$5,$6,'agent',now(),now())`,[projectId,id,roleId,`thread-${id}`,`native-${id}`,randomUUID()]);
});

test("two simultaneous idle starts share one persistent slot",async()=>{
  const a=input(),b=input();
  const outcomes=await Promise.allSettled([store.reserve(projectId,contentionSessionId,"user",a,grant(contentionSessionId),hash),
    store.reserve(projectId,contentionSessionId,"user",b,grant(contentionSessionId),hash)]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,2,"the loser is queued, not failed");
  const records=outcomes.map(x=>(x as PromiseFulfilledResult<{record:{queuedMessageId?:string|null}}>).value.record);
  assert.equal(records.filter(x=>x.queuedMessageId).length,1,"exactly one of the two was queued");
  assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM session_message_processing
    WHERE project_id=$1 AND session_id=$2`,[projectId,contentionSessionId])).rows[0].n,1);
});

test("unlimited direct start preserves prior usage while an explicit cap still blocks",async()=>{
  const id=randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/direct-test','project','danger-full-access','never','ready',1,$4,$5,$6,
    'agent',now(),now())`,[projectId,id,roleId,`thread-${id}`,`native-${id}`,randomUUID()]);
  for(let i=0;i<24;i++){
    const messageId=randomUUID();
    await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'user','old turn','replied',1,now(),now())`,
      [projectId,messageId,randomUUID(),id]);
    await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
      operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'agent','completed',$6,$7,1,now(),now())`,
      [projectId,randomUUID(),messageId,id,randomUUID(),`old-turn-${i}`,hash]);
  }
  const unlimited={...grant(id),maxTurns:undefined};
  assert.equal((await store.inspect(projectId,id,'user')).used,24);
  const binding={projectId,sessionId:id,roleId,cwd:'/tmp/direct-test',authorizationScope:'project',
    nativeThreadId:`thread-${id}`,nativeSessionId:`native-${id}`,owner:'evoloop-codex-app-server' as const,
    resumeProfile:{actorId:'agent',model:null,sandbox:'danger-full-access' as const,approvalPolicy:'never' as const}};
  let current=grant(id,24);
  const service=new DirectInputService({store,canWrite:()=>true,
    admission:async()=>({grant:current,binding}),bindingFor:async()=>binding,
    runtime:()=>({isReady:()=>true,registerBinding:async()=>{},
      capabilities:()=>({delivery:{midTurnInput:true,idleTurnStart:true}} as never),
      qualifyConversationThread:async()=>({available:true,reason:'',fingerprint:hash}),
      startConversationTurn:async()=>{throw Error('unused')},steerTurn:async()=>{throw Error('unused')},
      listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})})});
  const sender={actorId:'user',projectIds:[projectId],permissions:['read','write']} as never;
  assert.equal((await service.capability(sender,projectId,id)).reasonCode,'MESSAGE_BUDGET_EXHAUSTED');
  current=unlimited;
  assert.equal((await service.capability(sender,projectId,id)).mode,'start');
  await assert.rejects(()=>store.reserve(projectId,id,'user',input(),grant(id,24),hash),/budget is exhausted/);
  const command=input();
  assert.equal((await store.reserve(projectId,id,'user',command,unlimited,hash)).record.mode,'start');
  assert.equal((await store.inspect(projectId,id,'user')).used,25,'old counted Turns remain counted');
});

test("automatic message processing remains the only source for two attached inputs",async()=>{
  const messageId=randomUUID(),processingId=randomUUID(),operationId=randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'notice-sender','Automated notice','processing',1,now(),now())`,
    [projectId,messageId,operationId,noticeSessionId]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'agent','running','notice-turn',$6,1,now(),now())`,
    [projectId,processingId,messageId,noticeSessionId,randomUUID(),hash]);
  const acceptedIds:string[]=[];
  for(let i=0;i<2;i++){
    const command=input("notice-turn");
    acceptedIds.push(command.inputId);
    const reserved=await store.reserve(projectId,noticeSessionId,"user",command,grant(noticeSessionId,1),"");
    assert.deepEqual(reserved.record.source,{kind:"message",id:messageId,processingId});
    await store.accept(projectId,command.inputId,"notice-turn",`notice-item-${i}`);
  }
  const exact=await store.acceptedForInputs(projectId,noticeSessionId,acceptedIds);
  assert.deepEqual(new Set(exact.map(item=>item.inputId)),new Set(acceptedIds));
  assert.equal((await store.acceptedForInputs(projectId,sessionId,acceptedIds)).length,0,
    'the same project cannot lend a steer Item to another Session');
  const other=input("notice-turn");
  await store.reserve(projectId,noticeSessionId,"other",other,{...grant(noticeSessionId),senderActorId:"other"},"");
  assert.equal((await store.list(projectId,noticeSessionId,1,undefined,"user")).items.length,1);
  const userPage=await store.list(projectId,noticeSessionId,1,undefined,"user");
  assert.equal((await store.list(projectId,noticeSessionId,10,userPage.nextCursor!,"user")).items.length,1);
  assert.equal((await store.list(projectId,noticeSessionId,10,undefined,"other")).items.length,1);
  assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM session_message_processing
    WHERE project_id=$1 AND session_id=$2`,[projectId,noticeSessionId])).rows[0].n,1);
});

test("a non-steerable steer is rejected and its exact content becomes one queued ordinary message",async()=>{
  const primaryMessageId=randomUUID(),primaryProcessingId=randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'sender','Primary turn','processing',1,now(),now())`,
    [projectId,primaryMessageId,randomUUID(),queueSessionId]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'agent','running','queue-turn',$6,1,now(),now())`,
    [projectId,primaryProcessingId,primaryMessageId,queueSessionId,randomUUID(),hash]);
  const command=input("queue-turn");
  const reserved=await store.reserve(projectId,queueSessionId,"user",command,grant(queueSessionId,1),"");
  assert.equal(reserved.record.mode,"steer");
  const queued=await store.rejectSteerAndQueue(projectId,command.inputId,"cannot steer a review turn");
  assert.equal(queued.state,"rejected");
  assert.equal(queued.nativeItemId,null);
  const rows=(await pool.query(`SELECT message_id,operation_id,target_kind,session_id,sender_actor_id,content,state
    FROM session_message WHERE project_id=$1 AND message_id=$2`,[projectId,command.inputId])).rows;
  assert.equal(rows.length,1);
  assert.deepEqual({...rows[0]},{
    message_id:command.inputId,operation_id:command.operationId,target_kind:"owned",session_id:queueSessionId,
    sender_actor_id:"user",content:command.content,state:"queued",
  },"the queued message reuses the original operation ID only in session_message, a separate table");
  assert.equal(queued.queuedMessageId,command.inputId);
  const repeated=await store.rejectSteerAndQueue(projectId,command.inputId,"repeat");
  assert.equal(repeated.state,"rejected");
  assert.equal(repeated.queuedMessageId,command.inputId,"a repeated answer still names the queued message");
  assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM session_message
    WHERE project_id=$1 AND operation_id=$2`,[projectId,command.operationId])).rows[0].n,1,
  "a repeated rejection cannot duplicate the queued message");
  // The steer was inserted into a message Turn, so its record carries that Turn's processing_id. A later read
  // (lost receipt, page refresh, CLI show, history) must still say "queued", or the person resends and the Leader gets it twice.
  assert.equal(reserved.record.source.processingId,primaryProcessingId);
  assert.equal((await store.get(projectId,command.inputId))?.queuedMessageId,command.inputId);
  const listed=(await store.list(projectId,queueSessionId,50)).items.find(x=>x.inputId===command.inputId);
  assert.equal(listed?.queuedMessageId,command.inputId);
  const replayed=await store.reserve(projectId,queueSessionId,"user",command,grant(queueSessionId,1),"");
  assert.equal(replayed.created,false);
  assert.equal(replayed.record.queuedMessageId,command.inputId,"a same-ID replay answers with the queued message");
});

test("terminal commit overtaking direct receipt binds original Turn without releasing a newer slot",async()=>{
  const command=input();
  await store.reserve(projectId,raceSessionId,"user",command,grant(raceSessionId),hash);
  await pool.query(`UPDATE session_message_processing SET state='running',native_turn_id='race-turn',
    version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2`,[projectId,command.inputId]);
  await pool.query(`UPDATE session_message_processing SET state='completed',version=version+1,updated_at=now()
    WHERE project_id=$1 AND message_id=$2`,[projectId,command.inputId]);
  await pool.query(`UPDATE session_message SET state='replied',version=version+1,updated_at=now()
    WHERE project_id=$1 AND message_id=$2`,[projectId,command.inputId]);
  assert.equal((await store.accept(projectId,command.inputId,"race-turn",null)).state,"accepted");
  const next=input();
  assert.equal((await store.reserve(projectId,raceSessionId,"user",next,grant(raceSessionId),hash)).record.state,"attempted");
  assert.equal((await store.get(projectId,next.inputId))?.state,"attempted");
});

test("lost native start acknowledgement keeps original slot and reconciles without resending",async()=>{
  const binding={projectId,sessionId:recoverySessionId,roleId,cwd:"/tmp/direct-test",authorizationScope:"project",
    nativeThreadId:`thread-${recoverySessionId}`,nativeSessionId:`native-${recoverySessionId}`,owner:"evoloop-codex-app-server" as const,
    resumeProfile:{actorId:"agent",model:null,sandbox:"danger-full-access" as const,approvalPolicy:"never" as const}};
  const command=input();let starts=0;
  const runtime={isReady:()=>true,registerBinding:async()=>{},qualifyConversationThread:async()=>({available:true,reason:"",fingerprint:hash}),
    capabilities:()=>({delivery:{midTurnInput:true,idleTurnStart:true}} as never),
    startConversationTurn:async()=>{starts++;throw new Error("lost ack");},
    steerTurn:async()=>{throw new Error("unexpected steer");},
    listTurns:async()=>({data:[{id:"recovered-turn",status:"inProgress",completedAtUtc:null}],nextCursor:null}),
    listItems:async()=>({data:[{id:"recovered-item",type:"userMessage",clientUserMessageId:command.inputId}],nextCursor:null})};
  const principal={actorId:"user",projectIds:[projectId],permissions:["read","write"]} as never;
  const service=new DirectInputService({store,runtime:()=>runtime,canWrite:()=>true,
    admission:async()=>({grant:grant(recoverySessionId),binding}),bindingFor:async()=>binding});
  assert.equal((await service.submit(principal,projectId,recoverySessionId,command)).state,"unknown");
  assert.equal((await service.submit(principal,projectId,recoverySessionId,command)).state,"unknown");
  assert.equal(starts,1);
  await assertQueued(store.reserve(projectId,recoverySessionId,"user",input(),grant(recoverySessionId),hash));
  const reconciled=await service.reconcile(principal,projectId,command.inputId);
  assert.equal(reconciled.state,"accepted");assert.equal(reconciled.actualTurnId,"recovered-turn");
  assert.equal(reconciled.nativeItemId,"recovered-item");assert.equal(starts,1);
});

test("HTTP keeps exact input and actor receipts while repeated steer uses the same native Turn",async()=>{
  const binding={projectId,sessionId:httpSessionId,roleId,cwd:"/tmp/direct-test",authorizationScope:"project",
    nativeThreadId:`thread-${httpSessionId}`,nativeSessionId:`native-${httpSessionId}`,owner:"evoloop-codex-app-server" as const,
    resumeProfile:{actorId:"agent",model:null,sandbox:"danger-full-access" as const,approvalPolicy:"never" as const}};
  const turn={id:"http-turn",status:"inProgress" as const,completedAtUtc:null};
  const writes:string[]=[];
  const runtime={isReady:()=>true,registerBinding:async()=>{},qualifyConversationThread:async()=>({available:true,reason:"",fingerprint:hash}),
    capabilities:()=>({delivery:{midTurnInput:true,idleTurnStart:true}} as never),
    startConversationTurn:async(_binding:unknown,_content:string,id:string)=>{writes.push(`start:${id}`);return turn;},
    steerTurn:async(_binding:unknown,_turnId:string,_content:string,id:string)=>{writes.push(`steer:${id}`);return {turnId:turn.id,itemId:null};},
    listTurns:async()=>({data:[turn],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
  let principal={actorId:"user",projectIds:[projectId],permissions:["read","write"]};
  let authorized=true;
  const service=new DirectInputService({store,runtime:()=>runtime,canWrite:()=>true,
    admission:async()=>{if(!authorized)throw new Error("revoked");return {grant:grant(httpSessionId,1),binding};},
    bindingFor:async()=>binding});
  const app=Fastify();app.decorateRequest("principal",null);
  app.addHook("onRequest",async request=>{request.principal=principal as never;});
  app.setErrorHandler((error,_request,reply)=>{reply.code(error.message==="revoked"?403:409).send({code:error.message});});
  registerDirectInputRoutes(app,service);
  const endpoint=`/api/projects/${projectId}/sessions/${httpSessionId}/direct-inputs`;
  try{
    const first=input();
    const started=await app.inject({method:"POST",url:endpoint,payload:first});
    assert.equal(started.statusCode,200);assert.equal(started.json().state,"accepted");
    assert.equal(started.json().source.kind,"message");
    assert.equal(started.json().content,undefined);
    const capability=await app.inject({method:"GET",url:`/api/projects/${projectId}/sessions/${httpSessionId}/direct-input-capability`});
    assert.equal(capability.json().available,true);assert.equal(capability.json().mode,"steer");
    assert.equal(capability.json().expectedTurnId,turn.id);
    for(let n=0;n<2;n++){
      const extra=input(turn.id);
      const receipt=await app.inject({method:"POST",url:endpoint,payload:extra});
      assert.equal(receipt.statusCode,200);assert.equal(receipt.json().source.id,first.inputId);
      assert.equal(receipt.json().actualTurnId,turn.id);
      assert.equal((await app.inject({method:"POST",url:endpoint,payload:extra})).json().inputId,extra.inputId);
    }
    assert.equal(writes.length,3);
    authorized=false;
    const denied=await app.inject({method:"POST",url:endpoint,payload:input(turn.id)});
    assert.equal(denied.statusCode,403);assert.equal(writes.length,3);
    const disabled=await app.inject({method:"GET",url:`/api/projects/${projectId}/sessions/${httpSessionId}/direct-input-capability`});
    assert.equal(disabled.json().available,false);
    principal={actorId:"other",projectIds:[projectId],permissions:["read","write"]};
    const privateRead=await app.inject({method:"GET",url:`${endpoint}/${first.inputId}`});
    assert.equal(privateRead.statusCode,409);
  }finally{await app.close();}
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();
  try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

test("idle reserve uses original processing slot and budget, unknown retains it, exact terminal frees it",async()=>{
  const first=input();
  const reserved=await store.reserve(projectId,sessionId,"user",first,grant(),hash);
  assert.equal(reserved.created,true);assert.equal(reserved.record.mode,"start");
  assert.equal(reserved.record.state,"attempted");
  assert.equal((await store.reserve(projectId,sessionId,"user",first,grant(),hash)).created,false);
  await store.unknown(projectId,first.inputId,"lost acknowledgement");
  // (A start refused while the primary is unknown is queued; its message then waits behind the recovery gate, so it is checked last.)
  const accepted=await store.accept(projectId,first.inputId,"turn-direct-1",null);
  assert.equal(accepted.state,"accepted");
  const supplement=input("turn-direct-1");
  const steered=await store.reserve(projectId,sessionId,"user",supplement,grant(sessionId,1),"");
  assert.equal(steered.record.mode,"steer");
  assert.equal(steered.record.source.id,first.inputId);
  assert.equal((await store.accept(projectId,supplement.inputId,"turn-direct-1","item-1")).nativeItemId,"item-1");
  const stale=input("wrong");
  const converted=await store.reserve(projectId,sessionId,"user",stale,grant(),"");
  assert.equal(converted.record.state,"rejected","a stale expected Turn is no longer an error: the text is queued once (TURN_CHANGED tests below)");
  assert.equal(converted.record.queuedMessageId,stale.inputId);
  const lateStart=input();
  assert.equal((await store.reserve(projectId,sessionId,"user",lateStart,grant(),"")).record.queuedMessageId,lateStart.inputId,"a start that finds a running Turn is queued, not an error");
  const processing=(await pool.query("SELECT * FROM session_message_processing WHERE project_id=$1 AND message_id=$2",
    [projectId,first.inputId])).rows[0];
  await pool.query(`UPDATE session_message_processing SET state='completed',version=version+1,updated_at=now()
    WHERE project_id=$1 AND processing_id=$2 AND version=$3`,[projectId,processing.processing_id,processing.version]);
  await pool.query(`UPDATE session_message SET state='replied',version=version+1,updated_at=now()
    WHERE project_id=$1 AND message_id=$2`,[projectId,first.inputId]);
  await assert.rejects(()=>store.reserve(projectId,sessionId,"user",input(),grant(sessionId,1),hash),/budget is exhausted/);
  const later=input();
  assert.equal((await store.reserve(projectId,sessionId,"user",later,grant(sessionId,2),hash)).record.state,"attempted");
  await assert.rejects(()=>pool.query(`UPDATE session_message_processing SET state='completed',version=version+1,
    updated_at=now() WHERE project_id=$1 AND processing_id=$2`,[projectId,processing.processing_id]),/immutable/);
  assert.equal((await store.get(projectId,later.inputId))?.state,"attempted");
  assert.equal((await store.list(projectId,sessionId,10)).items.length,5);
});

test("requested business Run blocks start, then two steers retain one original source",async()=>{
  const taskId=randomUUID(),revisionId=randomUUID(),basisId=randomUUID(),docId=randomUUID(),docRevisionId=randomUUID();
  const c=await pool.connect();
  try {await c.query("BEGIN");
  await c.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
    VALUES($1,$2,'Task',1,$3,$3,'task','published')`,[projectId,docId,docRevisionId]);
  await c.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,
    media_type,original_name,assets_manifest) VALUES($1,$2,$3,'Body','markdown',$4,'agent',now(),'fixture','text/markdown',
    'task.md','[]'::jsonb)`,[projectId,docId,docRevisionId,hash]);
  await c.query(`INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at)
    VALUES($1,$2,$3,$4,'agent','adopt',now())`,[projectId,randomUUID(),docId,docRevisionId]);
  await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,
    content_document_id,content_revision_id) VALUES($1,$2,1,$3,'Task','check',$6,'in_progress',NULL,$4,$5)`,
    [projectId,taskId,revisionId,docId,docRevisionId,roleId]);
  await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,
    actor_id,reason,created_at,kind,content_document_id,content_revision_id)
    VALUES($1,$2,$3,1,'Task','check',$7,'in_progress',$4,'agent','fixture',now(),NULL,$5,$6)`,
    [projectId,taskId,revisionId,basisId,docId,docRevisionId,roleId]);
  await c.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)",
    [projectId,taskId,revisionId,basisId]);
  await c.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id)
    VALUES($1,$2,$3,$4,$5,$6)`,[projectId,taskId,revisionId,basisId,docId,docRevisionId]);
  await c.query("UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND basis_set_id=$3",
    [projectId,taskId,basisId]);
  await c.query("COMMIT");}catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
  const runId=randomUUID(),runOperationId=randomUUID();
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
    input,input_hash,state,version,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'original task input',$8,'requested',1,'agent',now(),now())`,
    [projectId,runId,taskId,revisionId,basisId,otherSessionId,runOperationId,hash]);
  await assertQueued(store.reserve(projectId,otherSessionId,"user",input(),grant(otherSessionId),hash));
  await pool.query(`UPDATE runtime_run SET state='dispatching',version=version+1,updated_at=now()
    WHERE project_id=$1 AND run_id=$2`,[projectId,runId]);
  await assertQueued(store.reserve(projectId,otherSessionId,"user",input(),grant(otherSessionId),hash));
  await pool.query(`UPDATE runtime_run SET state='running',native_turn_id='business-turn',version=version+1,updated_at=now()
    WHERE project_id=$1 AND run_id=$2`,[projectId,runId]);
  for(let n=0;n<2;n++){
    const command=input("business-turn");
    const receipt=await store.reserve(projectId,otherSessionId,"user",command,grant(otherSessionId,1),"");
    assert.equal(receipt.record.source.kind,"run");assert.equal(receipt.record.source.id,runId);
    await store.accept(projectId,command.inputId,"business-turn",`user-item-${n}`);
  }
  const run=(await pool.query("SELECT task_revision_id,input_hash,state FROM runtime_run WHERE project_id=$1 AND run_id=$2",
    [projectId,runId])).rows[0];
  assert.equal(run.task_revision_id,revisionId);assert.equal(run.input_hash,hash);assert.equal(run.state,"running");
  assert.equal((await store.list(projectId,otherSessionId,10)).items.length,4,"two steers plus the two refused starts, each saved as a queued message");
});

test("an accepted start has no native Item until it is read back; the unbound list holds it, and recording the Item removes it",async()=>{
  const id=randomUUID(),turnId=`turn-${randomUUID()}`;
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/direct-test','project','danger-full-access','never','ready',1,$4,$5,$6,
    'agent',now(),now())`,[projectId,id,roleId,`thread-${id}`,`native-${id}`,randomUUID()]);
  const command=input();
  await store.reserve(projectId,id,"user",command,grant(id,5),hash);
  assert.ok(!(await store.unboundAccepted(50)).some(r=>r.inputId===command.inputId),"not accepted yet");
  const accepted=await store.accept(projectId,command.inputId,turnId,null);
  assert.equal(accepted.state,"accepted");assert.equal(accepted.nativeItemId,null);
  assert.ok((await store.unboundAccepted(50)).some(r=>r.inputId===command.inputId),"an accepted start without an Item is listed");
  const recorded=await store.accept(projectId,command.inputId,turnId,"item-1");
  assert.equal(recorded.nativeItemId,"item-1");
  assert.ok(!(await store.unboundAccepted(50)).some(r=>r.inputId===command.inputId),"once the Item is recorded it is not listed again");
  await assert.rejects(()=>store.accept(projectId,command.inputId,"another-turn","item-2"),/another Turn/);
  assert.equal((await store.get(projectId,command.inputId))!.nativeItemId,"item-1","the recorded Item is never replaced");
});

test("a held provider: an idle start is refused before anything is reserved, adding to a running Turn still goes through", async () => {
  const idle = randomUUID(), running = randomUUID();
  for (const id of [idle, running]) await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,
    native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at) VALUES($1,$2,$3,'/tmp/direct-test','project','danger-full-access','never','ready',1,$4,$5,$6,'agent',now(),now())`,
    [projectId, id, roleId, `thread-${id}`, `native-${id}`, randomUUID()]);
  const primary = randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'sender','Primary','processing',1,now(),now())`, [projectId, primary, randomUUID(), running]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,receiver_actor_id,state,native_turn_id,
    read_only_policy_fingerprint,version,started_at,updated_at) VALUES($1,$2,$3,$4,$5,'agent','running','turn-live',$6,1,now(),now())`, [projectId, randomUUID(), primary, running, randomUUID(), hash]);
  const provider = (await pool.query("SELECT runtime_provider FROM runtime_session WHERE session_id=$1", [idle])).rows[0].runtime_provider;
  await pool.query(`INSERT INTO runtime_provider_hold(project_id,hold_id,provider,state,category,reason,version,opened_at) VALUES($1,$2,$3,'held','quota_exhausted','balance',1,now())`,
    [projectId, randomUUID(), provider]);
  try {
    assert.equal(await store.providerHeld(projectId, idle), true);
    const start = input();
    await assert.rejects(store.reserve(projectId, idle, "user", start, grant(idle, 5), hash), { code: "PROVIDER_HELD" });
    assert.equal(await store.get(projectId, start.inputId), null, "nothing was reserved: no input record, no message");
    assert.equal((await pool.query("SELECT count(*)::int n FROM session_message WHERE message_id=$1", [start.inputId])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM session_message_processing WHERE session_id=$1", [idle])).rows[0].n, 0, "no new Turn was begun");
    const steer = await store.reserve(projectId, running, "user", input("turn-live"), grant(running, 5), "");
    assert.equal(steer.record.mode, "steer"); assert.equal(steer.record.state, "attempted", "adding to the running Turn is not a new start");
  } finally { await pool.query("UPDATE runtime_provider_hold SET state='released',released_at=now(),released_by='test',version=version+1 WHERE project_id=$1 AND state='held'", [projectId]); }
});

const messageCount=async(id:string,operationId:string)=>(await pool.query(`SELECT count(*)::integer AS n FROM session_message
  WHERE project_id=$1 AND (message_id=$2 OR operation_id=$3)`,[projectId,id,operationId])).rows[0].n;
async function running(id:string,turn:string){
  const messageId=randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'sender','Primary turn','processing',1,now(),now())`,[projectId,messageId,randomUUID(),id]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'agent','running',$6,$7,1,now(),now())`,[projectId,randomUUID(),messageId,id,randomUUID(),turn,hash]);
  return messageId;
}

test("TURN_CHANGED: a steer for a Turn that is no longer current becomes one queued message, and a repeat adds nothing",async()=>{
  const primary=await running(changedSessionId,"turn-now");
  const command=input("turn-before");
  const reserved=await store.reserve(projectId,changedSessionId,"user",command,grant(changedSessionId,5),"");
  assert.equal(reserved.created,true);
  assert.equal(reserved.record.state,"rejected"); assert.match(reserved.record.reason!,/^TURN_CHANGED/);
  assert.equal(reserved.record.queuedMessageId,command.inputId);
  const rows=(await pool.query(`SELECT message_id,operation_id,state,content FROM session_message WHERE project_id=$1 AND operation_id=$2`,[projectId,command.operationId])).rows;
  assert.deepEqual(rows.map(row=>({...row})),[{message_id:command.inputId,operation_id:command.operationId,state:"queued",content:command.content}],
    "the original input ID and operation ID, one message");
  const again=await store.reserve(projectId,changedSessionId,"user",command,grant(changedSessionId,5),"");
  assert.equal(again.created,false); assert.equal(again.record.inputId,command.inputId);
  assert.equal(await messageCount(command.inputId,command.operationId),1,"the same input ID twice is still one message");
  const read=await store.get(projectId,command.inputId);
  assert.equal(read?.state,"rejected"); assert.equal(read?.queuedMessageId,command.inputId,"the readback says it was queued");
  assert.equal((await store.list(projectId,changedSessionId,10)).items.find(x=>x.inputId===command.inputId)?.queuedMessageId,command.inputId);
  // The primary Turn is untouched: no second processing, no steer was recorded as sent.
  assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM session_message_processing WHERE project_id=$1 AND session_id=$2`,[projectId,changedSessionId])).rows[0].n,1);
  assert.ok(primary);
  // A plain refusal (no message saved) does not read as queued.
  const plain=input("turn-now");
  const steer=await store.reserve(projectId,changedSessionId,"user",plain,grant(changedSessionId,5),"");
  assert.equal(steer.record.mode,"steer"); assert.equal(steer.record.state,"attempted");
  const refused=await store.reject(projectId,plain.inputId,"native refused");
  assert.equal(refused.state,"rejected");
  assert.equal((await store.get(projectId,plain.inputId))?.queuedMessageId,null);
  // Changed the other way: a start that now finds a running Turn is provably unsent too, so it is queued the same way.
  const start=input();
  const late=await store.reserve(projectId,changedSessionId,"user",start,grant(changedSessionId,5),hash);
  assert.equal(late.record.mode,"start"); assert.equal(late.record.state,"rejected"); assert.equal(late.record.queuedMessageId,start.inputId);
  assert.equal(await messageCount(start.inputId,start.operationId),1);
  assert.equal((await store.reserve(projectId,changedSessionId,"user",start,grant(changedSessionId,5),hash)).created,false,"a repeat of the start is the same receipt");
  assert.equal((await store.get(projectId,start.inputId))?.queuedMessageId,start.inputId);
  assert.equal(await messageCount(start.inputId,start.operationId),1);
});

test("TURN_CHANGED: a steer whose Turn already ended on an idle Session is queued too",async()=>{
  const command=input("turn-gone");
  const reserved=await store.reserve(projectId,orderSessionId,"user",command,grant(orderSessionId,5),hash);
  assert.equal(reserved.record.state,"rejected"); assert.equal(reserved.record.queuedMessageId,command.inputId);
  assert.equal(await messageCount(command.inputId,command.operationId),1);
});

test("a person's insert on an idle Session takes the slot before a notice already waiting; the notice then waits its turn",async()=>{
  const notice=randomUUID(),noticeOperation=randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'coordinator','A Task was created for Leader triage','queued',1,now() - interval '1 minute',now() - interval '1 minute')`,
    [projectId,notice,noticeOperation,firstSessionId]);
  const command=input();
  const reserved=await store.reserve(projectId,firstSessionId,"user",command,grant(firstSessionId,5),hash);
  assert.equal(reserved.record.mode,"start"); assert.equal(reserved.record.state,"attempted");
  const processing=(await pool.query(`SELECT message_id,state FROM session_message_processing WHERE project_id=$1 AND session_id=$2
    AND state IN ('dispatching','running','unknown')`,[projectId,firstSessionId])).rows;
  assert.deepEqual(processing.map(row=>row.message_id),[command.inputId],"the person's input holds the only slot");
  assert.equal((await pool.query(`SELECT state FROM session_message WHERE project_id=$1 AND message_id=$2`,[projectId,notice])).rows[0].state,"queued",
    "the waiting notice is neither lost nor started beside it");
  await assert.rejects(pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'agent','dispatching',$6,1,now(),now())`,[projectId,randomUUID(),notice,firstSessionId,noticeOperation,hash]),
    "a second processing cannot occupy the Session");
});

test("a steer whose primary Turn is not bound yet is queued once and a repeat returns the same receipt",async()=>{
  const id=randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,
    native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at) VALUES($1,$2,$3,'/tmp/direct-test','project',
    'danger-full-access','never','ready',1,$4,$5,$6,'agent',now(),now())`,[projectId,id,roleId,`thread-${id}`,`native-${id}`,randomUUID()]);
  const messageId=randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'sender','Primary','processing',1,now(),now())`,[projectId,messageId,randomUUID(),id]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,receiver_actor_id,state,
    read_only_policy_fingerprint,version,started_at,updated_at) VALUES($1,$2,$3,$4,$5,'agent','dispatching',$6,1,now(),now())`,[projectId,randomUUID(),messageId,id,randomUUID(),hash]);
  const command=input("turn-seen");
  const reserved=await store.reserve(projectId,id,"user",command,grant(id,5),"");
  assert.equal(reserved.record.state,"rejected"); assert.match(reserved.record.reason!,/^NOT_BOUND/); assert.equal(reserved.record.queuedMessageId,command.inputId);
  const again=await store.reserve(projectId,id,"user",command,grant(id,5),"");
  assert.equal(again.created,false); assert.equal(again.record.queuedMessageId,command.inputId,"the replay inside reserve says queued too");
  assert.equal(await messageCount(command.inputId,command.operationId),1);
});

test("the ordinary message entry refuses an ID that is already a direct input and accepts one that was refused",async()=>{
  const accepted=input("turn-now");
  const reserved=await store.reserve(projectId,changedSessionId,"user",accepted,grant(changedSessionId,9),"");
  assert.equal(reserved.record.mode,"steer"); assert.equal(reserved.record.state,"attempted");
  const post=async(messageId:string)=>{
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      await new PgSessionMessages(c,projectId).insertSessionMessage({id:messageId,projectId,operationId:randomUUID(),
        target:{kind:"owned",sessionId:changedSessionId},senderActorId:"user",content:accepted.content,context:null,replyToMessageId:null,
        state:"queued",version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),blockedReason:null} as never);
      await c.query("COMMIT");
    }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
  };
  await assert.rejects(post(accepted.inputId),{code:"INPUT_ID_IS_DIRECT_INPUT"},"a direct input in flight is not queued again");
  await store.accept(projectId,accepted.inputId,"turn-now","item-1");
  await assert.rejects(post(accepted.inputId),{code:"INPUT_ID_IS_DIRECT_INPUT"},"nor after the runtime took it");
  const refused=input("turn-now");
  await store.reserve(projectId,changedSessionId,"user",refused,grant(changedSessionId,9),"");
  await store.reject(projectId,refused.inputId,"explicit refusal");
  await post(refused.inputId);
  assert.equal(await messageCount(refused.inputId,"00000000-0000-4000-8000-000000000000"),1,"a refused input's ID may become a message");
});
