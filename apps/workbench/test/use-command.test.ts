// useCommand itself, rendered with a minimal hook runner (the hook only uses useState), and the one rule every task
// form applies to newer content (followLatest): an untouched form follows it, a form with changes waits for the
// person, a version conflict rereads before anyone decides, and a kept draft keeps the baseline it was written on.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import type { MutationContext, RecoverableCommand } from "../src/shared/ActionForm.tsx";
import { useCommand, type SavedDraft } from "../src/features/workflow/useCommand.ts";
import { followLatest, formDirty, keepEdits } from "../src/features/workflow/TaskForms.tsx";

/** Runs a hook outside a renderer: state lives in slots across renders, and every update is applied at the next render. */
function hookRunner<P, R>(hook: (props: P) => R) {
  const slots: unknown[] = [];
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return (props: P): R => {
    let index = 0;
    const dispatcher = {
      useState(initial: unknown) {
        const at = index++;
        if (!(at in slots)) slots[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
        const set = (next: unknown) => { slots[at] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots[at]) : next; };
        return [slots[at], set];
      },
    };
    const previous = internals.H;
    internals.H = dispatcher;
    try { return hook(props); } finally { internals.H = previous; }
  };
}

const projectId = "10000001-0000-4000-8000-000000000001";
const taskId = "10000002-0000-4000-8000-000000000002";
function contextWith(log: { attempts: RecoverableCommand[]; changed: number; known: string[] }): MutationContext {
  return { token: "", projectId, principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, blocked: false,
    onAttempt: command => { log.attempts.push(command); return true; }, onKnown: id => { log.known.push(id); }, onChanged: () => { log.changed++; } };
}
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a form refuses while its recorded baseline differs, and sends the recorded versions once the person has looked", async t => {
  const log = { attempts: [] as RecoverableCommand[], changed: 0, known: [] as string[] };
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
  // After the write is read back, the form is told the baseline moved; it is the form that follows (followLatest).
  assert.equal(render({ taskVersion: 5 }).baselineChanged, true);
});

test("a version conflict rereads, and the form waits for the reread before offering to keep or refill", async t => {
  const log = { attempts: [] as RecoverableCommand[], changed: 0, known: [] as string[] };
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

test("a kept draft keeps the baseline it was written against, and rebase moves that baseline with it", () => {
  const log = { attempts: [] as RecoverableCommand[], changed: 0, known: [] as string[] };
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
  command.rebase();
  assert.deepEqual(store.get(`assignment:${taskId}`)!.baseline, { assignmentVersion: 2 });
  assert.equal(again({ assignmentVersion: 2 }).baselineChanged, false);
  // A string baseline (目标与阶段) works the same way.
  const journey = hookRunner((baseline: string) => useCommand(contextWith(log), baseline, { draft: { store, key: "goal:g1" } }));
  journey("3:active").saveDraft({ outcome: "x" });
  assert.equal(store.get("goal:g1")!.baseline, "3:active");
});

test("dedicated endpoints and their own schema: validated commands are sent as built through `send`", async () => {
  const log = { attempts: [] as RecoverableCommand[], changed: 0, known: [] as string[] };
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
  // Typed: never followed silently.
  const typed = { base: opened, values: { ...opened, reason: "我的理由" } };
  assert.equal(formDirty(typed), true);
  assert.equal(followLatest(typed, latest, true, false), null);
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
