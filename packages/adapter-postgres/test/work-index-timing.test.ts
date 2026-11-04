import assert from "node:assert/strict";
import { test } from "node:test";
import { leaderWorkTaskFromRow } from "../src/work-index.ts";

const at = (minute: number) => new Date(Date.parse("2026-11-04T06:00:00Z") + minute * 60_000).toISOString();
const event = (kind: string, id: string, minute: number, extra: Record<string, unknown> = {}) =>
  ({ kind, id, at: at(minute), ...extra });

function row(timing_events: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    task_id: "task", version: 9, current_revision_id: "rev-3", title: "Timing",
    kind: "implementation", owner: "developer-role", state: "in_progress",
    created_at: at(0), business_changed_at: at(0), pending_impact_count: 0,
    dependency_facts: [], plan_version: null, has_closure: false,
    assignment_state: "accepted", assignment_target_kind: "owned", assignment_target_id: "session",
    latest_run_id: "run-3", latest_run_state: "completed", run_updated_at: at(90),
    delivery_id: "delivery-3", delivery_run_id: "run-3", delivery_task_revision_id: "rev-3",
    delivery_result: "passed", delivery_created_at: at(93), consumer: "qa-actor", use_required: true,
    timing_events, ...extra,
  };
}

test("three real-shaped rounds keep running through late ack and submitted through late terminal", () => {
  const events: Array<Record<string, unknown>> = [event("task", "rev-1", 0, { state: "in_progress", taskVersion: 3 })];
  for (let n = 1; n <= 3; n++) {
    const base = (n - 1) * 30;
    events.push(event("assignment", `assignment-${n}`, base + 1,
      { state: "assigned", targetId: "session", taskVersion: n + 2 }));
    events.push(event("run_reserved", `run-${n}`, base + 2,
      { targetId: "session", taskVersion: n + 2 }));
    events.push(event("run_bound", `run-${n}`, base + 3, { taskVersion: n + 2 }));
    events.push(event("assignment", `assignment-${n}-accepted`, base + 4,
      { state: "accepted", targetId: "session", taskVersion: n + 2 }));
    events.push(event("ack", `assignment-${n}-accepted`, base + 4,
      { state: "accepted", targetId: "session", taskVersion: n + 2 }));
    events.push(event("submission", `submission-${n}`, base + 20,
      { runId: `run-${n}`, taskVersion: n + 2 }));
    events.push(event("run_terminal", `run-${n}`, base + 22,
      { state: "completed", taskVersion: n + 2 }));
    events.push(event("delivery", `delivery-${n}`, base + 23,
      { state: n === 3 ? "passed" : "failed", runId: `run-${n}`, taskVersion: n + 2 }));
    if (n < 3) events.push(event("task", `rev-${n + 1}`, base + 24,
      { state: "in_progress", taskVersion: n + 3 }));
  }
  const value = leaderWorkTaskFromRow(row(events) as never, at(100));
  for (let n = 1; n <= 3; n++) {
    const intervals = value.timing.rounds.flatMap(round => round.intervals);
    const running = intervals.find(i => i.stage === "running" && i.source?.id === `run-${n}`);
    assert.equal(running?.endedAt, at((n - 1) * 30 + 20));
    assert.ok(!intervals.some(i => i.stage === "awaiting_run" && i.startedAt === at((n - 1) * 30 + 4)));
    assert.ok(!intervals.some(i => i.stage === "awaiting_submission" && i.startedAt === at((n - 1) * 30 + 22)));
  }
  assert.equal(value.timing.latestEffectiveProgress?.kind, "delivery");
  assert.ok(value.timing.rounds.every(round => round.intervals.every(i =>
    !i.startedAt || !i.endedAt || Date.parse(i.endedAt) >= Date.parse(i.startedAt))));
});

