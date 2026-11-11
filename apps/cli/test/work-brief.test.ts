import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { briefAcceptanceOverview, briefIndex, briefRelays, briefTask, briefTaskWithRelays } from "../src/brief.ts";
import { runCli } from "../src/application.ts";

const project = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** The shape of one work-index Task as the service writes it, including the bulky per-Task timing history. */
const indexTask = (n: number, over: Record<string, unknown> = {}) => ({
  kind: "task", taskId: `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`, version: 7, currentRevisionId: `rev-${n}`, workChangeSequence: 900 + n,
  title: `Task ${n}：把一件事做完并交付`, taskKind: "implementation", taskState: "in_progress", phase: "awaiting_acceptance",
  nextAction: "由声明验收责任者核对当前交付与实际使用", responsible: { kind: "consumer", id: "acceptance-agent", label: "验收者 acceptance-agent" },
  assignment: { state: "accepted", targetKind: "owned", targetId: "session-1", recipientActorId: "dev-agent", taskRevisionId: `rev-${n}` },
  latestRun: { runId: `run-${n}`, state: "completed" },
  delivery: { deliveryId: `delivery-${n}`, taskRevisionId: `rev-${n}`, technicalResult: "passed", consumer: "acceptance-agent", useRequired: true, observationResult: null, observationActorId: null, observationKind: null },
  pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: { plannedStartAt: null, dueAt: "2026-11-20T00:00:00.000Z", priority: 2 },
  dependencies: [{ taskId: "dep-1", title: "前置", state: "done", currentRevisionId: "r", actorId: "a", reason: "r", createdAt: "2026-11-01T00:00:00.000Z", acceptanceSatisfied: true },
    { taskId: "dep-2", title: "未满足的前置", state: "in_progress", currentRevisionId: "r", actorId: "a", reason: "r", createdAt: "2026-11-01T00:00:00.000Z", acceptanceSatisfied: false }],
  dependencyVersion: 1, review: null, dates: { createdAt: "2026-11-01T00:00:00.000Z", businessChangedAt: "2026-11-09T00:00:00.000Z", startedAt: null, completedAt: null, observedAt: "2026-11-11T00:00:00.000Z" },
  latestProgress: { sequence: 9, entityKind: "delivery", entityId: `delivery-${n}`, eventName: "交付已登记", changedAt: "2026-11-09T00:00:00.000Z" }, actionKey: `key-${n}`,
  timing: { createdAt: "2026-11-01T00:00:00.000Z", publication: { at: null, source: "unknown" },
    current: { stage: "awaiting_acceptance", startedAt: "2026-11-09T00:00:00.000Z", endedAt: null, source: { kind: "delivery", id: `delivery-${n}` }, waitingFor: { kind: "consumer", id: "acceptance-agent" }, elapsedMs: 123456 },
    rounds: Array.from({ length: 6 }, (_, round) => ({ number: round + 1, startedAt: "2026-11-01T00:00:00.000Z", endedAt: null, elapsedMs: 1,
      intervals: Array.from({ length: 8 }, (_, i) => ({ stage: "running", startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-02T00:00:00.000Z", source: { kind: "run", id: `run-${round}-${i}` } })) })) },
  ...over });
const page = (count = 20) => ({ items: Array.from({ length: count }, (_, i) => indexTask(i)), total: count, counts: { rework: 1, awaiting_acceptance: count - 1 },
  changeSequence: 11017, observedAt: "2026-11-11T08:00:00.000Z", partial: false, nextCursor: null });
const relay = (over: Record<string, unknown> = {}) => ({ projectId: project, relayId: "relay-1", operationId: "op", version: 3, supersedesRelayId: null, taskId, taskRevisionId: "rev-0", deliveryId: "delivery-0",
  stage: "formal", scopeKey: "scope", scopeDescription: "长长的验收说明".repeat(80), entrypoint: "http://127.0.0.1:4318", publicationRef: "ref", reason: "原因".repeat(60),
  mode: "session", recipientActorId: "acceptance-agent", sessionId: "session-9", nativeThreadId: "thread", roleId: "role", senderActorId: "lead", messageId: "m", messageOperationId: "mo",
  state: "pending", blockedReason: null, arrangedBy: "lead", createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", messageState: "queued",
  messageBlockedReason: null, processingState: null, nativeTurnId: null, readActorId: null, humanReadAt: null, observationId: null, observationResult: null, observationActorId: null,
  evidenceLevel: null, independenceEvidence: "unverified", ...over });

test("a briefed Task keeps what arranging needs: Task, version, stage, next step, owner, Run, delivery, waiting reason", () => {
  const brief = briefTask(indexTask(1)) as Record<string, any>;
  assert.equal(brief.taskId, indexTask(1).taskId);
  assert.equal(brief.version, 7);
  assert.equal(brief.revisionId, "rev-1");
  assert.equal(brief.phase, "awaiting_acceptance");
  assert.equal(brief.nextAction, "由声明验收责任者核对当前交付与实际使用");
  assert.deepEqual(brief.responsible, { kind: "consumer", id: "acceptance-agent", label: "验收者 acceptance-agent" });
  assert.deepEqual(brief.run, { runId: "run-1", state: "completed" });
  assert.equal(brief.delivery.deliveryId, "delivery-1");
  assert.equal(brief.delivery.technicalResult, "passed");
  assert.deepEqual(brief.waiting, { stage: "awaiting_acceptance", for: { kind: "consumer", id: "acceptance-agent" }, since: "2026-11-09T00:00:00.000Z" });
  assert.deepEqual(brief.blockedBy, ["dep-2"], "only the prerequisite that is not satisfied");
  assert.equal(brief.actionKey, "key-1", "the key for recording a review decision stays");
  for (const dropped of ["timing", "dates", "latestProgress", "workChangeSequence", "dependencies"]) assert.equal(dropped in brief, false, `${dropped} is not briefed`);
});

test("a delivery observation, an acceptance convention and queue holds survive when present, and nothing is invented when absent", () => {
  const rich = briefTask(indexTask(2, { queueHold: "awaiting_acceptance", pendingImpactCount: 2,
    delivery: { ...indexTask(2).delivery, observationResult: "failed", observationActorId: "acceptance-agent" },
    acceptanceConvention: { acceptanceTarget: "named_agent", acceptancePrecondition: "release", readiness: "waiting_precondition", namedAgent: "req" } })) as Record<string, any>;
  assert.deepEqual(rich.delivery.observation, { result: "failed", actorId: "acceptance-agent" });
  assert.equal(rich.queueHold, "awaiting_acceptance");
  assert.equal(rich.pendingImpacts, 2);
  assert.deepEqual(rich.acceptance, { acceptanceTarget: "named_agent", acceptancePrecondition: "release", readiness: "waiting_precondition", namedAgent: "req" });
  const bare = briefTask(indexTask(3, { assignment: null, latestRun: null, delivery: null, plan: null, dependencies: [], timing: null })) as Record<string, any>;
  for (const absent of ["assignment", "run", "delivery", "plan", "blockedBy", "queueHold", "pendingImpacts", "acceptance"]) assert.equal(absent in bare, false, absent);
  assert.equal(bare.waiting, null);
});

test("the index, the acceptance overview and the relays shrink to well under half and keep their paging", () => {
  const index = page();
  const brief = briefIndex(index) as Record<string, any>;
  assert.ok(bytes(brief) < bytes(index) / 2, `${bytes(brief)} vs ${bytes(index)}`);
  assert.deepEqual([brief.total, brief.changeSequence, brief.nextCursor, brief.partial, brief.brief], [20, 11017, undefined, false, true], "paging facts stay (a null cursor is omitted)");
  assert.deepEqual(brief.counts, index.counts);
  assert.equal(brief.items.length, 20);
  const capacity = { sessionId: "s", roleId: "r", sessionActorId: "x", cwd: "/work/long/path", state: "ready", nativeThreadId: "t", tenure: "resident", isLeader: true,
    activeRuns: 0, pendingMessages: 7, queueEntries: 0, openAssignments: 0, openAcceptance: 0, persistedWorkIdle: false, missingCapabilities: ["MESSAGE_GRANT_MISSING"], readyForAcceptance: false };
  const overview = { work: index, capacity: [capacity], observedAt: "2026-11-11T08:00:00.000Z" };
  const briefOverview = briefAcceptanceOverview(overview) as Record<string, any>;
  assert.ok(bytes(briefOverview) < bytes(overview) / 2);
  assert.deepEqual(briefOverview.capacity[0].missingCapabilities, ["MESSAGE_GRANT_MISSING"]);
  assert.equal("cwd" in briefOverview.capacity[0], false);
  const relays = { items: [relay(), relay({ relayId: "relay-2", state: "linked", observationResult: "used" })] };
  const briefList = briefRelays(relays) as Record<string, any>;
  assert.ok(bytes(briefList) < bytes(relays) / 2);
  assert.deepEqual(briefList.items.map((row: any) => [row.relayId, row.state, row.observationResult ?? null]), [["relay-1", "pending", null], ["relay-2", "linked", "used"]]);
  assert.equal("scopeDescription" in briefList.items[0], false, "the long prose is the part dropped");
});

test("work task --brief adds only the relays still in force", () => {
  const withRelays = briefTaskWithRelays(indexTask(4), { items: [relay({ relayId: "old", state: "superseded" }), relay({ relayId: "kept", state: "pending" }), relay({ relayId: "gone", state: "released" })] }) as Record<string, any>;
  assert.deepEqual(withRelays.acceptanceRelays.map((row: any) => row.relayId), ["kept"]);
  assert.equal(briefTaskWithRelays(indexTask(4), null).acceptanceRelays, null, "an unreadable relay list is null, not an empty list");
});

async function run(args: string[], responses: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const target = new URL(String(url)); const key = target.pathname + target.search; calls.push(key);
    const hit = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 });
  });
  let stdout = "", stderr = "";
  try { const code = await runCli(args, { EVOLOOP_TOKEN: "fixture" }, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }); return { code, stdout, stderr, calls }; }
  finally { fetch.mock.restore(); }
}

test("without --brief the three reads print exactly what the service answered; with it they print the brief form", async () => {
  const index = page(), overview = { work: page(), capacity: [], observedAt: "x" }, one = indexTask(5);
  const base = `/api/projects/${project}`;
  const responses = { [`${base}/work-management/index`]: index, [`${base}/acceptance-relay/overview`]: overview, [`${base}/work-management/tasks/${taskId}`]: one, [`${base}/tasks/${taskId}/acceptance-relay`]: { items: [relay()] } };
  for (const args of [["work", "leader"], ["work", "acceptance"], ["work", "task", taskId]]) {
    const plain = await run([...args, "--project", project], responses);
    assert.equal(plain.code, 0, plain.stderr);
    const expected = args[1] === "leader" ? index : args[1] === "acceptance" ? overview : one;
    assert.equal(plain.stdout, JSON.stringify(expected) + "\n", `${args.join(" ")} default output is unchanged`);
    const brief = await run([...args, "--brief", "--project", project], responses);
    assert.equal(brief.code, 0, brief.stderr);
    assert.ok(Buffer.byteLength(brief.stdout) < Buffer.byteLength(plain.stdout) / 2, `${args.join(" ")}: ${Buffer.byteLength(brief.stdout)} vs ${Buffer.byteLength(plain.stdout)}`);
    assert.equal(JSON.parse(brief.stdout).brief, true);
  }
  const task = JSON.parse((await run(["work", "task", taskId, "--brief", "--project", project], responses)).stdout);
  assert.equal(task.version, 7);
  assert.equal(task.acceptanceRelays.length, 1);
  const relays = JSON.parse((await run(["work", "acceptance", taskId, "--brief", "--project", project], responses)).stdout);
  assert.equal(relays.items[0].relayId, "relay-1");
});

test("work task --brief still answers when the relay list cannot be read", async () => {
  const base = `/api/projects/${project}`;
  const result = await run(["work", "task", taskId, "--brief", "--project", project], { [`${base}/work-management/tasks/${taskId}`]: indexTask(6) });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.phase, "awaiting_acceptance");
  assert.equal(body.acceptanceRelays, null);
});

test("--brief is refused where it has no brief form, before any request is made", async () => {
  for (const args of [["work", "leader", "--documents", "--brief"], ["work", "acceptance", "mine", "--brief"], ["work", "list", "--brief"], ["work", "leader", "changes", "--brief"]]) {
    const result = await run([...args, "--project", project], {});
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.calls.length, 0, `${args.join(" ")} makes no request`);
  }
});
