import assert from 'node:assert/strict';
import { randomUUID as id } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';
import { PgSessionObservation } from '../src/session-observation.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('Allocation invalidation requires a dedicated evoloop_*_test database');
const schema = `el_invalidation_${id().replaceAll('-', '').slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const project = id(), role = id(), roleRevision = id(), goal = id(), doc = id(), revision = id();
const discussion = id(), decision = id(), stage = id(), stageRevision = id();
const now = '2026-10-26T00:00:00.000Z';

before(async () => {
  await migrate(url!, schema);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Invalidation',$2)", [project, now]);
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'active','lead',$4,$4)`, [project, role, roleRevision, now]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'active','{}','lead','fixture',$4,$4)`, [project, role, roleRevision, now]);
    await c.query(`INSERT INTO project_goal(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,created_at)
      VALUES($1,$2,1,'outcome','none','lead','lead','test','lead','lead',$3)`, [project, goal, now]);
    await c.query(`INSERT INTO goal_revision(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,reason,created_at)
      VALUES($1,$2,1,'outcome','none','lead','lead','test','lead','lead','fixture',$3)`, [project, goal, now]);
    await c.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id)
      VALUES($1,$2,'Discussion body',1,$3)`, [project, doc, revision]);
    await c.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'Body','markdown',$4,'lead',$5,'fixture')`, [project, doc, revision, 'a'.repeat(64), now]);
    await c.query(`INSERT INTO project_stage(project_id,stage_id,goal_id,version,deliverable,learning_question,state,actor_id,created_at)
      VALUES($1,$2,$3,1,'Result','Question','proposed','lead',$4)`, [project, stage, goal, now]);
    await c.query(`INSERT INTO stage_revision(project_id,stage_id,revision_id,version,state,deliverable,learning_question,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,'proposed','Result','Question','lead','fixture',$4)`, [project, stage, stageRevision, now]);
    await c.query(`INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,prepared_document_revision_id,
      current_document_revision_id,latest_decision_event_id,goal_id,goal_version,question,options,authorization_boundary,
      target_session_label,actor_id,created_at,updated_at)
      VALUES($1,$2,5,'allocation','linked',$3,$4,$4,$5,$6,1,'Question','[]','lead','lead','lead',$7,$7)`,
      [project, discussion, doc, revision, decision, goal, now]);
    await c.query(`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,actor_id,created_at,choice)
      VALUES($1,$2,$3,1,'decision',$4,$5,'lead',$6,'Select')`, [project, discussion, decision, doc, revision, now]);
    for (const [kind, target, fixed, version] of [['role', role, roleRevision, 2], ['document', doc, revision, 3], ['stage', stage, null, 4]] as const)
      await c.query(`INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,
        actor_id,created_at,decision_event_id,target_kind,target_id,target_revision_id,target_version)
        VALUES($1,$2,$3,$4,'action',$5,$6,'lead',$7,$8,$9,$10,$11,$12)`,
        [project, discussion, id(), version, doc, revision, now, decision, kind, target, fixed, kind === 'stage' ? 1 : null]);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
});
after(async () => {
  await pool.end(); const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

test('independent Document and Stage writes invalidate relation cursors and publish truthful project changes', async () => {
  const uow = new PostgresUnitOfWork(pool);
  const read = () => uow.read(project, r => r.allocationRelations!('reader').list({ discussionId: discussion, limit: 1 }));
  const c = await pool.connect();
  try {
    let version = 1;
    for (const change of ['document-title', 'document-revision', 'stage-revision', 'discussion-head'] as const) {
      const first = await read(); assert.ok(first.nextCursor);
      const observation = new PgSessionObservation(c, project, 'reader');
      const changesCursor = (await observation.directory({ limit: 1, membership: 'all' })).observationCursor;
      if (change === 'document-title') await c.query('UPDATE process_document SET version=$3,title=$4 WHERE project_id=$1 AND document_id=$2',
        [project, doc, ++version, 'Changed title']);
      if (change === 'document-revision') {
        await c.query('BEGIN');
        const next = id();
        await c.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason)
          VALUES($1,$2,$3,'New body','markdown',$4,'lead',$5,$6,'independent edit')`, [project, doc, next, 'b'.repeat(64), now, revision]);
        await c.query('UPDATE process_document SET version=$3,current_revision_id=$4 WHERE project_id=$1 AND document_id=$2', [project, doc, ++version, next]);
        await c.query('COMMIT');
      }
      if (change === 'stage-revision') {
        await c.query('BEGIN');
        await c.query(`INSERT INTO stage_revision(project_id,stage_id,revision_id,version,state,deliverable,learning_question,actor_id,reason,created_at)
          VALUES($1,$2,$3,2,'active','Next result','Question','lead','independent edit',$4)`, [project, stage, id(), now]);
        await c.query("UPDATE project_stage SET version=2,state='active',deliverable='Next result' WHERE project_id=$1 AND stage_id=$2", [project, stage]);
        await c.query('COMMIT');
      }
      if (change === 'discussion-head') await c.query("UPDATE discussion SET version=6,status='decided' WHERE project_id=$1 AND discussion_id=$2", [project, discussion]);
      const next = await uow.read(project, r => r.allocationRelations!('reader').list({ discussionId: discussion, limit: 1, cursor: first.nextCursor! }));
      assert.equal(next.resetRequired, true, change); assert.deepEqual(next.items, []); assert.equal(next.nextCursor, null);
      const changes = await observation.changes({ cursor: changesCursor, limit: 100 });
      const expectedKind = change.startsWith('document') ? 'document' : change.startsWith('stage') ? 'stage' : 'discussion';
      assert.ok(changes.items.some(item => item.source.kind === expectedKind), `${change} has a truthful invalidation source`);
      const fresh = await uow.read(project, r => r.allocationRelations!('reader').list({ discussionId: discussion, limit: 50 }));
      assert.ok(fresh.items.every(item => item.decisionDocumentRevisionId === revision), 'old decision body is fixed');
      if (change === 'document-revision' || change === 'stage-revision') assert.ok(fresh.items.some(item => item.relation.kind === 'decision-target'
        && item.relation.target.kind === expectedKind && item.relation.targetStatus === 'changed'));
    }
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
});
