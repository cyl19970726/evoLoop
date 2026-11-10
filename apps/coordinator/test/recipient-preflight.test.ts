import test from "node:test";
import assert from "node:assert/strict";
import { materialCliRecipientMatches, requireOrdinaryRecipient, requireReservableRecipient } from "../src/runtime/recipient-preflight.js";

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
