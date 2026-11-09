// The one command implementation (shared/command): useCommand rendered with a minimal hook runner, and the rules every
// form applies (rules.ts): an untouched form follows newer content, a form with changes waits for the person, a
// version conflict rereads before anyone decides, a kept draft keeps the baseline it was written on, and an unknown
// result blocks the form until it is read back by its original operation ID.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import type { Operation } from "@evoloop/contracts";
import {
  changedParts, conflictingFields, contentMoved, followLatest, formDirty, keepEdits, movedFields, permissionText, personMessage, restoredFormState, submissionRefusal, useCommand,
  type MutationContext, type RecoverableCommand, type SavedDraft,
} from "../src/shared/command/index.ts";

/**
 * Runs a hook outside a renderer: state and refs live in slots across renders, every update is applied at the next
 * render, and an effect runs right after the render whose dependencies changed.
 */
function hookRunner<P, R>(hook: (props: P) => R) {
  const slots: unknown[] = [];
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return (props: P): R => {
    let index = 0;
    const effects: Array<() => void> = [];
    const dispatcher = {
      useState(initial: unknown) {
        const at = index++;
        if (!(at in slots)) slots[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
        const set = (next: unknown) => { slots[at] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots[at]) : next; };
        return [slots[at], set];
      },
      useRef(initial: unknown) {
        const at = index++;
        if (!(at in slots)) slots[at] = { current: initial };
        return slots[at];
      },
      useEffect(effect: () => void, deps?: unknown[]) {
        const at = index++;
        const before = slots[at] as unknown[] | undefined;
        if (!before || !deps || deps.length !== before.length || deps.some((dep, i) => !Object.is(dep, before[i]))) effects.push(effect);
        slots[at] = deps;
      },
    };
    const previous = internals.H;
    internals.H = dispatcher;
    let result: R;
    try { result = hook(props); } finally { internals.H = previous; }
    for (const effect of effects) effect();
    return result;
  };
}

const projectId = "10000001-0000-4000-8000-000000000001";
const taskId = "10000002-0000-4000-8000-000000000002";
type Log = { attempts: RecoverableCommand[]; changed: number; known: string[] };
const newLog = (): Log => ({ attempts: [], changed: 0, known: [] });
function contextWith(log: Log, patch: Partial<MutationContext> = {}): MutationContext {
  return { token: "", projectId, principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, blocked: false,
    onAttempt: command => { log.attempts.push(command); return true; }, onKnown: id => { log.known.push(id); }, onChanged: () => { log.changed++; }, ...patch };
}
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("a form refuses while its recorded baseline differs, and sends the recorded versions once the person has looked", async t => {
  const log = newLog();
  const context = contextWith(log);
  const sent: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>; sent.push(body);
    return reply({ operationId: body.operationId, status: "applied", entityId: taskId, version: 9 })();
  });
  const render = hookRunner((baseline: { taskVersion: number }) => useCommand(context, baseline));
  let command = render({ taskVersion: 3 });
  assert.equal(command.baselineChanged, false);
  command = render({ taskVersion: 4 });
  assert.equal(command.baselineChanged, true, "another write moved the task after the form opened");
  assert.equal(await command.submit(seen => ({ type: "task.cancel", taskId, expectedVersion: seen.taskVersion, reason: "r" })), false);
  assert.equal(log.attempts.length, 0, "nothing is sent, not even a recovery receipt");
  command = render({ taskVersion: 4 });
  assert.match(command.outcome!.message, /打开表单后，这里的内容已被更新/);
  // The hook never adopts the newer baseline by itself: only rebase (the person looked, or the form was untouched).
  assert.equal(render({ taskVersion: 4 }).baselineChanged, true);
  command.rebase();
  command = render({ taskVersion: 4 });
  assert.equal(command.baselineChanged, false);
  assert.equal(await command.submit(seen => ({ type: "task.cancel", taskId, expectedVersion: seen.taskVersion, reason: "r" })), true);
  assert.equal(sent[0]!.expectedVersion, 4);
  assert.equal(log.changed, 1, "an applied write rereads");
  assert.deepEqual(log.known, [sent[0]!.operationId], "a known result removes its receipt");
  // After the write is read back, the form is told the baseline moved; it is the form that follows (followLatest).
  assert.equal(render({ taskVersion: 5 }).baselineChanged, true);
});

