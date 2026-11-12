import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { DirectInputCommand, DirectInputRecord } from "@evoloop/contracts/direct-input";
import type { RuntimeBinding, RuntimeCapabilities } from "@evoloop/contracts/runtime";
import { DomainError } from "@evoloop/contracts/ports";
import { RuntimeLocalBusyError, RuntimeServerError, RuntimeUnknownError } from "@evoloop/adapter-codex-app-server";
import { DirectInputService } from "../src/direct-input/service.js";
import { SessionSteerLock } from "../src/runtime/session-steer-lock.js";

const projectId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID();
const principal = { actorId: "sender", projectIds: [projectId], permissions: ["read", "write"] as Array<"read" | "write"> };
const binding: RuntimeBinding = { projectId, sessionId, roleId: "role", nativeThreadId: "thread",
  nativeSessionId: "thread", cwd: "/tmp/direct-input-service", authorizationScope: "test",
  owner: "evoloop-codex-app-server" };
const grant = { projectId, sessionId, senderActorId: principal.actorId, receiverRoleId: "role",
  receiverActorId: "receiver", cwd: binding.cwd, enabled: true, canStart: true, canSteer: true };
const capabilities = (midTurnInput: boolean, idleTurnStart: boolean): RuntimeCapabilities => ({
  provider: "codex", process: "shared",
  delivery: { midTurnInput, idleTurnStart, callerAssignedTurnKey: false, callerAssignedSessionId: false },
  errors: { notSent: true, rejected: true }, compaction: { autoCompacts: true, mode: "unavailable" },
  history: { workTrace: true, workspace: false }, naming: true, archive: "native", nativeInput: false,
  executionProfileActivation: true, modelList: true, usage: "unavailable", cost: false,
});
const command = (): DirectInputCommand => ({
  inputId: randomUUID(), operationId: randomUUID(), content: "continue this Turn", expectedTurnId: null,
});
const record = (value: DirectInputCommand, mode: "start" | "steer"): DirectInputRecord => ({
  projectId, sessionId, inputId: value.inputId, operationId: value.operationId, actorId: principal.actorId,
  content: value.content, mode, source: { kind: "message", id: value.inputId, processingId: randomUUID() },
  expectedTurnId: mode === "steer" ? turnId : null, actualTurnId: null, nativeItemId: null,
  state: "attempted", reason: null, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

test("capability answers from the exact Session runtime for steer and idle start", async () => {
  let turns = 0;
  const runtime = {
    isReady: () => true, capabilitiesFor: () => capabilities(false, false),
    registerBinding: async () => {}, listTurns: async () => { turns++; return { data: [], nextCursor: null }; },
  } as never;
  const store = {
    inspect: async () => ({ state: "running", turnId, used: 0 }),
  } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const result = await service.capability(principal, projectId, sessionId);
  assert.deepEqual({ available: result.available, mode: result.mode, reasonCode: result.reasonCode },
    { available: false, mode: null, reasonCode: "NATIVE_STEER_UNAVAILABLE" });
  assert.equal(turns, 0, "an unavailable runtime is refused before native history is read");
});

test("one Session steer lock makes a competing submit retryable and preserves its draft for retry", async () => {
  const lock = new SessionSteerLock(), first = command(), second = command();
  const accepted: string[] = [];
  let reserve = 0;
  const store = {
    get: async () => null, hasPrimary: async () => false,
    reserve: async (_project: string, _session: string, _actor: string, value: DirectInputCommand) => {
      reserve++;
      return { record: record(value, "start"), created: true };
    },
    accept: async (_project: string, id: string) => {
      accepted.push(id); return { ...record(first, "start"), inputId: id, state: "accepted" as const };
    },
  } as never;
  let releaseNative!: () => void;
  const nativeGate = new Promise<void>(resolve => { releaseNative = resolve; });
  let enteredNative!: () => void;
  const nativeStarted = new Promise<void>(resolve => { enteredNative = resolve; });
  const runtime = {
    isReady: () => true, capabilitiesFor: () => capabilities(true, true), registerBinding: async () => {},
    qualifyConversationThread: async () => ({ available: true, reason: "ready", fingerprint: "a".repeat(64) }),
    startConversationTurn: async (_binding: RuntimeBinding, _input: string, id: string) => {
      enteredNative(); await nativeGate; return { id: `turn-${id}`, status: "inProgress", completedAtUtc: null };
    },
    listTurns: async () => ({ data: [], nextCursor: null }),
  } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true, lock,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const owner = service.submit(principal, projectId, sessionId, first);
  await nativeStarted;
  await assert.rejects(() => service.submit(principal, projectId, sessionId, second),
    error => error instanceof DomainError && error.code === "SESSION_INPUT_BUSY");
  assert.equal(reserve, 1, "a busy lock does not reserve the competing input");
  releaseNative();
  assert.equal((await owner).state, "accepted");
  const retried = await service.submit(principal, projectId, sessionId, second);
  assert.equal(retried.state, "accepted");
  assert.deepEqual(accepted, [first.inputId, second.inputId]);
});

test("a non-steerable Turn rejects direct input and atomically queues its content", async () => {
  const value = { ...command(), expectedTurnId: turnId };
  const queued: string[] = [];
  const store = {
    get: async () => null, hasPrimary: async () => true,
    reserve: async () => ({ record: record(value, "steer"), created: true }),
    rejectSteerAndQueue: async (_project: string, id: string) => {
      queued.push(id); return { ...record(value, "steer"), state: "rejected" as const,
        reason: "Native Turn kind cannot accept input; saved as a queued ordinary message" };
    },
  } as never;
  const runtime = {
    isReady: () => true, capabilitiesFor: () => capabilities(true, true), registerBinding: async () => {},
    listTurns: async () => ({ data: [{ id: turnId, status: "inProgress", completedAtUtc: null }], nextCursor: null }),
    steerTurn: async () => { throw new RuntimeServerError("turn/steer", 7, -32602,
      "cannot steer a review turn", undefined,
      { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } }); },
  } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const receipt = await service.submit(principal, projectId, sessionId, value);
  assert.equal(receipt.state, "rejected");
  assert.deepEqual(queued, [value.inputId]);
});

test("a review ancestor Turn stays steerable enough to receive the native refusal and queue its content", async () => {
  const value = { ...command(), expectedTurnId: turnId };
  const queued: string[] = [];
  const store = {
    get: async () => null, hasPrimary: async () => true,
    reserve: async () => ({ record: record(value, "steer"), created: true }),
    rejectSteerAndQueue: async (_project: string, id: string) => {
      queued.push(id); return { ...record(value, "steer"), state: "rejected" as const };
    },
  } as never;
  const runtime = {
    isReady: () => true, capabilitiesFor: () => capabilities(true, true), registerBinding: async () => {},
    listTurns: async () => ({ data: [
      { id: "review-child", status: "inProgress", completedAtUtc: null },
      { id: turnId, status: "completed", completedAtUtc: new Date().toISOString() },
    ], nextCursor: null }),
    steerTurn: async () => { throw new RuntimeServerError("turn/steer", 7, -32600,
      "cannot steer a review turn", undefined,
      { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } }); },
  } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const receipt = await service.submit(principal, projectId, sessionId, value);
  assert.equal(receipt.state, "rejected");
  assert.deepEqual(queued, [value.inputId]);
});

