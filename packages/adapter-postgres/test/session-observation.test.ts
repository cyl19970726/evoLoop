import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { DiscussionEvent, DiscussionRecord } from "@evoloop/contracts/discussions";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { PgSessionAssignments } from "../src/session-assignments.ts";
import { PgSessionObservation } from "../src/session-observation.ts";
import { PgResidentHosts } from "../src/resident-hosts.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Session observation requires a dedicated evoloop_*_test database");
const schema = `el_observe_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), otherProjectId = randomUUID(), roleId = randomUUID(), revisionId = randomUUID();
const a = randomUUID(), aAlias = randomUUID(), b = randomUUID(), unclassified = randomUUID();
const owned = randomUUID(), ownedUnbound = randomUUID(), ownedLink = randomUUID();
const taskId = randomUUID(), taskRevisionId = randomUUID();
const documentId = randomUUID(), contentRevisionId = randomUUID(), basisId = randomUUID();
const now = "2026-10-26T00:00:00.000Z";
const later = "2026-10-26T00:00:01.000Z";
const scope = JSON.stringify({ actorId: "reader", permissions: ["read"] });
const otherScope = JSON.stringify({ actorId: "other", permissions: ["read"] });

async function addHost(client: pg.PoolClient, linkId: string, host: object, state: "verified" | "registered", createdAt = now) {
  await client.query("INSERT INTO role_host_link(project_id,link_id,role_id,version,state) VALUES($1,$2,$3,1,$4)",
    [projectId, linkId, roleId, state]);
  await client.query(`INSERT INTO role_host_link_revision(project_id,link_id,version,role_id,host,claimed_capabilities,
    verified_capabilities,evidence,observer,observed_at_utc,state,actor_id,reason,created_at_utc)
    VALUES($1,$2,1,$3,$4::jsonb,'["open","read"]'::jsonb,$5::jsonb,$6,$7,$8,$9,'lead','fixture',$10)`,
    [projectId, linkId, roleId, JSON.stringify(host), state === "verified" ? JSON.stringify(["open", "read"]) : "[]",
      state === "verified" ? "actually opened" : null, state === "verified" ? "lead" : null,
      state === "verified" ? createdAt : null, state, createdAt]);
}

before(async () => {
  await migrate(url, schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Observation test',$2),($3,'Other project',$2)",
      [projectId, now, otherProjectId]);
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'active','lead',$4,$4)`, [projectId, roleId, revisionId, now]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'active',$4::jsonb,'lead','fixture',$5,$5)`,
      [projectId, roleId, revisionId, JSON.stringify({ title: "Shared Role", roleClass: "business", independentResponsibility: "Work" }), now]);
    const sharedRef = `codex://threads/${randomUUID()}`;
    await addHost(client, a, { kind: "external", provider: "codex-desktop", ref: sharedRef }, "verified");
    await addHost(client, aAlias, { kind: "external", provider: "codex-desktop", ref: sharedRef }, "verified", later);
    await addHost(client, b, { kind: "external", provider: "codex-desktop", ref: `codex://threads/${randomUUID()}` }, "verified");
    await addHost(client, unclassified, { kind: "external", provider: "codex-desktop", ref: `codex://threads/${randomUUID()}` }, "registered");
    for (const sessionId of [owned, ownedUnbound]) {
      await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,approval_policy,
        state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
        VALUES($1,$2,$3,'/tmp','fixture',NULL,'read-only','on-request','ready',1,$4,$4,$5,'lead',$6,$6)`,
        [projectId, sessionId, roleId, `native-${sessionId}`, randomUUID(), now]);
    }
    await client.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
      VALUES($1,$2,$3,$4,$5,'lead','fixture',$6)`, [projectId, randomUUID(), roleId, owned, revisionId, now]);
    await addHost(client, ownedLink, { kind: "owned", sessionId: owned }, "verified");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await new PostgresUnitOfWork(pool).transaction(projectId, async tx => {
    await tx.insertDocument({ projectId, id: documentId, title: "Task", version: 1, currentRevisionId: contentRevisionId,
      adoptedRevisionId: null, kind: "task", status: "draft" });
    await tx.insertDocumentRevision({ projectId, documentId, id: contentRevisionId, body: "Fixed work", format: "markdown",
      mediaType: "text/markdown", originalName: "task.md", payloadRef: null, entrypoint: null, assetsManifest: [],
      contentHash: "0".repeat(64), author: "lead", createdAt: now, previousRevisionId: null, reason: "fixture" });
    await tx.insertTask({ projectId, id: taskId, version: 1, currentRevisionId: taskRevisionId, title: "Assigned task",
      content: "Fixed work", contentDocumentId: documentId, contentRevisionId, kind: null,
      acceptance: "Result", owner: roleId, state: "in_progress" });
    await tx.insertTaskRevision({ projectId, taskId, id: taskRevisionId, version: 1, title: "Assigned task",
      content: "Fixed work", contentDocumentId: documentId, contentRevisionId, kind: null,
      acceptance: "Result", owner: roleId, state: "in_progress", basisSetId: basisId,
      actorId: "lead", reason: "fixture", createdAt: now });
    await tx.insertSealedBasisSet({ projectId, taskId, taskRevisionId, id: basisId, sealed: true,
      members: [{ documentId, revisionId: contentRevisionId }] });
  });
});
after(async () => {
  await pool.end();
  const cleanup = new pg.Client({ connectionString: url }); await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
});

