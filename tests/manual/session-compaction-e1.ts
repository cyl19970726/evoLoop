/** Isolated HTTP candidate for an independent reviewer. Native calls are controlled substitutes. */
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile,chmod} from 'node:fs/promises';
import pg from 'pg';
import {migrate,PostgresUnitOfWork} from '@evoloop/adapter-postgres';
import {WorkflowService} from '@evoloop/core';
import {RuntimeUnknownError} from '@evoloop/adapter-codex-app-server';
import {CompactionMaintenance} from '../../apps/coordinator/src/runtime/compaction.js';
import {buildServer} from '../../apps/coordinator/src/server.js';
import type {RuntimeRunner} from '../../apps/coordinator/src/runtime/runner.js';
import type {RuntimeBinding,RuntimeCompactionObservation} from '@evoloop/contracts/runtime';

const url=process.env.TEST_DATABASE_URL;
const manifestPath=process.env.E1_MANIFEST_PATH;
if(!url||!/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname)||!manifestPath)
  throw Error('Set a dedicated TEST_DATABASE_URL and a private E1_MANIFEST_PATH');
const schema=`compact_e1_${randomUUID().replaceAll('-','').slice(0,12)}`;
await migrate(url,schema);
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),sessionId=randomUUID(),threadId=randomUUID(),messageId=randomUUID();
await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,now())',[projectId,'isolated compaction E1']);
await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,
  sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
  VALUES($1,$2,$3,'/tmp/compact-e1','project','gpt-6-astra','danger-full-access','never',
  'ready',1,$4,$5,$6,'owner',now(),now())`,
  [projectId,sessionId,randomUUID(),threadId,randomUUID(),randomUUID()]);
await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
  sender_actor_id,content,state,version,created_at,updated_at)
  VALUES($1,$2,$3,'owned',$4,'sender','known failed Turn fixture','failed',1,now(),now())`,
  [projectId,messageId,randomUUID(),sessionId]);
await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
  operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
  VALUES($1,$2,$3,$4,$5,'receiver','failed','old-turn',$6,1,now(),now())`,
  [projectId,randomUUID(),messageId,sessionId,randomUUID(),'a'.repeat(64)]);
await pool.query(`UPDATE session_recovery_gate SET phase='blocked',cause_kind='message',cause_id=$3,
  cause_state='failed',version=version+1 WHERE project_id=$1 AND session_id=$2`,
  [projectId,sessionId,messageId]);
const gateVersion=(await pool.query<{version:number}>(`SELECT version FROM session_recovery_gate
  WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId])).rows[0]!.version;
const binding:RuntimeBinding={projectId,sessionId,roleId:'fixture-role',cwd:'/tmp/compact-e1',
  authorizationScope:'project',nativeThreadId:threadId,nativeSessionId:'fixture-native',owner:'evoloop-codex-app-server',
  resumeProfile:{actorId:'owner',model:'gpt-6-astra',reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never'}};
const observation:RuntimeCompactionObservation={threadId,threadStatus:'idle',model:'gpt-6-astra',
  reasoningEffort:'max',latestTurnId:'old-turn',latestTurnStatus:'failed',
  latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:null,
  compactionItemCompleted:false,tokenUsage:null};
const runner={compactionBinding:async()=>binding,observeCompaction:async()=>observation,
  compactThread:async(_binding:RuntimeBinding,_baselineTurnId:string,beforeSend:(id:number)=>Promise<void>)=>{
    await beforeSend(17);throw new RuntimeUnknownError('thread/compact/start',17,'controlled lost reply');
  }} as unknown as RuntimeRunner;
const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},
  ids:{next:randomUUID},hasher:{hash:(value:string)=>value}});
const reviewerToken=randomBytes(32).toString('hex'),readerToken=randomBytes(32).toString('hex');
const app=await buildServer({service:workflow,compaction:new CompactionMaintenance(pool,runner),credentials:[
  {token:reviewerToken,actorId:'e1-maintainer',projectIds:[projectId],permissions:['read','write','review']},
  {token:readerToken,actorId:'e1-reader',projectIds:[projectId],permissions:['read']},
]});
const address=await app.listen({host:'127.0.0.1',port:Number(process.env.E1_PORT??55493)});
await writeFile(manifestPath,JSON.stringify({kind:'controlled-native-fixture',address,schema,projectId,sessionId,
  threadId,gateVersion,sessionVersion:1,messageId,reviewerToken,readerToken},null,2),{mode:0o600});
await chmod(manifestPath,0o600);
console.log(`E1 ready: ${address}; private manifest: ${manifestPath}`);
const shutdown=async()=>{await app.close();await pool.end();process.exit(0)};
process.once('SIGINT',()=>void shutdown());
process.once('SIGTERM',()=>void shutdown());
