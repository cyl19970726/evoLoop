import test from "node:test";
import assert from "node:assert/strict";
import { requireOrdinaryRecipient } from "../src/runtime/recipient-preflight.js";

test("independent ordinary Run rejects missing or mismatched fixed recipient before native start", () => {
  const check = (mode: string | null, recipient: string | null, cliActorId: string | null) =>
    requireOrdinaryRecipient(mode, recipient, cliActorId, "task", "revision");
  assert.throws(() => check("independent_agent", null, "lead"), { code: "RECIPIENT_UNBOUND" });
  assert.throws(() => check("independent_agent", "worker", null), { code: "RECIPIENT_UNBOUND" });
  assert.throws(() => check("independent_agent", "worker", "lead"), { code: "RECIPIENT_UNBOUND" });
  assert.doesNotThrow(() => check("independent_agent", "worker", "worker"));
  assert.doesNotThrow(() => check(null, null, null));
});
