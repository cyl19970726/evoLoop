import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,before,test} from 'node:test';
import pg from 'pg';
import {migrate,PgConnectorRoutes,PgConnectorDeliveryDecisions} from '../src/index.ts';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('Connector decision tests require a dedicated evoloop test database');
const schema=`el_delivery_${randomUUID().replaceAll('-','').slice(0,12)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),sessionId=randomUUID(),bindingId=randomUUID();
before(async()=>{
  await migrate(url!,schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Connector',now())",[projectId]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'worker','/tmp','project','danger-full-access','never','ready',1,'thread','native',$3,'receiver',now(),now())`,
    [projectId,sessionId,randomUUID()]);
  await new PgConnectorRoutes(pool).create({projectId,bindingId,
    source:{provider:'wechat',connectionId:'test',conversationId:'a'.repeat(32)},
    conversationLabel:'Test conversation',conversationKind:'group',targetSessionId:sessionId,targetThreadId:'thread',
    targetActorId:'receiver',senderActorId:'gateway',
    owner:'owner',epoch:1,sessionRef:'session',mode:'standard',readScope:'project',
    sendTargets:['a'.repeat(32)],senderIds:['participant-a'],
    internalTargets:[],state:'disabled',capabilities:{history:true,search:false,subscribe:true,
      sendText:true,sendMedia:false,receipt:'none'},policyHash:'a'.repeat(64)},randomUUID(),'lead');
});
after(async()=>{
  await pool.end();
  const client=new pg.Client({connectionString:url});await client.connect();
  try{await client.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await client.end();}
});

test('one saved send attempt survives a new store instance and refuses changed text',async()=>{
  const store=new PgConnectorDeliveryDecisions(pool);
  const claimRoute={owner:'owner',epoch:1,sessionRef:'session',policyHash:'a'.repeat(64),
    targetThreadId:'thread'};
  assert.equal(await store.markClaimAttempted(projectId,bindingId,7,1,claimRoute),true);
  assert.deepEqual(await store.claim(projectId,bindingId,7),{routeVersion:1,routeOwner:'owner',
    routeEpoch:1,routeSessionRef:'session',routePolicyHash:'a'.repeat(64),targetThreadId:'thread',observed:false,
    owner:null,epoch:null,cursorStart:null,cursorEnd:null});
  assert.equal(await store.markClaimAttempted(projectId,bindingId,7,1,claimRoute),false);
  assert.equal(await store.markClaimObserved(projectId,bindingId,7,1,{owner:'owner',epoch:1,
    cursorStart:2,cursorEnd:2}),true);
  assert.deepEqual(await store.claim(projectId,bindingId,7),{routeVersion:1,routeOwner:'owner',
    routeEpoch:1,routeSessionRef:'session',routePolicyHash:'a'.repeat(64),targetThreadId:'thread',observed:true,
    owner:'owner',epoch:1,cursorStart:2,cursorEnd:2});
  assert.equal(await store.markReserve(projectId,bindingId,7,1),true);
  assert.equal(await new PgConnectorDeliveryDecisions(pool).markReserve(projectId,bindingId,7,1),false);
  assert.equal(await store.markRecord(projectId,bindingId,7,1,'native-turn'),true);
  assert.equal(await store.markRecord(projectId,bindingId,7,1,'native-turn'),false);
  assert.equal(await store.markFinish(projectId,bindingId,7,1,'completed'),true);
  assert.equal(await store.markFinish(projectId,bindingId,7,1,'completed'),false);
  assert.deepEqual(await store.transport(projectId,bindingId,7),{routeVersion:1,recordTurnId:'native-turn',
    finishStatus:'completed'});
  const intent={projectId,bindingId,deliveryId:7,routeVersion:1,
    routeOwner:'owner',routeEpoch:1,routeSessionRef:'session',conversationId:'a'.repeat(32),
    cursorStart:2,cursorEnd:2,
    decision:'reply' as const,requestId:'original-request',content:'response'};
  assert.equal((await store.prepare(intent)).state,'prepared');
  assert.equal(await store.markAttempted({...intent,state:'prepared'}),true);
  assert.equal(await new PgConnectorDeliveryDecisions(pool).markAttempted({...intent,state:'prepared'}),false);
  assert.equal((await store.get(projectId,bindingId,7))?.state,'attempted');
  await assert.rejects(store.prepare({...intent,content:'different'}),/different decision/);
  await store.markObserved({...intent,state:'attempted'});
  assert.equal((await store.get(projectId,bindingId,7))?.state,'observed');
  assert.equal(await store.markCompleteAttempted({...intent,state:'observed'}),true);
  assert.equal((await store.get(projectId,bindingId,7))?.state,'complete_attempted');
  assert.equal(await store.markCompleted({...intent,state:'complete_attempted'},{owner:'owner',epoch:1,
    sessionRef:'session',conversationId:'a'.repeat(32),cursorStart:2,cursorEnd:3}),false);
  assert.equal(await store.markCompleted({...intent,state:'complete_unknown'},{owner:'owner',epoch:1,
    sessionRef:'session',conversationId:'a'.repeat(32),cursorStart:2,cursorEnd:2}),true);
  assert.equal((await store.get(projectId,bindingId,7))?.state,'completed');
  const [recent]=await store.listRecent(projectId,bindingId,10);
  assert.equal(recent?.deliveryId,7);
  assert.equal(recent?.latestMessageState,'completed');
  assert.equal(recent?.decision?.state,'completed');
});
