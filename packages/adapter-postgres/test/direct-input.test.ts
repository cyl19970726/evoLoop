import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import pg from "pg";
import Fastify from "fastify";
import { migrate } from "../src/index.ts";
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
  contentionSessionId=randomUUID(),roleId=randomUUID();
const grant=(id=sessionId,maxTurns=2)=>({projectId,sessionId:id,senderActorId:"user",receiverRoleId:roleId,
  receiverActorId:"agent",cwd:"/tmp/direct-test",maxTurns,enabled:true,canSteer:true,canStart:true});
const input=(expectedTurnId:string|null=null)=>({inputId:randomUUID(),operationId:randomUUID(),content:"Additional authorized detail",expectedTurnId});
const hash="a".repeat(64);

before(async()=>{
  await migrate(url!,schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Direct test',now())",[projectId]);
  for(const id of [sessionId,otherSessionId,httpSessionId,recoverySessionId,noticeSessionId,raceSessionId,contentionSessionId])await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,
    authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,
    created_at,updated_at) VALUES($1,$2,$3,'/tmp/direct-test','project','danger-full-access','never',
    'ready',1,$4,$5,$6,'agent',now(),now())`,[projectId,id,roleId,`thread-${id}`,`native-${id}`,randomUUID()]);
});

test("two simultaneous idle starts share one persistent slot",async()=>{
  const a=input(),b=input();
  const outcomes=await Promise.allSettled([store.reserve(projectId,contentionSessionId,"user",a,grant(contentionSessionId),hash),
    store.reserve(projectId,contentionSessionId,"user",b,grant(contentionSessionId),hash)]);
  assert.equal(outcomes.filter(x=>x.status==="fulfilled").length,1);
  assert.equal(outcomes.filter(x=>x.status==="rejected").length,1);
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
  await assert.rejects(()=>store.reserve(projectId,recoverySessionId,"user",input(),grant(recoverySessionId),hash),/not bound and running/);
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
  await assert.rejects(()=>store.reserve(projectId,sessionId,"user",input(),grant(),hash),/not bound and running/);
  await store.unknown(projectId,first.inputId,"lost acknowledgement");
  await assert.rejects(()=>store.reserve(projectId,sessionId,"user",input(),grant(),hash),/not bound and running/);
  const accepted=await store.accept(projectId,first.inputId,"turn-direct-1",null);
  assert.equal(accepted.state,"accepted");
  const supplement=input("turn-direct-1");
  const steered=await store.reserve(projectId,sessionId,"user",supplement,grant(sessionId,1),"");
  assert.equal(steered.record.mode,"steer");
  assert.equal(steered.record.source.id,first.inputId);
  assert.equal((await store.accept(projectId,supplement.inputId,"turn-direct-1","item-1")).nativeItemId,"item-1");
  await assert.rejects(()=>store.reserve(projectId,sessionId,"user",input("wrong"),grant(),""),/Expected Turn differs/);
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
  assert.equal((await store.list(projectId,sessionId,10)).items.length,3);
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
  await assert.rejects(()=>store.reserve(projectId,otherSessionId,"user",input(),grant(otherSessionId),hash),/not bound and running/);
  await pool.query(`UPDATE runtime_run SET state='dispatching',version=version+1,updated_at=now()
    WHERE project_id=$1 AND run_id=$2`,[projectId,runId]);
  await assert.rejects(()=>store.reserve(projectId,otherSessionId,"user",input(),grant(otherSessionId),hash),/not bound and running/);
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
  assert.equal((await store.list(projectId,otherSessionId,10)).items.length,2);
});
