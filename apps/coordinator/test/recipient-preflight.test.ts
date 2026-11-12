import test from "node:test";
import assert from "node:assert/strict";
import { configuredCliActorId, createRunRecipientGuard, materialCliRecipientMatches, requireOrdinaryRecipient, requireReservableRecipient } from "../src/runtime/recipient-preflight.js";

test("independent ordinary Run rejects missing or mismatched fixed recipient before native start", () => {
  const check = (mode: string | null, recipient: string | null, cliActorId: string | null) =>
    requireOrdinaryRecipient(mode, recipient, cliActorId, "task", "revision");
  assert.throws(() => check("independent_agent", null, "lead"), { code: "RECIPIENT_UNBOUND" });
  assert.throws(() => check("independent_agent", "worker", null), { code: "RECIPIENT_UNBOUND" });
  assert.throws(() => check("independent_agent", "worker", "lead"), { code: "RECIPIENT_UNBOUND" });
  assert.doesNotThrow(() => check("independent_agent", "worker", "worker"));
  assert.doesNotThrow(() => check(null, null, null));
});

test("direct Run accepts the assignment's fixed signer without a collaboration channel", () => {
  assert.equal(materialCliRecipientMatches([], "candidate-consumer", "acceptance-owner", "candidate-consumer"), true);
  assert.equal(materialCliRecipientMatches([], "other", "acceptance-owner", "candidate-consumer"), false);
  assert.equal(materialCliRecipientMatches([], "candidate-consumer", "acceptance-owner", null), false);
  assert.equal(materialCliRecipientMatches([], "acceptance-owner", "acceptance-owner", null), true);
  assert.equal(materialCliRecipientMatches(["candidate-consumer"], "candidate-consumer", "acceptance-owner", null), true);
  assert.equal(materialCliRecipientMatches(["other"], "candidate-consumer", "acceptance-owner", "candidate-consumer"), false);
  assert.equal(materialCliRecipientMatches(["candidate-consumer", "candidate-consumer"], "candidate-consumer", "acceptance-owner", "candidate-consumer"), false);
});

test("reservation refuses a missing, stale or unbound recipient before any Run exists, naming the missing item", () => {
  const ok = { state: "assigned", taskRevisionId: "r2", recipientActorId: "dev-claude-agent" };
  const check = (over: Record<string, unknown>) => requireReservableRecipient({ acceptanceMode: "independent_agent", taskRevisionId: "r2",
    assignment: ok, cliActorId: "dev-claude-agent", ...over } as Parameters<typeof requireReservableRecipient>[0]);
  assert.throws(() => check({ assignment: null }), { code: "ASSIGNMENT_MISSING", message: /task.start/ });
  assert.throws(() => check({ assignment: { ...ok, state: "released" } }), { code: "ASSIGNMENT_MISSING" });
  assert.throws(() => check({ assignment: { ...ok, taskRevisionId: "r1" } }), { code: "ASSIGNMENT_STALE", message: /task.assignment.set/ });
  assert.throws(() => check({ assignment: { ...ok, recipientActorId: null } }), { code: "RECIPIENT_UNBOUND", message: /没有固定执行接收者/ });
  assert.throws(() => check({ assignment: { ...ok, recipientActorId: "target-owner" } }), { code: "RECIPIENT_UNBOUND", message: /target-owner.*dev-claude-agent/ });
  assert.doesNotThrow(() => check({}));
  assert.doesNotThrow(() => check({ cliActorId: null }), "a Session whose CLI identity is known only at start is not guessed");
  assert.doesNotThrow(() => check({ acceptanceMode: null, assignment: null }), "a Task without independent acceptance keeps the old path");
});

