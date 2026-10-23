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
import { workerGuardFacts } from "../../apps/coordinator/src/workers/facts.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { prepareRequest } from "../../apps/cli/src/requests.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !/\/evoloop_references(?:_009|_run)?_test(?:\?|$)/.test(url)) throw new Error("Use a dedicated evoloop_references test database");
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
  const projectId = randomUUID(), refId = randomUUID(), taskId = randomUUID(), oldRev = randomUUID(), newRev = randomUUID(), carriedRev = randomUUID();
  const contentDocumentId = randomUUID(), contentRevisionId = randomUUID();
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
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
      VALUES($1,$2,'Process note',1,$3,$3,'spec','published')`, [projectId,documentId,documentRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,
      created_at,previous_revision_id,reason) VALUES($1,$2,$3,'# Process','markdown',$4,'reviewer',now(),null,'fixture')`,
      [projectId,documentId,documentRevisionId,hash("# Process")]);
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Task',1,$3,'task','draft')`, [projectId,contentDocumentId,contentRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,
      created_at,previous_revision_id,reason) VALUES($1,$2,$3,'# Goal','markdown',$4,'reviewer',now(),null,'fixture')`,
      [projectId,contentDocumentId,contentRevisionId,hash("# Goal")]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Task','Done','reviewer','todo',null,$4,$5)`, [projectId,taskId,oldRev,contentDocumentId,contentRevisionId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,'Task','Done','reviewer','todo',null,$4,$5,null,'reviewer','first',now())`, [projectId,taskId,oldRev,contentDocumentId,contentRevisionId]);
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
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,2,'Task','Done','reviewer','todo',null,$4,$5,null,'reviewer','adopt source',now())`, [projectId,taskId,newRev,contentDocumentId,contentRevisionId]);
    await client.query("UPDATE task SET version=2,current_revision_id=$3 WHERE project_id=$1 AND task_id=$2", [projectId,taskId,newRev]);
    const snapshots = await store.listTaskExternalSnapshot(taskId,newRev);
    assert.equal(snapshots.length,1);
    assert.equal(snapshots[0]!.id,decisionId);
    assert.equal(snapshots[0]!.taskRevisionId,newRev);
    assert.equal((await store.getTaskExternalSnapshot(taskId,newRev,slotId))?.taskRevisionId,newRev);
    assert.equal((await store.listTaskExternalReferences(taskId))[0]?.taskRevisionId,oldRev);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,3,'Task','Done','reviewer','todo',null,$4,$5,null,'reviewer','later task change',now())`,
      [projectId,taskId,carriedRev,contentDocumentId,contentRevisionId]);
    await client.query("UPDATE task SET version=3,current_revision_id=$3 WHERE project_id=$1 AND task_id=$2", [projectId,taskId,carriedRev]);
    const carried = await store.listTaskExternalSnapshot(taskId,carriedRev);
    assert.equal(carried[0]?.id,decisionId);
    assert.equal(carried[0]?.taskRevisionId,carriedRev);
    // Migration 020 must preserve nonempty Git and Wiki decisions as a Run joins another slot.
    const wikiSlotId=randomUUID(),wikiDecisionId=randomUUID(),wikiHash=hash("fixed wiki body");
    await store.insertTaskExternalDecision({projectId,id:wikiDecisionId,taskId,taskRevisionId:carriedRev,
      slotId:wikiSlotId,version:1,decision:"adopt",kind:"wiki",referenceId:randomUUID(),revision:"wiki-v1",
      contentHash:wikiHash,observedCurrentRevision:"wiki-v1",observedCurrentHash:wikiHash,
      observedCurrentValidity:"valid",reason:"retain old wiki",actionImpact:"compare source",actorId:"reviewer",
      createdAt:new Date().toISOString()});
    assert.equal(await store.advanceTaskExternalHead({projectId,taskId,slotId:wikiSlotId,version:1,decisionId:wikiDecisionId},0),true);
    const runId=randomUUID(), sessionId=randomUUID(), runBasisId=randomUUID(), runSlotId=randomUUID(), runDecisionId=randomUUID();
    const inputHash=hash("fixed source input");
    await client.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,true)",
      [projectId,taskId,newRev,runBasisId]);
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
      state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,'researcher','/fixture','task','read-only','on-request','ready',1,$3,$4,$5,'reviewer',now(),now())`,
      [projectId,sessionId,randomUUID(),randomUUID(),randomUUID()]);
    await client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
      input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'fixed source input',$8,'completed',1,'owned-turn','reviewer',now(),now())`,
      [projectId,runId,taskId,newRev,runBasisId,sessionId,randomUUID(),inputHash]);
    await store.insertTaskExternalDecision({projectId,id:runDecisionId,taskId,taskRevisionId:carriedRev,
      slotId:runSlotId,version:1,decision:"adopt",kind:"run",referenceId:runId,revision:newRev,
      contentHash:inputHash,observedCurrentRevision:newRev,observedCurrentHash:inputHash,observedCurrentValidity:"valid",
      reason:"read a bound source Run",actionImpact:"compare real work",actorId:"reviewer",createdAt:new Date().toISOString()});
    assert.equal(await store.advanceTaskExternalHead({projectId,taskId,slotId:runSlotId,version:1,decisionId:runDecisionId},0),true);
    const consumerRev=randomUUID();
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,4,'Task','Done','reviewer','todo',null,$4,$5,null,'reviewer','adopt Run',now())`,
      [projectId,taskId,consumerRev,contentDocumentId,contentRevisionId]);
    const consumer=await store.listTaskExternalSnapshot(taskId,consumerRev);
    assert.deepEqual(consumer.map(item=>item.kind).sort(),["git","run","wiki"]);
    assert.equal(consumer.find(item=>item.kind==="run")?.contentHash,inputHash);
    const readerSessionId=randomUUID(), readerRunId=randomUUID(), readerBasisId=randomUUID();
    const loopId=randomUUID(), policyId=randomUUID(), inboxId=randomUUID(), dispatchId=randomUUID();
    await client.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,true)",
      [projectId,taskId,consumerRev,readerBasisId]);
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
      state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,'researcher','/fixture','task','read-only','on-request','ready',1,$3,$4,$5,'reviewer',now(),now())`,
      [projectId,readerSessionId,randomUUID(),randomUUID(),randomUUID()]);
    await client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
      input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'consumer input',$8,'running',1,$9,'reviewer',now(),now())`,
      [projectId,readerRunId,taskId,consumerRev,readerBasisId,readerSessionId,randomUUID(),hash("consumer input"),randomUUID()]);
    await client.query("INSERT INTO orchestration_loop(project_id,loop_id,version,state,data,current_policy_revision_id) VALUES($1,$2,1,'active','{}',$3)",[projectId,loopId,policyId]);
    const policyCreatedAt=new Date().toISOString();
    const policyData={projectId,id:policyId,loopId,version:1,previousId:null,
      allowedBusinessRoleIds:["researcher"],bindingByRole:{},changedBindingId:null,
      decisionOperationId:null,actorId:"reviewer",createdAtUtc:policyCreatedAt};
    await client.query(`INSERT INTO loop_policy_revision(project_id,policy_id,loop_id,version,previous_policy_id,
      allowed_business_role_ids,binding_by_role,changed_binding_id,decision_operation_id,actor_id,created_at_utc,data)
      VALUES($1,$2,$3,1,null,'["researcher"]','{}',null,null,'reviewer',$4,$5)`,
      [projectId,policyId,loopId,policyCreatedAt,JSON.stringify(policyData)]);
    await client.query(`INSERT INTO orchestration_inbox(project_id,inbox_id,loop_id,source_event_id,recipient_role_id,purpose,
      version,state,data) VALUES($1,$2,$3,$4,'researcher','next_action',1,'acknowledged','{}')`,
      [projectId,inboxId,loopId,randomUUID()]);
    await client.query(`INSERT INTO orchestration_dispatch(project_id,dispatch_id,loop_id,inbox_id,task_id,task_version,
      version,state,data,policy_revision_id) VALUES($1,$2,$3,$4,$5,4,1,'accepted',$6,$7)`,
      [projectId,dispatchId,loopId,inboxId,taskId,JSON.stringify({runtimeRunId:readerRunId,recipientRoleId:"researcher",policyRevisionId:policyId,bindingId:null}),policyId]);
    const facts=workerGuardFacts({query:(sql:string,args:unknown[])=>client.query(sql,args)} as never,
      {principal:{actorId:"worker-fixture",projectIds:[projectId],permissions:["read"]},
        scope:{projectId,loopId,taskId,runId:readerRunId,sessionId:readerSessionId,roleId:"researcher",
          kind:"business",allowedRoleIds:["researcher"]}});
    assert.equal(await facts.fixedRunTrace!(runId),true);
    assert.equal(await facts.fixedRunTrace!(randomUUID()),false);
    const foreignFacts=workerGuardFacts({query:(sql:string,args:unknown[])=>client.query(sql,args)} as never,
      {principal:{actorId:"worker-fixture",projectIds:[randomUUID()],permissions:["read"]},
        scope:{projectId:randomUUID(),loopId,taskId,runId:readerRunId,sessionId:readerSessionId,
          roleId:"researcher",kind:"business",allowedRoleIds:["researcher"]}});
    assert.equal(await foreignFacts.fixedRunTrace!(runId),false);
    await client.query("SAVEPOINT closed_source");
    await client.query("UPDATE runtime_session SET state='closed',version=version+1,close_operation_id=$3,close_verified_at=now() WHERE project_id=$1 AND session_id=$2",
      [projectId,sessionId,randomUUID()]);
    assert.equal(await facts.fixedRunTrace!(runId),false);
    await client.query("ROLLBACK TO SAVEPOINT closed_source");
    await client.query("SAVEPOINT closed_reader");
    await client.query("UPDATE runtime_session SET state='closed',version=version+1,close_operation_id=$3,close_verified_at=now() WHERE project_id=$1 AND session_id=$2",
      [projectId,readerSessionId,randomUUID()]);
    assert.equal(await facts.fixedRunTrace!(runId),false);
    await client.query("ROLLBACK TO SAVEPOINT closed_reader");
    assert.equal(await facts.fixedRunTrace!(runId),true);
    const oldFacts=workerGuardFacts({query:(sql:string,args:unknown[])=>client.query(sql,args)} as never,
      {principal:{actorId:"worker-fixture",projectIds:[projectId],permissions:["read"]},
        scope:{projectId,loopId,taskId,runId:readerRunId,sessionId:readerSessionId,roleId:"wrong",
          kind:"business",allowedRoleIds:["wrong"]}});
    assert.equal(await oldFacts.fixedRunTrace!(runId),false);
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
  await workflow.execute(principal as never, { type:"task.create",projectId,operationId:randomUUID(),taskId,
    title:"Task",content:"# Use formal constraint",acceptance:"Done",owner:"reviewer",documentIds:[documentId] });
  await workflow.execute(principal as never, { type:"task.start",projectId,operationId:randomUUID(),taskId,
    expectedVersion:1,basis:[{documentId,revisionId:originalRevisionId}],reason:"Begin work" });
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
  await workflow.execute(principal as never, { type:"task.create",projectId,operationId:randomUUID(),taskId:doneTaskId,
    title:"Completed task",content:"# Use accepted source",acceptance:"Done",owner:"reviewer",documentIds:[documentId] });
  await workflow.execute(principal as never, { type:"task.start",projectId,operationId:randomUUID(),taskId:doneTaskId,
    expectedVersion:1,basis:[{documentId,revisionId:revisedId}],reason:"started" });
  const delivered = await workflow.execute(principal as never, { type:"delivery.record",projectId,
    operationId:randomUUID(),taskId:doneTaskId,expectedVersion:2,artifactRef:"artifact",
    artifactRevision:"fixed",contentHash:hash("artifact"),technicalResult:"passed",
    technicalEvidence:"fixture checks passed",reason:"delivered" });
  assert.equal(delivered.status,"applied");
  const deliveryId = delivered.status === "applied" ? delivered.revisionId! : "";
  const completion = await workflow.execute(principal as never, { type:"task.close",projectId,
    operationId:randomUUID(),taskId:doneTaskId,expectedVersion:3,deliveryId,
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

test("CLI Run-reference request crosses HTTP review and persists a fixed consumer revision", {skip:!url},async t=>{
  await migrate(url!);
  const pool=new pg.Pool({connectionString:url});t.after(()=>pool.end());
  const projectId=randomUUID(),sourceTaskId=randomUUID(),consumerTaskId=randomUUID(),sourceRev=randomUUID(),consumerRev=randomUUID();
  const sourceDoc=randomUUID(),consumerDoc=randomUUID(),sourceDocRev=randomUUID(),consumerDocRev=randomUUID();
  const basisId=randomUUID(),sessionId=randomUUID(),runId=randomUUID(),inputHash=hash("synthetic test input");
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Run reference fixture',now())",[projectId]);
    for(const [taskId,rev,doc,docRev] of [[sourceTaskId,sourceRev,sourceDoc,sourceDocRev],[consumerTaskId,consumerRev,consumerDoc,consumerDocRev]]){
      await client.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Task',1,$3,'task','draft')",[projectId,doc,docRev]);
      await client.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason) VALUES($1,$2,$3,'# Task','markdown',$4,'reviewer',now(),null,'fixture')",[projectId,doc,docRev,hash("# Task")]);
      await client.query("INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,content_document_id,content_revision_id) VALUES($1,$2,1,$3,'Task','Review','reviewer','todo',null,$4,$5)",[projectId,taskId,rev,doc,docRev]);
      await client.query("INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at) VALUES($1,$2,$3,1,'Task','Review','reviewer','todo',null,$4,$5,null,'reviewer','fixture',now())",[projectId,taskId,rev,doc,docRev]);
    }
    await client.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,true)",[projectId,sourceTaskId,sourceRev,basisId]);
    await client.query("INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at) VALUES($1,$2,'researcher','/fixture','task','read-only','on-request','ready',1,$3,$4,$5,'reviewer',now(),now())",[projectId,sessionId,randomUUID(),randomUUID(),randomUUID()]);
    await client.query("INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'synthetic test input',$8,'completed',1,$9,'reviewer',now(),now())",[projectId,runId,sourceTaskId,sourceRev,basisId,sessionId,randomUUID(),inputHash,randomUUID()]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const uow=new PostgresUnitOfWork(pool);
  const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
  const token="r".repeat(40),readOnlyToken="w".repeat(40);
  const app=await buildServer({service:workflow,credentials:[{token,actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"]},
    {token:readOnlyToken,actorId:"writer",projectIds:[projectId],permissions:["read","write"]}],
    references:{uow,gitForPrincipal:async()=>({read:async()=>({status:"unavailable"})}) as never,
      knowledgeForPrincipal:async()=>({}) as never,runSessionAvailable:async()=>true}});
  t.after(()=>app.close());
  const body={operationId:randomUUID(),decisionId:randomUUID(),taskRevisionId:consumerRev,expectedTaskVersion:1,
    slotId:randomUUID(),expectedHeadVersion:0,decision:"adopt",kind:"run",referenceId:runId,revision:sourceRev,
    contentHash:inputHash,reason:"Investigate actual task burden",actionImpact:"Inspect fixed trace before a trial"};
  const intent=prepareRequest("reference.task-decide",projectId,body,consumerTaskId);
  assert.equal((await app.inject({method:"POST",url:intent.path,headers:{authorization:`Bearer ${readOnlyToken}`},payload:intent.body})).statusCode,403);
  const response=await app.inject({method:"POST",url:intent.path,headers:{authorization:`Bearer ${token}`},payload:intent.body});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().status,"applied");
  const task=await workflow.getTask({actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"]},projectId,consumerTaskId);
  const fixed=await uow.read(projectId,reader=>reader.listTaskExternalSnapshot(consumerTaskId,task.task.currentRevisionId));
  assert.equal(fixed[0]?.referenceId,runId);assert.equal(fixed[0]?.revision,sourceRev);assert.equal(fixed[0]?.contentHash,inputHash);
  const denied=await app.inject({method:"POST",url:intent.path,headers:{authorization:`Bearer ${token}`},payload:{...body,operationId:randomUUID(),decisionId:randomUUID(),referenceId:randomUUID()}});
  assert.equal(denied.json().status,"rejected");assert.equal(denied.json().code,"BASIS_UNAVAILABLE");
  const mismatch=await app.inject({method:"POST",url:intent.path,headers:{authorization:`Bearer ${token}`},payload:{...body,operationId:randomUUID(),decisionId:randomUUID(),contentHash:"0".repeat(64)}});
  assert.equal(mismatch.json().status,"rejected");assert.equal(mismatch.json().code,"BASIS_UNAVAILABLE");
});