test("a locally refused in-flight steer is retryable with the same input and has no native replay", async () => {
  const value = { ...command(), expectedTurnId: turnId };
  let saved = record(value, "steer");
  let reserved = false;
  const writes: string[] = [];
  const store = {
    get: async () => reserved ? saved : null,
    hasPrimary: async () => true,
    reserve: async () => { const created = !reserved; reserved = true; return { record: saved, created }; },
    accept: async (_project: string, id: string, turn: string) => {
      saved = { ...saved, inputId: id, state: "accepted" as const, actualTurnId: turn };
      return saved;
    },
    rejectSteerAndQueue: async () => { throw new Error("must not queue a local busy"); },
    reject: async () => { throw new Error("must not reject a local busy"); },
    unknown: async () => { throw new Error("must not mark a local busy unknown"); },
  } as never;
  const runtime = {
    isReady: () => true, capabilitiesFor: () => capabilities(true, true), registerBinding: async () => {},
    listTurns: async () => ({ data: [{ id: turnId, status: "inProgress", completedAtUtc: null }], nextCursor: null }),
    steerTurn: async (_binding: RuntimeBinding, _turn: string, _content: string, id: string) => {
      writes.push(id);
      if (writes.length === 1) throw new RuntimeLocalBusyError("turn/steer", "another send owns this Thread");
      return { turnId, itemId: "item-1" };
    },
  } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  await assert.rejects(() => service.submit(principal, projectId, sessionId, value),
    error => error instanceof DomainError && error.code === "SESSION_INPUT_BUSY");
  assert.equal(saved.state, "attempted", "the durable intent survives the local refusal");
  const retried = await service.submit(principal, projectId, sessionId, value);
  assert.equal(retried.state, "accepted");
  assert.deepEqual(writes, [value.inputId, value.inputId], "both attempts carry the original input ID");
});

