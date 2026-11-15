import assert from "node:assert/strict";
import test from "node:test";
import {
  commandSchema,
  migrateLegacyAuthConfig,
  parseAuthConfig,
  type Command,
  type Principal,
} from "@evoloop/contracts";
import { authorizeCommand, commandPermissionPolicy, commandPolicy } from "../src/index.ts";

const projectId = "00000000-0000-4000-8000-000000000001";
const otherProjectId = "00000000-0000-4000-8000-000000000002";
const sessionX = "00000000-0000-4000-8000-000000000010";
const sessionY = "00000000-0000-4000-8000-000000000011";
const taskId = "00000000-0000-4000-8000-000000000020";
const documentId = "00000000-0000-4000-8000-000000000021";
const roleId = "00000000-0000-4000-8000-000000000022";
const scheduleId = "00000000-0000-4000-8000-000000000023";
const queueId = "00000000-0000-4000-8000-000000000024";

const command = (value: Record<string, unknown>): Command => ({ operationId: crypto.randomUUID(), ...value }) as Command;
const principal = (actorId: string, permissions: Principal["permissions"],
  options: Pick<Principal, "decisions" | "sessionIds" | "extraCommands" | "identityKind"> = {}): Principal =>
  ({ actorId, projectIds: [projectId], permissions, ...options });
const forbidden = (fn: () => void) => assert.throws(fn, error => error instanceof Error && "code" in error && error.code === "FORBIDDEN");

test("every coordinator Command appears exactly once and unknown commands fail closed", () => {
  const declared = commandSchema.options.map(option => option.shape.type.value).sort();
  const mapped = Object.keys(commandPermissionPolicy).sort();
  assert.deepEqual(mapped, declared);
  assert.equal(mapped.length, new Set(mapped).size);
  assert.throws(() => commandPolicy("not-a-command"), /Unclassified coordinator command/);
  assert.throws(() => authorizeCommand(principal("owner", ["task"]), { projectId, type: "not-a-command" } as Command),
    /Unclassified coordinator command/);
});

test("the command table keeps task, document, Session and management ownership distinct", () => {
  const expected = (type: string): "task" | "document" | "session" | "management" => {
    if (type.startsWith("leader.notice")) return "task";
    if (type.startsWith("task.attention.") || type === "project.create") return "management";
    if (type.startsWith("task.") || type.startsWith("delivery.") || type.startsWith("observation.") ||
        type.startsWith("goal.") || type.startsWith("stage.") || type.startsWith("discussion.") ||
        type.startsWith("decision.request.")) return "task";
    if (type.startsWith("document.")) return "document";
    if (type.startsWith("session.") || type.startsWith("runtime.")) return "session";
    return "management";
  };
  for (const type of Object.keys(commandPermissionPolicy) as Command["type"][])
    assert.equal(commandPermissionPolicy[type].permission, expected(type), type);
  for (const type of ["task.start", "stage.review", "document.publish", "runtime.session.reserve",
    "session.message.interrupt", "role.decide", "line.append", "queue.claim",
    "schedule.dispatch.set", "schedule.directList.set"] as const)
    assert.equal(commandPolicy(type).decision, true, `${type} is decision-class`);
  for (const type of ["task.create", "document.create", "session.message.post", "schedule.revise"] as const)
    assert.equal(commandPolicy(type).decision, false, `${type} is not decision-class`);
});