// ---- the wiring the coordinator puts on runtime.run.reserve (main.ts), tested directly ------------------------------------------
const session = { id: "session-1", actorId: "target-owner", roleId: "role-1" };
const guardFor = (over: { task?: unknown; proposal?: unknown; assignment?: unknown; cli?: string | null } = {}) => {
  const seen: string[] = [];
  const has = (key: string) => key in over;
  const guard = createRunRecipientGuard({
    read: async (projectId, fn) => { seen.push(`read:${projectId}`); return fn({
      getTask: async taskId => { seen.push(`task:${taskId}`); return (has("task") ? over.task : { id: taskId, currentRevisionId: "rev-2" }) as never; },
      getTaskProposal: async (taskId, revisionId) => { seen.push(`proposal:${taskId}@${revisionId}`); return (has("proposal") ? over.proposal : { acceptanceMode: "independent_agent" }) as never; },
      sessionAssignments: { getTaskSessionAssignment: async taskId => { seen.push(`assignment:${taskId}`); return (has("assignment") ? over.assignment : null) as never; } } }); },
    cliActorId: async () => over.cli ?? null });
  return { guard, seen };
};
const command = { projectId: "project-1", taskId: "task-1" };

test("the reserve guard reads the Task's current revision, its proposal at that revision and its assignment, then refuses by the rule", async () => {
  const { guard, seen } = guardFor();
  await assert.rejects(guard(command, session), { code: "ASSIGNMENT_MISSING" });
  assert.deepEqual(seen, ["read:project-1", "task:task-1", "proposal:task-1@rev-2", "assignment:task-1"]);
  await assert.rejects(guardFor({ assignment: { state: "assigned", taskRevisionId: "rev-1", recipientActorId: "dev" } }).guard(command, session), { code: "ASSIGNMENT_STALE" });
  await assert.rejects(guardFor({ assignment: { state: "assigned", taskRevisionId: "rev-2", recipientActorId: null } }).guard(command, session), { code: "RECIPIENT_UNBOUND" });
  await assert.rejects(guardFor({ assignment: { state: "assigned", taskRevisionId: "rev-2", recipientActorId: "target-owner" }, cli: "dev-claude-agent" }).guard(command, session),
    { code: "RECIPIENT_UNBOUND", message: /target-owner.*dev-claude-agent/ });
  await guardFor({ assignment: { state: "assigned", taskRevisionId: "rev-2", recipientActorId: "dev-claude-agent" }, cli: "dev-claude-agent" }).guard(command, session);
  // A brokered Session has no configured identity yet: only the fixed recipient is required.
  await guardFor({ assignment: { state: "assigned", taskRevisionId: "rev-2", recipientActorId: "dev" }, cli: null }).guard(command, session);
});

test("the reserve guard leaves a missing Task to the command, and a Task with no recorded acceptance mode is not held to the rule", async () => {
  await guardFor({ task: null }).guard(command, session);
  await guardFor({ proposal: null }).guard(command, session);
  await guardFor({ proposal: { acceptanceMode: null } }).guard(command, session);
});

test("the Session's business CLI identity comes from the private configuration read at call time, per project, Session and Task", async () => {
  const entries = [
    { projectId: "project-1", sessionId: "session-1", sessionActorId: "target-owner", cliActorId: "dev-claude-agent" },
    { projectId: "project-1", sessionId: "session-1", sessionActorId: "target-owner", taskId: "task-1", cliActorId: "task-signer" },
    { projectId: "project-2", sessionId: "session-1", sessionActorId: "target-owner", cliActorId: "other-project" }] as never;
  let loads = 0;
  const lookup = (runtime: unknown) => configuredCliActorId(async () => { loads++; return { runtime } as never; });
  assert.equal(await lookup({ enabled: true, materialCli: entries })(command, session), "task-signer", "the Task's own entry wins");
  assert.equal(await lookup({ enabled: true, materialCli: entries })({ projectId: "project-1", taskId: "task-9" }, session), "dev-claude-agent");
  assert.equal(await lookup({ enabled: true, materialCli: entries })({ projectId: "project-3", taskId: "task-1" }, session), null, "another project has none");
  assert.equal(await lookup({ enabled: false, materialCli: entries })(command, session), null, "the runtime is off");
  assert.equal(await lookup(null)(command, session), null);
  assert.equal(loads, 5, "the configuration is read on every reservation, not cached");
});