test("an accepted steer whose Turn later fails stays unread without a native Item", async () => {
  const value = { ...command(), expectedTurnId: turnId };
  const accepted: DirectInputRecord = { ...record(value, "steer"), state: "accepted",
    actualTurnId: turnId, nativeItemId: null, version: 2 };
  let acceptedWrites = 0;
  const store = {
    get: async () => accepted,
    accept: async () => { acceptedWrites++; return accepted; },
  } as never;
  const runtime = {
    isReady: () => true, registerBinding: async () => {},
    listTurns: async () => ({ data: [{ id: turnId, status: "failed", completedAtUtc: new Date().toISOString() }],
      nextCursor: null }),
    listItems: async () => ({ data: [], nextCursor: null }),
  } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const receipt = await service.reconcile({ ...principal, permissions: ["read", "write"] },
    projectId, value.inputId);
  assert.equal(receipt.state, "accepted", "the native acknowledgement is still a delivery fact");
  assert.equal(receipt.nativeItemId, null, "no matching Item means the input is unread, not consumed");
  assert.equal(acceptedWrites, 0);
});

test("capability: a held provider offers no idle start, with the reason named", async () => {
  const runtime = { isReady: () => true, capabilitiesFor: () => capabilities(true, true), registerBinding: async () => {}, qualifyConversationThread: async () => ({ available: true, reason: "ok", fingerprint: "a".repeat(64) }) } as never;
  const store = { inspect: async () => ({ state: "idle", turnId: null, used: 0 }), providerHeld: async () => true } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true, admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const result = await service.capability(principal, projectId, sessionId);
  assert.equal(result.available, false); assert.equal(result.reasonCode, "PROVIDER_HELD"); assert.match(result.detail!, /paused/);
  const running = new DirectInputService({ store: { inspect: async () => ({ state: "running", turnId, used: 0 }), providerHeld: async () => true } as never,
    runtime: () => ({ ...(runtime as object), listTurns: async () => ({ data: [{ id: turnId, status: "inProgress" }], nextCursor: null }) }) as never,
    canWrite: () => true, admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  assert.equal((await running.capability(principal, projectId, sessionId)).mode, "steer", "a running Turn can still be added to");
});

// ---- Task e31f9511: "this kind of Session cannot take an addition" is not "no authorization" ----------------------------------
const reasonFor = async (options: { midTurnInput: boolean; admission: "granted" | "missing"; canSteer?: boolean; state?: "running" | "idle" }) => {
  const runtime = { isReady: () => true, capabilitiesFor: () => capabilities(options.midTurnInput, true), registerBinding: async () => {},
    qualifyConversationThread: async () => ({ available: true, reason: "ok", fingerprint: "f".repeat(64) }),
    listTurns: async () => ({ data: [{ id: turnId, status: "inProgress" }], nextCursor: null }) } as never;
  const store = { inspect: async () => ({ state: options.state ?? "running", turnId: options.state === "idle" ? null : turnId, used: 0 }), providerHeld: async () => false } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true, bindingFor: async () => binding,
    admission: async () => { if (options.admission === "missing") throw new DomainError("DIRECT_GRANT_MISSING", "no grant"); return { grant: { ...grant, canSteer: options.canSteer ?? true }, binding }; } });
  const result = await service.capability(principal, projectId, sessionId);
  return result.reasonCode;
};

test("capability: a running Session whose runtime has no mid-turn input says so, with or without a grant; authorization is named only when it is what is missing", async () => {
  // Claude-like runtime (no mid-turn input): the runtime's limit wins over every grant state.
  assert.equal(await reasonFor({ midTurnInput: false, admission: "missing" }), "NATIVE_STEER_UNAVAILABLE", "no grant, but adding one would not help");
  assert.equal(await reasonFor({ midTurnInput: false, admission: "granted", canSteer: false }), "NATIVE_STEER_UNAVAILABLE", "a grant without steer does not change the runtime's limit");
  assert.equal(await reasonFor({ midTurnInput: false, admission: "granted", canSteer: true }), "NATIVE_STEER_UNAVAILABLE");
  // A runtime that can take an addition: now the authorization is what is said.
  assert.equal(await reasonFor({ midTurnInput: true, admission: "missing" }), "DIRECT_GRANT_MISSING");
  assert.equal(await reasonFor({ midTurnInput: true, admission: "granted", canSteer: false }), "DIRECT_STEER_DISABLED");
  assert.equal(await reasonFor({ midTurnInput: true, admission: "granted", canSteer: true }), "READY_TO_STEER");
  // Idle: nothing to add to, so a missing grant is still a missing grant.
  assert.equal(await reasonFor({ midTurnInput: false, admission: "missing", state: "idle" }), "DIRECT_GRANT_MISSING");
});