test("every submission gets a new operation ID, and a receipt that cannot be saved sends nothing", async t => {
  const log = newLog();
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>; sent.push(String(body.operationId));
    return reply({ operationId: body.operationId, status: "rejected", code: "TASK_STATE", message: "任务已关闭" })();
  });
  let saveReceipt = false;
  const render = hookRunner(() => useCommand(contextWith(log, { onAttempt: command => { log.attempts.push(command); return saveReceipt; } })));
  let command = render(undefined);
  const build = () => ({ type: "task.cancel", taskId, expectedVersion: 1, reason: "r" });
  assert.equal(await command.submit(build), false);
  command = render(undefined);
  assert.equal(sent.length, 0, "the command is not sent without a saved receipt");
  assert.match(command.outcome!.message, /不能保存恢复回执/);
  saveReceipt = true;
  await command.submit(build);
  command = render(undefined);
  await command.submit(build);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1], "a new submission is a new operation");
  assert.deepEqual(log.attempts.slice(1).map(item => item.operationId), sent, "each receipt names the operation that was sent");
});

test("a version conflict rereads, and the form waits for the reread before offering to keep or refill", async t => {
  const log = newLog();
  const context = contextWith(log);
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return reply({ operationId: body.operationId, status: "rejected", code: "VERSION_CONFLICT", message: "版本已变化", currentVersion: 6 })();
  });
  let rereads = 0;
  const render = hookRunner((baseline: { taskVersion: number }) => useCommand(context, baseline, { onStale: () => { rereads++; } }));
  let command = render({ taskVersion: 5 });
  assert.equal(await command.submit(seen => ({ type: "task.cancel", taskId, expectedVersion: seen.taskVersion, reason: "r" })), false);
  command = render({ taskVersion: 5 });
  assert.equal(rereads, 1, "the conflict asks for a reread");
  assert.equal(command.baselineChanged, true);
  assert.equal(command.awaitingReread, true, "nothing new to look at yet");
  command = render({ taskVersion: 6 });
  assert.equal(command.awaitingReread, false, "the latest content arrived; the person can decide now");
  assert.equal(command.baselineChanged, true);
  command.rebase();
  assert.equal(render({ taskVersion: 6 }).baselineChanged, false);
});

test("after a conflict, a reread that changes only what the form shows also ends the wait", async t => {
  const log = newLog();
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return reply({ operationId: body.operationId, status: "rejected", code: "VERSION_CONFLICT", message: "版本已变化" })();
  });
  // An ActionForm without a baseline: the content it shows is all there is to compare.
  const render = hookRunner((content: string) => useCommand(contextWith(log), undefined, { content }));
  let command = render("旧名");
  await command.submit(() => ({ type: "task.cancel", taskId, expectedVersion: 1, reason: "r" }));
  command = render("旧名");
  assert.equal(command.awaitingReread, true);
  assert.equal(render("别人改的名").awaitingReread, false);
});

test("an unknown result keeps the receipt and blocks the form; once checked as applied, the draft is cleared", async t => {
  const log = newLog();
  const store = new Map<string, SavedDraft>();
  let operation: Operation | null = null;
  const sent: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { sent.push(JSON.parse(String(init.body)) as Record<string, unknown>); return reply({ message: "网关超时" }, 504)(); }
    assert.match(url, new RegExp(`/operations/${String(sent[0]!.operationId)}$`), "the operation is read by its original ID");
    return reply(operation)();
  });
  let blocked = false;
  let applied: string | null = null;
  const key = `cancel:${taskId}`;
  const render = hookRunner((baseline: { taskVersion: number }) => useCommand(contextWith(log, { blocked }), baseline,
    { draft: { store, key }, onApplied: result => { applied = result.entityId; } }));
  let command = render({ taskVersion: 2 });
  command.saveDraft({ reason: "范围已变" });
  assert.equal(await command.submit(seen => ({ type: "task.cancel", taskId, expectedVersion: seen.taskVersion, reason: "范围已变" })), false);
  blocked = true; // App keeps the receipt: every write in the project waits.
  command = render({ taskVersion: 2 });
  assert.equal(command.unconfirmed, true);
  assert.deepEqual(log.known, [], "the receipt stays");
  assert.match(command.outcome!.message, /请在上方按原操作 ID 核对，确认前不要再次提交/);
  assert.equal(store.get(key)!.pending?.operationId, sent[0]!.operationId, "the draft remembers the operation still to be checked");
  assert.equal(submissionRefusal({ busy: false, blocked: false, stale: false, unconfirmed: command.unconfirmed }), "unconfirmed");
  assert.equal(await command.submit(seen => ({ type: "task.cancel", taskId, expectedVersion: seen.taskVersion, reason: "再发一次" })), false);
  assert.equal(sent.length, 1, "nothing more is sent while the result is unknown");
  // The receipt is checked elsewhere (结果未知的操作) and removed: the form reads the operation by its original ID.
  operation = { projectId, id: String(sent[0]!.operationId), actorId: "reader", commandHash: "a".repeat(64), commandType: "task.cancel", createdAt: "2026-11-10T00:00:00.000Z",
    result: { status: "applied", operationId: String(sent[0]!.operationId), entityId: taskId } };
  blocked = false;
  render({ taskVersion: 2 });
  await settle();
  command = render({ taskVersion: 2 });
  assert.equal(command.unconfirmed, false);
  assert.equal(applied, taskId);
  assert.equal(store.get(key), undefined, "an applied result clears the draft");
  assert.match(command.outcome!.message, /已核对为已应用/);
  assert.equal(log.changed, 1);
});

