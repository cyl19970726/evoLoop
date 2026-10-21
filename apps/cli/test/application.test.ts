import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { runCli } from "../src/application.ts";

async function run(args: string[], env: Record<string, string | undefined> = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(args, env, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}
test("an unauthenticated fresh Agent can discover help, IDs, exact command schemas and named routes", async () => {
  const help = await run(["help"]); assert.equal(help.code, 0); assert.ok(JSON.parse(help.stdout).commands.some((value: string) => value.startsWith("context ")));
  assert.ok(JSON.parse(help.stdout).commands.some((value: string) => value.startsWith("receipts retry ")));
  const schema = await run(["command", "schema", "task.create"]); assert.equal(schema.code, 0);
  const create = JSON.parse(schema.stdout);
  assert.ok(create.required.includes("content"));
  assert.ok(create.required.includes("acceptance"));
  assert.equal(create.properties.goal, undefined);
  const update = await run(["command", "schema", "task.update"]);
  assert.ok(JSON.parse(update.stdout).required.includes("expectedVersion"));
  const commands = JSON.parse((await run(["command", "types"])).stdout).types;
  assert.ok(commands.includes("task.start"));
  assert.ok(!commands.includes("task.accept"));
  const types = await run(["request", "types"]); assert.equal(types.code, 0);
  assert.ok(JSON.parse(types.stdout).requests.some((value: { name: string }) => value.name === "knowledge.publish"));
  const requestSchema = await run(["request", "schema", "knowledge.propose"]); assert.equal(requestSchema.code, 0);
  assert.ok(JSON.parse(requestSchema.stdout).properties.pageType.enum.includes("concept"));
  assert.match(JSON.parse((await run(["id"])).stdout).id, /^[\da-f-]{36}$/);
});
test("evaluation CLI reads preserve fixed revision, attempt and source identities", async () => {
  const p = "00000000-0000-4000-8000-000000000001", e = "00000000-0000-4000-8000-000000000002";
  const r = "00000000-0000-4000-8000-000000000003", a = "00000000-0000-4000-8000-000000000004";
  const requests: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    requests.push(String(url)); return new Response(JSON.stringify({ fixed: true }), { status: 200 });
  });
  const env = { EVOLOOP_TOKEN: "fake-local-fixture", EVOLOOP_PROJECT: p, EVOLOOP_API_URL: "http://127.0.0.1:4318" };
  try {
    assert.equal((await run(["evaluation", e, "--revision", r], env)).code, 0);
    assert.equal((await run(["evaluation-source", a], env)).code, 0);
    assert.equal((await run(["evaluation-packet", e, "--revision", r, "--attempt", a], env)).code, 0);
    assert.equal((await run(["list", "evaluations", "--task", a, "--limit", "10"], env)).code, 0);
    assert.deepEqual(requests.map(url => new URL(url).pathname + new URL(url).search), [
      `/api/projects/${p}/evaluations/${e}?revision=${r}`, `/api/projects/${p}/evaluations/source-task/${a}`,
      `/api/projects/${p}/evaluations/${e}/attempts/${a}/packet?revision=${r}`, `/api/projects/${p}/evaluations?limit=10&taskId=${a}`,
    ]);
    assert.equal((await run(["evaluation-packet", e, "--attempt", a], env)).code, 2);
    assert.equal(requests.length, 4);
    assert.equal((await run(["command", "schema", "evaluation.create"])).code, 0);
  } finally { fetch.mock.restore(); }
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
