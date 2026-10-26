import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { SessionObservationReader } from "@evoloop/contracts/session-observation";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Session activity provenance requires a dedicated evoLoop test database");
const schema = `el_activity_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const id = randomUUID;
const project = id(), role = id(), roleRevision = id(), ownedX = id(), ownedY = id();
const taskB = id(), taskC = id(), taskF = id();
const revisionB = id(), revisionC = id(), revisionF = id();
const goal = id(), taskDocumentB = id(), taskDocumentC = id(), taskDocumentF = id();
const taskDocumentRevisionB = id(), taskDocumentRevisionC = id(), taskDocumentRevisionF = id();
const discussionDocument = id(), discussionDocumentRevision = id();
const discussionX = id(), discussionY = id(), preparedX = id(), decisionX = id(), actionB = id(), actionF = id();
const preparedY = id(), decisionY = id(), actionC = id();
const at = "2026-10-26T00:00:00.000Z", acceptedAt = "2026-10-26T00:00:01.000Z", eventAt = "2026-10-26T00:00:02.000Z";
const scope = JSON.stringify({ actorId: "reader", permissions: ["read"] });
const q = (client: pg.PoolClient, sql: string, values: unknown[] = []) => client.query(sql, values);
const observe = <T>(fn: (reader: SessionObservationReader) => Promise<T>) =>
  uow.read(project, async reader => fn(reader.sessionObservation!(scope)));

before(async () => {
  await migrate(url!, schema);
  const client = await pool.connect();
  try {
    await q(client, "BEGIN");
    await q(client, "INSERT INTO project(project_id,title,created_at) VALUES($1,'Activity provenance',$2)", [project, at]);
    await q(client, `INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'active','lead',$4,$4)`, [project, role, roleRevision, at]);
    await q(client, `INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'active','{"title":"Shared role"}'::jsonb,'lead','fixture',$4,$4)`, [project, role, roleRevision, at]);
    for (const session of [ownedX, ownedY]) await q(client, `INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp','fixture','read-only','on-request','ready',1,$4,$4,$5,'lead',$6,$6)`,
      [project, session, role, `native-${session}`, id(), at]);
    await q(client, `INSERT INTO project_goal(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,created_at)
      VALUES($1,$2,1,'Fixture','none','lead','lead','test','lead','lead',$3)`, [project, goal, at]);
    await q(client, `INSERT INTO goal_revision(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,reason,created_at)
      VALUES($1,$2,1,'Fixture','none','lead','lead','test','lead','lead','fixture',$3)`, [project, goal, at]);
    for (const [document, revision, kind] of [[taskDocumentB, taskDocumentRevisionB, "task"],
      [taskDocumentC, taskDocumentRevisionC, "task"], [taskDocumentF, taskDocumentRevisionF, "task"],
      [discussionDocument, discussionDocumentRevision, "discussion"]] as const) {
      await q(client, `INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
        VALUES($1,$2,$3,1,$4,$5,'draft')`, [project, document, kind, revision, kind]);
      await q(client, `INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
        VALUES($1,$2,$3,'Fixed fixture body','markdown',$4,'lead',$5,'fixture')`, [project, document, revision, "0".repeat(64), at]);
    }
    for (const [task, revision, title, document, documentRevision] of [
      [taskB, revisionB, "Accepted B", taskDocumentB, taskDocumentRevisionB],
      [taskC, revisionC, "Accepted C", taskDocumentC, taskDocumentRevisionC],
      [taskF, revisionF, "Assigned F", taskDocumentF, taskDocumentRevisionF]] as const) {
      await q(client, `INSERT INTO task(project_id,task_id,version,current_revision_id,title,content_document_id,content_revision_id,
        acceptance,owner,state) VALUES($1,$2,1,$3,$4,$5,$6,'Result',$7,'todo')`,
        [project, task, revision, title, document, documentRevision, role]);
      await q(client, `INSERT INTO task_revision(project_id,task_id,revision_id,version,title,content_document_id,
        content_revision_id,acceptance,owner,state,actor_id,reason,created_at)
        VALUES($1,$2,$3,1,$4,$5,$6,'Result',$7,'todo','lead','fixture',$8)`,
        [project, task, revision, title, document, documentRevision, role, at]);
    }
    for (const [task, revision, session, state] of [[taskB, revisionB, ownedX, "accepted"],
      [taskC, revisionC, ownedY, "accepted"], [taskF, revisionF, ownedX, "assigned"]] as const) {
      const ack = state === "accepted";
      const values = [project, task, revision, session, state, ack ? "direct" : null,
        ack ? "worker" : null, ack ? "worker" : null, ack ? "Accepted in own chat" : null,
        ack ? acceptedAt : null, acceptedAt];
      for (const table of ["task_session_assignment", "task_session_assignment_revision"])
        await q(client, `INSERT INTO ${table}(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,
          state,ack_method,ack_actor_id,ack_observer_actor_id,ack_evidence,ack_at,actor_id,reason,updated_at)
          VALUES($1,$2,1,$3,'owned',$4,'worker',$5,$6,$7,$8,$9,$10,'lead','fixture',$11)`, values);
    }
    for (const [discussion, task, revision, latest, version] of [[discussionX, taskB, revisionB, decisionX, 4],
      [discussionY, taskC, revisionC, decisionY, 3]] as const) {
      await q(client, `INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,prepared_document_revision_id,
        current_document_revision_id,latest_decision_event_id,goal_id,goal_version,task_id,task_revision_id,question,options,
        authorization_boundary,target_session_label,actor_id,created_at,updated_at)
        VALUES($1,$2,$3,'allocation','linked',$4,$5,$5,$6,$7,1,$8,$9,'allocation','[]'::jsonb,'lead','lead','lead',$10,$10)`,
        [project, discussion, version, discussionDocument, discussionDocumentRevision, latest, goal, task, revision, eventAt]);
    }
    for (const [discussion, event, version, kind, decision, target, targetRevision] of [
      [discussionX, preparedX, 1, "prepared", null, null, null],
      [discussionX, decisionX, 2, "decision", null, null, null],
      [discussionX, actionB, 3, "action", decisionX, taskB, revisionB],
      [discussionX, actionF, 4, "action", decisionX, taskF, revisionF],
      [discussionY, preparedY, 1, "prepared", null, null, null],
      [discussionY, decisionY, 2, "decision", null, null, null],
      [discussionY, actionC, 3, "action", decisionY, taskC, revisionC],
    ] as const) await q(client, `INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,
      document_revision_id,actor_id,created_at,decision_event_id,target_kind,target_id,target_revision_id,choice)
      VALUES($1,$2,$3,$4,$5,$6,$7,'lead',$8,$9,$10,$11,$12,$13)`,
      [project, discussion, event, version, kind, discussionDocument, discussionDocumentRevision, eventAt, decision,
        kind === "action" ? "task" : null, target, targetRevision, kind === "decision" ? "choose" : null]);
    await q(client, "COMMIT");
  } catch (error) { await q(client, "ROLLBACK"); throw error; } finally { client.release(); }
});
after(async () => { await pool.end(); const client = new pg.Client({ connectionString: url }); await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); } });