test("single-category identities can act only through their own object class", () => {
  const taskAgent = principal("task-agent", ["task"], { decisions: true });
  for (const value of [
    command({ type: "task.create", projectId, taskId, title: "T", content: "C", acceptance: "A", owner: roleId }),
    command({ type: "task.update", projectId, taskId, expectedVersion: 1, title: "T", content: "C", acceptance: "A", owner: roleId, reason: "R" }),
    command({ type: "task.start", projectId, taskId, expectedVersion: 1, reason: "R" }),
    command({ type: "task.close", projectId, taskId, expectedVersion: 1, deliveryId: crypto.randomUUID(),
      acceptanceResult: "met", acceptanceEvidence: "E", reason: "R" }),
  ]) authorizeCommand(taskAgent, value);
  forbidden(() => authorizeCommand(taskAgent, command({ type: "document.revise", projectId, documentId,
    expectedVersion: 1, body: "x", reason: "R" })));
  forbidden(() => authorizeCommand(taskAgent, command({ type: "session.message.post", projectId, messageId: crypto.randomUUID(),
    target: { kind: "owned", sessionId: sessionX }, content: "x" })));

  const documentAgent = principal("document-agent", ["document"], { decisions: true });
  for (const value of [
    command({ type: "document.create", projectId, documentId, title: "D", body: "x" }),
    command({ type: "document.revise", projectId, documentId, expectedVersion: 1, body: "x", reason: "R" }),
    command({ type: "document.publish", projectId, documentId, expectedVersion: 1, revisionId: crypto.randomUUID(), reason: "R" }),
  ]) authorizeCommand(documentAgent, value);
  forbidden(() => authorizeCommand(documentAgent, command({ type: "task.start", projectId, taskId, expectedVersion: 1, reason: "R" })));

  const sessionAgent = principal("session-agent", ["session"], { decisions: true, sessionIds: [sessionX] });
  for (const value of [
    command({ type: "session.message.post", projectId, messageId: crypto.randomUUID(), target: { kind: "owned", sessionId: sessionX }, content: "x" }),
    command({ type: "runtime.run.interrupt", projectId, runId: crypto.randomUUID(), reason: "R" }),
    command({ type: "runtime.session.recovery.resume", projectId, sessionId: sessionX, expectedVersion: 1, reason: "R" }),
  ]) authorizeCommand(sessionAgent, value);
  forbidden(() => authorizeCommand(sessionAgent, command({ type: "task.create", projectId, taskId,
    title: "T", content: "C", acceptance: "A", owner: roleId })));
  forbidden(() => authorizeCommand(sessionAgent, command({ type: "document.create", projectId, documentId, title: "D", body: "x" })));

  const manager = principal("manager", ["management"], { decisions: true });
  for (const value of [
    command({ type: "role.propose", projectId, roleId, reason: "R" }),
    command({ type: "schedule.create", projectId, scheduleId, roleId, revisionId: crypto.randomUUID(),
      watermarkUtc: "2026-11-15T00:00:00.000Z", state: "active", reason: "R" }),
    command({ type: "queue.create", projectId, queueId, title: "Q", entries: [], reason: "R" }),
  ]) authorizeCommand(manager, value);
  forbidden(() => authorizeCommand({ ...manager, projectIds: [otherProjectId] },
    command({ type: "role.propose", projectId, roleId, reason: "R" })));
});

test("decision authority and explicit extra commands stay separate from object ownership", () => {
  const writer = principal("writer", ["task"]);
  forbidden(() => authorizeCommand(writer, command({ type: "task.start", projectId, taskId, expectedVersion: 1, reason: "R" })));
  authorizeCommand({ ...writer, decisions: true }, command({ type: "task.start", projectId, taskId, expectedVersion: 1, reason: "R" }));
  authorizeCommand({ ...writer, identityKind: "human" }, command({ type: "task.start", projectId, taskId,
    expectedVersion: 1, reason: "R" }), "a human receives decision authority with the class");

  const archiver = principal("archiver", ["document"], { extraCommands: ["document.archive"] });
  authorizeCommand(archiver, command({ type: "document.archive", projectId, documentId, expectedVersion: 1, reason: "R" }));
  forbidden(() => authorizeCommand(archiver, command({ type: "document.publish", projectId, documentId,
    expectedVersion: 1, revisionId: crypto.randomUUID(), reason: "R" })));
  forbidden(() => authorizeCommand({ ...archiver, permissions: ["task"] },
    command({ type: "document.archive", projectId, documentId, expectedVersion: 1, reason: "R" })));
});

test("dispatch intake requires the original issuer's decision authority", () => {
  const managementOnly = principal("management-only", ["management"]);
  for (const value of [
    command({ type: "line.append", projectId, sessionId: sessionX, taskId, expectedTaskVersion: 1, source: "leader", reason: "R" }),
    command({ type: "line.begin", projectId, entryId: crypto.randomUUID(), expectedVersion: 1,
      assignOperationId: crypto.randomUUID(), startOperationId: crypto.randomUUID(),
      reassignOperationId: crypto.randomUUID(), reserveOperationId: crypto.randomUUID(), messageId: crypto.randomUUID() }),
    command({ type: "schedule.dispatch.set", projectId, scheduleId, expectedVersion: 0, mode: "direct",
      state: "active", reason: "R" }),
    command({ type: "schedule.directList.set", projectId, roleId, expectedVersion: 0, sessionIds: [sessionX], reason: "R" }),
    command({ type: "queue.create", projectId, queueId, maxRuns: 1, reason: "R", entries: [] }),
    command({ type: "queue.claim", projectId, queueId, entryId: crypto.randomUUID(), expectedVersion: 1,
      claimId: crypto.randomUUID(), runId: crypto.randomUUID(), runOperationId: crypto.randomUUID() }),
  ]) forbidden(() => authorizeCommand(managementOnly, value));

  const decisionManager = { ...managementOnly, decisions: true };
  for (const value of [
    command({ type: "line.append", projectId, sessionId: sessionX, taskId, expectedTaskVersion: 1, source: "leader", reason: "R" }),
    command({ type: "schedule.dispatch.set", projectId, scheduleId, expectedVersion: 0, mode: "direct",
      state: "active", reason: "R" }),
    command({ type: "queue.hold", projectId, queueId, entryId: crypto.randomUUID(), reason: "R" }),
  ]) authorizeCommand(decisionManager, value);

  const taskOnly = principal("task-only", ["task"], { decisions: true });
  forbidden(() => authorizeCommand(taskOnly, command({ type: "line.append", projectId, sessionId: sessionX, taskId,
    expectedTaskVersion: 1, source: "leader", reason: "R" })));
  forbidden(() => authorizeCommand(taskOnly, command({ type: "queue.claim", projectId, queueId,
    entryId: crypto.randomUUID(), expectedVersion: 1, claimId: crypto.randomUUID(), runId: crypto.randomUUID(),
    runOperationId: crypto.randomUUID() })));

  const migrated = migrateLegacyAuthConfig([{ token: "c".repeat(32), actorId: "owner-proxy-agent",
    projectIds: [projectId], permissions: ["read", "write"] }]).config[0]!;
  forbidden(() => authorizeCommand({ ...migrated, identityKind: "agent" }, command({ type: "line.append", projectId,
    sessionId: sessionX, taskId, expectedTaskVersion: 1, source: "leader", reason: "R" })));
});

