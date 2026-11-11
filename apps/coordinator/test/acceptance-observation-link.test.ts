import assert from "node:assert/strict";
import { test } from "node:test";
import { observationLinkProblem, type ObservationLinkFacts } from "../src/acceptance-relay/observation-link.js";

const session = "40000007-0000-4000-8000-000000000001";
const ok: ObservationLinkFacts = { state: "completed", nativeTurnId: "turn-1", sessionId: session, readReceiptActorId: "recipient", afterRead: true };
const refused = (facts: ObservationLinkFacts | undefined, pattern: RegExp) => {
  const problem = observationLinkProblem(facts, session);
  assert.equal(problem?.code, "ACCEPTANCE_NOT_USED");
  assert.match(problem!.message, pattern);
};

test("an observation recorded during the arranged turn links once the processing has completed (the d8f120be sample)", () => {
  // The observation predates the completion of the processing by seconds; only its relation to the read receipt matters.
  assert.equal(observationLinkProblem(ok, session), null);
});

test("an observation recorded after the turn still links", () => {
  assert.equal(observationLinkProblem({ ...ok, afterRead: true }, session), null);
});

test("each missing condition is refused with its own reason", () => {
  refused(undefined, /还没有处理记录/);
  refused({ ...ok, state: "processing" }, /处理尚未完成（当前 processing）.*完成后再关联/);
  refused({ ...ok, state: "failed" }, /尚未完成（当前 failed）/);
  refused({ ...ok, nativeTurnId: null }, /没有保存对应的原生 Turn/);
  refused({ ...ok, readReceiptActorId: null }, /session\.message\.receipt/);
  refused({ ...ok, afterRead: false }, /早于本人的已读回执/);
  refused({ ...ok, sessionId: "40000007-0000-4000-8000-000000000002" }, /不是由被安排的 Session/);
});

test("an observation recorded before the recipient read the message never links, even after completion", () => {
  refused({ ...ok, afterRead: false }, /请在记录已读之后/);
});