test("formal Lead discussion events retain project provenance without duplicate head rows", async () => {
  const keyX = `owned:${ownedX}`, keyY = `owned:${ownedY}`;
  const snapshot = await observe(reader => reader.snapshot(keyX));
  assert.ok(snapshot);
  const history = await observe(reader => reader.history(keyX, { limit: 50 }));
  assert.ok(history);
  const eventIds = [preparedX, decisionX, actionB, actionF];
  const forDiscussion = history.items.filter(item => item.source.kind === "discussion" && item.source.id === discussionX);
  assert.equal(forDiscussion.length, eventIds.length, "the mutable Discussion head is an invalidation, not a second activity");
  for (const event of eventIds) {
    const item = forDiscussion.find(activity => activity.source.revision === event);
    assert.ok(item, `missing formal event ${event}`);
    assert.equal(item.actorId, "lead");
    assert.equal(item.source.evidence, "project-record", "Lead action is not speech by the Session recipient");
    assert.equal(item.source.href, `#/p/${project}/discussions/${discussionX}`);
    assert.equal(snapshot.activity.filter(activity => activity.source.revision === event).length, 1);
  }
  assert.match(forDiscussion.find(item => item.source.revision === actionF)?.summary ?? "", /讨论关联目标：任务/);
  assert.ok(forDiscussion.find(item => item.source.revision === actionF)?.summary.includes(taskF),
    "action summary identifies its exact target rather than implying Session execution");
  assert.equal(snapshot.metadata.partial, false, "ordinary linked context alone is not a partial response");
  const y = await observe(reader => reader.history(keyY, { limit: 50 }));
  assert.ok(y?.items.some(item => item.source.revision === actionC));
  assert.ok(!y?.items.some(item => eventIds.includes(item.source.revision as typeof eventIds[number])));
  assert.ok(!history.items.some(item => item.source.revision === actionC), "same Role does not merge the other concrete Session");
  const byX = await uow.read(project, reader => reader.allocationRelations!(scope).list({ sessionKey: keyX, limit: 50 }));
  assert.deepEqual(byX.items.filter(item => item.relation.kind === "task-recipient")
    .map(item => item.relation.kind === "task-recipient" ? item.relation.task.id : ""), [taskB],
    "assigned F has no accepted recipient relation");
});

