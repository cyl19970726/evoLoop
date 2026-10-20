import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../src/application.ts";

async function run(args: string[], env: Record<string, string | undefined> = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(args, env, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}
test("an unauthenticated fresh Agent can discover help, IDs, exact command schemas and named routes", async () => {
  const help = await run(["help"]); assert.equal(help.code, 0); assert.ok(JSON.parse(help.stdout).commands.some((value: string) => value.startsWith("context ")));
  const schema = await run(["command", "schema", "task.accept"]); assert.equal(schema.code, 0);
  assert.ok(JSON.parse(schema.stdout).required.includes("expectedVersion"));
  const types = await run(["request", "types"]); assert.equal(types.code, 0);
  assert.ok(JSON.parse(types.stdout).requests.some((value: { name: string }) => value.name === "knowledge.publish"));
  const requestSchema = await run(["request", "schema", "knowledge.propose"]); assert.equal(requestSchema.code, 0);
  assert.ok(JSON.parse(requestSchema.stdout).properties.pageType.enum.includes("concept"));
  assert.match(JSON.parse((await run(["id"])).stdout).id, /^[\da-f-]{36}$/);
});
test("specialist request mistakes stay actionable local input errors before any network request", async () => {
  const result = await run(["request", "unknown", "--project", "11111111-1111-4111-8111-111111111111", "--file", "package.json"], { EVOLOOP_TOKEN: "dummy" });
  assert.equal(result.code, 2); assert.equal(JSON.parse(result.stderr).error.code, "INVALID_INPUT");
  assert.match(JSON.parse(result.stderr).error.message, /request types/);
  const config = await run(["session"], { EVOLOOP_TOKEN: "dummy", EVOLOOP_API_URL: "https://user:secret@example.test" });
  assert.equal(config.code, 2); assert.ok(!config.stderr.includes("secret"));
});
test("input mistakes and missing auth return structured failures without stack traces", async () => {
  for (const args of [["task", "bad", "--token", "secret"], ["id", "extra"], ["command", "schema", "not-real"], ["list", "tasks"]]) {
    const result = await run(args); assert.equal(result.code, 2); assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_INPUT"); assert.ok(!result.stderr.includes("secret"));
  }
});
