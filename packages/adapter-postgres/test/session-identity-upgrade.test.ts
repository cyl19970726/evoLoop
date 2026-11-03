import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { migrate } from '../src/index.ts';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('Session identity upgrade requires a dedicated evoloop_*_test database');
const schema=`el_identity_upgrade_${randomUUID().replaceAll('-','').slice(0,12)}`;
const migrations=fileURLToPath(new URL('../migrations/',import.meta.url));
const client=new pg.Client({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),roleId=randomUUID(),roleRevisionId=randomUUID(),linkId=randomUUID(),noProfileLinkId=randomUUID();
const now='2026-10-26T00:00:00.000Z';

before(async()=>{
  const count=readdirSync(migrations).filter(name=>/^\d{3}_.*\.mjs$/.test(name)&&Number(name.slice(0,3))<=51).length;
  await runner({databaseUrl:url!,dir:migrations,migrationsTable:'pgmigrations',schema,
    createSchema:true,createMigrationsSchema:true,direction:'up',singleTransaction:true,count,log:()=>{}});
  await client.connect();
  await client.query('BEGIN');
  await client.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)',[projectId,'Existing identity profile',now]);
  await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
    VALUES($1,$2,1,$3,'active','lead',$4,$4)`,[projectId,roleId,roleRevisionId,now]);
  await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
    VALUES($1,$2,$3,1,'active','{}'::jsonb,'lead','original',$4,$4)`,[projectId,roleId,roleRevisionId,now]);
  await client.query("INSERT INTO role_host_link(project_id,link_id,role_id,version,state) VALUES($1,$2,$3,1,'verified')",[projectId,linkId,roleId]);
  await client.query(`INSERT INTO role_host_link_revision(project_id,link_id,version,role_id,host,claimed_capabilities,
    verified_capabilities,state,actor_id,reason,created_at_utc)
    VALUES($1,$2,1,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb,'verified','lead','original',$5)`,
    [projectId,linkId,roleId,JSON.stringify({kind:'external',provider:'codex-desktop',ref:`chat:${linkId}`}),now]);
  await client.query(`INSERT INTO session_profile(project_id,target_kind,target_id,version,display_name,purpose,membership,tenure,
    actor_id,reason,updated_at) VALUES($1,'external',$2,1,'Original name','Original purpose','current','temporary','lead','original',$3)`,
    [projectId,linkId,now]);
  await client.query('INSERT INTO session_profile_revision SELECT * FROM session_profile WHERE project_id=$1 AND target_id=$2',[projectId,linkId]);
  await client.query("INSERT INTO role_host_link(project_id,link_id,role_id,version,state) VALUES($1,$2,$3,1,'verified')",[projectId,noProfileLinkId,roleId]);
  await client.query(`INSERT INTO role_host_link_revision(project_id,link_id,version,role_id,host,claimed_capabilities,
    verified_capabilities,state,actor_id,reason,created_at_utc)
    VALUES($1,$2,1,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb,'verified','lead','original',$5)`,
    [projectId,noProfileLinkId,roleId,JSON.stringify({kind:'external',provider:'codex-desktop',ref:`chat:${noProfileLinkId}`}),now]);
  await client.query('COMMIT');
});
after(async()=>{
  await client.end().catch(()=>{});
  const admin=new pg.Client({connectionString:url});await admin.connect();
  try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
});

test('052 appends a visual profile revision and preserves existing metadata and old revision',async()=>{
  await migrate(url!,schema);
  const current=(await client.query('SELECT * FROM session_profile WHERE project_id=$1 AND target_id=$2',[projectId,linkId])).rows[0];
  assert.deepEqual([current.version,current.display_name,current.purpose,current.membership,current.tenure],
    [2,'Original name','Original purpose','current','temporary']);
  assert.ok(current.identity_color&&current.identity_mark);
  const history=(await client.query(`SELECT version,display_name,identity_color,identity_mark FROM session_profile_revision
    WHERE project_id=$1 AND target_id=$2 ORDER BY version`,[projectId,linkId])).rows;
  assert.deepEqual(history.map(row=>row.version),[1,2]);
  assert.equal(history[0].identity_color,null);
  assert.deepEqual([history[1].identity_color,history[1].identity_mark],[current.identity_color,current.identity_mark]);
  const newProfile=(await client.query('SELECT version,identity_color,identity_mark FROM session_profile WHERE project_id=$1 AND target_id=$2',
    [projectId,noProfileLinkId])).rows[0];
  assert.equal(newProfile.version,1,'a previously unprofiled Session starts at revision one');
  assert.ok(newProfile.identity_color&&newProfile.identity_mark);
  const newHistory=(await client.query('SELECT version FROM session_profile_revision WHERE project_id=$1 AND target_id=$2 ORDER BY version',
    [projectId,noProfileLinkId])).rows;
  assert.deepEqual(newHistory.map(row=>row.version),[1],'the first persisted profile has a matching immutable revision');
});