test("directory keeps separate same-Role chats, deduplicates aliases, includes unbound owned Session", async () => {
  const client = await pool.connect();
  try {
    const reader = new PgSessionObservation(client, projectId, scope);
    const current = await reader.directory({ limit: 10, membership: "current" });
    assert.equal(current.items.length, 3); // A, B, owned with verified HostLink.
    const aSession = current.items.find(item => item.key === `external:${a}`);
    assert.deepEqual(aSession?.aliases.map(item => item.kind === "external" && item.linkId), [a, aAlias]);
    assert.ok(current.items.some(item => item.key === `external:${b}`));
    assert.ok(current.items.some(item => item.key === `owned:${owned}`));
    const all = await reader.directory({ limit: 10, membership: "all" });
    assert.ok(all.items.some(item => item.key === `owned:${ownedUnbound}`));
    assert.equal(current.items.filter(item => item.key === `owned:${owned}`).length, 1);
    assert.equal(current.totals.unclassified, 2);
    assert.equal(current.attention.unclassifiedSessions, 2);
    assert.equal(current.items.find(item => item.key === `external:${b}`)?.busy, null);
    assert.equal(aSession?.capabilities.send.available, true);
    assert.equal(aSession?.capabilities.send.mode, "manual-handoff");
    assert.equal(aSession?.capabilities.open.available, true);
    assert.equal(current.items.find(item => item.key === `owned:${owned}`)?.capabilities.send.mode, "owned-read-only");
    assert.equal(current.items.find(item => item.key === `owned:${owned}`)?.capabilities.open.available, false);
    await new PgSessionAssignments(client, projectId).saveSessionProfile({ projectId,
      target: { kind: "external", linkId: aAlias }, version: 1, displayName: "Alias title", purpose: "Alias metadata",
      membership: "current", tenure: "temporary", actorId: "lead", reason: "alias presentation", updatedAt: later }, 0);
    const aliased = await reader.snapshot(`external:${a}`);
    assert.equal(aliased?.session.title, "Alias title");
    assert.deepEqual(aliased?.session.profile?.target, { kind: "external", linkId: aAlias });
    const first = await reader.directory({ limit: 1, membership: "current" });
    assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
    assert.equal(first.totals.current, 3);
    const second = await reader.directory({ limit: 1, membership: "current", cursor: first.nextCursor! });
    assert.notEqual(second.items[0]?.key, first.items[0]?.key);
    await assert.rejects(reader.directory({ limit: 1, membership: "historical", cursor: first.nextCursor! }), { code: "INVALID_CURSOR" });
    await assert.rejects(new PgSessionObservation(client, projectId, otherScope).directory({ limit: 1, membership: "current", cursor: first.nextCursor! }), { code: "INVALID_CURSOR" });
    await assert.rejects(new PgSessionObservation(client, otherProjectId, scope).directory({ limit: 1, membership: "current", cursor: first.nextCursor! }), { code: "INVALID_CURSOR" });
  } finally { client.release(); }
});

