import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { CommandResult, Principal } from "@evoloop/contracts";
import { buildServer } from "../../apps/coordinator/src/server.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/\/evoloop_[a-z_]*test(?:\?|$)/.test(database)) throw new Error("Use a dedicated evoloop_*test database");

test("migration 019 preserves an existing Delivery closure without changing its evidence", async t => {
  const schema=`task_closure_legacy_${randomUUID().replaceAll("-","")}`;
  const migrations=fileURLToPath(new URL("../../packages/adapter-postgres/migrations/",import.meta.url));
  await runner({databaseUrl:database!,dir:migrations,direction:"up",migrationsTable:"pgmigrations",schema,count:18,
    createSchema:true,createMigrationsSchema:true,singleTransaction:true,log:()=>{}});
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  t.after(async()=>{await pool.end();const admin=new pg.Client({connectionString:database});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const projectId=randomUUID(),taskId=randomUUID(),actorId="legacy-reviewer";
  const service=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},
    ids:{next:randomUUID},hasher:{hash:value=>createHash("sha256").update(value).digest("hex")}});
  const principal:Principal={actorId,projectIds:[projectId],permissions:["read","write","review"]};
  const issue=async(command:Record<string,unknown>)=>{
    const result=await service.execute(principal,{projectId,operationId:randomUUID(),...command} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result as Extract<CommandResult,{status:"applied"}>;
  };
  await issue({type:"project.create",title:"Legacy closure"});
  await issue({type:"task.create",taskId,title:"Old delivered task",content:"# Old body",acceptance:"Artifact checked",owner:actorId});
  await issue({type:"task.start",taskId,expectedVersion:1,reason:"Begin"});
  const delivery=await issue({type:"delivery.record",taskId,expectedVersion:2,artifactRef:"fixture:old",artifactRevision:"r1",
    contentHash:"a".repeat(64),technicalResult:"passed",technicalEvidence:"Checked",reason:"Original delivery"});
  const current=(await service.getTask(principal,projectId,taskId)).task;
  const closureId=randomUUID();
  await pool.query(`INSERT INTO task_closure(project_id,closure_id,task_id,task_revision_id,delivery_id,
    acceptance_result,acceptance_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'met','Original evidence','Original reason',$6,'2026-10-20T00:00:00Z')`,
    [projectId,closureId,taskId,current.currentRevisionId,delivery.revisionId,actorId]);
  const original=(await pool.query("SELECT project_id,closure_id,task_id,task_revision_id,delivery_id,acceptance_result,acceptance_evidence,reason,actor_id,created_at FROM task_closure WHERE closure_id=$1",[closureId])).rows[0];
  await migrate(database!,schema);
  const preserved=(await pool.query("SELECT * FROM task_closure WHERE closure_id=$1",[closureId])).rows[0];
  for(const [key,value] of Object.entries(original)) assert.deepEqual(preserved[key],value,key);
  assert.equal(preserved.decision_id,null);
  assert.equal(preserved.source_inbox_id,null);
  assert.equal(preserved.waiting_inbox_id,null);
  assert.equal(preserved.handoff_dispatch_id,null);
  assert.equal(preserved.handoff_task_id,null);
});

