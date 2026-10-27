import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test, mock } from "node:test";
import { commandSchema } from "@evoloop/contracts";
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
  const updateShape = JSON.parse(update.stdout);
  assert.ok(updateShape.required.includes("expectedVersion"));
  assert.equal(updateShape.required.includes("basis"), false);
  assert.equal(updateShape.required.includes("retentions"), false);
  assert.equal(updateShape.properties.basis.type, "array");
  assert.equal(updateShape.properties.retentions.type, "array");
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
test("a worker reads its exact Run without requiring a project-wide list", async () => {
  const project = "00000000-0000-4000-8000-000000000001", runId = "00000000-0000-4000-8000-000000000002";
  const seen: string[] = [];
  const mocked = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname; seen.push(path);
    return new Response(JSON.stringify(path.endsWith(`/${runId}`) ? {id: runId, inputHash: "fixed"} : {code: "FORBIDDEN"}),
      {status: path.endsWith(`/${runId}`) ? 200 : 403});
  });
  try {
    const result = await run(["read", "run", runId], {EVOLOOP_TOKEN: "private-fixture", EVOLOOP_PROJECT: project});
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).inputHash, "fixed");
    assert.deepEqual(seen, [`/api/projects/${project}/runtime/runs/${runId}`]);
  } finally {mocked.mock.restore();}
});

test("run trace CLI uses a named read and optional cursor", async () => {
  const project = "00000000-0000-4000-8000-000000000001", runId = "00000000-0000-4000-8000-000000000002";
  const seen: string[] = [];
  const mocked = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    seen.push(String(url)); return new Response(JSON.stringify({ source: "owned-native-history" }), { status: 200 });
  });
  try {
    const result = await run(["read", "run", runId, "--trace", "--cursor", "page-2", "--turn-cursor", "older-turns"],
      { EVOLOOP_TOKEN: "private-fixture", EVOLOOP_PROJECT: project });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).source, "owned-native-history");
    assert.equal(new URL(seen[0]!).pathname + new URL(seen[0]!).search,
      `/api/projects/${project}/runtime/runs/${runId}/trace?cursor=page-2&turnCursor=older-turns`);
    assert.equal((await run(["read", "run", runId, "--cursor", "page-2"],
      { EVOLOOP_TOKEN: "private-fixture", EVOLOOP_PROJECT: project })).code, 2);
  } finally { mocked.mock.restore(); }
});

test("the CLI entry point reads resident queue attempts and preserves ordinary reads", async () => {
  const project = "00000000-0000-4000-8000-000000000001", queue = "00000000-0000-4000-8000-000000000002";
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url?.endsWith("/attempts") ? { items: [{ id: "attempt-1" }] } : { id: queue }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const entry = new URL("../src/main.ts", import.meta.url).pathname;
  const invoke = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      env: { ...process.env, EVOLOOP_API_URL: `http://127.0.0.1:${address.port}`, EVOLOOP_TOKEN: "local-fixture", EVOLOOP_PROJECT: project },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code: code ?? -1, stdout, stderr }));
  });
  try {
    const help = await invoke("help");
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--attempts/);
    const attempts = await invoke("read", "resident-queue", queue, "--project", project, "--attempts");
    assert.equal(attempts.code, 0, attempts.stderr);
    assert.deepEqual(JSON.parse(attempts.stdout), { items: [{ id: "attempt-1" }] });
    const ordinary = await invoke("read", "resident-queue", queue, "--project", project);
    assert.equal(ordinary.code, 0, ordinary.stderr);
    assert.deepEqual(JSON.parse(ordinary.stdout), { id: queue });
    const recovery=await invoke('read','session',queue,'--project',project,'--recovery');
    assert.equal(recovery.code,0,recovery.stderr);
    assert.deepEqual(JSON.parse(recovery.stdout),{id:queue});
    const unknown = await invoke("read", "resident-queue", queue, "--project", project, "--not-a-mode");
    assert.equal(unknown.code, 2);
    assert.equal(JSON.parse(unknown.stderr).error.code, "INVALID_INPUT");
    assert.deepEqual(paths, [
      `/api/projects/${project}/resident-queues/${queue}/attempts`,
      `/api/projects/${project}/resident-queues/${queue}`,
      `/api/projects/${project}/runtime/sessions/${queue}/recovery`,
    ]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});


test("CLI discovers the single full execution policy and rejects new restricted Sessions",async()=>{
  const discovery=await run(["command","schema","runtime.session.reserve"]);
  assert.equal(discovery.code,0);
  const schema=JSON.parse(discovery.stdout);
  assert.equal(schema.properties.sandbox.const,"danger-full-access");
  assert.equal(schema.properties.sandbox.default,"danger-full-access");
  assert.equal(schema.properties.approvalPolicy.const,"never");
  const input={type:"runtime.session.reserve",projectId:"00000000-0000-4000-8000-000000000001",
    operationId:"00000000-0000-4000-8000-000000000002",sessionId:"00000000-0000-4000-8000-000000000003",
    roleId:"developer",cwd:"/project",authorizationScope:"project"};
  const parsed=commandSchema.parse(input);
  assert.equal(parsed.type,"runtime.session.reserve");
  if(parsed.type==="runtime.session.reserve"){
    assert.equal(parsed.sandbox,"danger-full-access");assert.equal(parsed.approvalPolicy,"never");
  }
  for(const sandbox of ["read-only","workspace-write"])
    assert.equal(commandSchema.safeParse({...input,sandbox}).success,false);
  assert.equal(commandSchema.safeParse({...input,approvalPolicy:"on-request"}).success,false);
});