test("history paginates real events and changes still expose Discussion head invalidations", async () => {
  const keyX = `owned:${ownedX}`;
  const baseline = (await observe(reader => reader.snapshot(keyX)))!.observationCursor;
  const addedEvent = id();
  const client = await pool.connect();
  try {
    await q(client, "BEGIN");
    await q(client, `INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,
      actor_id,created_at,decision_event_id,target_kind,target_id,target_revision_id)
      VALUES($1,$2,$3,5,'action',$4,$5,'lead',$6,$7,'task',$8,$9)`,
      [project, discussionX, addedEvent, discussionDocument, discussionDocumentRevision, eventAt, decisionX, taskB, revisionB]);
    await q(client, `UPDATE discussion SET version=5,updated_at=$3 WHERE project_id=$1 AND discussion_id=$2`,
      [project, discussionX, "2026-10-26T00:00:03.000Z"]);
    await q(client, "COMMIT");
  } catch (error) { await q(client, "ROLLBACK"); throw error; } finally { client.release(); }
  const changes = await observe(reader => reader.changes({ cursor: baseline, key: keyX, limit: 100 }));
  assert.ok(changes.items.some(item => item.source.revision === addedEvent));
  assert.ok(changes.items.every(item => item.source.evidence === "project-record"));
  const headChange = changes.items.find(item => item.source.kind === "discussion" && item.source.id === discussionX &&
    item.source.revision !== addedEvent);
  assert.ok(headChange, "project changes retain the Discussion head invalidation");
  const next = await observe(reader => reader.changes({ cursor: changes.nextCursor, key: keyX, limit: 100 }));
  assert.equal(next.items.length, 0, "change cursor advances past both head and event");
  await pool.query(`UPDATE discussion SET version=6,status='decided',updated_at=$3 WHERE project_id=$1 AND discussion_id=$2`,
    [project, discussionX, "2026-10-26T00:00:04.000Z"]);
  const headOnly = await observe(reader => reader.changes({ cursor: changes.nextCursor, key: keyX, limit: 100 }));
  assert.equal(headOnly.items.length, 1, "a head-only update still invalidates the Session view");
  assert.equal(headOnly.items[0]?.source.id, discussionX);
  const afterHeadOnly = await observe(reader => reader.changes({ cursor: headOnly.nextCursor, key: keyX, limit: 100 }));
  assert.equal(afterHeadOnly.items.length, 0);
  const all = await observe(reader => reader.history(keyX, { limit: 50 }));
  assert.equal(all?.items.filter(item => item.source.revision === addedEvent).length, 1);
  assert.ok(!all?.items.some(item => item.sequence === headChange.sequence), "pure head invalidation stays out of history");
  assert.ok(!all?.items.some(item => item.sequence === headOnly.items[0]?.sequence));
  const found: string[] = []; let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await observe(reader => reader.history(keyX, { limit: 1, ...(cursor ? { cursor } : {}) }));
    assert.ok(result);
    found.push(...result.items.map(item => item.sequence));
    cursor = result.nextCursor ?? undefined;
    if (!cursor) break;
  }
  assert.deepEqual(found, all!.items.map(item => item.sequence), "limit=1 neither repeats heads nor skips events");
});

test("actual activity truncation propagates to snapshot metadata", async () => {
  const client = await pool.connect();
  try {
    await q(client, "BEGIN");
    for (let version = 7; version <= 30; version++) {
      await q(client, `INSERT INTO discussion_event(project_id,discussion_id,event_id,version,kind,document_id,document_revision_id,
        actor_id,created_at,decision_event_id,target_kind,target_id,target_revision_id)
        VALUES($1,$2,$3,$4,'action',$5,$6,'lead',$7,$8,'task',$9,$10)`,
        [project, discussionX, id(), version, discussionDocument, discussionDocumentRevision, eventAt, decisionX, taskB, revisionB]);
      await q(client, `UPDATE discussion SET version=$3,updated_at=$4 WHERE project_id=$1 AND discussion_id=$2`,
        [project, discussionX, version, eventAt]);
    }
    await q(client, "COMMIT");
  } catch (error) { await q(client, "ROLLBACK"); throw error; } finally { client.release(); }
  const keyX = `owned:${ownedX}`;
  const history = await observe(reader => reader.history(keyX, { limit: 20 }));
  const snapshot = await observe(reader => reader.snapshot(keyX));
  assert.ok(history?.nextCursor);
  assert.equal(history?.metadata.partial, false, "normal history pagination is a supported continuation");
  assert.equal(snapshot?.metadata.partial, true);
  assert.ok(snapshot?.metadata.limitations.some(item => /历史|动态/.test(item)));
  assert.equal(snapshot?.activity.length, 20);
});
