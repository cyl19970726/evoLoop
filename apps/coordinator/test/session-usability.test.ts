import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@evoloop/contracts/ports";
import { sessionUsability, usabilityProblems, type UsabilitySession } from "../src/runtime/session-usability.js";
import { createReserveRecipientCheck } from "../src/runtime/recipient-preflight.js";

const p = "00000000-0000-4000-8000-000000000001", role = "00000000-0000-4000-8000-000000000002", sid = "00000000-0000-4000-8000-000000000003";
const base: UsabilitySession = { projectId: p, id: sid, roleId: role, actorId: "owner", state: "ready", nativeThreadId: "thread" };
const writers = (...ids: string[]) => async (_p: string, a: string) => ids.includes(a);
const codes = async (s: Partial<UsabilitySession>, config: Parameters<typeof sessionUsability>[1], live: number, w = writers("worker")) =>
  (await sessionUsability({ ...base, ...s }, config, live, w)).reasons.map(r => r.code);
const exact = { projectId: p, sessionId: sid, sessionActorId: "owner", cliActorId: "worker" };

test("a Session is usable when it has an identity that is a project writer, a native thread and is ready", async () => {
  assert.deepEqual(await codes({}, { materialCli: [exact], roleActors: [] }, 2), []);
  assert.deepEqual(await codes({}, { materialCli: [], roleActors: [{ projectId: p, roleId: role, actorId: "worker" }] }, 1), [], "the Role's actor stands in only for its only live Session");
});

test("each cause that makes every Run fail in the preflight is named", async () => {
  assert.deepEqual(await codes({}, { materialCli: [], roleActors: [] }, 1), ["BUSINESS_IDENTITY_UNBOUND"]);
  assert.deepEqual(await codes({}, { materialCli: [], roleActors: [{ projectId: p, roleId: role, actorId: "worker" }] }, 2), ["BUSINESS_IDENTITY_UNBOUND"], "with a second live Session the Role's actor is not this Session's identity");
  assert.deepEqual(await codes({}, { materialCli: [exact], roleActors: [] }, 2, writers()), ["BUSINESS_IDENTITY_NOT_WRITER"]);
  assert.deepEqual(await codes({ nativeThreadId: null }, { materialCli: [exact], roleActors: [] }, 2), ["NATIVE_THREAD_UNAVAILABLE"]);
  assert.deepEqual(await codes({ state: "closing" }, { materialCli: [exact], roleActors: [] }, 2), ["SESSION_NOT_READY"]);
  assert.deepEqual(await codes({ nativeThreadId: null }, { materialCli: [], roleActors: [] }, 2), ["NATIVE_THREAD_UNAVAILABLE", "BUSINESS_IDENTITY_UNBOUND"], "every reason is listed");
});

test("the reservation check refuses an unusable Session for every Task, and when the judgement fails or says nothing (fail closed); refusals are recorded with their cause", async () => {
  const reasons = (...rs: Array<[string, string]>) => ({ usable: false, reasons: rs.map(([code, reason]) => ({ code, reason })) });
  const recorded: string[] = [];
  const check = (usability: NonNullable<Parameters<typeof createReserveRecipientCheck>[0]["usability"]>) => createReserveRecipientCheck({
    uow: { read: async (_project: string, fn: (reader: any) => Promise<any>) => fn({ getTask: async () => ({ id: "t", currentRevisionId: "r" }), getTaskProposal: async () => ({ acceptanceMode: null }) }) },
    loadIntegrations: async () => ({ runtime: null }), usability, recordRefusal: async (_p, _s, _t, cause) => { recorded.push(cause); } });
  const run = (usability: Parameters<typeof check>[0]) => check(usability)(null, { projectId: p, taskId: "t" }, { id: sid, actorId: "owner", roleId: role });
  const judged = (value: unknown) => async () => new Map([[sid, value as never]]);
  await assert.rejects(run(judged(reasons(["BUSINESS_IDENTITY_UNBOUND", "没有绑定业务身份"]))), (e: DomainError) => e.code === "SESSION_UNUSABLE" && /未创建 Run/.test(e.message) && /没有绑定业务身份/.test(e.message),
    "a Task with no declared acceptance mode is refused for the missing identity too: every Run starts a model");
  await assert.rejects(run(judged(reasons(["NATIVE_THREAD_UNAVAILABLE", "没有可用的原生线程"]))), (e: DomainError) => e.code === "SESSION_UNUSABLE" && /原生线程/.test(e.message));
  await assert.rejects(run(async () => { throw new Error("config unreadable"); }), (e: DomainError) => e.code === "SESSION_USABILITY_UNKNOWN" && /config unreadable/.test(e.message) && /未创建 Run/.test(e.message), "a judgement that throws refuses");
  await assert.rejects(run(async () => new Map()), (e: DomainError) => e.code === "SESSION_USABILITY_UNKNOWN", "a judgement that says nothing about the Session refuses");
  assert.deepEqual(recorded, ["BUSINESS_IDENTITY_UNBOUND", "NATIVE_THREAD_UNAVAILABLE", "USABILITY_UNKNOWN", "USABILITY_UNKNOWN"], "each refusal is recorded with its first cause");
  await assert.doesNotReject(run(judged({ usable: true, reasons: [] })).catch(e => { if (e.code === "SESSION_UNUSABLE" || e.code === "SESSION_USABILITY_UNKNOWN") throw e; }), "a usable Session is not refused by this check");
  const failingRecorder = createReserveRecipientCheck({ uow: { read: async () => null as never }, loadIntegrations: async () => ({ runtime: null }), usability: judged(reasons(["SESSION_NOT_READY", "x"])), recordRefusal: async () => { throw new Error("db down"); } });
  await assert.rejects(failingRecorder(null, { projectId: p, taskId: "t" }, { id: sid, actorId: "o", roleId: role }), (e: DomainError) => e.code === "SESSION_UNUSABLE", "a failure to record never changes the refusal");
});

test("the capacity problems (what `work acceptance` lists as missing) carry the unusable reasons, and USABILITY_UNKNOWN when the judgement fails or says nothing", async () => {
  const judge = (value: unknown) => async () => new Map([[sid, value as never]]);
  assert.deepEqual(await usabilityProblems(judge({ usable: true, reasons: [] }), p, sid), []);
  assert.deepEqual(await usabilityProblems(judge({ usable: false, reasons: [{ code: "BUSINESS_IDENTITY_UNBOUND", reason: "x" }, { code: "NATIVE_THREAD_UNAVAILABLE", reason: "y" }] }), p, sid), ["BUSINESS_IDENTITY_UNBOUND", "NATIVE_THREAD_UNAVAILABLE"]);
  assert.deepEqual(await usabilityProblems(async () => { throw new Error("boom"); }, p, sid), ["USABILITY_UNKNOWN"]);
  assert.deepEqual(await usabilityProblems(async () => new Map(), p, sid), ["USABILITY_UNKNOWN"]);
});
