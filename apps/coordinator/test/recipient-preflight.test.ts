import test from "node:test";
import assert from "node:assert/strict";
import { materialCliRecipientMatches, requireOrdinaryRecipient } from "../src/runtime/recipient-preflight.js";

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
