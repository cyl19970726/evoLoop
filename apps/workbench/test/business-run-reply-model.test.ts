import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptRunReplyForScope,
  businessRunReplyEligible,
  runReplyScope,
  terminalRunStates,
} from "../src/sessions/businessRunReplyModel.ts";

test("business Run reply only appears for a task-linked owned Run", () => {
  assert.equal(businessRunReplyEligible("owned", { taskId: "task-a" }), true);
  assert.equal(businessRunReplyEligible("external", { taskId: "task-a" }), false);
  assert.equal(businessRunReplyEligible("owned", { taskId: null }), false);
  assert.equal(businessRunReplyEligible("owned", null), false);
});

test("a late business Run result cannot replace the newly selected Session or Run", () => {
  const sessionA = runReplyScope("owned:a", "run-a");
  const sessionB = runReplyScope("owned:b", "run-a");
  const nextRun = runReplyScope("owned:a", "run-b");
  const lateResult = { messages: ["old reply"] };
  assert.notEqual(sessionA, sessionB);
  assert.notEqual(sessionA, nextRun);
  assert.equal(acceptRunReplyForScope(sessionA, sessionB, lateResult), null);
  assert.equal(acceptRunReplyForScope(sessionA, nextRun, lateResult), null);
  assert.deepEqual(acceptRunReplyForScope(sessionA, sessionA, lateResult), lateResult);
});

test("only terminal managed Runs request the saved public result", () => {
  assert.equal(terminalRunStates.has("completed"), true);
  assert.equal(terminalRunStates.has("failed"), true);
  assert.equal(terminalRunStates.has("interrupted"), true);
  assert.equal(terminalRunStates.has("running"), false);
  assert.equal(terminalRunStates.has("dispatching"), false);
});
