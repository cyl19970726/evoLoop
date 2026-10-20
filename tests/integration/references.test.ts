import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { migrate } from "@evoloop/adapter-postgres";
import { PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { GitDocumentSource } from "@evoloop/adapter-git-documents";
import { WorkflowService } from "@evoloop/core";
import { decideTaskExternalReference, registerFixedGitReference } from "../../packages/core/src/references/index.js";
import { PgReferenceStore } from "../../packages/adapter-postgres/src/references.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/evoloop_references(?:_009)?_test(?:\?|$)/.test(url)) throw new Error("Use a dedicated evoloop_references test database");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

test("fixed Git bytes and immutable PostgreSQL external reference snapshots", { skip: !url }, async t => {
  await migrate(url!);
  const root = await mkdtemp(join(tmpdir(), "evoloop-ref-git-"));
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => { await pool.end(); await rm(root, { recursive: true, force: true }); });
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  await writeFile(join(root, "formal.md"), "# Fixed formal source\n");
  git(root, "add", "formal.md"); git(root, "commit", "-qm", "fixed");
  const commit = git(root, "rev-parse", "HEAD");
  const projectId = randomUUID(), refId = randomUUID(), taskId = randomUUID(), oldRev = randomUUID(), newRev = randomUUID();
  const documentId = randomUUID(), documentRevisionId = randomUUID(), formalDecisionId = randomUUID();
  const ref = { projectId, repositoryId: "formal", path: "formal.md", commit, contentHash: hash("# Fixed formal source\n") };
  const source = new GitDocumentSource([{ projectId, repositoryId: "formal", root, allowedPaths: ["formal.md"] }], async () => true);
  const read = await source.read(ref);
  assert.equal(read.status, "available");
  assert.equal((await source.read({ ...ref, path: "../formal.md" })).status, "unavailable");
  assert.equal((await source.read({ ...ref, contentHash: "0".repeat(64) })).status, "unavailable");
  await writeFile(join(root, "formal.md"), "# Changed working tree\n");
  const stable = await source.read(ref);
  assert.equal(stable.status, "available");
  if (stable.status === "available") assert.equal(Buffer.from(stable.bytes).toString(), "# Fixed formal source\n");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Reference fixture',now())", [projectId]);
    await client.query(`INSERT INTO git_source_ref(project_id,git_source_ref_id,repository_id,source_path,commit_hash,
      content_hash,state,observed_at) VALUES($1,$2,'formal','formal.md',$3,$4,'reachable',now())`,
      [projectId,refId,commit,ref.contentHash]);
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id)
      VALUES($1,$2,'Process note',1,$3,$3)`, [projectId,documentId,documentRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,
      created_at,previous_revision_id,reason) VALUES($1,$2,$3,'# Process','markdown',$4,'reviewer',now(),null,'fixture')`,
      [projectId,documentId,documentRevisionId,hash("# Process")]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,goal,acceptance,owner,state)
      VALUES($1,$2,1,$3,'Task','Goal','Done','reviewer','proposed')`, [projectId,taskId,oldRev]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,goal,acceptance,owner,
      state,basis_set_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,'Task','Goal','Done','reviewer','proposed',null,'reviewer','first',now())`, [projectId,taskId,oldRev]);
    const store = new PgReferenceStore(client, projectId);
    await store.insertFormalSourceDecision({ projectId,id:formalDecisionId,gitReferenceId:refId,
      documentId,documentRevisionId,decision:"incorporated",actorId:"reviewer",reason:"reviewed source",createdAt:new Date().toISOString() });
    assert.equal((await store.listFormalSourceDecisions(refId))[0]?.decision,"incorporated");
    const slotId = randomUUID(), decisionId = randomUUID();
    await store.insertTaskExternalDecision({ projectId, id: decisionId, taskId, taskRevisionId: oldRev,
      slotId, version: 1, decision: "adopt", kind: "git", referenceId: refId, revision: commit,
      contentHash: ref.contentHash, reason: "use formal source", actionImpact: "check goal against formal source",
      observedCurrentRevision: commit, observedCurrentHash: ref.contentHash, observedCurrentValidity: "valid",
      actorId: "reviewer", createdAt: new Date().toISOString() });
    assert.equal(await store.advanceTaskExternalHead({ projectId,taskId,slotId,version:1,decisionId },0),true);
    assert.equal(await store.advanceTaskExternalHead({ projectId,taskId,slotId,version:1,decisionId },0),false);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,goal,acceptance,owner,
      state,basis_set_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,2,'Task','Goal','Done','reviewer','proposed',null,'reviewer','adopt source',now())`, [projectId,taskId,newRev]);
    await client.query("UPDATE task SET version=2,current_revision_id=$3 WHERE project_id=$1 AND task_id=$2", [projectId,taskId,newRev]);
    const snapshots = await store.listTaskExternalSnapshot(taskId,newRev);
    assert.equal(snapshots.length,1);
    assert.equal(snapshots[0]!.id,decisionId);
    assert.deepEqual(await store.listTaskExternalSnapshot(taskId,oldRev),[]);
    await assert.rejects(client.query("DELETE FROM task_external_ref_snapshot WHERE project_id=$1",[projectId]), /immutable/);
    await client.query("ROLLBACK");
  } finally { client.release(); }
});

test("registered Git source becomes an explicit Task revision with replay and actor checks", { skip: !url }, async t => {
  await migrate(url!);
  const root = await mkdtemp(join(tmpdir(), "evoloop-ref-command-"));
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => { await pool.end(); await rm(root, { recursive: true, force: true }); });
  git(root, "init", "-q"); git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  const body = "# Formal constraint\n";
  await writeFile(join(root, "formal.md"), body);
  git(root, "add", "formal.md"); git(root, "commit", "-qm", "initial");
  const commit = git(root, "rev-parse", "HEAD"), projectId = randomUUID(), referenceId = randomUUID(), taskId = randomUUID();
  const documentId = randomUUID();
  const principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] as const };
  const uow = new PostgresUnitOfWork(pool);
  const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID }, hasher: { hash } });
  const source = new GitDocumentSource([{ projectId,repositoryId:"formal",root,allowedPaths:["formal.md"] }], async () => true);
  const deps = { uow, git: source, hashText: hash, nextId: randomUUID, now: () => new Date().toISOString(),
    observeExternal: async () => ({ status: "reachable" as const, revision: commit, contentHash: hash(body),
      currentRevision: commit, currentHash: hash(body), currentValidity: "valid" as const }) };
  await workflow.execute(principal as never, { type:"project.create",projectId,operationId:randomUUID(),title:"Refs" });
  const createdDocument = await workflow.execute(principal as never, { type:"document.create",projectId,
    operationId:randomUUID(),documentId,title:"Process source",body:"# initial\n" });
  assert.equal(createdDocument.status,"applied");
  const originalRevisionId = createdDocument.status === "applied" ? createdDocument.revisionId! : "";
  await workflow.execute(principal as never, { type:"document.adopt",projectId,operationId:randomUUID(),
    documentId,expectedVersion:1,revisionId:originalRevisionId,reason:"accepted source" });
  await workflow.execute(principal as never, { type:"task.propose",projectId,operationId:randomUUID(),taskId,
    title:"Task",goal:"Use formal constraint",acceptance:"Done",owner:"reviewer",documentIds:[documentId] });
  await workflow.execute(principal as never, { type:"task.accept",projectId,operationId:randomUUID(),taskId,
    expectedVersion:1,basis:[{documentId,revisionId:originalRevisionId}],reason:"approved basis" });
  const registered = await registerFixedGitReference(deps as never,principal as never,{ projectId,operationId:randomUUID(),actorId:"reviewer",
    referenceId,repositoryId:"formal",path:"formal.md",commit,contentHash:hash(body) });
  assert.equal(registered.status,"applied");
  const before = await workflow.getTask(principal as never,projectId,taskId);
  const command = { projectId,operationId:randomUUID(),actorId:"reviewer",decisionId:randomUUID(),taskId,
    taskRevisionId:before.task.currentRevisionId,expectedTaskVersion:before.task.version,
    slotId:randomUUID(),expectedHeadVersion:0,decision:"adopt",kind:"git",referenceId,
    revision:commit,contentHash:hash(body),reason:"Formal source bounds action",actionImpact:"Check constraint before work" };
  const decided = await decideTaskExternalReference(deps as never,principal as never,command);
  assert.equal(decided.status,"applied");
  const replay = await decideTaskExternalReference(deps as never,principal as never,command);
  assert.deepEqual(replay,decided);
  const after = await workflow.getTask(principal as never,projectId,taskId);
  assert.equal(after.task.version,before.task.version+1);
  const snapshot = await uow.read(projectId, reader => reader.listTaskExternalSnapshot(taskId,after.task.currentRevisionId));
  assert.equal(snapshot.length,1);
  assert.equal(snapshot[0]!.observedCurrentRevision,commit);
  const revised = await workflow.execute(principal as never, { type:"document.revise",projectId,
    operationId:randomUUID(),documentId,expectedVersion:2,body:"# changed\n",reason:"new process source" });
  assert.equal(revised.status,"applied");
  const revisedId = revised.status === "applied" ? revised.revisionId! : "";
  await workflow.execute(principal as never, { type:"document.adopt",projectId,operationId:randomUUID(),
    documentId,expectedVersion:3,revisionId:revisedId,reason:"new adopted process source" });
  const pendingCommand = { ...command, operationId:randomUUID(),decisionId:randomUUID(),
    taskRevisionId:after.task.currentRevisionId,expectedTaskVersion:after.task.version,
    expectedHeadVersion:1,decision:"retain" };
  const pending = await decideTaskExternalReference(deps as never,principal as never,pendingCommand);
  assert.equal(pending.status,"rejected");
  if (pending.status === "rejected") assert.equal(pending.code,"PENDING_BASIS_REVIEW");
  assert.equal((await workflow.getTask(principal as never,projectId,taskId)).task.version,after.task.version);
  const cancelled = await workflow.execute(principal as never, { type:"task.cancel",projectId,
    operationId:randomUUID(),taskId,expectedVersion:after.task.version,reason:"stop after review" });
  assert.equal(cancelled.status,"applied");
  const closedTask = await workflow.getTask(principal as never,projectId,taskId);
  const closed = await decideTaskExternalReference(deps as never,principal as never,{ ...pendingCommand,
    operationId:randomUUID(),decisionId:randomUUID(),taskRevisionId:closedTask.task.currentRevisionId,
    expectedTaskVersion:closedTask.task.version });
  assert.equal(closed.status,"rejected");
  if (closed.status === "rejected") assert.equal(closed.code,"INVALID_STATE");
  assert.equal((await workflow.getTask(principal as never,projectId,taskId)).task.version,closedTask.task.version);
  const doneTaskId = randomUUID();
  await workflow.execute(principal as never, { type:"task.propose",projectId,operationId:randomUUID(),taskId:doneTaskId,
    title:"Completed task",goal:"Use accepted source",acceptance:"Done",owner:"reviewer",documentIds:[documentId] });
  await workflow.execute(principal as never, { type:"task.accept",projectId,operationId:randomUUID(),taskId:doneTaskId,
    expectedVersion:1,basis:[{documentId,revisionId:revisedId}],reason:"accepted" });
  await workflow.execute(principal as never, { type:"task.start",projectId,operationId:randomUUID(),taskId:doneTaskId,
    expectedVersion:2,reason:"started" });
  const delivered = await workflow.execute(principal as never, { type:"delivery.record",projectId,
    operationId:randomUUID(),taskId:doneTaskId,expectedVersion:3,artifactRef:"artifact",
    artifactRevision:"fixed",contentHash:hash("artifact"),technicalResult:"passed",
    technicalEvidence:"fixture checks passed",reason:"delivered" });
  assert.equal(delivered.status,"applied");
  const deliveryId = delivered.status === "applied" ? delivered.revisionId! : "";
  const completion = await workflow.execute(principal as never, { type:"task.close",projectId,
    operationId:randomUUID(),taskId:doneTaskId,expectedVersion:4,deliveryId,
    acceptanceResult:"met",acceptanceEvidence:"fixture acceptance",reason:"closed" });
  assert.equal(completion.status,"applied");
  const doneTask = await workflow.getTask(principal as never,projectId,doneTaskId);
  const done = await decideTaskExternalReference(deps as never,principal as never,{ ...command,
    operationId:randomUUID(),decisionId:randomUUID(),taskId:doneTaskId,
    taskRevisionId:doneTask.task.currentRevisionId,expectedTaskVersion:doneTask.task.version,slotId:randomUUID() });
  assert.equal(done.status,"rejected");
  if (done.status === "rejected") assert.equal(done.code,"INVALID_STATE");
  assert.equal((await workflow.getTask(principal as never,projectId,doneTaskId)).task.version,doneTask.task.version);
  await assert.rejects(registerFixedGitReference(deps as never,{ ...principal,actorId:"forged" } as never,
    { projectId,operationId:randomUUID(),actorId:"reviewer",referenceId:randomUUID(),repositoryId:"formal",
      path:"formal.md",commit,contentHash:hash(body) }),/authority/);
});