test("an unknown result read back as rejected keeps the draft for a new submission; a remount checks it too", async t => {
  const log = newLog();
  const store = new Map<string, SavedDraft>();
  const operationId = "10000009-0000-4000-8000-000000000009";
  store.set("cancel", { values: { reason: "保留的理由" }, baseline: { taskVersion: 2 }, pending: { operationId, type: "task.cancel" } });
  t.mock.method(globalThis, "fetch", async () => reply({ projectId, id: operationId, actorId: "reader", commandHash: "b".repeat(64), commandType: "task.cancel",
    createdAt: "2026-11-10T00:00:00.000Z", result: { status: "rejected", operationId, code: "TASK_STATE", message: "任务已关闭" } })());
  const render = hookRunner((baseline: { taskVersion: number }) => useCommand(contextWith(log), baseline, { draft: { store, key: "cancel" } }));
  let command = render({ taskVersion: 2 });
  assert.equal(command.unconfirmed, true, "a draft whose operation was never checked comes back blocked");
  assert.deepEqual(command.restoredDraft, { reason: "保留的理由" });
  await settle();
  command = render({ taskVersion: 2 });
  assert.equal(command.unconfirmed, false);
  assert.match(command.outcome!.message, /已核对为被拒绝：.*草稿保留/);
  assert.deepEqual(store.get("cancel"), { values: { reason: "保留的理由" }, baseline: { taskVersion: 2 } });
});

test("a kept draft keeps the baseline it was written against, and rebase moves that baseline with it", () => {
  const log = newLog();
  const store = new Map<string, SavedDraft>();
  const render = hookRunner((baseline: { assignmentVersion: number }) =>
    useCommand(contextWith(log), baseline, { draft: { store, key: `assignment:${taskId}` } }));
  let command = render({ assignmentVersion: 1 });
  command.saveDraft({ reason: "写到一半" });
  assert.deepEqual(store.get(`assignment:${taskId}`), { values: { reason: "写到一半" }, baseline: { assignmentVersion: 1 } });
  // Mounted again later, on a newer version: the draft is compared with what it was written against.
  const again = hookRunner((baseline: { assignmentVersion: number }) =>
    useCommand(contextWith(log), baseline, { draft: { store, key: `assignment:${taskId}` } }));
  command = again({ assignmentVersion: 2 });
  assert.deepEqual(command.restoredDraft, { reason: "写到一半" });
  assert.equal(command.baselineChanged, true);
  command.rebase({ reason: "保留下来的理由" });
  assert.deepEqual(store.get(`assignment:${taskId}`), { values: { reason: "保留下来的理由" }, baseline: { assignmentVersion: 2 } });
  assert.equal(again({ assignmentVersion: 2 }).baselineChanged, false);
  // A string baseline (目标与阶段) works the same way.
  const journey = hookRunner((baseline: string) => useCommand(contextWith(log), baseline, { draft: { store, key: "goal:g1" } }));
  journey("3:active").saveDraft({ outcome: "x" });
  assert.equal(store.get("goal:g1")!.baseline, "3:active");
});

test("picking an object takes its part of the baseline as read now, and moved parts are named", () => {
  const log = newLog();
  const labels = { goal: "目标版本", task: "任务修订" };
  const render = hookRunner((baseline: Record<string, string>) => useCommand(contextWith(log), baseline, { partLabels: labels }));
  let command = render({ goal: "", task: "" });
  command.adopt({ goal: "g1@3" });
  command = render({ goal: "g1@3", task: "" });
  assert.equal(command.baselineChanged, false, "the reader's own pick is not a change to look at");
  command = render({ goal: "g1@4", task: "t1@r2" });
  assert.deepEqual(command.changed, ["目标版本", "任务修订"]);
  assert.deepEqual(changedParts({ goal: "a", internal: "1" }, { goal: "a", internal: "2" }, labels), [], "a part without a readable name is not listed");
});