test("Session-scoped identities cannot message or resume another Session", () => {
  const scoped = principal("scoped", ["session"], { sessionIds: [sessionX] });
  authorizeCommand(scoped, command({ type: "session.message.post", projectId, messageId: crypto.randomUUID(),
    target: { kind: "owned", sessionId: sessionX }, content: "x" }));
  forbidden(() => authorizeCommand(scoped, command({ type: "session.message.post", projectId, messageId: crypto.randomUUID(),
    target: { kind: "owned", sessionId: sessionY }, content: "x" })));
  forbidden(() => authorizeCommand(scoped, command({ type: "runtime.session.recovery.resume", projectId,
    sessionId: sessionY, expectedVersion: 1, reason: "R" })));
  authorizeCommand(principal("unscoped", ["session"]), command({ type: "session.message.post", projectId,
    messageId: crypto.randomUUID(), target: { kind: "owned", sessionId: sessionY }, content: "x" }));
});

test("legacy read/write/review conversion is explicit, lossless and keeps owner-proxy out of decisions", () => {
  const legacy = [
    { token: "a".repeat(32), actorId: "leader-agent", projectIds: [projectId],
      permissions: ["read", "write", "review"], extraCommands: ["document.archive"] },
    { token: "b".repeat(32), actorId: "owner-proxy-agent", projectIds: [projectId],
      permissions: ["read", "write"], extraCommands: ["document.restore"] },
  ];
  assert.throws(() => migrateLegacyAuthConfig(legacy), /confirm-review-as-management/);
  assert.throws(() => parseAuthConfig(legacy), /identity migrate/);
  const migration = migrateLegacyAuthConfig(legacy, { confirmReviewAsManagement: true });
  assert.deepEqual(migration.changes, [
    { actorId: "leader-agent", from: ["read", "write", "review"], to: ["task", "document", "session", "management"],
      decisions: true, note: "read becomes project membership read; write becomes task, document and session writes; review explicitly becomes management plus decision authority" },
    { actorId: "owner-proxy-agent", from: ["read", "write"], to: ["task", "document", "session"],
      decisions: false, note: "read becomes project membership read; write becomes task, document and session writes" },
  ]);
  assert.deepEqual(migration.config[0]?.extraCommands, ["document.archive"]);
  assert.deepEqual(migration.config[1]?.extraCommands, ["document.restore"]);

  const leader: Principal = { actorId: "leader-agent", projectIds: [projectId], permissions: ["task", "document", "session", "management"],
    decisions: true, extraCommands: ["document.archive"] };
  const proxy: Principal = { actorId: "owner-proxy-agent", projectIds: [projectId], permissions: ["task", "document", "session"],
    extraCommands: ["document.restore"] };
  authorizeCommand(leader, command({ type: "task.start", projectId, taskId, expectedVersion: 1, reason: "R" }));
  authorizeCommand(proxy, command({ type: "task.create", projectId, taskId, title: "T", content: "C", acceptance: "A", owner: roleId }));
  forbidden(() => authorizeCommand(proxy, command({ type: "task.start", projectId, taskId, expectedVersion: 1, reason: "R" })));
  forbidden(() => authorizeCommand(proxy, command({ type: "task.close", projectId, taskId, expectedVersion: 1,
    deliveryId: crypto.randomUUID(), acceptanceResult: "met", acceptanceEvidence: "E", reason: "R" })));
  authorizeCommand(proxy, command({ type: "document.restore", projectId, documentId, expectedVersion: 1, reason: "R" }));
});
