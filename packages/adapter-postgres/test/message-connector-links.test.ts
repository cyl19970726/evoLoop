import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { ConnectorRoute, ConnectorTrustedAdmission } from "@evoloop/contracts/message-connectors";
import { migrate, PgConnectorMessageLinks, PgConnectorRoutes, PgConnectorDeliveryDecisions } from "../src/index.ts";
import { PgSessionMessages } from "../src/session-messages.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Connector link tests require a dedicated evoloop test database");
const schema = `el_link_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const routes = new PgConnectorRoutes(pool), links = new PgConnectorMessageLinks(pool);
const projectId = randomUUID(), sessionId = randomUUID();
const now = new Date().toISOString();
const capabilities = {history:true,search:false,subscribe:true,sendText:false,sendMedia:false,
  receipt:"none" as const};
const route: ConnectorRoute = {projectId,bindingId:randomUUID(),
  source:{provider:"wechat",connectionId:"test-connection",conversationId:"test-conversation"},
  targetSessionId:sessionId,targetActorId:"receiver",senderActorId:"gateway",owner:"owner-a",
  epoch:7,sessionRef:"wx-session-a",state:"disabled",mode:"standard",
  sendTargets:["test-conversation"],internalTargets:[],capabilities,policyHash:"a".repeat(64)};
let version = 1;
const admission = (eventCursor=11): ConnectorTrustedAdmission => ({
  projectId,bindingId:route.bindingId,routeVersion:version,
  source:{source:route.source,deliveryId:41,cursorStart:10,cursorEnd:12,eventCursor,
    participantId:"participant-a",replyToEventCursor:null},
  messageId:randomUUID(),messageOperationId:randomUUID(),decisionId:randomUUID(),
  content:"hello",gateway:{owner:route.owner,epoch:route.epoch,sessionRef:route.sessionRef},
});

before(async () => {
  await migrate(url!,schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Connector link',$2)",[projectId,now]);
  // The standard route requires this exact full, never, owned Session scope.
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,
    created_at,updated_at)
    VALUES($1,$2,'receiver','/tmp',$3,'danger-full-access','never','ready',1,'thread-link','native-link',$4,'receiver',$5,$5)`,
    [projectId,sessionId,`connector-standard:${route.bindingId}`,randomUUID(),now]);
  await routes.create(route,randomUUID(),"lead");
});