test("same-Role HostLink events stay with exact Session aliases across snapshot, history and changes", async () => {
  const client = await pool.connect();
  try {
    const reader = new PgSessionObservation(client, projectId, scope);
    const keyA = `external:${a}`, keyB = `external:${b}`, keyOwned = `owned:${owned}`;
    const initialA = await reader.snapshot(keyA), initialB = await reader.snapshot(keyB);
    assert.ok(initialA && initialB);
    const hosts = (items: { source: { kind: string; id: string } }[]) => items.filter(x => x.source.kind === "host-link").map(x => x.source.id);
    assert.ok(hosts(initialA.activity).includes(a));
    assert.ok(hosts(initialA.activity).includes(aAlias));
    assert.ok(!hosts(initialA.activity).includes(b), "B's HostLink must not appear in A's snapshot activity");
    assert.deepEqual(hosts(initialB.activity).filter(id => id === a || id === aAlias), []);
    assert.ok(hosts(initialB.activity).includes(b));
    assert.ok(!hosts((await reader.history(keyA, { limit: 50 }))!.items).includes(b));
    assert.ok(hosts((await reader.history(keyB, { limit: 50 }))!.items).includes(b));
    const ownedHosts = hosts((await reader.snapshot(keyOwned))!.activity);
    assert.ok(ownedHosts.includes(ownedLink));
    assert.ok(!ownedHosts.includes(a) && !ownedHosts.includes(b));
    const roleActivity = initialA.activity.find(x => x.source.kind === "role");
    assert.equal(roleActivity?.source.id, roleId, "shared Role history is explicitly sourced as Role context");

    const store = new PgResidentHosts(client, projectId);
    await client.query("BEGIN");
    for (const linkId of [b, aAlias]) {
      const old = await store.getHostLink(linkId);
      assert.ok(old);
      const updated = { ...old, version: 2, reason: `verified ${linkId}`, createdAtUtc: later };
      await store.advanceHostLink(updated, 1, updated);
    }
    await client.query("COMMIT");
    const aChanges = await reader.changes({ cursor: initialA.observationCursor, key: keyA, limit: 100 });
    const bChanges = await reader.changes({ cursor: initialB.observationCursor, key: keyB, limit: 100 });
    assert.ok(hosts(aChanges.items).includes(aAlias), "A' must aggregate into A");
    assert.ok(!hosts(aChanges.items).includes(b), "B's later HostLink update must not invalidate A");
    assert.ok(hosts(bChanges.items).includes(b));
    assert.ok(!hosts(bChanges.items).includes(aAlias));
    assert.ok(!hosts((await reader.history(keyA, { limit: 50 }))!.items).includes(b));
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

test("profile and accepted assignment remain explicit; role responsibility alone does not become current work", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const store = new PgSessionAssignments(client, projectId);
    await store.saveSessionProfile({ projectId, target: { kind: "external", linkId: a }, version: 1,
      displayName: "Design chat", purpose: "Design the requested change", membership: "current", tenure: "temporary",
      actorId: "lead", reason: "presentation", updatedAt: now }, 0);
    await store.saveTaskSessionAssignment({ projectId, taskId, version: 1, taskRevisionId,
      target: { kind: "external", linkId: a }, recipientActorId: "worker", state: "accepted",
      ack: { method: "lead-observed", actorId: null, observerActorId: "lead", evidence: "Manual reply", sourceRef: "chat:1", at: now },
      actorId: "lead", reason: "manual acceptance", updatedAt: now }, 0);
    await client.query("COMMIT");
    const reader = new PgSessionObservation(client, projectId, scope);
    const aSnapshot = await reader.snapshot(`external:${a}`);
    const bSnapshot = await reader.snapshot(`external:${b}`);
    assert.equal(aSnapshot?.session.title, "Design chat");
    assert.equal(aSnapshot?.assignments[0]?.assignment.ack?.method, "lead-observed");
    assert.equal(aSnapshot?.assignments[0]?.assignment.ack?.actorId, null);
    assert.equal(aSnapshot?.assignments[0]?.stale, false);
    assert.equal(aSnapshot?.currentWork?.id, taskId);
    assert.equal(bSnapshot?.currentWork, null);
    assert.ok(bSnapshot?.roleTasks.some(item => item.id === taskId));
    assert.equal(bSnapshot?.resources.actualModel.value, null);
    assert.equal(bSnapshot?.resources.processMemory.value, null);
    const nextRevisionId = randomUUID(), nextBasisId = randomUUID();
    await new PostgresUnitOfWork(pool).transaction(projectId, async tx => {
      await tx.insertTaskRevision({ projectId, taskId, id: nextRevisionId, version: 2, title: "Assigned task",
        content: "Fixed work", contentDocumentId: documentId, contentRevisionId, kind: null,
        acceptance: "Result", owner: roleId, state: "in_progress", basisSetId: nextBasisId,
        actorId: "lead", reason: "new fixed baseline", createdAt: later });
      await tx.insertSealedBasisSet({ projectId, taskId, taskRevisionId: nextRevisionId, id: nextBasisId, sealed: true,
        members: [{ documentId, revisionId: contentRevisionId }] });
      await tx.updateTask({ projectId, id: taskId, version: 2, currentRevisionId: nextRevisionId,
        title: "Assigned task", content: "Fixed work", contentDocumentId: documentId, contentRevisionId,
        kind: null, acceptance: "Result", owner: roleId, state: "in_progress" }, 1);
    });
    const stale = await reader.snapshot(`external:${a}`);
    assert.equal(stale?.assignments[0]?.stale, true);
    assert.equal(stale?.currentWork, null);
    const acceptAt = "2026-10-26T00:00:02.000Z", deliveryAt = "2026-10-26T00:00:03.000Z";
    await client.query("BEGIN");
    await store.saveTaskSessionAssignment({ projectId, taskId, version: 2, taskRevisionId: nextRevisionId,
      target: { kind: "external", linkId: b }, recipientActorId: "reviewer", state: "assigned", ack: null,
      actorId: "lead", reason: "moved to review chat", updatedAt: later }, 1);
    await store.saveTaskSessionAssignment({ projectId, taskId, version: 3, taskRevisionId: nextRevisionId,
      target: { kind: "external", linkId: b }, recipientActorId: "reviewer", state: "accepted",
      ack: { method: "lead-observed", actorId: null, observerActorId: "lead", evidence: "Review chat replied", sourceRef: "chat:2", at: acceptAt },
      actorId: "lead", reason: "accepted in B", updatedAt: acceptAt }, 2);
    await client.query("COMMIT");
    const deliveryId = randomUUID();
    await new PostgresUnitOfWork(pool).transaction(projectId, tx => tx.insertDelivery({ projectId, id: deliveryId,
      taskId, taskRevisionId: nextRevisionId, runId: null, artifactRef: "report:1", artifactRevision: "1",
      contentHash: "1".repeat(64), technicalResult: "passed", technicalEvidence: "review chat output",
      reason: "delivered", actorId: "reviewer", createdAt: deliveryAt }));
    const afterMoveA = await reader.snapshot(`external:${a}`), afterMoveB = await reader.snapshot(`external:${b}`);
    assert.equal(afterMoveA?.results.length, 0, "A must not claim B's later delivery");
    assert.deepEqual(afterMoveB?.results.map(item => item.deliveryId), [deliveryId]);
    assert.equal(afterMoveA?.currentWork, null);
    assert.equal(afterMoveB?.currentWork?.id, taskId);
    const hugeDeliveryId = randomUUID();
    await new PostgresUnitOfWork(pool).transaction(projectId, tx => tx.insertDelivery({ projectId, id: hugeDeliveryId,
      taskId, taskRevisionId: nextRevisionId, runId: null, artifactRef: "x".repeat(300_000), artifactRevision: "2",
      contentHash: "2".repeat(64), technicalResult: "passed", technicalEvidence: "large fixed artifact",
      reason: "large result", actorId: "reviewer", createdAt: "2026-10-26T00:00:04.000Z" }));
    const bounded = await reader.snapshot(`external:${b}`);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 256 * 1024);
    assert.ok(bounded?.metadata.limitations.some(item => item.includes("响应大小限制")));
    assert.deepEqual(bounded?.results.map(item => item.deliveryId), [deliveryId]);
    assert.equal((await reader.history(`external:${a}`, { limit: 50 }))?.items.filter(item => item.source.kind === "delivery").length, 0);
    assert.ok((await reader.history(`external:${b}`, { limit: 50 }))?.items.some(item => item.source.id === hugeDeliveryId));
    const aChanges = await reader.changes({ cursor: stale!.observationCursor, limit: 100, key: `external:${a}` });
    assert.equal(aChanges.items.filter(item => item.source.kind === "delivery").length, 0);
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

test("incremental changes and history are scoped, bounded, and cursor-stable", async () => {
  const client = await pool.connect();
  try {
    const reader = new PgSessionObservation(client, projectId, scope);
    const before = await reader.directory({ limit: 1, membership: "current" });
    const empty = await reader.changes({ cursor: before.observationCursor, limit: 10 });
    assert.equal(empty.items.length, 0);
    const store = new PgSessionAssignments(client, projectId);
    await store.saveSessionProfile({ projectId, target: { kind: "external", linkId: b }, version: 1,
      displayName: "Review chat", purpose: "Review", membership: "current", tenure: "resident",
      actorId: "lead", reason: "presentation", updatedAt: later }, 0);
    const changed = await reader.changes({ cursor: before.observationCursor, limit: 1 });
    assert.equal(changed.items.length, 1);
    assert.equal(changed.items[0]?.operation, "invalidate");
    assert.equal((await reader.changes({ cursor: changed.nextCursor, limit: 10 })).items.length, 0);
    await assert.rejects(new PgSessionObservation(client, projectId, otherScope).changes({ cursor: before.observationCursor, limit: 10 }), { code: "INVALID_CURSOR" });
    await assert.rejects(reader.changes({ cursor: before.observationCursor, limit: 101 }), { code: "INVALID_PAGE" });
    const history = await reader.history(`external:${b}`, { limit: 1 });
    assert.equal(history?.items.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(await reader.snapshot(`external:${b}`))) < 256 * 1024);
  } finally { client.release(); }
});

test("runtime and delivery activity sources retain actual event identity and Task route", async () => {
  const runId = randomUUID(), eventId = randomUUID(), discussionId = randomUUID(), questionId = randomUUID();
  const channelId = randomUUID(), channelRevisionId = randomUUID();
  await new PostgresUnitOfWork(pool).transaction(projectId, async tx => {
    const task = await tx.getTask(taskId);
    assert.ok(task);
    const revision = await tx.getTaskRevision(taskId, task.currentRevisionId);
    assert.ok(revision?.basisSetId);
    await tx.insertRuntimeRun({ projectId, id: runId, taskId, taskRevisionId: task.currentRevisionId,
      basisSetId: revision.basisSetId, sessionId: owned, operationId: randomUUID(), input: "fixed",
      inputHash: "0".repeat(64), state: "requested", version: 1, nativeTurnId: null,
      interruptRequested: false, resultSummary: null, actorId: "lead", createdAt: later, updatedAt: later });
    await tx.appendRuntimeEvent({ projectId, id: eventId, runId, sessionId: owned, kind: "run.requested",
      detail: "reserved", nativeTurnId: null, cursor: null, itemsDigest: null, actorId: "lead", createdAt: later });
    await tx.insertDocument({ projectId, id: channelId, title: "Question", version: 1, currentRevisionId: channelRevisionId,
      adoptedRevisionId: null, kind: "discussion", status: "draft" });
    await tx.insertDocumentRevision({ projectId, documentId: channelId, id: channelRevisionId, body: "What changed?", format: "markdown",
      mediaType: "text/markdown", originalName: "question.md", payloadRef: null, entrypoint: null, assetsManifest: [],
      contentHash: "3".repeat(64), author: "lead", createdAt: later, previousRevisionId: null, reason: "question" });
    const record: DiscussionRecord = { projectId, id: discussionId, version: 1, kind: "task_collaboration", status: "prepared",
      documentId: channelId, preparedDocumentRevisionId: channelRevisionId, currentDocumentRevisionId: channelRevisionId,
      latestDecisionEventId: null, goal: null, stage: null, task: { id: taskId, revisionId: task.currentRevisionId },
      adoptedDocuments: [], question: "", options: [], authorizationBoundary: "", targetSessionLabel: "", targetSessionRef: null,
      actorId: "lead", createdAt: later, updatedAt: later,
      collaboration: { runId, sessionId: owned, issuerActorId: "lead", recipientActorId: "worker" } };
    const prepared: DiscussionEvent = { projectId, id: randomUUID(), discussionId, version: 1, kind: "prepared",
      documentRevisionId: channelRevisionId, actorId: "lead", createdAt: later, evidence: null, reason: null,
      choice: null, unresolved: null, relookCondition: null, supersedesDecisionEventId: null,
      decisionEventId: null, target: null };
    await tx.insertDiscussion(record, prepared);
    await tx.updateDiscussion({ ...record, version: 2 }, 1, { ...prepared, id: questionId, version: 2,
      kind: "message", documentRevisionId: null, collaborationPayload: { type: "message", kind: "question",
        recipientActorId: "worker", body: { documentId: channelId, revisionId: channelRevisionId }, replyToEventId: null } });
  });
  const client = await pool.connect();
  try {
    const reader = new PgSessionObservation(client, projectId, scope);
    const runEvent = (await reader.history(`owned:${owned}`, { limit: 50 }))?.items.find(item => item.source.revision === eventId);
    assert.equal(runEvent?.source.kind, "run");
    assert.equal(runEvent?.source.id, runId);
    assert.match(runEvent?.source.href ?? "", new RegExp(`run=${runId}`));
    const question = (await reader.history(`owned:${owned}`, { limit: 50 }))?.items.find(item => item.source.revision === questionId);
    assert.equal(question?.source.kind, "discussion");
    assert.equal(question?.source.id, discussionId);
    assert.match(question?.source.href ?? "", new RegExp(`discussions/${discussionId}`));
    const delivery = (await reader.history(`external:${b}`, { limit: 50 }))?.items.find(item => item.source.kind === "delivery");
    assert.ok(delivery);
    assert.notEqual(delivery.source.id, taskId);
    assert.match(delivery.source.href, new RegExp(`tasks/${taskId}`));
  } finally { client.release(); }
});

test("commit-ordered counter does not lose a blocked later writer across a read cursor", async () => {
  const writerA = await pool.connect(), writerB = await pool.connect(), readerClient = await pool.connect();
  try {
    const reader = new PgSessionObservation(readerClient, projectId, scope);
    const baseline = (await reader.directory({ limit: 1, membership: "all" })).observationCursor;
    await writerA.query("BEGIN"); await writerB.query("BEGIN");
    const first = new PgSessionAssignments(writerA, projectId), second = new PgSessionAssignments(writerB, projectId);
    await first.saveSessionProfile({ projectId, target: { kind: "external", linkId: unclassified },
      version: 1, displayName: "Pending classification", purpose: "Check", membership: "unclassified", tenure: "unknown",
      actorId: "lead", reason: "first writer", updatedAt: later }, 0);
    // Writer B reaches the same project counter only after A has locked it.
    const laterWrite = second.saveSessionProfile({ projectId, target: { kind: "owned", sessionId: ownedUnbound },
      version: 1, displayName: "Unbound owned", purpose: "Observe", membership: "unclassified", tenure: "unknown",
      actorId: "lead", reason: "second writer", updatedAt: later }, 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await reader.changes({ cursor: baseline, limit: 10 })).items.length, 0);
    await writerA.query("COMMIT");
    await laterWrite; await writerB.query("COMMIT");
    const changes = await reader.changes({ cursor: baseline, limit: 10 });
    assert.equal(changes.items.filter(item => item.source.kind === "session-profile").length, 2);
    assert.equal(new Set(changes.items.map(item => item.sequence)).size, changes.items.length);
    assert.equal((await reader.changes({ cursor: changes.nextCursor, limit: 10 })).items.length, 0);
  } catch (error) {
    await Promise.allSettled([writerA.query("ROLLBACK"), writerB.query("ROLLBACK")]);
    throw error;
  } finally { writerA.release(); writerB.release(); readerClient.release(); }
});

test("100 added Sessions keep directory query count and payload bounded", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invalidRefLink = randomUUID();
    for (let i = 0; i < 100; i++) await addHost(client, i === 0 ? invalidRefLink : randomUUID(),
      { kind: "external", provider: "codex-desktop", ref: i === 0 ? "https://example.test/not-a-codex-thread" : `codex://threads/${randomUUID()}` }, "verified");
    await client.query("COMMIT");
    let queries = 0;
    const counting = new Proxy(client, { get(target, property) {
      if (property === "query") return (...args: unknown[]) => { queries++; return (target.query as Function).apply(target, args); };
      return Reflect.get(target, property);
    } }) as pg.PoolClient;
    const reader = new PgSessionObservation(counting, projectId, scope);
    assert.equal((await reader.snapshot(`external:${invalidRefLink}`))?.session.capabilities.open.available, false);
    queries = 0;
    const first = await reader.directory({ limit: 50, membership: "current" });
    assert.equal(first.items.length, 50);
    assert.ok(first.nextCursor);
    assert.ok(queries <= 10, `directory used ${queries} queries for 50 rows`);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 256 * 1024);
    queries = 0;
    const second = await reader.directory({ limit: 50, membership: "current", cursor: first.nextCursor! });
    assert.equal(second.items.length, 50);
    assert.ok(queries <= 10, `second page used ${queries} queries for 50 rows`);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.key)).size, 100);
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});