test("dedicated endpoints and their own schema: validated commands are sent as built through `send`", async () => {
  const log = newLog();
  const sent: Record<string, unknown>[] = [];
  const render = hookRunner((baseline: { planVersion: number }) => useCommand(contextWith(log), baseline, {
    validate: candidate => { if (!candidate.reason) throw new Error("missing"); },
    send: async command => { sent.push(command as Record<string, unknown>); return { operationId: command.operationId, status: "applied", entityId: taskId }; },
  }));
  const command = render({ planVersion: 2 });
  assert.equal(await command.submit(seen => ({ type: "work.plan.set", taskId, expectedPlanVersion: seen.planVersion, reason: " 不修剪 " })), true);
  assert.equal(sent[0]!.reason, " 不修剪 ");
  assert.equal(sent[0]!.expectedPlanVersion, 2);
  assert.equal(log.attempts[0]!.operationId, sent[0]!.operationId, "the receipt is saved for the command that is sent");
});

test("the form rule: untouched forms follow the latest content, changed forms wait, and keeping changes keeps only them", () => {
  const opened = { title: "旧名", content: "旧正文", reason: "" };
  const latest = { title: "别人改的名", content: "别人改的正文", reason: "" };
  // Untouched: follows, and records the new baseline when it moved.
  assert.deepEqual(followLatest({ base: opened, values: opened }, latest, true, false), { state: { base: latest, values: latest }, rebase: true });
  assert.equal(followLatest({ base: opened, values: opened }, opened, false, false), null);
  // Waiting for the reread after a conflict: nothing moves yet.
  assert.equal(followLatest({ base: opened, values: opened }, latest, true, true), null);
  // Typed: never followed silently, and asked about even when no baseline part moved.
  const typed = { base: opened, values: { ...opened, reason: "我的理由" } };
  assert.equal(formDirty(typed), true);
  assert.equal(followLatest(typed, latest, true, false), null);
  assert.equal(contentMoved(typed, latest), true);
  assert.equal(contentMoved(typed, opened), false);
  assert.deepEqual(keepEdits(typed, latest).values, { title: "别人改的名", content: "别人改的正文", reason: "我的理由" },
    "only the reason the person wrote is kept; the title and text they did not touch take the latest content");
});

test("a write that is read back late does not carry an edit made in between over someone else's change", () => {
  // The form wrote version 3 and went back to untouched; the reread failed, the person edited the title, and the next
  // reread shows version 5 (someone else wrote in between). The form must ask, not adopt version 5 under the edit.
  const afterWrite = { base: { title: "我刚保存的名" }, values: { title: "我刚保存的名" } };
  const edited = { ...afterWrite, values: { title: "又改了一次" } };
  assert.equal(followLatest(edited, { title: "别人后来改的名" }, true, false), null);
  // Untouched, the same reread is simply followed.
  assert.deepEqual(followLatest(afterWrite, { title: "别人后来改的名" }, true, false)!.state.values, { title: "别人后来改的名" });
});

test("small rules: permissions, messages for the person, and drafts kept before the form state had a base", () => {
  assert.equal(permissionText(["read", "write"], ["review"]), "当前身份没有审阅权限。");
  assert.equal(permissionText(["read", "write"], ["write"]), null);
  assert.equal(personMessage(new Error("模型不在授权与目录交集内")), "模型不在授权与目录交集内");
  assert.equal(personMessage(new Error("Unexpected token")), "请补全必需字段并检查输入格式。", "an English or internal message is not shown");
  assert.deepEqual(restoredFormState({ reason: "旧草稿" }, { reason: "", title: "名" }), { base: { reason: "", title: "名" }, values: { reason: "旧草稿", title: "名" } });
  assert.equal(restoredFormState(undefined, {}), undefined);
});

test("keeping changes never sends text written against older content over a newer edit of the same field", () => {
  // A changes the body on version 3; B saves version 4 with another body. A's body is a conflict, not a kept change.
  const opened = { body: "第一段\n第二段（v3）", reason: "" };
  const typed = { base: opened, values: { body: "第一段（我改的）\n第二段（v3）", reason: "补充" } };
  const latest = { body: "第一段\n第二段（v4 别人改的）\n第三段（v4 新增）", reason: "" };
  assert.deepEqual(movedFields(typed, latest), ["body"]);
  assert.deepEqual(conflictingFields(typed, latest), ["body"]);
  const kept = keepEdits(typed, latest);
  assert.equal(kept.values.body, latest.body, "without a choice the conflicting field takes the latest content");
  assert.equal(kept.values.reason, "补充", "a field only the person changed is kept");
  assert.equal(keepEdits(typed, latest, { body: "mine" }).values.body, typed.values.body, "the person's text only when they chose it for that field");
  // The same text on both sides is no conflict; a field only someone else changed is no conflict either.
  assert.deepEqual(conflictingFields({ base: opened, values: { ...opened, body: latest.body } }, latest), []);
  assert.deepEqual(conflictingFields({ base: opened, values: { ...opened, reason: "补充" } }, latest), []);
});

