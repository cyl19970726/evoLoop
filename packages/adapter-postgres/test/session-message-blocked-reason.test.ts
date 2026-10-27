import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';
import { SessionMessageService } from '@evoloop/core/session-messages';
import { SessionMessagePump } from '../../../apps/coordinator/src/session-messages/pump.ts';
import { sessionMessageCanStart } from '../../../apps/coordinator/src/session-messages/scheduling.ts';
import type { WorkflowService } from '@evoloop/core';
import type { Principal } from '@evoloop/contracts';
import type { SessionMessageRecord, SessionMessageDispatchGrant } from '@evoloop/contracts/session-messages';

const url=process.env.TEST_DATABASE_URL;
if(!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('blocked reason regression requires a dedicated evoLoop test database');
const schema=`el_blocked_${randomUUID().replaceAll('-','').slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const uow=new PostgresUnitOfWork(pool);
const projectId=randomUUID(),sessionId=randomUUID(),roleId=randomUUID(),messageId=randomUUID(),now='2026-10-26T00:00:00.000Z';
const principal:Principal={actorId:'reader',projectIds:[projectId],permissions:['read','write','review']};
const baseGrant:SessionMessageDispatchGrant={projectId,sessionId,senderActorId:'sender',receiverRoleId:roleId,
  receiverActorId:'receiver',cwd:'/tmp/evoloop-blocked-reason',maxTurns:3,enabled:true};
let currentGrant:SessionMessageDispatchGrant|null=baseGrant;
const service=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
  grantFor:async()=>currentGrant});
const message:SessionMessageRecord={projectId,id:messageId,operationId:randomUUID(),target:{kind:'owned',sessionId},
  senderActorId:'sender',content:'What changed?',context:null,replyToMessageId:null,state:'queued',version:1,
  blockedReason:null,readReceipt:null,createdAt:now,updatedAt:now};

before(async()=>{
  await migrate(url!,schema);
  await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)',[projectId,'Blocked reason test',now]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,'project','danger-full-access','never','ready',1,$5,$6,$7,'receiver',$8,$8)`,
    [projectId,sessionId,roleId,baseGrant.cwd,`thread-${sessionId}`,`native-${sessionId}`,randomUUID(),now]);
  await uow.transaction(projectId,tx=>tx.sessionMessages!.insertSessionMessage(message));
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();
  try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