test("HTTP and PostgreSQL: a simple Task owns its Document body and closes without a pre-created source or review Task", async t => {
  const schema = `task_content_${randomUUID().replaceAll("-", "")}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const projectId = randomUUID(), taskId = randomUUID();
  const principal: Principal = { actorId: "task-owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const token = randomUUID() + randomUUID(), writerToken = randomUUID() + randomUUID();
  const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool),
    clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const app = await buildServer({ service, credentials: [{ token, ...principal },
    { token: writerToken, actorId: "task-writer", projectIds: [projectId], permissions: ["read", "write"] }] });
  t.after(async () => {
    await app.close(); await pool.end();
    const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const send = async (command: Record<string, unknown>) => {
    const reply = await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${token}` },
      payload: { projectId, operationId: randomUUID(), ...command } });
    return { reply, result: reply.json() as CommandResult };
  };
  const applied = (result: CommandResult) => { assert.equal(result.status, "applied", JSON.stringify(result)); return result as Extract<CommandResult, { status: "applied" }>; };
  applied((await send({ type: "project.create", title: "Simple Task" })).result);
  const original = "# Produce one report\n\nShow the checked result.";
  const created = applied((await send({ type: "task.create", taskId, title: "Report", content: original,
    acceptance: "The report exists and its check passes", owner: principal.actorId })).result);
  const first = await service.getTask(principal, projectId, taskId);
  assert.equal(first.task.state, "todo");
  assert.equal(first.task.content, original);
  assert.equal(first.revision.content, original);
  assert.equal(first.task.contentDocumentId, first.revision.contentDocumentId);
  assert.equal(first.task.contentRevisionId, first.revision.contentRevisionId);
  assert.equal(first.task.kind, null);
  const main = await service.getDocument(principal, projectId, first.task.contentDocumentId);
  assert.equal(main.document.kind, "task");
  assert.equal(main.document.status, "draft");
  assert.equal(main.current.id, first.task.contentRevisionId);
  assert.equal(main.current.body, original);

  const revisedBody = "# Produce one report\n\nShow the checked result and cite the source.";
  const updated = applied((await send({ type: "task.update", taskId, expectedVersion: created.version,
    title: "Report", content: revisedBody, acceptance: "The report exists and its check passes",
    owner: principal.actorId, reason: "Clarify what the report must show" })).result);
  const second = await service.getTask(principal, projectId, taskId);
  assert.equal(second.task.content, revisedBody);
  assert.notEqual(second.task.contentRevisionId, first.task.contentRevisionId);
  assert.equal((await service.getTaskRevision(principal, projectId, taskId, first.revision.id)).revision.content, original);
  assert.equal((await service.getDocumentRevision(principal, projectId, first.task.contentDocumentId, first.task.contentRevisionId)).body, original);
  const stale = await send({ type: "task.update", taskId, expectedVersion: created.version, title: "Stale",
    content: revisedBody, acceptance: "The report exists and its check passes", owner: principal.actorId, reason: "Wrong version" });
  assert.equal(stale.result.status, "rejected");
  if (stale.result.status === "rejected") assert.equal(stale.result.code, "VERSION_CONFLICT");
  const genericEdit = await send({ type: "document.revise", documentId: first.task.contentDocumentId,
    expectedVersion: 2, body: "# Bypass Task", reason: "Must use Task" });
  assert.equal(genericEdit.result.status, "rejected");
  assert.equal((await service.getTask(principal, projectId, taskId)).task.content, revisedBody);

  const unauthorizedStart = await app.inject({ method: "POST", url: "/api/commands",
    headers: { authorization: `Bearer ${writerToken}` }, payload: { projectId, operationId: randomUUID(),
      type: "task.start", taskId, expectedVersion: updated.version, reason: "Writer cannot authorize execution" } });
  assert.equal(unauthorizedStart.statusCode, 403);
  const started = applied((await send({ type: "task.start", taskId, expectedVersion: updated.version, reason: "Begin checked report" })).result);
  const active = await service.getTask(principal, projectId, taskId);
  assert.equal(active.task.state, "in_progress");
  assert.equal(active.basis?.members.find(member => member.documentId === active.task.contentDocumentId)?.revisionId,
    active.task.contentRevisionId);
  assert.equal((await service.getDocument(principal, projectId, active.task.contentDocumentId)).document.status, "published");
  const illegalBodyChange = await send({ type: "task.update", taskId, expectedVersion: started.version,
    title: "Report", content: "# Changed while executing", acceptance: "The report exists and its check passes",
    owner: principal.actorId, reason: "Must reopen first" });
  assert.equal(illegalBodyChange.result.status, "rejected");
  const failed = applied((await send({ type: "delivery.record", taskId, expectedVersion: started.version,
    artifactRef: "repo://report", artifactRevision: "first", contentHash: "a".repeat(64),
    technicalResult: "failed", technicalEvidence: "Check failed", reason: "First candidate" })).result);
  const premature = await send({ type: "task.close", taskId, expectedVersion: failed.version,
    deliveryId: failed.revisionId, acceptanceResult: "met", acceptanceEvidence: "Claimed complete", reason: "Premature" });
  assert.equal(premature.result.status, "rejected");
  if (premature.result.status === "rejected") assert.equal(premature.result.code, "TECHNICAL_CHECK_FAILED");
  const delivered = applied((await send({ type: "delivery.record", taskId, expectedVersion: failed.version,
    artifactRef: "repo://report", artifactRevision: "second", contentHash: "b".repeat(64),
    technicalResult: "passed", technicalEvidence: "Check passed", reason: "Corrected candidate" })).result);
  const closed = applied((await send({ type: "task.close", taskId, expectedVersion: delivered.version,
    deliveryId: delivered.revisionId, acceptanceResult: "met", acceptanceEvidence: "Report and check inspected", reason: "Accepted" })).result);
  const done = await service.getTask(principal, projectId, taskId);
  assert.equal(done.task.state, "done");
  assert.equal(done.task.content, revisedBody);
  assert.equal(done.task.acceptance, "The report exists and its check passes");
  assert.deepEqual((await service.listTasks(principal, projectId)).items.map(item => item.id), [taskId],
    "closing a Task does not generate a separate acceptance Task");
  const reopened = applied((await send({ type: "task.reopen", taskId, expectedVersion: closed.version,
    reason: "A new report is required" })).result);
  assert.equal((await service.getTask(principal, projectId, taskId)).task.state, "todo");
  const priorPublishedContentRevision = done.task.contentRevisionId;
  const changed = applied((await send({ type: "task.update", taskId, expectedVersion: reopened.version,
    title: "Report", content: "# Produce the next report", acceptance: "The next report and its check pass",
    owner: principal.actorId, reason: "New reporting cycle" })).result);
  const pendingMain = await service.getDocument(principal, projectId, done.task.contentDocumentId);
  assert.equal(pendingMain.document.status, "published", "editing a reopened Task keeps the old published source visible");
  assert.equal(pendingMain.document.adoptedRevisionId, priorPublishedContentRevision);
  assert.notEqual(pendingMain.current.id, priorPublishedContentRevision,
    "the new Task content is a candidate until start republishes it");
  const restarted = applied((await send({ type: "task.start", taskId, expectedVersion: changed.version,
    reason: "Start the next report" })).result);
  const oldDelivery = await send({ type: "task.close", taskId, expectedVersion: restarted.version,
    deliveryId: delivered.revisionId, acceptanceResult: "met", acceptanceEvidence: "Old report", reason: "Stale result" });
  assert.equal(oldDelivery.result.status, "rejected", "a prior delivery cannot close the reopened Task");
  assert.equal((await service.getTask(principal, projectId, taskId)).task.state, "in_progress");

  const specId = randomUUID();
  const spec = applied((await send({ type: "document.create", documentId: specId, title: "Independent specification",
    kind: "spec", body: "# First specification" })).result);
  assert.equal((await service.getDocument(principal, projectId, specId)).document.status, "draft");
  applied((await send({ type: "document.publish", documentId: specId, expectedVersion: spec.version,
    revisionId: spec.revisionId, reason: "Publish fixed source" })).result);
  const candidate = applied((await send({ type: "document.revise", documentId: specId, expectedVersion: 2,
    body: "# Candidate specification", reason: "Prepare a replacement" })).result);
  const withCandidate = await service.getDocument(principal, projectId, specId);
  assert.equal(withCandidate.document.status, "published");
  assert.equal(withCandidate.document.adoptedRevisionId, spec.revisionId,
    "a candidate cannot silently replace the published fixed revision");
  assert.equal(withCandidate.current.id, candidate.revisionId);
  applied((await send({ type: "document.archive", documentId: specId, expectedVersion: 3,
    reason: "No longer a current specification" })).result);
  assert.equal((await service.getDocument(principal, projectId, specId)).document.status, "archived");
  assert.equal((await service.getDocumentRevision(principal, projectId, specId, spec.revisionId!)).body,
    "# First specification", "archiving leaves fixed historical reads intact");
  applied((await send({ type: "document.restore", documentId: specId, expectedVersion: 4,
    reason: "Needed as reference again" })).result);
  assert.equal((await service.getDocument(principal, projectId, specId)).document.status, "published");

  const linkedTaskId = randomUUID();
  applied((await send({ type: "task.create", taskId: linkedTaskId, title: "Use fixed specification",
    content: "# Follow the published specification", acceptance: "One checked result", owner: principal.actorId,
    documentIds: [specId] })).result);
  const linkedStart = applied((await send({ type: "task.start", taskId: linkedTaskId, expectedVersion: 1,
    basis: [{ documentId: specId, revisionId: spec.revisionId }], reason: "Start with fixed specification" })).result);
  const linkedBefore = await service.getTask(principal, projectId, linkedTaskId);
  assert.equal(linkedBefore.basis?.members.find(member => member.documentId === specId)?.revisionId, spec.revisionId);
  const linkedReopen = applied((await send({ type: "task.reopen", taskId: linkedTaskId,
    expectedVersion: linkedStart.version, reason: "Repeat the same checked work" })).result);
  applied((await send({ type: "task.start", taskId: linkedTaskId, expectedVersion: linkedReopen.version,
    reason: "Restart with the unchanged published specification" })).result);
  const linkedAfter = await service.getTask(principal, projectId, linkedTaskId);
  assert.equal(linkedAfter.basis?.members.find(member => member.documentId === specId)?.revisionId, spec.revisionId,
    "omitting basis on restart must retain the fixed external Document source");
  assert.equal(linkedAfter.basis?.members.find(member => member.documentId === linkedAfter.task.contentDocumentId)?.revisionId,
    linkedAfter.task.contentRevisionId);
});
