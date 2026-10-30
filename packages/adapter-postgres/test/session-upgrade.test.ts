import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { PgSessionObservation } from "../src/session-observation.ts";
import { PgSessionRecovery } from "../src/session-recovery.ts";
import { sessionRecoveryCommands } from '@evoloop/contracts/session-recovery';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Session upgrade requires a dedicated evoloop_*_test database");

const schema = `el_upgrade_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const migrations = fileURLToPath(new URL("../migrations/", import.meta.url));
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), taskId = randomUUID(), taskRevisionId = randomUUID();
const documentId = randomUUID(), documentRevisionId = randomUUID(), basisSetId = randomUUID();
const roleId = randomUUID(), roleRevisionId = randomUUID(), sessionId = randomUUID();
const hostLinkId = randomUUID(), runId = randomUUID(), runEventId = randomUUID();
const failedSessionId=randomUUID(),failedRunId=randomUUID(),failedClaimId=randomUUID(),failedQueueId=randomUUID(),
  failedEntryId=randomUUID(),failedMessageId=randomUUID(),laterSessionId=randomUUID();
const recoveryScenarios={independentFailed:randomUUID(),independentInterrupted:randomUUID(),messageFailed:randomUUID(),
  runThenMessageSuccess:randomUUID(),messageThenRunFailure:randomUUID(),releasedOldOnly:randomUUID(),
  releasedThenIndependentFailure:randomUUID(),ambiguousTie:randomUUID(),committedTransition:randomUUID(),
  unknownRunLaterSuccess:randomUUID(),unknownMessageLaterSuccess:randomUUID(),
  independentFailureThenReleasedSuccess:randomUUID(),releasedSuccessThenIndependentFailure:randomUUID()};
const releasedLaterIndependentRunId=randomUUID();
const laterFailureAfterReleasedSuccessId=randomUUID();
const operationId = randomUUID();
const now = "2026-10-26T00:00:00.000Z";
const body = "# Legacy task\n\nKeep these exact bytes, including the trailing newline.\n";

const migrateTo029 = () => runner({ databaseUrl: url!, dir: migrations, migrationsTable: "pgmigrations", schema,
  createSchema: true, createMigrationsSchema: true, direction: "up", singleTransaction: true, count: 28, log: () => {} });
const migrateFour = () => runner({ databaseUrl:url!,dir:migrations,migrationsTable:'pgmigrations',schema,
  createSchema:true,createMigrationsSchema:true,direction:'up',singleTransaction:true,count:4,log:()=>{} });

const legacyTables = ["project", "process_document", "document_revision", "document_decision", "task", "task_revision",
  "basis_set", "basis_member", "task_document_link", "role_definition", "role_revision", "role_host_link",
  "role_host_link_revision", "runtime_session", "role_session_binding", "runtime_run", "runtime_record_event"] as const;

async function legacySnapshot(): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of legacyTables) {
    const rows = await client.query(`SELECT ${table==='runtime_run'?"to_jsonb(t)-'execution_profile_snapshot'":(table==='document_revision'?"to_jsonb(t)-'organization_review'":"to_jsonb(t)")}-'native_environment_epoch'-'observed_model'-'observed_provider' AS row FROM ${table} t WHERE project_id=$1`, [projectId]);
    result[table] = rows.rows.map(row => row.row).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

before(async () => {
  // The old baseline is the first 28 migration files; numbering has a gap, so
  // count refers to the ordered migration list rather than migration filename.
  await migrateTo029();
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Legacy upgrade fixture',$2)", [projectId, now]);
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
      VALUES($1,$2,'Legacy task body',1,$3,$3,'task','published')`, [projectId, documentId, documentRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,
      previous_revision_id,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,$4,'markdown',$5,'legacy-author',$6,NULL,'legacy fixed body','text/markdown','legacy-task.md','[]'::jsonb)`,
    [projectId, documentId, documentRevisionId, body, "a".repeat(64), now]);
    await client.query(`INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,'legacy-reviewer','previously adopted',$5)`,
    [projectId, randomUUID(), documentId, documentRevisionId, now]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,
      content_document_id,content_revision_id,domain_id)
      VALUES($1,$2,1,$3,'Legacy task','Preserve and read the fixed source', $4,'in_progress','implementation',$5,$6,NULL)`,
    [projectId, taskId, taskRevisionId, roleId, documentId, documentRevisionId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,kind,
      content_document_id,content_revision_id,basis_set_id,domain_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,'Legacy task','Preserve and read the fixed source',$4,'in_progress','implementation',$5,$6,$7,NULL,
      'legacy-author','original fixed revision',$8)`,
    [projectId, taskId, taskRevisionId, roleId, documentId, documentRevisionId, basisSetId, now]);
    await client.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)",
      [projectId, taskId, taskRevisionId, basisSetId]);
    await client.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id)
      VALUES($1,$2,$3,$4,$5,$6)`, [projectId, taskId, taskRevisionId, basisSetId, documentId, documentRevisionId]);
    await client.query("UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3",
      [projectId, taskId, taskRevisionId]);
    await client.query(`INSERT INTO task_document_link(project_id,link_id,task_id,document_id,actor_id,created_at)
      VALUES($1,$2,$3,$4,'legacy-author',$5)`, [projectId, randomUUID(), taskId, documentId, now]);

    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'active','legacy-author',$4,$4)`, [projectId, roleId, roleRevisionId, now]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'active',$4::jsonb,'legacy-author','legacy role',$5,$5)`,
    [projectId, roleId, roleRevisionId, JSON.stringify({ title: "Legacy role", roleClass: "business", independentResponsibility: "Work" }), now]);
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,approval_policy,
      state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/legacy','old fixed scope','legacy-model','read-only','on-request','ready',1,'native-thread-legacy',
      'native-session-legacy',$4,'legacy-author',$5,$5)`, [projectId, sessionId, roleId, operationId, now]);
    await client.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
      VALUES($1,$2,$3,$4,$5,'legacy-author','old binding',$6)`, [projectId, randomUUID(), roleId, sessionId, roleRevisionId, now]);
    await client.query(`INSERT INTO role_host_link(project_id,link_id,role_id,version,state) VALUES($1,$2,$3,1,'verified')`,
      [projectId, hostLinkId, roleId]);
    await client.query(`INSERT INTO role_host_link_revision(project_id,link_id,version,role_id,host,claimed_capabilities,
      verified_capabilities,evidence,observer,observed_at_utc,state,actor_id,reason,created_at_utc)
      VALUES($1,$2,1,$3,$4::jsonb,'["open","read"]'::jsonb,'["open","read"]'::jsonb,'legacy verification',
      'legacy-observer',$5,'verified','legacy-author','existing external HostLink',$5)`,
    [projectId, hostLinkId, roleId, JSON.stringify({ kind: "external", provider: "codex-desktop", ref: `codex://threads/${randomUUID()}` }), now]);
    await client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,
      input_hash,state,version,native_turn_id,interrupt_requested,result_summary,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'old fixed input',$8,'completed',1,'native-turn-legacy',false,'legacy result',
      'legacy-author',$9,$9)`,
    [projectId, runId, taskId, taskRevisionId, basisSetId, sessionId, randomUUID(), "b".repeat(64), now]);
    await client.query(`INSERT INTO runtime_record_event(project_id,event_id,run_id,session_id,kind,detail,native_turn_id,cursor,
      items_digest,actor_id,created_at)
      VALUES($1,$2,$3,$4,'run.completed','legacy event','native-turn-legacy','legacy-cursor','legacy-digest','legacy-author',$5)`,
    [projectId, runEventId, runId, sessionId, now]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
});

after(async () => {
  await client.end().catch(() => {});
  const cleanup = new pg.Client({ connectionString: url });
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await cleanup.end(); }
});

test("029 legacy authority survives 030-034 and recovery upgrade selects only current unresolved work", async () => {
  const beforeUpgrade = await legacySnapshot();
  const baseline = await client.query("SELECT name FROM pgmigrations ORDER BY run_on, name");
  assert.equal(baseline.rowCount, 28);
  assert.ok(baseline.rows.some(row => row.name === "029_task_closure_revisions"));

  await migrateFour();
  const afterUpgrade = await legacySnapshot();
  assert.deepEqual(afterUpgrade, beforeUpgrade, "legacy authoritative rows must be byte/value stable across the upgrade");
  const upgradedMigrations = await client.query("SELECT name FROM pgmigrations ORDER BY run_on, name");
  assert.equal(upgradedMigrations.rowCount, 32);
  assert.deepEqual(upgradedMigrations.rows.slice(-4).map(row => row.name), [
    "030_session_observation", "031_session_messages", "032_session_assignments", "033_allocation_relations_indexes",
  ]);
  await client.query('BEGIN');
  try{
    for(const id of [failedSessionId,laterSessionId,...Object.values(recoveryScenarios)]){
      await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,
        approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
        VALUES($1,$2,$3,'/legacy','old fixed scope','legacy-model','read-only','on-request','ready',1,
        $4,$4,$5,'legacy-author',$6,$6)`,[projectId,id,roleId,'native-'+id,randomUUID(),now]);
    }
    await client.query(`INSERT INTO resident_queue(project_id,queue_id,version,adopted_version,max_runs,adopted_by,adopted_at,reason,actor_id)
      VALUES($1,$2,1,1,3,'legacy-author',now(),'Original queue','legacy-author')`,[projectId,failedQueueId]);
    await client.query(`INSERT INTO resident_queue_entry(project_id,queue_id,entry_id,task_id,task_revision_id,
      source_input_json,session_id,role_id,position,consumer_id,use_required,release_rule,state,claim_id)
      VALUES($1,$2,$3,$4,$5,'{"fixed":true}',$6,$7,0,'consumer',false,'accepted','claimed',$8)`,
      [projectId,failedQueueId,failedEntryId,taskId,taskRevisionId,failedSessionId,roleId,failedClaimId]);
    await client.query(`INSERT INTO resident_queue_claim(project_id,queue_id,entry_id,claim_id,task_id,session_id,role_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[projectId,failedQueueId,failedEntryId,failedClaimId,taskId,failedSessionId,roleId]);
    await client.query(`INSERT INTO resident_queue_attempt(project_id,claim_id,sequence,run_id,operation_id,task_revision_id)
      VALUES($1,$2,1,$3,$4,$5)`,[projectId,failedClaimId,failedRunId,randomUUID(),taskRevisionId]);
    const oldRun=(id:string,sid:string,state:'running'|'failed'|'interrupted'|'unknown'|'completed',when:string)=>client.query(`INSERT INTO runtime_run
      (project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,
      version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'old fixed input',$8,$9,1,$11,'legacy-author',$10,$10)`,
      [projectId,id,taskId,taskRevisionId,basisSetId,sid,randomUUID(),'b'.repeat(64),state,when,'turn-'+id]);
    await oldRun(failedRunId,failedSessionId,'failed',now);
    await oldRun(randomUUID(),laterSessionId,'failed','2026-10-26T00:00:01.000Z');
    await oldRun(randomUUID(),laterSessionId,'completed','2026-10-26T00:00:02.000Z');
    await oldRun(randomUUID(),recoveryScenarios.independentFailed,'failed','2026-10-26T00:00:03.000Z');
    await oldRun(randomUUID(),recoveryScenarios.independentInterrupted,'interrupted','2026-10-26T00:00:03.000Z');
    const messageOutcome=async(sid:string,state:'running'|'unknown'|'failed'|'completed',when:string)=>{
      const messageId=randomUUID(),processingId=randomUUID();
      await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
        sender_actor_id,content,state,version,created_at,updated_at)
        VALUES($1,$2,$3,'owned',$4,'legacy-author','Historical M','queued',1,$5,$5)`,
        [projectId,messageId,randomUUID(),sid,when]);
      await client.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
        receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'legacy-author',$6,$7,$8,1,$9,$9)`,
        [projectId,processingId,messageId,sid,randomUUID(),state,'native-'+processingId,'a'.repeat(64),when]);
      return {messageId,processingId};
    };
    await messageOutcome(recoveryScenarios.messageFailed,'failed','2026-10-26T00:00:03.000Z');
    await oldRun(randomUUID(),recoveryScenarios.runThenMessageSuccess,'failed','2026-10-26T00:00:01.000Z');
    await messageOutcome(recoveryScenarios.runThenMessageSuccess,'completed','2026-10-26T00:00:02.000Z');
    await messageOutcome(recoveryScenarios.messageThenRunFailure,'completed','2026-10-26T00:00:01.000Z');
    await oldRun(randomUUID(),recoveryScenarios.messageThenRunFailure,'failed','2026-10-26T00:00:02.000Z');
    const releasedOldRun=randomUUID(),releasedThenIndependentOldRun=randomUUID();
    await oldRun(releasedOldRun,recoveryScenarios.releasedOldOnly,'failed','2026-10-26T00:00:01.000Z');
    await oldRun(releasedThenIndependentOldRun,recoveryScenarios.releasedThenIndependentFailure,'failed','2026-10-26T00:00:01.000Z');
    const releasedClaim=async(sid:string,rid:string)=>{
      const queue=randomUUID(),entry=randomUUID(),claim=randomUUID(),decision=randomUUID();
      await client.query(`INSERT INTO resident_queue(project_id,queue_id,version,adopted_version,max_runs,adopted_by,adopted_at,reason,actor_id)
        VALUES($1,$2,1,1,2,'legacy-author',now(),'Previously released','legacy-author')`,[projectId,queue]);
      await client.query(`INSERT INTO resident_queue_entry(project_id,queue_id,entry_id,task_id,task_revision_id,
        source_input_json,session_id,role_id,position,consumer_id,use_required,release_rule,state,claim_id)
        VALUES($1,$2,$3,$4,$5,'{"fixed":true}',$6,$7,0,'consumer',false,'bounded_decision','released',$8)`,
        [projectId,queue,entry,taskId,taskRevisionId,sid,roleId,claim]);
      await client.query(`INSERT INTO resident_queue_claim(project_id,queue_id,entry_id,claim_id,task_id,session_id,role_id,
        release_kind,bounded_decision_id,released_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'bounded',$8,now())`,[projectId,queue,entry,claim,taskId,sid,roleId,decision]);
      await client.query(`INSERT INTO resident_queue_attempt(project_id,claim_id,sequence,run_id,operation_id,task_revision_id)
        VALUES($1,$2,1,$3,$4,$5)`,[projectId,claim,rid,randomUUID(),taskRevisionId]);
      await client.query(`INSERT INTO resident_queue_release_decision(project_id,decision_id,claim_id,actor_id,reason,next_responsibility)
        VALUES($1,$2,$3,'legacy-author','Previously bounded','Reviewed externally')`,[projectId,decision,claim]);
    };
    await releasedClaim(recoveryScenarios.releasedOldOnly,releasedOldRun);
    await releasedClaim(recoveryScenarios.releasedThenIndependentFailure,releasedThenIndependentOldRun);
    await oldRun(releasedLaterIndependentRunId,recoveryScenarios.releasedThenIndependentFailure,'failed','2026-10-26T00:00:03.000Z');
    await oldRun(randomUUID(),recoveryScenarios.independentFailureThenReleasedSuccess,'failed','2026-10-26T00:00:01.000Z');
    const laterReleasedSuccess=randomUUID();
    await oldRun(laterReleasedSuccess,recoveryScenarios.independentFailureThenReleasedSuccess,'completed','2026-10-26T00:00:02.000Z');
    await releasedClaim(recoveryScenarios.independentFailureThenReleasedSuccess,laterReleasedSuccess);
    const earlierReleasedSuccess=randomUUID();
    await oldRun(earlierReleasedSuccess,recoveryScenarios.releasedSuccessThenIndependentFailure,'completed','2026-10-26T00:00:01.000Z');
    await releasedClaim(recoveryScenarios.releasedSuccessThenIndependentFailure,earlierReleasedSuccess);
    await oldRun(laterFailureAfterReleasedSuccessId,recoveryScenarios.releasedSuccessThenIndependentFailure,'failed','2026-10-26T00:00:02.000Z');
    await oldRun(randomUUID(),recoveryScenarios.ambiguousTie,'failed','2026-10-26T00:00:04.000Z');
    await messageOutcome(recoveryScenarios.ambiguousTie,'completed','2026-10-26T00:00:04.000Z');
    const transitionRun=randomUUID();
    await oldRun(transitionRun,recoveryScenarios.committedTransition,'running','2026-10-26T00:00:10.000Z');
    await client.query(`UPDATE runtime_run SET state='completed',version=2 WHERE project_id=$1 AND run_id=$2`,
      [projectId,transitionRun]);
    const transitionMessage=await messageOutcome(recoveryScenarios.committedTransition,'running','2026-10-26T00:00:01.000Z');
    await client.query(`UPDATE session_message_processing SET state='failed',version=2 WHERE project_id=$1 AND processing_id=$2`,
      [projectId,transitionMessage.processingId]);
    await oldRun(randomUUID(),recoveryScenarios.unknownRunLaterSuccess,'unknown','2026-10-26T00:00:01.000Z');
    await oldRun(randomUUID(),recoveryScenarios.unknownRunLaterSuccess,'completed','2026-10-26T00:00:02.000Z');
    await messageOutcome(recoveryScenarios.unknownMessageLaterSuccess,'unknown','2026-10-26T00:00:01.000Z');
    await oldRun(randomUUID(),recoveryScenarios.unknownMessageLaterSuccess,'completed','2026-10-26T00:00:02.000Z');
    await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'legacy-author','Original queued M','queued',1,$5,$5)`,
      [projectId,failedMessageId,randomUUID(),failedSessionId,now]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  const before034=await legacySnapshot();
  const journalBefore034=(await client.query(`SELECT to_jsonb(c) AS row FROM session_observation_change c
    WHERE project_id=$1 ORDER BY sequence`,[projectId])).rows;
  const headBefore034=(await client.query('SELECT sequence FROM session_observation_head WHERE project_id=$1',[projectId])).rows[0].sequence;
  await migrate(url!,schema);
  assert.deepEqual(await legacySnapshot(),before034,'upgrade may add nullable observation fields but must preserve all old columns');
  const legacyReviewMetadata=(await client.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE organization_review IS NOT NULL)::int AS invented FROM document_revision WHERE project_id=$1",[projectId])).rows[0];
  assert.ok(legacyReviewMetadata.total>0);
  assert.equal(legacyReviewMetadata.invented,0,"045 must not invent observation metadata for old Documents");
  const legacyModelObservation=(await client.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE observed_model IS NOT NULL OR observed_provider IS NOT NULL)::int AS invented
    FROM runtime_session WHERE project_id=$1`,[projectId])).rows[0];
  assert.ok(legacyModelObservation.total>0);
  assert.equal(legacyModelObservation.invented,0,
    '043 must leave native model and provider unknown for old Sessions');
  assert.deepEqual((await client.query('SELECT to_jsonb(c) AS row FROM session_observation_change c WHERE project_id=$1 ORDER BY sequence',[projectId])).rows,
    journalBefore034,'034 configured snapshot backfill must not invent a new native event');
  assert.equal((await client.query('SELECT sequence FROM session_observation_head WHERE project_id=$1',[projectId])).rows[0].sequence,headBefore034);
  const names034=(await client.query('SELECT name FROM pgmigrations ORDER BY run_on,name')).rows.map(row=>row.name);
  assert.deepEqual([...names034].sort(), readdirSync(migrations).filter(name=>name.endsWith('.mjs'))
    .map(name=>name.slice(0,-4)).sort(), 'upgrade must apply every current migration exactly once');
  assert.ok(names034.includes('038_native_observation') && names034.includes('039_reviewed_claim_rework')
    && names034.includes('040_task_acceptance_mode') && names034.includes('041_ordinary_run_submission')
    && names034.includes('042_leader_work_index'));
  assert.equal((await client.query('SELECT count(*)::int AS count FROM session_native_input_request')).rows[0].count,0,
    '037 must not invent native questions or reply intents from historical Sessions');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM session_native_observation')).rows[0].count,0,
    '038 must not infer native progress or usage from historical Sessions');
  assert.equal((await client.query('SELECT count(*)::int AS count FROM native_execution_environment')).rows[0].count,0,
    '035 must preserve legacy operation without inventing verified native ownership from ready Sessions');
  for(const table of ['runtime_session','runtime_run','session_message_processing'])
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE native_environment_epoch IS NOT NULL`)).rows[0].count,0,
      '035 must leave historical native environment evidence absent');
  const legacyProfile=(await client.query('SELECT execution_profile_snapshot FROM runtime_run WHERE project_id=$1 AND run_id=$2',[projectId,runId])).rows[0].execution_profile_snapshot;
  assert.deepEqual({...legacyProfile,revisionId:undefined},{revisionId:undefined,version:1,model:'legacy-model',
    sandbox:'read-only',approvalPolicy:'on-request',cwd:'/legacy',authorizationScope:'old fixed scope',
    provenance:'legacy_session_identity'});
  assert.match(legacyProfile.revisionId,/^[0-9a-f-]{36}$/);
  assert.equal(sessionRecoveryCommands[0].safeParse({type:'runtime.session.executionProfile.revise',projectId,
    operationId:randomUUID(),sessionId,expectedVersion:1,
    expectedExecutionProfileRevisionId:legacyProfile.revisionId,model:'reviewed-model',
    sandbox:'danger-full-access',approvalPolicy:'never',
    evidenceRef:'review://upgrade',reason:'Controlled legacy revision'}).success,true,
    'legacy SQL profile ID must satisfy the public UUID contract');
  const blocked=(await client.query('SELECT * FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2',
    [projectId,failedSessionId])).rows[0];
  assert.equal(blocked.phase,'blocked');assert.equal(blocked.cause_id,failedRunId);
  assert.equal(blocked.claim_id,failedClaimId);assert.equal(blocked.resume_message_id,failedMessageId);
  assert.equal((await client.query('SELECT phase FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2',
    [projectId,laterSessionId])).rows[0].phase,'open','old failed Run followed by later success must not be re-blocked');
  const recoveryRows=(await client.query(`SELECT session_id,phase,cause_kind,cause_id,cause_state,reason,claim_id
    FROM session_recovery_gate WHERE project_id=$1 AND session_id=ANY($2::uuid[])`,
    [projectId,Object.values(recoveryScenarios)])).rows;
  const recoveryBySession=new Map(recoveryRows.map(row=>[row.session_id as string,row]));
  for(const [name,expected] of Object.entries({independentFailed:'blocked',independentInterrupted:'blocked',
    messageFailed:'blocked',runThenMessageSuccess:'open',messageThenRunFailure:'blocked',
    releasedOldOnly:'open',releasedThenIndependentFailure:'blocked',ambiguousTie:'blocked',committedTransition:'blocked',
    unknownRunLaterSuccess:'blocked',unknownMessageLaterSuccess:'blocked',
    independentFailureThenReleasedSuccess:'open',releasedSuccessThenIndependentFailure:'blocked'})){
    assert.equal(recoveryBySession.get(recoveryScenarios[name as keyof typeof recoveryScenarios])?.phase,expected,name);
  }
  assert.equal(recoveryBySession.get(recoveryScenarios.messageFailed)?.cause_kind,'message');
  assert.equal(recoveryBySession.get(recoveryScenarios.independentInterrupted)?.cause_state,'interrupted');
  assert.equal(recoveryBySession.get(recoveryScenarios.releasedThenIndependentFailure)?.cause_id,releasedLaterIndependentRunId);
  assert.equal(recoveryBySession.get(recoveryScenarios.releasedSuccessThenIndependentFailure)?.cause_id,laterFailureAfterReleasedSuccessId);
  assert.match(recoveryBySession.get(recoveryScenarios.ambiguousTie)?.reason ?? '',/ambiguous|uncertain/i);
  assert.match(recoveryBySession.get(recoveryScenarios.committedTransition)?.reason ?? '',/sequence|transition/i);

  const projected = await client.query(`SELECT source_table,count(*)::int AS rows FROM session_observation_change
    WHERE project_id=$1 GROUP BY source_table`, [projectId]);
  const projectionCounts = new Map(projected.rows.map(row => [row.source_table as string, row.rows as number]));
  for (const source of ["task_revision", "role_revision", "role_host_link_revision", "runtime_session", "runtime_run", "runtime_record_event"])
    assert.ok((projectionCounts.get(source) ?? 0) > 0, `030 must backfill legacy ${source}`);
  assert.equal((await client.query("SELECT sequence FROM session_observation_head WHERE project_id=$1", [projectId])).rows.length, 1);

  const readPool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    const unitOfWork = new PostgresUnitOfWork(readPool);
    const oldRead = await unitOfWork.read(projectId, async reader => ({
      task: await reader.getTask(taskId), revision: await reader.getTaskRevision(taskId, taskRevisionId),
      document: await reader.getDocument(documentId), documentRevision: await reader.getDocumentRevision(documentId, documentRevisionId),
      basis: await reader.getBasisSet(taskId, taskRevisionId, basisSetId),
    }));
    assert.equal(oldRead.task?.content, body);
    assert.equal(oldRead.task?.currentRevisionId, taskRevisionId);
    assert.equal(oldRead.revision?.content, body);
    assert.equal(oldRead.documentRevision?.body, body);
    assert.deepEqual(oldRead.basis?.members, [{ documentId, revisionId: documentRevisionId }]);
  } finally { await readPool.end(); }

  const observationClient = await new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` }).connect();
  try {
    const observation = new PgSessionObservation(observationClient, projectId, JSON.stringify({ actorId: "reader", permissions: ["read"] }));
    const directory = await observation.directory({ limit: 10, membership: "current" });
    const session = directory.items.find(item => item.key === `external:${hostLinkId}`);
    assert.ok(session, "legacy verified HostLink appears in the unified directory");
    const history = await observation.history(`external:${hostLinkId}`, { limit: 50 });
    assert.ok(history?.items.some(item => item.source.kind === "host-link" && item.source.id === hostLinkId));
    assert.ok(history?.items.some(item => item.source.kind === "role" && item.source.id === roleId));
  } finally { observationClient.release(); }

  const projectionBeforeRepeat = await client.query(`SELECT to_jsonb(c) AS row FROM session_observation_change c WHERE project_id=$1 ORDER BY sequence`, [projectId]);
  await migrate(url!, schema);
  assert.deepEqual((await legacySnapshot()), before034, "repeat migration cannot alter old authorities");
  assert.deepEqual((await client.query("SELECT name FROM pgmigrations ORDER BY run_on, name")).rows.map(row=>row.name),names034);
  assert.deepEqual((await client.query(`SELECT to_jsonb(c) AS row FROM session_observation_change c WHERE project_id=$1 ORDER BY sequence`, [projectId])).rows,
    projectionBeforeRepeat.rows, "repeat migration cannot duplicate the legacy projection");
});

test('036 upgrades an idle legacy Session by immutable same-model revision without rewriting its Run or opening an unknown gate',async()=>{
  const oldRun=(await client.query('SELECT execution_profile_snapshot FROM runtime_run WHERE project_id=$1 AND run_id=$2',
    [projectId,runId])).rows[0].execution_profile_snapshot;
  const old=(await client.query('SELECT * FROM session_execution_profile_revision WHERE project_id=$1 AND session_id=$2 ORDER BY version',
    [projectId,sessionId])).rows[0];
  const revisionId=randomUUID(),operationId=randomUUID();
  const rejectedInsert=`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,
    approval_policy,state,version,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/legacy','project','legacy-model','read-only','on-request','reserved',1,$4,'legacy-author',now(),now())`;
  await assert.rejects(client.query(rejectedInsert,[projectId,randomUUID(),roleId,randomUUID()]),
    /full-access execution policy/);
  await assert.rejects(client.query(`UPDATE runtime_session SET sandbox='danger-full-access',approval_policy='never',
    version=version+1 WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]),
    /adopted immutable profile revision/);
  await client.query('BEGIN');
  try{
    const recovery=new PgSessionRecovery(client,projectId);
    await recovery.adoptExecutionProfile({projectId,sessionId,revisionId,version:2,previousRevisionId:old.revision_id,
      model:old.model,sandbox:'danger-full-access',approvalPolicy:'never',cwd:old.cwd,
      authorizationScope:old.authorization_scope,provenance:'revised',operationId,actorId:'legacy-reviewer',
      reason:'Reviewed full permission upgrade',evidenceRef:'review://full-policy',createdAt:new Date().toISOString()},1);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  const sessionAfter=(await client.query('SELECT version,model,sandbox,approval_policy FROM runtime_session WHERE project_id=$1 AND session_id=$2',
    [projectId,sessionId])).rows[0];
  assert.equal(sessionAfter.version,2);assert.equal(sessionAfter.model,old.model);
  assert.equal(sessionAfter.sandbox,'danger-full-access');assert.equal(sessionAfter.approval_policy,'never');
  assert.deepEqual((await client.query('SELECT * FROM session_execution_profile_revision WHERE project_id=$1 AND session_id=$2 AND revision_id=$3',
    [projectId,sessionId,old.revision_id])).rows[0],old,'old immutable revision is unchanged');
  assert.deepEqual((await client.query('SELECT execution_profile_snapshot FROM runtime_run WHERE project_id=$1 AND run_id=$2',
    [projectId,runId])).rows[0].execution_profile_snapshot,oldRun,'old Run keeps its launch policy');
  assert.equal((await client.query('SELECT phase FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2',
    [projectId,sessionId])).rows[0].phase,'open');
  await client.query('BEGIN');
  try{
    const recovery=new PgSessionRecovery(client,projectId);
    assert.equal(await recovery.beginExecutionProfileActivation(sessionId,revisionId,operationId),true,
      'vacant Session may activate its adopted profile without manufacturing a Run');
    await recovery.settleExecutionProfileActivation(sessionId,revisionId,'unknown','Lost native acknowledgement');
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  const gate=(await client.query('SELECT phase,cause_kind,cause_id,retry_run_id FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2',
    [projectId,sessionId])).rows[0];
  assert.equal(gate.phase,'blocked');assert.equal(gate.cause_kind,'execution_profile');
  assert.equal(gate.cause_id,revisionId);assert.equal(gate.retry_run_id,null);
  await assert.rejects(client.query(`UPDATE runtime_session SET sandbox='read-only',approval_policy='on-request',
    version=version+1 WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]),
    /adopted immutable profile revision/);
});