test("a steer whose Turn changed is queued by the store and nothing is sent to the runtime", async () => {
  const value = { ...command(), expectedTurnId: "turn-seen" };
  let steers = 0, starts = 0;
  const runtime = {
    isReady: () => true, capabilitiesFor: () => capabilities(true, true), registerBinding: async () => {},
    steerTurn: async () => { steers++; return { turnId: "x", itemId: null }; },
    startConversationTurn: async () => { starts++; throw new Error("never"); },
  } as never;
  const queued = { ...record(value, "steer"), expectedTurnId: "turn-seen", state: "rejected" as const,
    reason: "TURN_CHANGED: the Turn changed before the input was added; saved as a queued ordinary message", queuedMessageId: value.inputId };
  const store = { get: async () => null, hasPrimary: async () => true, reserve: async () => ({ record: queued, created: true }) } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const receipt = await service.submit(principal, projectId, sessionId, value);
  assert.equal(receipt.state, "rejected"); assert.equal(receipt.queuedMessageId, value.inputId);
  assert.match(receipt.reason!, /^TURN_CHANGED/);
  assert.deepEqual({ steers, starts }, { steers: 0, starts: 0 }, "the changed Turn is not steered and no other Turn is started");
  assert.equal("content" in receipt, false);
});

test("a missing grant is refused with the missing item named, in the capability and the submission", async () => {
  const refuse = async () => { throw new DomainError("DIRECT_GRANT_MISSING", "Direct input refused; missing: direct input grant (steer or start) for this sender and Session"); };
  const runtime = { isReady: () => true } as never;
  const service = new DirectInputService({ store: { get: async () => null } as never, runtime: () => runtime, canWrite: () => true,
    admission: refuse, bindingFor: async () => binding });
  const capability = await service.capability(principal, projectId, sessionId);
  assert.equal(capability.available, false); assert.equal(capability.reasonCode, "DIRECT_GRANT_MISSING");
  assert.match(capability.detail!, /missing: direct input grant/);
  await assert.rejects(service.submit(principal, projectId, sessionId, command()), { code: "DIRECT_GRANT_MISSING", message: /missing: direct input grant/ });
});

// ---- Task e0bcde26 (follow-up to #350) ---------------------------------------------------------------------------------------
const steerFixture = (thrown: unknown) => {
  const value = { ...command(), expectedTurnId: turnId };
  const calls: string[] = [];
  const stored = { ...record(value, "steer") };
  const store = {
    get: async () => null, hasPrimary: async () => true,
    reserve: async () => ({ record: stored, created: true }),
    reject: async () => { calls.push("reject"); return { ...stored, state: "rejected" as const, reason: "Native request was explicitly rejected" }; },
    rejectSteerAndQueue: async () => { calls.push("queue"); return { ...stored, state: "rejected" as const, queuedMessageId: value.inputId }; },
    unknown: async () => { calls.push("unknown"); return { ...stored, state: "unknown" as const }; },
  } as never;
  const runtime = { isReady: () => true, capabilitiesFor: () => capabilities(true, true), registerBinding: async () => {},
    steerTurn: async () => { throw thrown; } } as never;
  const service = new DirectInputService({ store, runtime: () => runtime, canWrite: () => true, admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  return { service, value, calls };
};

test("item 1: the native runtime refusing a steer because the Turn just ended (-32600, no steer classification) saves it as one queued message, not a red error", async () => {
  // The window: the Turn has ended natively while the database still says running; the runtime answers -32600 and no steerRejection.
  const ended = new RuntimeServerError("turn/steer", 9, -32600, "no active turn to steer");
  assert.equal(ended.steerRejection, null);
  const { service, value, calls } = steerFixture(ended);
  const receipt = await service.submit(principal, projectId, sessionId, value);
  assert.deepEqual(calls, ["queue"], "queued once, not rejected");
  assert.equal(receipt.state, "rejected"); assert.equal(receipt.queuedMessageId, value.inputId);
  // A different expected Turn answered the same way is the same window.
  const mismatch = steerFixture(new RuntimeServerError("turn/steer", 10, -32600, "expected turn id does not match the active turn"));
  await mismatch.service.submit(principal, projectId, sessionId, mismatch.value);
  assert.deepEqual(mismatch.calls, ["queue"]);
});

test("item 1: only a provable refusal of the steer is queued; an unclear outcome stays unknown (never a second message)", async () => {
  const lost = steerFixture(new RuntimeUnknownError("turn/steer", 11, "no reply"));
  await lost.service.submit(principal, projectId, sessionId, lost.value);
  assert.deepEqual(lost.calls, ["unknown"], "a lost reply may have reached the Turn: not queued");
});
