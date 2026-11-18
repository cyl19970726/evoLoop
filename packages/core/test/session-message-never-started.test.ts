// Task a533cb64: a message whose bound native Turn never started (host down between turn/start and the native record) used to stay
// unknown forever and keep its Session busy, so the recovery gate could not be resumed (the Leader stalled on 11-18).
import assert from "node:assert/strict";
import test from "node:test";
import { NEVER_STARTED_GRACE_MS, SessionMessageService, neverStartedProof } from "../src/session-messages/index.ts";

const started = "2026-11-17T21:18:49.000Z";
const startedMs = Date.parse(started);
const later = startedMs + NEVER_STARTED_GRACE_MS + 1;
const processing = { state: "unknown" as const, nativeTurnId: "turn-bound", startedAt: started };
const ended = (id: string, at: string, status = "completed") => ({ id, status, completedAtUtc: at });
const history = [ended("turn-newest", "2026-11-17T21:01:55.000Z"), ended("turn-older", "2026-11-17T20:02:08.000Z", "failed")];

test("never started: newest native Turn ended before the dispatch began, bound Turn absent, grace passed", () => {
  assert.deepEqual(neverStartedProof(processing, history, later), {
    nativeTurnId: "turn-bound", newestTurnId: "turn-newest", newestCompletedAtUtc: "2026-11-17T21:01:55.000Z", processingStartedAt: started });
  assert.ok(neverStartedProof({ ...processing, state: "running" }, history, later), "a running record is judged the same way");
});

test("never started: each missing proof leaves the message unknown", () => {
  const cases: [string, unknown][] = [
    ["inside the grace", neverStartedProof(processing, history, startedMs + NEVER_STARTED_GRACE_MS - 1)],
    ["newest Turn still running", neverStartedProof(processing, [{ id: "turn-live", status: "inProgress", completedAtUtc: null }, ...history], later)],
    ["newest Turn ended at the dispatch start", neverStartedProof(processing, [ended("turn-same", started), ...history], later)],
    ["newest Turn ended after the dispatch start", neverStartedProof(processing, [ended("turn-after", "2026-11-17T21:19:00.000Z"), ...history], later)],
    ["an older listed Turn ended after the dispatch start", neverStartedProof(processing, [history[0]!, ended("turn-odd", "2026-11-17T21:20:00.000Z")], later)],
    ["terminal Turn without a completion time", neverStartedProof(processing, [{ id: "turn-x", status: "completed", completedAtUtc: null }], later)],
    ["empty history", neverStartedProof(processing, [], later)],
    ["bound Turn is listed", neverStartedProof(processing, [ended("turn-bound", "2026-11-17T21:01:55.000Z")], later)],
    ["no bound Turn", neverStartedProof({ ...processing, nativeTurnId: null }, history, later)],
    ["already settled", neverStartedProof({ ...processing, state: "failed" }, history, later)],
    ["unreadable start time", neverStartedProof({ ...processing, startedAt: "not a time" }, history, later)],
  ];
  for (const [name, proof] of cases) assert.equal(proof, null, name);
});

const serviceWith = (stored: Record<string, unknown>, message: Record<string, unknown>, now: string) => {
  const settled: string[] = [];
  const tx = { sessionMessages: {
    getSessionMessageProcessing: async () => stored,
    updateSessionMessageProcessing: async (next: object) => Object.assign(stored, next),
    getSessionMessage: async () => message,
    updateSessionMessage: async (next: object) => Object.assign(message, next),
    markSessionMessageSettled: async (_session: string, id: string) => { settled.push(id); },
  } };
  const service = new SessionMessageService({
    uow: { transaction: async (_projectId: string, action: (value: unknown) => Promise<unknown>) => action(tx) },
    clock: { now: () => now }, ids: { next: () => "id" }, grantFor: async () => null,
  } as never);
  return { service, settled };
};

test("never started: the service fails the message once, with the proof in the reason, and does not resend", async () => {
  const stored = { sessionId: "session-1", nativeTurnId: "turn-bound", state: "unknown", startedAt: started, version: 3, failure: "Bound native Turn is not currently readable" };
  const message = { state: "unknown", version: 3 };
  const { service, settled } = serviceWith(stored, message, new Date(later).toISOString());
  const proof = neverStartedProof(processing, history, later)!;
  await service.failNeverStarted("project", "message-1", proof);
  assert.equal(stored.state, "failed"); assert.equal(stored.version, 4);
  assert.match(String(stored.failure), /never appeared in native history.*turn-newest.*Treated as never started; not resent/);
  assert.equal(message.state, "failed"); assert.equal(message.version, 4);
  assert.deepEqual(settled, ["message-1"]);
  await service.failNeverStarted("project", "message-1", proof);
  assert.equal(stored.version, 4, "an already failed processing is left alone");
});

test("never started: the service rejects a proof that does not match the stored processing", async () => {
  const good = neverStartedProof(processing, history, later)!;
  const bad: [string, Record<string, unknown>, typeof good, string][] = [
    ["another bound Turn", { nativeTurnId: "turn-other" }, good, new Date(later).toISOString()],
    ["another start time", { startedAt: "2026-11-17T21:30:00.000Z" }, good, new Date(later + 3_600_000).toISOString()],
    ["proof newest ended after start", {}, { ...good, newestCompletedAtUtc: "2026-11-17T21:19:00.000Z" }, new Date(later).toISOString()],
    ["inside the grace by the service clock", {}, good, new Date(startedMs + 60_000).toISOString()],
    ["still dispatching", { state: "dispatching" }, good, new Date(later).toISOString()],
  ];
  for (const [name, change, proof, now] of bad) {
    const stored = { sessionId: "session-1", nativeTurnId: "turn-bound", state: "unknown", startedAt: started, version: 3, ...change };
    const message = { state: "unknown", version: 3 };
    const { service } = serviceWith(stored, message, now);
    await assert.rejects(service.failNeverStarted("project", "message-1", proof), /PROCESSING_STATE|does not match/, name);
    assert.equal(message.state, "unknown", name);
  }
});