test("explicit current follow-up wins over a used observation; owner remains a Role", () => {
  const events = [
    event("task", "rev-3", 0, { state: "in_progress" }),
    event("delivery", "delivery-3", 1, { state: "passed", runId: "run-3" }),
    event("observation", "used", 2, { state: "used", deliveryId: "delivery-3" }),
  ];
  const explicit = leaderWorkTaskFromRow(row(events, {
    observation_result: "used", follow_up_task_revision_id: "rev-3",
    follow_up_waiting_on: { kind: "consumer", id: "qa-actor" },
  }) as never, at(4));
  assert.deepEqual(explicit.timing.current.waitingFor, { kind: "consumer", id: "qa-actor" });
  assert.deepEqual({ kind: explicit.responsible.kind, id: explicit.responsible.id },
    { kind: "consumer", id: "qa-actor" });
  const actualLeader = leaderWorkTaskFromRow(row(events, {
    observation_result: "used", follow_up_task_revision_id: "rev-3",
    follow_up_waiting_on: { kind: "leader", id: "leader-actor" },
  }) as never, at(4));
  assert.deepEqual(actualLeader.timing.current.waitingFor, { kind: "leader", id: "leader-actor" });
  assert.equal(actualLeader.responsible.id, "leader-actor");
  const unverifiedLeader = leaderWorkTaskFromRow(row(events, {
    observation_result: "used", follow_up_task_revision_id: "rev-3",
    follow_up_waiting_on: { kind: "leader", id: null },
  }) as never, at(4));
  assert.deepEqual(unverifiedLeader.timing.current.waitingFor, { kind: "unknown", id: null });
  assert.equal(unverifiedLeader.responsible.kind, "unknown");
  const implicit = leaderWorkTaskFromRow(row(events, { observation_result: "used" }) as never, at(4));
  assert.deepEqual(implicit.timing.current.waitingFor, { kind: "role", id: "developer-role" });
  assert.equal(implicit.responsible.kind, "role");
  const staleFollowUp = leaderWorkTaskFromRow(row(events, {
    observation_result: "used", follow_up_task_revision_id: "rev-2",
    follow_up_waiting_on: { kind: "consumer", id: "old-qa" },
  }) as never, at(4));
  assert.deepEqual(staleFollowUp.timing.current.waitingFor, { kind: "role", id: "developer-role" });
  const unobserved = leaderWorkTaskFromRow(row(events.slice(0, 2), { observation_result: null }) as never, at(4));
  assert.deepEqual(unobserved.timing.current.waitingFor, { kind: "consumer", id: "qa-actor" });
  const reviewed = leaderWorkTaskFromRow(row(events, {
    observation_result: "used", review_decision: "acknowledged", review_actor_id: "leader-actor",
  }) as never, at(4));
  assert.deepEqual(reviewed.timing.current.waitingFor, { kind: "role", id: "developer-role" });
  const noOwner = leaderWorkTaskFromRow(row(events, { observation_result: "used", owner: null }) as never, at(4));
  assert.deepEqual(noOwner.timing.current.waitingFor, { kind: "unknown", id: null });
});

test("late ack cannot refresh progress while its Run is already running", () => {
  const value = leaderWorkTaskFromRow(row([
    event("task", "rev-3", 0, { state: "in_progress", taskVersion: 9 }),
    event("assignment", "assignment", 1, { state: "assigned", targetId: "session", taskVersion: 9 }),
    event("run_reserved", "run-3", 2, { targetId: "session", taskVersion: 9 }),
    event("run_bound", "run-3", 3, { taskVersion: 9 }),
    event("ack", "assignment", 4, { targetId: "session", taskVersion: 9 }),
  ], { latest_run_state: "running", delivery_id: null }) as never, at(5));
  assert.equal(value.timing.current.stage, "running");
  assert.deepEqual(value.timing.latestEffectiveProgress,
    { kind: "run_bound", sourceId: "run-3", at: at(3) });
});

test("new assignment and Run are retained; old Run terminal cannot displace the new one", () => {
  const value = leaderWorkTaskFromRow(row([
    event("task", "rev-2", 0, { state: "in_progress", taskVersion: 8 }),
    event("run_reserved", "run-2", 1, { targetId: "session", taskVersion: 8 }),
    event("run_bound", "run-2", 2, { taskVersion: 8 }),
    event("assignment", "release", 3, { state: "released", targetId: "session", taskVersion: 8 }),
    event("task", "rev-3", 4, { state: "in_progress", taskVersion: 9 }),
    event("assignment", "replacement", 5,
      { state: "assigned", targetId: "other-session", taskVersion: 9 }),
    event("run_reserved", "run-3", 6, { targetId: "other-session", taskVersion: 9 }),
    event("run_bound", "run-3", 7, { taskVersion: 9 }),
    event("run_terminal", "run-2", 8, { state: "failed", taskVersion: 8 }),
  ], { latest_run_state: "running", delivery_id: null }) as never, at(9));
  assert.equal(value.timing.current.stage, "running");
  assert.equal(value.timing.current.source?.id, "run-3");
  assert.ok(value.timing.rounds.flatMap(r => r.intervals).some(i => i.stage === "unassigned" && i.startedAt === at(3)));
  assert.ok(value.timing.rounds.flatMap(r => r.intervals).some(i => i.stage === "awaiting_ack" && i.startedAt === at(5)));
  assert.equal(value.timing.latestEffectiveProgress?.sourceId, "run-3");
});