test('036 standalone activation of a second idle legacy Session keeps an open gate open only after confirmed settlement',async()=>{
  const before=(await client.query(`SELECT s.version,s.model,s.sandbox,s.approval_policy,s.cwd,s.authorization_scope,
    p.revision_id,p.version AS profile_version FROM runtime_session s
    JOIN session_execution_profile h ON h.project_id=s.project_id AND h.session_id=s.session_id
    JOIN session_execution_profile_revision p ON p.project_id=h.project_id AND p.session_id=h.session_id AND p.revision_id=h.revision_id
    WHERE s.project_id=$1 AND s.session_id=$2`,[projectId,laterSessionId])).rows[0];
  assert.equal(before.sandbox,'read-only');assert.equal(before.approval_policy,'on-request');
  const revisionId=randomUUID(),operationId=randomUUID(),recovery=new PgSessionRecovery(client,projectId);
  await client.query('BEGIN');
  try{
    await recovery.adoptExecutionProfile({projectId,sessionId:laterSessionId,revisionId,
      version:before.profile_version+1,previousRevisionId:before.revision_id,model:before.model,
      sandbox:'danger-full-access',approvalPolicy:'never',cwd:before.cwd,
      authorizationScope:before.authorization_scope,provenance:'revised',operationId,
      actorId:'legacy-reviewer',reason:'Reviewed second full policy',evidenceRef:'review://second',
      createdAt:new Date().toISOString()},before.version);
    assert.equal(await recovery.beginExecutionProfileActivation(laterSessionId,revisionId,operationId),true);
    assert.equal((await recovery.getRecoveryGate(laterSessionId))!.phase,'open');
    await recovery.settleExecutionProfileActivation(laterSessionId,revisionId,'active','Exact original Thread confirmed');
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  const after=(await client.query(`SELECT h.activation_state,h.active_revision_id,g.phase,g.cause_id
    FROM session_execution_profile h JOIN session_recovery_gate g
      ON g.project_id=h.project_id AND g.session_id=h.session_id
    WHERE h.project_id=$1 AND h.session_id=$2`,[projectId,laterSessionId])).rows[0];
  assert.equal(after.activation_state,'active');assert.equal(after.active_revision_id,revisionId);
  assert.equal(after.phase,'open');assert.equal(after.cause_id,null);
});