test("Codex bare and URI refs share identity; invalid or different refs stay separate and cannot open", async () => {
  const client = await pool.connect();
  try {
    const thread = randomUUID(), distinctThread = randomUUID();
    const bare = randomUUID(), uriAlias = randomUUID(), otherBare = randomUUID();
    const invalidA = randomUUID(), invalidB = randomUUID(), otherProtocol = randomUUID(), unverified = randomUUID();
    await client.query("BEGIN");
    await addHost(client, bare, { kind: "external", provider: "codex-desktop", ref: thread.toUpperCase() }, "verified");
    await addHost(client, uriAlias, { kind: "external", provider: "codex-desktop", ref: `codex://threads/${thread}` }, "verified", later);
    await addHost(client, otherBare, { kind: "external", provider: "codex-desktop", ref: distinctThread }, "verified");
    await addHost(client, invalidA, { kind: "external", provider: "codex-desktop", ref: "not-a-thread" }, "verified");
    await addHost(client, invalidB, { kind: "external", provider: "codex-desktop", ref: "also-not-a-thread" }, "verified");
    await addHost(client, otherProtocol, { kind: "external", provider: "codex-desktop", ref: `other://threads/${randomUUID()}` }, "verified");
    await addHost(client, unverified, { kind: "external", provider: "codex-desktop", ref: randomUUID() }, "registered");
    await client.query("COMMIT");
    const reader = new PgSessionObservation(client, projectId, scope);
    const same = await reader.snapshot(`external:${uriAlias}`), primary = await reader.snapshot(`external:${bare}`);
    assert.equal(same?.session.key, primary?.session.key);
    assert.deepEqual(primary?.session.aliases.map(x => x.kind === "external" && x.linkId), [bare, uriAlias]);
    assert.equal(primary?.session.capabilities.open.available, true);
    assert.equal(primary?.session.capabilities.open.ref, thread);
    const different = await reader.snapshot(`external:${otherBare}`);
    assert.notEqual(different?.session.key, primary?.session.key);
    assert.equal(different?.session.capabilities.open.ref, distinctThread);
    const bad = [];
    for (const id of [invalidA, invalidB, otherProtocol]) bad.push(await reader.snapshot(`external:${id}`));
    assert.equal(new Set(bad.map(x => x?.session.key)).size, 3);
    for (const item of bad) assert.deepEqual(item?.session.capabilities.open, {
      available: false, reason: "缺少已验证的打开能力或有效聊天引用。", ref: null });
    assert.equal((await reader.snapshot(`external:${unverified}`))?.session.capabilities.open.available, false);
    assert.equal(await new PgSessionObservation(client, otherProjectId, scope).snapshot(`external:${bare}`), null);
    await client.query("BEGIN");
    await assert.rejects(addHost(client, randomUUID(), { kind: "external", provider: "other-provider", ref: thread }, "verified"),
      { code: "23514" });
    await client.query("ROLLBACK");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});
