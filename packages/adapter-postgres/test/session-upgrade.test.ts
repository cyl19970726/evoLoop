import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { PgSessionObservation } from "../src/session-observation.ts";
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
    const rows = await client.query(`SELECT ${table==='runtime_run'?"to_jsonb(t)-'execution_profile_snapshot'":"to_jsonb(t)"} AS row FROM ${table} t WHERE project_id=$1`, [projectId]);
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
  assert.deepEqual(await legacySnapshot(),before034,'034 may add a configured snapshot but must preserve all old columns');
  assert.deepEqual((await client.query('SELECT to_jsonb(c) AS row FROM session_observation_change c WHERE project_id=$1 ORDER BY sequence',[projectId])).rows,
    journalBefore034,'034 configured snapshot backfill must not invent a new native event');
  assert.equal((await client.query('SELECT sequence FROM session_observation_head WHERE project_id=$1',[projectId])).rows[0].sequence,headBefore034);
  const names034=(await client.query('SELECT name FROM pgmigrations ORDER BY run_on,name')).rows.map(row=>row.name);
  assert.equal(names034.length,33);assert.equal(names034.at(-1),'034_session_recovery');
  const legacyProfile=(await client.query('SELECT execution_profile_snapshot FROM runtime_run WHERE project_id=$1 AND run_id=$2',[projectId,runId])).rows[0].execution_profile_snapshot;
  assert.deepEqual({...legacyProfile,revisionId:undefined},{revisionId:undefined,version:1,model:'legacy-model',
    sandbox:'read-only',approvalPolicy:'on-request',cwd:'/legacy',authorizationScope:'old fixed scope',
    provenance:'legacy_session_identity'});
  assert.match(legacyProfile.revisionId,/^[0-9a-f-]{36}$/);
  assert.equal(sessionRecoveryCommands[0].safeParse({type:'runtime.session.executionProfile.revise',projectId,
    operationId:randomUUID(),sessionId,expectedVersion:1,
    expectedExecutionProfileRevisionId:legacyProfile.revisionId,model:'reviewed-model',
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