test("moved baseline parts are named: common parts of object baselines, and a string baseline as 版本", () => {
  const log = newLog();
  const render = hookRunner((baseline: { taskVersion: number; queueVersion: number }) => useCommand(contextWith(log), baseline));
  render({ taskVersion: 1, queueVersion: 1 });
  assert.deepEqual(render({ taskVersion: 2, queueVersion: 1 }).changed, ["任务版本"]);
  assert.deepEqual(changedParts("3:r3", "4:r4"), ["版本"]);
  assert.deepEqual(changedParts("3:r3", "3:r3"), []);
});

test("a version conflict thrown as HTTP 409 rereads and waits like a rejected result", async t => {
  const log = newLog();
  t.mock.method(globalThis, "fetch", async () => reply({ code: "VERSION_CONFLICT", message: "版本已变化" }, 409)());
  let rereads = 0;
  const render = hookRunner((baseline: { taskVersion: number }) => useCommand(contextWith(log), baseline, { onStale: () => { rereads++; } }));
  let command = render({ taskVersion: 2 });
  assert.equal(await command.submit(seen => ({ type: "task.cancel", taskId, expectedVersion: seen.taskVersion, reason: "r" })), false);
  command = render({ taskVersion: 2 });
  assert.equal(rereads, 1);
  assert.equal(command.unconfirmed, false, "a 409 is a known answer");
  assert.equal(log.known.length, 1, "its receipt is removed");
  assert.equal(command.awaitingReread, true);
  assert.equal(command.baselineChanged, true);
});

test("a second submission while one is being sent is refused, even before the next render", async t => {
  const log = newLog();
  let release: () => void = () => undefined;
  const posted: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>; posted.push(String(body.operationId));
    await new Promise<void>(done => { release = done; });
    return reply({ operationId: body.operationId, status: "applied", entityId: taskId })();
  });
  const render = hookRunner(() => useCommand(contextWith(log)));
  const command = render(undefined);
  const build = () => ({ type: "task.cancel", taskId, expectedVersion: 1, reason: "r" });
  const first = command.submit(build);
  await settle();
  assert.equal(await command.submit(build), false, "the double click is refused");
  release();
  assert.equal(await first, true);
  assert.equal(posted.length, 1);
  assert.equal(log.attempts.length, 1, "no second receipt either");
});

test("an unknown result read back as applied runs the form's registered cleanup; a form without one does not claim it cleared", async t => {
  let posted: Record<string, unknown> | null = null;
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posted = JSON.parse(String(init.body)) as Record<string, unknown>; return reply({ message: "网关超时" }, 504)(); }
    const operationId = String(posted!.operationId);
    return reply({ projectId, id: operationId, actorId: "reader", commandHash: "c".repeat(64), commandType: "task.cancel", createdAt: "2026-11-10T00:00:00.000Z",
      result: { status: "applied", operationId, entityId: taskId } })();
  });
  // A form registers its reset with the hook (the follow-up form does), so a lost answer read back as applied leaves
  // nothing behind that could be sent a second time.
  let resets = 0;
  let blocked = false;
  const withCleanup = hookRunner(() => useCommand(contextWith(newLog(), { blocked }), undefined, { onApplied: () => { resets++; } }));
  let command = withCleanup(undefined);
  await command.submit(() => ({ type: "task.cancel", taskId, expectedVersion: 1, reason: "r" }));
  blocked = true; withCleanup(undefined);
  blocked = false; withCleanup(undefined);
  await settle();
  command = withCleanup(undefined);
  assert.equal(resets, 1, "the cleanup ran for the read-back result");
  assert.match(command.outcome!.message, /草稿已清除/);
  assert.equal(command.unconfirmed, false);
  // Without any cleanup the message says only what was checked.
  const plain = hookRunner(() => useCommand(contextWith(newLog(), { blocked })));
  let other = plain(undefined);
  await other.submit(() => ({ type: "task.cancel", taskId, expectedVersion: 1, reason: "r" }));
  blocked = true; plain(undefined);
  blocked = false; plain(undefined);
  await settle();
  other = plain(undefined);
  assert.equal(other.outcome!.message, "原操作已核对为已应用。");
});
