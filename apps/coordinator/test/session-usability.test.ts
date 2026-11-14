import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@evoloop/contracts/ports";
import { sessionUsability, type UsabilitySession } from "../src/runtime/session-usability.js";
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

test("the reservation check refuses the missing identity only for a Task that needs a signer, and a missing native thread for every Task", async () => {
  const reasons = (...rs: Array<[string, string]>) => ({ usable: false, reasons: rs.map(([code, reason]) => ({ code, reason })) });
  const check = (mode: string | null, judged: ReturnType<typeof reasons>) => createReserveRecipientCheck({
    uow: { read: async (_project: string, fn: (reader: any) => Promise<any>) => fn({ getTask: async () => ({ id: "t", currentRevisionId: "r" }), getTaskProposal: async () => ({ acceptanceMode: mode }) }) },
    loadIntegrations: async () => ({ runtime: null }), usability: async () => new Map([[sid, judged]]) });
  const run = (mode: string | null, judged: ReturnType<typeof reasons>) => check(mode, judged)(null, { projectId: p, taskId: "t" }, { id: sid, actorId: "owner", roleId: role });
  const identity = reasons(["BUSINESS_IDENTITY_UNBOUND", "没有绑定业务身份"]), thread = reasons(["NATIVE_THREAD_UNAVAILABLE", "没有可用的原生线程"]);
  await assert.rejects(run("independent_agent", identity), (e: DomainError) => e.code === "SESSION_UNUSABLE" && /未创建 Run/.test(e.message) && /没有绑定业务身份/.test(e.message));
  await assert.doesNotReject(run(null, identity), "no declared mode: no signer needed, so the missing identity is not a reason to refuse");
  await assert.rejects(run(null, thread), (e: DomainError) => e.code === "SESSION_UNUSABLE" && /原生线程/.test(e.message), "no thread fails every Run");
  await assert.doesNotReject(run("independent_agent", { usable: true, reasons: [] }).catch(e => { if (e.code === "SESSION_UNUSABLE") throw e; }), "a usable Session is not refused by this check");
});