test("restricted Session creation still refuses an unrelated read-only scope", async () => {
  await assert.rejects(pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,
    authorization_scope,sandbox,approval_policy,state,version,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'receiver','/tmp','other:scope','read-only','never','preparing',1,$3,'receiver',$4,$4)`,
    [projectId,randomUUID(),randomUUID(),now]),/exact restricted connector receiver scope/);
});
after(async () => {
  await pool.end();
  const client = new pg.Client({connectionString:url});
  await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
});

test("disabled route refuses ingress without message, link, or journal",async () => {
  const intent=admission();
  await assert.rejects(links.admitTrusted(intent),/Exact active standard route/);
  assert.equal(await links.getByMessageId(projectId,intent.messageId),null);
  const rows=await pool.query(`SELECT count(*)::int AS n FROM operation_journal
    WHERE project_id=$1 AND operation_id=$2`,[projectId,intent.messageOperationId]);
  assert.equal(rows.rows[0].n,0);
});

test("standard active route admits once, joins unknown Turn, and rejects stale source",async () => {
  await routes.update({...route,version:2,state:"active"},1,randomUUID(),"lead");
  version=2;
  const intent=admission();
  const [first, concurrent]=await Promise.all([links.admitTrusted(intent),links.admitTrusted(intent)]);
  assert.deepEqual(concurrent,first);
  assert.equal(first.messageId,intent.messageId);
  assert.equal(first.messageState,"queued");
  assert.equal(first.processingId,null);
  assert.deepEqual(await links.getByMessageId(projectId,intent.messageId),first);
  assert.deepEqual(await links.getBySource(projectId,intent.source),first);
  assert.equal(await links.getBySource(randomUUID(),intent.source),null);
  await assert.rejects(pool.query(`INSERT INTO connector_message_link(project_id,binding_id,route_version,
    route_owner,route_epoch,route_session_ref,route_policy_hash,provider,connection_id,conversation_id,
    delivery_id,cursor_start,cursor_end,event_cursor,participant_id,reply_to_event_cursor,
    message_id,message_operation_id,decision_id)
    SELECT project_id,binding_id,route_version,'wrong-owner',route_epoch,route_session_ref,
      route_policy_hash,provider,connection_id,conversation_id,delivery_id,cursor_start,cursor_end,
      event_cursor,participant_id,reply_to_event_cursor,message_id,message_operation_id,$2
    FROM connector_message_link WHERE project_id=$1 AND message_id=$3`,
    [projectId,randomUUID(),intent.messageId]),/not active standard at exact version\/source/);
  assert.deepEqual(await links.admitTrusted(intent),first);
  await assert.rejects(links.admitTrusted({...intent,content:"changed"}),/different admission intent/);
  await assert.rejects(links.admitTrusted({...intent,messageId:randomUUID()}),/different admission intent/);
  const reusedOperation={...admission(12),messageOperationId:intent.messageOperationId};
  await assert.rejects(links.admitTrusted(reusedOperation),/already belongs to another intent/);
  assert.equal(await links.getBySource(projectId,reusedOperation.source),null);
  const count=await pool.query(`SELECT
    (SELECT count(*)::int FROM session_message WHERE project_id=$1 AND operation_id=$2) AS messages,
    (SELECT count(*)::int FROM connector_message_link WHERE project_id=$1 AND message_id=$3) AS links,
    (SELECT count(*)::int FROM operation_journal WHERE project_id=$1 AND operation_id=$2) AS operations`,
    [projectId,intent.messageOperationId,intent.messageId]);
  assert.deepEqual([count.rows[0].messages,count.rows[0].links,count.rows[0].operations],[1,1,1]);
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const store=new PgSessionMessages(client,projectId);
    await store.assertCurrentConnectorSource(intent.messageId,{bindingId:route.bindingId,
      mode:"standard",routeVersion:2,epoch:7,policyHash:route.policyHash});
    await assert.rejects(store.assertCurrentConnectorSource(intent.messageId,{bindingId:route.bindingId,
      mode:"standard",routeVersion:2,epoch:8,policyHash:route.policyHash}),/changed/);
    await client.query("COMMIT");
  } finally { client.release(); }
  const preflight=await pool.connect();
  try {
    await preflight.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await new PgSessionMessages(preflight,projectId).assertCurrentConnectorSource(intent.messageId,
      {bindingId:route.bindingId,mode:"standard",routeVersion:2,epoch:7,policyHash:route.policyHash});
    await preflight.query("COMMIT");
  } finally { preflight.release(); }
  const processingId=randomUUID(), processingOperationId=randomUUID();
  await pool.query(`UPDATE session_message SET state='processing',version=version+1,updated_at=now()
    WHERE project_id=$1 AND message_id=$2`,[projectId,intent.messageId]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,native_turn_id,response,failure,read_only_policy_fingerprint,
    version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'receiver','dispatching',NULL,NULL,NULL,$6,1,now(),now())`,
    [projectId,processingId,intent.messageId,sessionId,processingOperationId,route.policyHash]);
  await pool.query(`UPDATE session_message_processing SET state='unknown',native_turn_id='turn-link-1',
    version=version+1,updated_at=now() WHERE project_id=$1 AND processing_id=$2`,
    [projectId,processingId]);
  await pool.query(`UPDATE session_message SET state='unknown',version=version+1,updated_at=now()
    WHERE project_id=$1 AND message_id=$2`,[projectId,intent.messageId]);
  const unknown=await links.getByMessageId(projectId,intent.messageId);
  assert.equal(unknown?.messageState,"unknown");
  assert.equal(unknown?.processingId,processingId);
  assert.equal(unknown?.processingOperationId,processingOperationId);
  assert.equal(unknown?.processingState,"unknown");
  assert.equal(unknown?.nativeTurnId,"turn-link-1");
  const delivery=new PgConnectorDeliveryDecisions(pool);
  assert.deepEqual((await delivery.messages(projectId,route.bindingId,intent.source.deliveryId))
    .map(value=>[value.eventCursor,value.messageId,value.messageState,value.nativeTurnId]),
    [[intent.source.eventCursor,intent.messageId,'unknown','turn-link-1']]);
  assert.equal((await delivery.listRecent(projectId,route.bindingId,10))[0]?.deliveryId,intent.source.deliveryId);
  await pool.query(`UPDATE connector_route SET state='disabled',version=version+1
    WHERE project_id=$1 AND binding_id=$2`,[projectId,route.bindingId]);
  const retry=await links.admitTrusted(intent);
  assert.equal(retry.messageId,intent.messageId);
  assert.equal(retry.nativeTurnId,"turn-link-1");
  const stale=await pool.connect();
  try {
    await stale.query("BEGIN");
    await assert.rejects(new PgSessionMessages(stale,projectId).assertCurrentConnectorSource(
      intent.messageId,{bindingId:route.bindingId,mode:"standard",routeVersion:2,epoch:7,policyHash:route.policyHash}),/changed/);
    await stale.query("ROLLBACK");
  } finally { stale.release(); }
});