test("a newer Task revision can assign the same Session for a distinct round", () => {
  const value = leaderWorkTaskFromRow(row([
    event("task", "rev-2", 0, { state: "in_progress", taskVersion: 8 }),
    event("run_reserved", "run-2", 1, { targetId: "session", taskVersion: 8 }),
    event("run_bound", "run-2", 2, { taskVersion: 8 }),
    event("task", "rev-3", 3, { state: "in_progress", taskVersion: 9 }),
    event("assignment", "new-assignment", 4,
      { state: "assigned", targetId: "session", taskVersion: 9 }),
    event("ack", "new-assignment", 5,
      { state: "accepted", targetId: "session", taskVersion: 9 }),
  ], { latest_run_state: "completed", delivery_id: null }) as never, at(6));
  assert.equal(value.timing.current.stage, "awaiting_run");
  assert.equal(value.timing.current.source?.id, "new-assignment");
});

test("a same-time assignment without a shared reservation operation still supersedes the Run", () => {
  const value = leaderWorkTaskFromRow(row([
    event("task", "rev-3", 0, { state: "in_progress", taskVersion: 9 }),
    event("run_reserved", "run-3", 1, { targetId: "session", taskVersion: 9, sequence: 10 }),
    event("assignment", "separate-assignment", 1,
      { state: "assigned", targetId: "session", taskVersion: 9, sequence: 11 }),
    event("run_bound", "run-3", 2, { taskVersion: 9 }),
  ], { latest_run_state: "running", delivery_id: null }) as never, at(3));
  assert.equal(value.timing.current.stage, "awaiting_ack");
  assert.equal(value.timing.current.source?.id, "separate-assignment");
  assert.ok(!value.timing.rounds.flatMap(round => round.intervals).some(interval =>
    interval.stage === "running" && interval.source?.id === "run-3"));
});

test("a failed Run can be reassigned to the same Session and revision without reviving its old ack", () => {
  const value = leaderWorkTaskFromRow(row([
    event("task", "rev-3", 0, { state: "in_progress", taskVersion: 9 }),
    event("assignment", "assignment-1", 1,
      { state: "assigned", targetId: "session", taskVersion: 9 }),
    event("run_reserved", "run-3", 2, { targetId: "session", taskVersion: 9 }),
    event("run_bound", "run-3", 3, { taskVersion: 9 }),
    event("run_terminal", "run-3", 4, { state: "failed", taskVersion: 9 }),
    event("ack", "assignment-1", 4.5, { targetId: "session", taskVersion: 9 }),
    event("assignment", "assignment-2", 5,
      { state: "assigned", targetId: "session", taskVersion: 9 }),
    event("ack", "assignment-2", 6, { targetId: "session", taskVersion: 9 }),
    event("ack", "assignment-1", 6.5, { targetId: "session", taskVersion: 9 }),
  ], { latest_run_state: "failed", delivery_id: null }) as never, at(7));
  assert.ok(value.timing.rounds.flatMap(r => r.intervals).some(i => i.stage === "rework" && i.startedAt === at(4)));
  assert.ok(!value.timing.rounds.flatMap(r => r.intervals).some(i => i.stage === "awaiting_run" && i.startedAt === at(4.5)));
  assert.equal(value.timing.current.stage, "awaiting_run");
  assert.equal(value.timing.current.source?.id, "assignment-2");
  assert.equal(value.timing.latestEffectiveProgress?.sourceId, "assignment-2");
});

test("a real failure or unknown terminal still changes its own Run after submission", () => {
  for (const state of ["failed", "unknown"]) {
    const value = leaderWorkTaskFromRow(row([
      event("task", "rev-3", 0, { state: "in_progress", taskVersion: 9 }),
      event("run_reserved", "run-3", 1, { targetId: "session", taskVersion: 9 }),
      event("run_bound", "run-3", 2, { taskVersion: 9 }),
      event("submission", "submission-3", 3, { runId: "run-3", taskVersion: 9 }),
      event("run_terminal", "run-3", 4, { state, taskVersion: 9 }),
    ], { latest_run_state: state, delivery_id: null }) as never, at(5));
    assert.equal(value.timing.current.stage, state === "unknown" ? "unknown" : "rework");
    assert.equal(value.timing.latestEffectiveProgress?.kind, "run_terminal");
  }
});