test('stable blockers do not churn message revisions, observation head or journal; eligibility clears only at dispatch',async()=>{
  let readyQueue=false,configured=true,qualified=false,reason='Full execution profile is not verified';
  let starts=0,historyReads=0,qualifications=0,registrations=0;
  const errors:unknown[]=[];
  const native:{isReady:()=>boolean;registerBinding:()=>Promise<void>;qualifyConversationThread?:()=>Promise<{available:boolean;reason:string;fingerprint:string|null}>;
    startConversationTurn:()=>Promise<{id:string;status:string}>;listTurns:()=>Promise<{data:Array<{id:string;status:string;completedAtUtc:null}>;nextCursor:null}>;
    listItems:()=>Promise<{data:unknown[];nextCursor:null}>}={
      isReady:()=>true,registerBinding:async()=>{registrations++;},
      qualifyConversationThread:async()=>{qualifications++;return{available:qualified,reason,fingerprint:qualified?'a'.repeat(64):null};},
      startConversationTurn:async()=>{starts++;return{id:'fixture-native-turn',status:'inProgress'};},
      listTurns:async()=>{historyReads++;return{data:[{id:'fixture-native-turn',status:'inProgress',completedAtUtc:null}],nextCursor:null};},
      listItems:async()=>{historyReads++;return{data:[],nextCursor:null};},
    };
  const qualify=native.qualifyConversationThread;
  const queueId=randomUUID(),entryId=randomUUID();
  const workflow={listResidentQueues:async()=>readyQueue?[{id:queueId,version:1,adoptedVersion:1,actorId:'lead',entries:[
    {id:entryId,sessionId,state:'queued',holdCode:null,dependsOn:[],position:0}]}]:[]} as unknown as WorkflowService;
  const scheduler=sessionMessageCanStart({workflow,service,principals:async()=>[principal],onError:e=>errors.push(e)});
  const canStart=async(item:SessionMessageRecord)=>{
    if(!configured){await service.noteBlocked(item.projectId,item.id,'Ordinary message dispatch is disabled');return false;}
    return scheduler(item);
  };
  const pump=new SessionMessagePump({service,runtime:()=>native,projects:async()=>[projectId],canStart,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>errors.push(e)});
  const snapshot=async()=>{
    const m=await service.get(projectId,messageId);
    const head=(await pool.query('SELECT sequence FROM session_observation_head WHERE project_id=$1',[projectId])).rows[0]?.sequence;
    const changes=(await pool.query(`SELECT count(*)::int AS n FROM session_observation_change
      WHERE project_id=$1 AND message_id=$2 AND source_table='session_message'`,[projectId,messageId])).rows[0]?.n;
    return {state:m.state,version:m.version,updatedAt:m.updatedAt,blockedReason:m.blockedReason,
      readReceipt:m.readReceipt,head:String(head),changes};
  };
  const stable=async(expected:string)=>{
    const first=await snapshot();assert.equal(first.state,'queued');assert.equal(first.blockedReason,expected);
    assert.equal(first.readReceipt,null);
    await pump.tick();await pump.tick();await pump.tick();
    assert.deepEqual(await snapshot(),first,'repeated ticks must not rewrite an unchanged blocked reason or journal');
    assert.equal(await service.processing(projectId,messageId),null);
    assert.equal(starts,0);assert.equal(historyReads,0);assert.deepEqual(errors,[]);
  };
  await pump.tick();await stable('Full execution profile is not verified');
  let prior=await snapshot();reason='Full execution profile verification changed';await pump.tick();
  let changed=await snapshot();assert.equal(changed.version,prior.version+1);assert.equal(changed.changes,prior.changes+1);
  assert.equal(BigInt(changed.head),BigInt(prior.head)+1n);await stable(reason);

  prior=await snapshot();currentGrant=null;const beforeGrantQualification=qualifications;await pump.tick();
  changed=await snapshot();assert.equal(changed.version,prior.version+1);assert.equal(changed.changes,prior.changes+1);
  assert.equal(BigInt(changed.head),BigInt(prior.head)+1n);
  assert.match(changed.blockedReason??'',/grant is unavailable/);assert.equal(qualifications,beforeGrantQualification);
  await stable(changed.blockedReason!);

  currentGrant=baseGrant;configured=false;
  prior=await snapshot();await pump.tick();changed=await snapshot();
  assert.equal(changed.version,prior.version+1);assert.equal(changed.changes,prior.changes+1);
  assert.equal(BigInt(changed.head),BigInt(prior.head)+1n);
  assert.equal(changed.blockedReason,'Ordinary message dispatch is disabled');
  assert.equal(qualifications,beforeGrantQualification);await stable(changed.blockedReason!);

  configured=true;native.qualifyConversationThread=undefined;
  prior=await snapshot();await pump.tick();changed=await snapshot();
  assert.equal(changed.version,prior.version+1);assert.equal(changed.changes,prior.changes+1);
  assert.equal(BigInt(changed.head),BigInt(prior.head)+1n);
  assert.equal(changed.blockedReason,'Native Session execution profile verification is unavailable');
  assert.equal(qualifications,beforeGrantQualification);await stable(changed.blockedReason!);

  native.qualifyConversationThread=qualify;
  await pool.query(`INSERT INTO session_message_schedule(project_id,session_id,must_yield_business,updated_at)
    VALUES($1,$2,true,$3)`,[projectId,sessionId,now]);
  readyQueue=true;prior=await snapshot();await pump.tick();changed=await snapshot();
  assert.equal(changed.version,prior.version+1);assert.equal(changed.changes,prior.changes+1);
  assert.equal(BigInt(changed.head),BigInt(prior.head)+1n);
  assert.equal(changed.blockedReason,'Waiting for one ready Task turn after the previous ordinary message');
  assert.equal(qualifications,beforeGrantQualification);await stable(changed.blockedReason!);

  readyQueue=false;qualified=true;prior=await snapshot();await pump.tick();changed=await snapshot();
  assert.equal(changed.state,'processing');assert.equal(changed.version,prior.version+1);
  assert.equal(changed.blockedReason,null);assert.equal(changed.changes,prior.changes+1);
  assert.equal(starts,1);assert.equal((await service.processing(projectId,messageId))?.nativeTurnId,'fixture-native-turn');
  await pump.tick();await pump.tick();assert.equal(starts,1,'same message cannot start a second native Turn');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM session_message_processing
    WHERE project_id=$1 AND message_id=$2`,[projectId,messageId])).rows[0]?.n,1);
  assert.deepEqual(errors,[]);
  assert.ok(registrations>0);assert.ok(historyReads>0);
});
