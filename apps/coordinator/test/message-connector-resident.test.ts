import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';
import pg from 'pg';
import type {WorkflowService} from '@evoloop/core';
import {SessionMessageService} from '@evoloop/core/session-messages';
import type {RuntimeSessionRecord} from '@evoloop/contracts/runtime';
import type {ConnectorRoute, VersionedConnectorRoute} from '@evoloop/contracts/message-connectors';
import {migrate, PgConnectorRoutes, PgConnectorMessageLinks, PostgresUnitOfWork} from '@evoloop/adapter-postgres';
import {authConfigSchema} from '../src/auth.ts';
import {loadIntegrations} from '../src/configuration.ts';
import {currentConnectorBusinessActor} from '../src/message-connectors/business-actor.ts';
import {qualifyStandardConnectorRoute} from '../src/message-connectors/qualification.ts';
import {buildServer} from '../src/server.ts';
import {writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('A dedicated evoloop test database is required');
const schema=`el_resident_${randomUUID().replaceAll('-','').slice(0,12)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(), otherProjectId=randomUUID(),roleId=randomUUID(),roleRevision=randomUUID();
const sessionId=randomUUID(),otherSessionId=randomUUID(),bindingId=randomUUID();
const requester='reviewer',business='worker',sender='gateway';
const scope='resident:existing-role',cwd='/tmp';
const file=join(tmpdir(),`evoloop-connector-resident-${randomUUID()}.json`);
const conversation='approved-fixture-only';
const policyHash='a'.repeat(64);
const route:ConnectorRoute={projectId,bindingId,source:{provider:'wechat',connectionId:'fixture-connection',conversationId:conversation},
  conversationLabel:'Approved fixture only',conversationKind:'group',targetSessionId:sessionId,
  targetThreadId:`thread-${sessionId}`,
  targetActorId:business,senderActorId:sender,owner:'fixture-owner',epoch:1,
  sessionRef:'fixture-session',mode:'standard',state:'disabled',sendTargets:[conversation],
  senderIds:['external-person'],internalTargets:[],
  readScope:'project',
  capabilities:{history:true,search:false,subscribe:true,sendText:true,sendMedia:false,receipt:'local_observed'},policyHash};
const routes=new PgConnectorRoutes(pool),links=new PgConnectorMessageLinks(pool);
const credentials=authConfigSchema.parse([
  {token:'r'.repeat(40),actorId:requester,projectIds:[projectId],permissions:['read','write','review']},
  {token:'w'.repeat(40),actorId:business,projectIds:[projectId],permissions:['read','write']},
  {token:'g'.repeat(40),actorId:sender,projectIds:[projectId],permissions:['read','write']},
]);
let gatewayActive=true,nativeActive=true;
function config(){return {runtime:{enabled:true,grants:[{projectId,actorId:requester,roleId,
  authorizationScope:scope,cwd,sandbox:'danger-full-access',model:'gpt-6-sol',approvalPolicy:'never',networkAccess:true}],
  materialCli:[{projectId,sessionId,sessionActorId:requester,cliActorId:business,command:'/bin/true'}]},
  residentQueue:{enabled:true,roleActors:[{projectId,roleId,actorId:business}],actionGrants:[]},
  sessionMessages:{enabled:true,grants:[],connectorReceivers:[{projectId,bindingId,sessionId,mode:'standard',
    senderActorId:sender,receiverActorId:business,receiverRoleId:roleId,cwd,policyHash,maxTurns:10,enabled:true}]},
  messageConnectors:{enabled:true,gateway:{executable:'/bin/true',configPath:'/tmp/fixture.json'}}};}
const saveConfig=async(value:ReturnType<typeof config>)=>writeFile(file,JSON.stringify(value));
async function session(id:string):Promise<RuntimeSessionRecord|null>{
  const r=await pool.query('SELECT * FROM runtime_session WHERE project_id=$1 AND session_id=$2',[projectId,id]);
  const x=r.rows[0];if(!x)return null;
  return {projectId,id:x.session_id,roleId:x.role_id,cwd:x.cwd,authorizationScope:x.authorization_scope,
    model:x.model,sandbox:x.sandbox,approvalPolicy:x.approval_policy,state:x.state,version:x.version,
    nativeThreadId:x.native_thread_id,nativeSessionId:x.native_session_id,operationId:x.operation_id,
    actorId:x.actor_id,createdAt:new Date(x.created_at).toISOString(),updatedAt:new Date(x.updated_at).toISOString()} as RuntimeSessionRecord;
}
async function qualify(input:VersionedConnectorRoute){
  const current=await loadIntegrations(file);
  const receiving=await session(input.targetSessionId);
  return qualifyStandardConnectorRoute(input,receiving,current,{
    projectWriter:async(p,a)=>p===projectId&&credentials.some(x=>x.actorId===a&&x.permissions.includes('write')),
    businessActor:async(s,a)=>currentConnectorBusinessActor(s,a,current,pool,async(p,x)=>p===projectId&&
      credentials.some(v=>v.actorId===x&&v.permissions.includes('write'))),
    sessionAuthority:async s=>{
      const profile=await pool.query(`SELECT p.activation_state,p.revision_id,p.active_revision_id,
        r.authorization_scope,r.sandbox,r.approval_policy FROM session_execution_profile p
        JOIN session_execution_profile_revision r ON r.project_id=p.project_id AND r.session_id=p.session_id
          AND r.revision_id=p.revision_id WHERE p.project_id=$1 AND p.session_id=$2`,[projectId,s.id]);
      const x=profile.rows[0];return !!x&&x.activation_state==='active'&&x.revision_id===x.active_revision_id&&
        x.authorization_scope===s.authorizationScope&&x.sandbox===s.sandbox&&x.approval_policy===s.approvalPolicy&&
        current.hasRuntimeGrant({projectId,actorId:s.actorId,roleId:s.roleId,authorizationScope:s.authorizationScope,
          cwd:s.cwd,sandbox:s.sandbox,model:s.model,approvalPolicy:s.approvalPolicy});
    },
    cwdCurrent:async value=>value===cwd,nativeReady:async()=>nativeActive,
    gatewayBinding:async id=>gatewayActive?{conversation_id:id,owner:route.owner,epoch:route.epoch,
      control:'active',owner_session_ref:route.sessionRef,thread_id:route.targetThreadId}:null,
  });
}
let app:Awaited<ReturnType<typeof buildServer>>;
before(async()=>{
  await migrate(url!,schema);
  for(const id of [projectId,otherProjectId])await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Fixture',now())",[id]);
  const roleClient=await pool.connect();
  try{await roleClient.query('BEGIN');
  await roleClient.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,
    created_at_utc,review_at_utc,trial_started_at_utc) VALUES($1,$2,1,$3,'trial',$4,now(),now()+interval '1 day',now())`,
    [projectId,roleId,roleRevision,requester]);
  await roleClient.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,
    created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'trial','{}'::jsonb,$4,'fixture',now(),now()+interval '1 day')`,
    [projectId,roleId,roleRevision,requester]);
  await roleClient.query('COMMIT');}catch(error){await roleClient.query('ROLLBACK');throw error;}finally{roleClient.release();}
  for(const id of [sessionId,otherSessionId]){
    await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'gpt-6-sol','danger-full-access','never','ready',1,$6,$7,$8,$9,now(),now())`,
      [projectId,id,roleId,cwd,scope,`thread-${id}`,`native-${id}`,randomUUID(),requester]);
    await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,
      actor_id,note,created_at_utc) VALUES($1,$2,$3,$4,$5,$6,'fixture',now())`,
      [projectId,randomUUID(),roleId,id,roleRevision,requester]);
  }
  await saveConfig(config());
  app=await buildServer({credentials,service:{getProject:async()=>({}),listRoleRevisions:async()=>[],
    listRoleReviews:async()=>[],listRoleHandoffs:async()=>[],listRoleSessionBindings:async()=>[]} as unknown as WorkflowService,
    connectorRoutes:routes,canActivateConnectorRoute:qualify,canWrite:()=>true});
});
after(async()=>{await app?.close();await pool.end();await rm(file,{force:true});const c=new pg.Client({connectionString:url});
  await c.connect();try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

test('HTTP activation and trusted message admission use existing requester scope with separate business actor',async()=>{
  const path=`/api/projects/${projectId}/message-connectors/routes`;
  const headers={authorization:`Bearer ${'r'.repeat(40)}`};
  const created=await app.inject({method:'POST',url:path,headers,payload:{operationId:randomUUID(),route}});
  assert.equal(created.statusCode,200,created.body);
  const {createdAt: _createdAt,updatedAt: _updatedAt,...saved}=created.json().route;
  const active={...saved,state:'active',version:2};
  const enabled=await app.inject({method:'PUT',url:`${path}/${bindingId}`,headers,
    payload:{operationId:randomUUID(),expectedVersion:1,route:active}});
  assert.equal(enabled.statusCode,200,enabled.body);
  assert.equal(enabled.json().route.state,'active');
  const intent={projectId,bindingId,routeVersion:2,source:{source:route.source,deliveryId:1,cursorStart:1,
    cursorEnd:1,eventCursor:1,participantId:'external-person',replyToEventCursor:null},
    messageId:randomUUID(),messageOperationId:randomUUID(),decisionId:randomUUID(),content:'external text',
    gateway:{owner:route.owner,epoch:route.epoch,sessionRef:route.sessionRef}};
  const admitted=await links.admitTrusted(intent);
  assert.equal(admitted.messageState,'queued');
  assert.equal(admitted.messageId,intent.messageId);
  const messages=new SessionMessageService({uow:new PostgresUnitOfWork(pool),
    clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
    grantFor:async(message,receiver)=>{
      const link=await links.getByMessageId(message.projectId,message.id);
      const current=await routes.get(message.projectId,bindingId);
      if(!link||!current||!await qualify(current))return null;
      return {...config().sessionMessages.connectorReceivers[0]!,connector:{mode:'standard' as const,
        bindingId,routeVersion:link.routeVersion,epoch:link.routeEpoch,policyHash:link.routePolicyHash}};
    }});
  await messages.preflightDispatch(projectId,intent.messageId);
  assert.equal((await session(sessionId))?.authorizationScope,scope);
  assert.equal((await session(sessionId))?.actorId,requester);
  assert.equal((await session(otherSessionId))?.roleId,roleId);
  const wrong={...active,targetActorId:requester,version:3};
  assert.equal(await qualify(wrong),false);
  assert.equal(await qualify({...active,targetSessionId:otherSessionId,version:3}),false);
  assert.equal(await qualify({...active,targetThreadId:'other-thread',version:3}),false);
  assert.equal(await qualify({...active,projectId:otherProjectId,version:3}),false);
  const mismatchedBusiness=config();mismatchedBusiness.residentQueue.roleActors[0]!.actorId=requester;
  await saveConfig(mismatchedBusiness);
  assert.equal(await qualify({...active,version:3}),false);
  await saveConfig(config());
  const revoked=config();revoked.runtime.grants=[];await saveConfig(revoked);
  assert.equal(await qualify({...active,version:3}),false);
  await assert.rejects(messages.preflightDispatch(projectId,intent.messageId),/grant/);
  await saveConfig(config());
  nativeActive=false;assert.equal(await qualify({...active,version:3}),false);nativeActive=true;
  gatewayActive=false;assert.equal(await qualify({...active,version:3}),false);gatewayActive=true;
  const paused=await app.inject({method:'PUT',url:`${path}/${bindingId}`,headers,
    payload:{operationId:randomUUID(),expectedVersion:2,route:{...active,state:'paused',version:3}}});
  assert.equal(paused.statusCode,200,paused.body);
  await assert.doesNotReject(messages.preflightDispatch(projectId,intent.messageId));
  const repolicy=await app.inject({method:'PUT',url:`${path}/${bindingId}`,headers,
    payload:{operationId:randomUUID(),expectedVersion:3,route:{...active,state:'disabled',
      policyHash:'b'.repeat(64),version:4}}});
  assert.equal(repolicy.statusCode,200,repolicy.body);
  const repolicyConfig=config();repolicyConfig.sessionMessages.connectorReceivers[0]!.policyHash='b'.repeat(64);
  await saveConfig(repolicyConfig);
  await assert.rejects(messages.preflightDispatch(projectId,intent.messageId),/source/i);
});
