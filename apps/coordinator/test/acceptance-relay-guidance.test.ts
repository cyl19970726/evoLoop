import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("Leader scheduling guidance says where the handoff detail goes and what happens to a message sent with the reserved IDs", async () => {
  const text = await readFile(fileURLToPath(new URL("../../../.agents/skills/evoloop-workflow/references/leader-scheduling.md", import.meta.url)), "utf8");
  for (const needle of ["scopeDescription", "messageOperationId", "MESSAGE_BINDING_CHANGED", "work acceptance observe", "never rewritten"])
    assert.ok(text.includes(needle), `guidance names ${needle}`);
  assert.match(text, /Do not post a separate message with the `messageId`/);
});
