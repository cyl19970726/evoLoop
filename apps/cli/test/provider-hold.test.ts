import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../src/application.ts";

test("the release command is discoverable and its schema asks for the version it releases", async () => {
  let stdout = "";
  const code = await runCli(["command", "schema", "runtime.providerHold.release"], {}, { stdout: text => { stdout += text; }, stderr: () => {} });
  assert.equal(code, 0);
  const schema = JSON.parse(stdout) as { properties: Record<string, { enum?: string[] }>; required: string[] };
  assert.deepEqual(schema.properties.provider!.enum, ["codex", "claude"]);
  for (const field of ["provider", "expectedVersion", "evidenceRef", "reason"]) assert.ok(schema.required.includes(field), field);
});
