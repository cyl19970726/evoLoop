import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test, mock } from "node:test";
import { commandSchema } from "@evoloop/contracts";
import { runCli } from "../src/application.ts";

async function run(args: string[], env: Record<string, string | undefined> = {}) {
  let stdout = "", stderr = "";
  const code = await runCli(args, env, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}
test("work attention CLI entry forwards filters and cursor while rejecting invalid values", async () => {
  const project = "00000000-0000-4000-8000-000000000001";
  const task = "00000000-0000-4000-8000-000000000002";
  const item = "00000000-0000-4000-8000-000000000003";
  const stage = "00000000-0000-4000-8000-000000000004";
  const urls: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    urls.push(String(url)); return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  });
  const env = { EVOLOOP_TOKEN: "fixture", EVOLOOP_PROJECT: project };
  try {
    const commands = [
      ["work", "attention"],
      ["work", "attention", "--task", task, "--state", "open", "--phase", "awaiting_publication",
        "--signal", "stage_overdue", "--waiting-on-kind", "publisher", "--waiting-on-id", "release-team",
        "--limit", "2", "--cursor", "next-page"],
      ["work", "attention", "task", task],
      ["work", "attention", "item", item],
      ["work", "attention", "thresholds", "--stage", stage, "--phase", "awaiting_publication"],
    ];
    for (const command of commands) {
      const result = await run(command, env);
      assert.equal(result.code, 0, `${command.join(" ")}: ${result.stderr}`);
    }
    assert.deepEqual(urls.map(value => new URL(value).pathname + new URL(value).search), [
      `/api/projects/${project}/task-attention/items`,
      `/api/projects/${project}/task-attention/items?taskId=${task}&state=open&phase=awaiting_publication&signal=stage_overdue&waitingOnKind=publisher&waitingOnId=release-team&limit=2&cursor=next-page`,
      `/api/projects/${project}/tasks/${task}/attention`,
      `/api/projects/${project}/task-attention/items/${item}`,
      `/api/projects/${project}/task-attention/thresholds?stageId=${stage}&phase=awaiting_publication`,
    ]);
    for (const args of [["--state", "pending"], ["--phase", "bad"], ["--signal", "bad"],
      ["--waiting-on-kind", "bad"], ["--limit", "0"], ["--unknown", "x"]]) {
      const result = await run(["work", "attention", ...args], env);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code, "INVALID_INPUT");
    }
    assert.equal(urls.length, commands.length, "invalid filters must not reach the API");
  } finally { fetch.mock.restore(); }
});
test("connector status CLI reads the fixed route and bounded page without creating a subscription", async () => {
  const project = "00000000-0000-4000-8000-000000000001";
  const binding = "00000000-0000-4000-8000-000000000002";
  const urls: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    urls.push(String(url)); return new Response(JSON.stringify({ state: "disabled", items: [], nextCursor: null }));
  });
  try {
    const env = { EVOLOOP_TOKEN: "fixture", EVOLOOP_PROJECT: project };
    assert.equal((await run(["work", "connectors", "--limit", "2", "--cursor", binding], env)).code, 0);
    assert.equal((await run(["work", "connector", binding], env)).code, 0);
    assert.equal((await run(["work", "connector-operation", binding], env)).code, 0);
    assert.deepEqual(urls.map(url => new URL(url).pathname + new URL(url).search), [
      `/api/projects/${project}/message-connectors/routes?limit=2&cursor=${binding}`,
      `/api/projects/${project}/message-connectors/routes/${binding}`,
      `/api/projects/${project}/message-connectors/operations/${binding}`,
    ]);
    assert.equal((await run(["work", "connector", "../other"], env)).code, 2);
    assert.equal(urls.length, 3);
  } finally { fetch.mock.restore(); }
});
test("an unauthenticated fresh Agent can discover help, IDs, exact command schemas and named routes", async () => {
  const help = await run(["help"]); assert.equal(help.code, 0); assert.ok(JSON.parse(help.stdout).commands.some((value: string) => value.startsWith("context ")));
  assert.ok(JSON.parse(help.stdout).commands.some((value: string) => value.startsWith("receipts retry ")));
  assert.ok(JSON.parse(help.stdout).commands.some((value: string) => value.startsWith("work send ")));
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
test("native input CLI reads retain the owned Session and request identity", async () => {
  const p = "00000000-0000-4000-8000-000000000001", id = "00000000-0000-4000-8000-000000000002";
  const urls: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    urls.push(new URL(String(url)).pathname); return new Response(JSON.stringify({ items: [] }), { status: 200 });
  });
  try {
    const env = { EVOLOOP_TOKEN: "fixture", EVOLOOP_PROJECT: p };
    assert.equal((await run(["read", "session", id, "--inputs"], env)).code, 0);
    assert.equal((await run(["read", "native-input", id], env)).code, 0);
    assert.equal((await run(["read", "session", id, "--observation"], env)).code, 0);
    assert.deepEqual(urls, [`/api/projects/${p}/runtime/sessions/${id}/inputs`, `/api/projects/${p}/session-inputs/${id}`,
      `/api/projects/${p}/runtime/sessions/${id}/observation`]);
    const schema = JSON.parse((await run(["command", "schema", "session.input.reply"])).stdout);
    assert.ok(schema.required.includes("answers")); assert.ok(schema.required.includes("expectedVersion"));
    assert.equal(schema.properties.actorId, undefined); assert.equal(schema.properties.connectionId, undefined);
  } finally { fetch.mock.restore(); }
});

test('session profile CLI saves an exact model and effort target with the current revision',async()=>{
  const projectId='00000000-0000-4000-8000-000000000011';
  const sessionId='00000000-0000-4000-8000-000000000012';
  const revisionId='00000000-0000-4000-8000-000000000013';
  const operationId='00000000-0000-4000-8000-000000000014';
  const directory=await mkdtemp(join(tmpdir(),'evoloop-profile-cli-'));
  let submitted:Record<string,unknown>|null=null;
  const fetch=mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname;
    if(path==='/api/session')return new Response(JSON.stringify({principal:{actorId:'reviewer',projectIds:[projectId]}}));
    if(path===`/api/projects/${projectId}/runtime/sessions`)return new Response(JSON.stringify([
      {id:sessionId,version:8,executionProfile:{revision:{revisionId}}}]));
    if(path==='/api/commands'){
      submitted=JSON.parse(String(init?.body));
      return new Response(JSON.stringify({status:'applied',operationId,entityId:sessionId,version:9}));
    }
    throw new Error(`Unexpected path ${path}`);
  });
  try{
    const result=await run(['session','profile','set',sessionId,'--project',projectId,
      '--model','gpt-6-astra','--effort','max','--reason','Reviewed exact grant',
      '--evidence-ref','review://profile','--operation',operationId],
      {EVOLOOP_TOKEN:'fixture',EVOLOOP_STATE_DIR:directory});
    assert.equal(result.code,0,result.stderr);
    assert.equal(submitted?.type,'runtime.session.executionProfile.revise');
    assert.equal(submitted?.expectedVersion,8);
    assert.equal(submitted?.expectedExecutionProfileRevisionId,revisionId);
    assert.equal(submitted?.model,'gpt-6-astra');
    assert.equal(submitted?.reasoningEffort,'max');
  }finally{fetch.mock.restore();await rm(directory,{recursive:true,force:true});}
});
test('Session identity CLI reads current version and returns persisted readback after CAS',async()=>{
  const projectId='00000000-0000-4000-8000-000000000021';
  const sessionId='00000000-0000-4000-8000-000000000022';
  const operationId='00000000-0000-4000-8000-000000000023';
  const key=`owned:${sessionId}`;
  const directory=await mkdtemp(join(tmpdir(),'evoloop-identity-cli-'));
  let version=1,submitted:Record<string,unknown>|null=null;
  const fetch=mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname;
    if(path==='/api/session')return new Response(JSON.stringify({principal:{actorId:'reviewer',projectIds:[projectId]}}));
    if(path===`/api/projects/${projectId}/session-work/${encodeURIComponent(key)}`)
      return new Response(JSON.stringify({session:{identity:{target:{kind:'owned',sessionId},version,color:version===1?'blue':'teal',mark:version===1?'dot':'brackets'}}}));
    if(path==='/api/commands'){
      submitted=JSON.parse(String(init?.body));version=2;
      return new Response(JSON.stringify({status:'applied',operationId,entityId:sessionId,version}));
    }
    throw new Error(`Unexpected path ${path}`);
  });
  try{
    const result=await run(['session','identity','set',key,'--project',projectId,'--color','teal','--mark','brackets',
      '--reason','Selected visible identity','--operation',operationId],
      {EVOLOOP_TOKEN:'fixture',EVOLOOP_STATE_DIR:directory});
    assert.equal(result.code,0,result.stderr);
    assert.deepEqual([submitted?.type,submitted?.expectedVersion,submitted?.color,submitted?.mark],
      ['session.identity.set',1,'teal','brackets']);
    assert.deepEqual(JSON.parse(result.stdout).identity,{target:{kind:'owned',sessionId},version:2,color:'teal',mark:'brackets'});
  }finally{fetch.mock.restore();await rm(directory,{recursive:true,force:true});}
});
test('Session identity CLI writes the canonical target when the requested key is an alias',async()=>{
  const projectId='00000000-0000-4000-8000-000000000031';
  const aliasId='00000000-0000-4000-8000-000000000032';
  const canonicalId='00000000-0000-4000-8000-000000000033';
  const operationId='00000000-0000-4000-8000-000000000034';
  const key=`external:${aliasId}`;
  const directory=await mkdtemp(join(tmpdir(),'evoloop-identity-alias-cli-'));
  let submitted:Record<string,unknown>|null=null;
  const fetch=mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname;
    if(path==='/api/session')return new Response(JSON.stringify({principal:{actorId:'reviewer',projectIds:[projectId]}}));
    if(path===`/api/projects/${projectId}/session-work/${encodeURIComponent(key)}`)
      return new Response(JSON.stringify({session:{identity:{target:{kind:'external',linkId:canonicalId},version:2,color:'blue',mark:'dot'}}}));
    if(path==='/api/commands'){
      submitted=JSON.parse(String(init?.body));
      return new Response(JSON.stringify({status:'applied',operationId,entityId:canonicalId,version:3}));
    }
    throw new Error(`Unexpected path ${path}`);
  });
  try{
    const result=await run(['session','identity','set',key,'--project',projectId,'--color','teal','--mark','brackets',
      '--reason','Alias selection','--operation',operationId],{EVOLOOP_TOKEN:'fixture',EVOLOOP_STATE_DIR:directory});
    assert.equal(result.code,0,result.stderr);
    assert.deepEqual(submitted?.target,{kind:'external',linkId:canonicalId});
  }finally{fetch.mock.restore();await rm(directory,{recursive:true,force:true});}
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

test("work send posts a UTF-8 file body exactly and requires server readback", async () => {
  const project = "00000000-0000-4000-8000-000000000041";
  const session = "00000000-0000-4000-8000-000000000042";
  const task = "00000000-0000-4000-8000-000000000043";
  const revision = "00000000-0000-4000-8000-000000000044";
  const operation = "00000000-0000-4000-8000-000000000045";
  const messageId = "00000000-0000-4000-8000-000000000046";
  const directory = await mkdtemp(join(tmpdir(), "evoloop-message-send-"));
  const bodyPath = join(directory, "body.txt");
  const body = "第一行：请核对“原样”与 'quotes'。\n第二行：中文、换行和符号都要保留。";
  let submitted: Record<string, unknown> | null = null;
  const paths: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path === "/api/session") return new Response(JSON.stringify({ principal: { actorId: "sender", projectIds: [project] } }));
    if (path === "/api/commands") {
      submitted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: "applied", operationId: operation, entityId: messageId, version: 1 }));
    }
    if (path === `/api/projects/${project}/session-messages/${messageId}`)
      return new Response(JSON.stringify({ message: { id: messageId, content: body, state: "queued" } }));
    throw new Error(`Unexpected path ${path}`);
  });
  try {
    await writeFile(bodyPath, body, "utf8");
    const result = await run(["work", "send", `owned:${session}`, "--project", project, "--file", bodyPath,
      "--context-task", task, "--context-revision", revision, "--operation", operation, "--message-id", messageId],
      { EVOLOOP_TOKEN: "fixture", EVOLOOP_STATE_DIR: directory });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(submitted?.type, "session.message.post");
    assert.equal(submitted?.content, body);
    assert.deepEqual(submitted?.target, { kind: "owned", sessionId: session });
    assert.deepEqual(submitted?.context, { taskId: task, taskRevisionId: revision });
    const output = JSON.parse(result.stdout);
    assert.equal(output.readbackVerified, true);
    assert.equal(output.message.content, body);
    assert.equal(output.content.characters, body.length);
    assert.equal(output.content.utf8Bytes, Buffer.byteLength(body, "utf8"));
    assert.deepEqual(paths, ["/api/session", "/api/commands", `/api/projects/${project}/session-messages/${messageId}`]);
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("work send rejects punctuation-only and invalid UTF-8 bodies before any API request", async () => {
  const project = "00000000-0000-4000-8000-000000000051";
  const session = "00000000-0000-4000-8000-000000000052";
  const directory = await mkdtemp(join(tmpdir(), "evoloop-message-guard-"));
  let calls = 0;
  const fetch = mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ principal: { actorId: "sender", projectIds: [project] } }));
  });
  try {
    const emptyQuotes = join(directory, "quotes.txt"), invalid = join(directory, "invalid.txt");
    await writeFile(emptyQuotes, "“”", "utf8");
    await writeFile(invalid, Buffer.from([0xff, 0xfe, 0xfd]));
    for (const [file, message] of [[emptyQuotes, /no letters or numbers/], [invalid, /not valid UTF-8/]] as const) {
      const result = await run(["work", "send", `owned:${session}`, "--project", project, "--file", file],
        { EVOLOOP_TOKEN: "fixture", EVOLOOP_STATE_DIR: directory });
      assert.equal(result.code, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).error.code, "INVALID_INPUT");
      assert.match(JSON.parse(result.stderr).error.message, message);
    }
    assert.equal(calls, 0, "invalid bodies must not reach the API");
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("work send reports a content mismatch instead of claiming success", async () => {
  const project = "00000000-0000-4000-8000-000000000061";
  const session = "00000000-0000-4000-8000-000000000062";
  const operation = "00000000-0000-4000-8000-000000000063";
  const messageId = "00000000-0000-4000-8000-000000000064";
  const directory = await mkdtemp(join(tmpdir(), "evoloop-message-mismatch-"));
  const bodyPath = join(directory, "body.txt");
  const body = "请只回复“收到”。";
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/session") return new Response(JSON.stringify({ principal: { actorId: "sender", projectIds: [project] } }));
    if (path === "/api/commands")
      return new Response(JSON.stringify({ status: "applied", operationId: operation, entityId: messageId, version: 1 }));
    if (path === `/api/projects/${project}/session-messages/${messageId}`)
      return new Response(JSON.stringify({ message: { id: messageId, content: "UI “” Task", state: "queued" } }));
    throw new Error(`Unexpected path ${path}`);
  });
  try {
    await writeFile(bodyPath, body, "utf8");
    const result = await run(["work", "send", `owned:${session}`, "--project", project, "--file", bodyPath,
      "--operation", operation, "--message-id", messageId],
      { EVOLOOP_TOKEN: "fixture", EVOLOOP_STATE_DIR: directory });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    assert.equal(error.error.code, "MESSAGE_CONTENT_MISMATCH");
    assert.equal(error.error.data.messageId, messageId);
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

test("work send accepts a UTF-8 body from stdin", async () => {
  const project = "00000000-0000-4000-8000-000000000071";
  const session = "00000000-0000-4000-8000-000000000072";
  const operation = "00000000-0000-4000-8000-000000000073";
  const messageId = "00000000-0000-4000-8000-000000000074";
  const directory = await mkdtemp(join(tmpdir(), "evoloop-message-stdin-"));
  const body = "从 stdin 发送：“保留中文”。\n第二行也保留。";
  let submitted: Record<string, unknown> | null = null;
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/session") return new Response(JSON.stringify({ principal: { actorId: "sender", projectIds: [project] } }));
    if (path === "/api/commands") {
      submitted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: "applied", operationId: operation, entityId: messageId, version: 1 }));
    }
    if (path === `/api/projects/${project}/session-messages/${messageId}`)
      return new Response(JSON.stringify({ message: { id: messageId, content: body, state: "queued" } }));
    throw new Error(`Unexpected path ${path}`);
  });
  try {
    let stdout = "", stderr = "";
    const code = await runCli(["work", "send", `external:${session}`, "--project", project, "--stdin",
      "--operation", operation, "--message-id", messageId],
      { EVOLOOP_TOKEN: "fixture", EVOLOOP_STATE_DIR: directory }, {
        stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
        stdin: async function* () { yield Buffer.from(body, "utf8"); },
      });
    assert.equal(code, 0, stderr);
    assert.equal(submitted?.content, body);
    assert.deepEqual(submitted?.target, { kind: "external", linkId: session });
    assert.equal(JSON.parse(stdout).message.content, body);
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
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


test("CLI discovers the full-only default profile for core authorization",async()=>{
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
  assert.equal(commandSchema.safeParse({...input,sandbox:"read-only"}).success,false);
  assert.equal(commandSchema.safeParse({...input,sandbox:"workspace-write"}).success,false);
  assert.equal(commandSchema.safeParse({...input,sandbox:"read-only",
    authorizationScope:"connector-receiver:00000000-0000-4000-8000-000000000004"}).success,false);
  assert.equal(commandSchema.safeParse({...input,approvalPolicy:"on-request"}).success,false);
});
test('role runtime CLI binds once from the live view, then changes only skills and reads back',async()=>{
  const projectId='00000000-0000-4000-8000-000000000031',roleId='00000000-0000-4000-8000-000000000032';
  const directory=await mkdtemp(join(tmpdir(),'evoloop-role-runtime-cli-'));
  const selection={project:true,personal:true,builtin:false,add:[] as string[],remove:[] as string[]};
  let binding:{revision:number;provider:string;skills:unknown}|null=null;const submitted:Record<string,unknown>[]=[];
  const fetch=mock.method(globalThis,'fetch',async(url:string|URL|Request,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname;
    if(path==='/api/session')return new Response(JSON.stringify({principal:{actorId:'lead',projectIds:[projectId]}}));
    if(path===`/api/projects/${projectId}/roles/${roleId}/runtime`)return new Response(JSON.stringify({projectId,roleId,binding,
      provider:binding?.provider??'codex',selection:binding?.skills??selection,skills:[]}));
    if(path==='/api/commands'){
      const command=JSON.parse(String(init?.body));submitted.push(command);
      binding={revision:command.expectedRevision+1,provider:command.provider,skills:command.skills};
      return new Response(JSON.stringify({status:'applied',operationId:command.operationId,entityId:roleId,version:binding.revision}));
    }
    throw new Error(`Unexpected path ${path}`);
  });
  const env={EVOLOOP_TOKEN:'fixture',EVOLOOP_STATE_DIR:directory};
  try{
    const shown=await run(['role','runtime','show',roleId,'--project',projectId],env);
    assert.equal(shown.code,0,shown.stderr);
    assert.equal(JSON.parse(shown.stdout).provider,'codex');
    const first=await run(['role','runtime','set',roleId,'--project',projectId,'--provider','claude','--personal','off',
      '--add','zeta, project:alpha','--reason','首次绑定'],env);
    assert.equal(first.code,0,first.stderr);
    assert.deepEqual([submitted[0]?.type,submitted[0]?.expectedRevision,submitted[0]?.provider,submitted[0]?.skills],
      ['role.runtime.set',0,'claude',{project:true,personal:false,builtin:false,add:['zeta','project:alpha'],remove:[]}]);
    assert.equal(JSON.parse(first.stdout).runtime.binding.revision,1);
    const second=await run(['role','runtime','set',roleId,'--project',projectId,'--builtin','on','--add','none','--reason','调整'],env);
    assert.equal(second.code,0,second.stderr);
    assert.deepEqual([submitted[1]?.expectedRevision,submitted[1]?.provider,submitted[1]?.skills],
      [1,'claude',{project:true,personal:false,builtin:true,add:[],remove:[]}],'the bound runtime is kept without --provider');
    const wrong=await run(['role','runtime','set',roleId,'--project',projectId,'--personal','maybe','--reason','x'],env);
    assert.equal(wrong.code,2);
    assert.equal(JSON.parse(wrong.stderr).error.code,'INVALID_INPUT');
    const noReason=await run(['role','runtime','set',roleId,'--project',projectId,'--personal','on'],env);
    assert.equal(noReason.code,2);
    assert.equal(submitted.length,2);
  }finally{fetch.mock.restore();await rm(directory,{recursive:true,force:true});}
});

test("drain CLI reads the instance state and history, starts and releases with a recorded reason, and refuses a missing reason before any request", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path: new URL(String(url)).pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ state: "draining" }), { status: 200 });
  });
  const env = { EVOLOOP_TOKEN: "fixture" };
  try {
    for (const command of [["drain", "status"], ["drain", "history"], ["drain", "start", "--reason", "发布 0dd0baa"], ["drain", "release", "--reason", "发布完成"]]) {
      const result = await run(command, env);
      assert.equal(result.code, 0, `${command.join(" ")}: ${result.stderr}`);
    }
    assert.deepEqual(calls, [
      { method: "GET", path: "/api/instance/drain", body: null },
      { method: "GET", path: "/api/instance/drain/history", body: null },
      { method: "POST", path: "/api/instance/drain", body: { action: "start", reason: "发布 0dd0baa" } },
      { method: "POST", path: "/api/instance/drain", body: { action: "release", reason: "发布完成" } },
    ]);
    calls.length = 0;
    const noReason = await run(["drain", "start"], env);
    assert.notEqual(noReason.code, 0);
    assert.match(noReason.stderr, /requires --reason/);
    assert.notEqual((await run(["drain", "pause"], env)).code, 0);
    assert.equal(calls.length, 0, "nothing was sent");
    assert.match((await run(["help"], env)).stdout, /drain start\|release --reason TEXT/);
  } finally { fetch.mock.restore(); }
});

test("command run shows the failing field and its accepted form when executeAtUtc is malformed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evoloop-cli-timing-"));
  try {
    const id = (n: number) => `40000005-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const timing = { executeAtUtc: "tomorrow 9am", timezone: "Asia/Shanghai", repeat: "none" };
    const files = { create: { type: "task.create", projectId: id(1), operationId: id(2), taskId: id(3), title: "t", content: "c", acceptance: "a", owner: "o", timing },
      set: { type: "task.timing.set", projectId: id(1), operationId: id(4), taskId: id(3), expectedTaskVersion: 1, expectedTimingVersion: 0, ...timing, scope: "this", reason: "r" } };
    for (const [name, body] of Object.entries(files)) {
      const file = join(dir, `${name}.json`);
      await (await import("node:fs/promises")).writeFile(file, JSON.stringify(body));
      const result = await run(["command", "run", file], { EVOLOOP_API_URL: "http://127.0.0.1:9", EVOLOOP_TOKEN: "t".repeat(40), EVOLOOP_STATE_DIR: dir });
      assert.equal(result.code, 2, result.stderr);
      const message = JSON.parse(result.stderr).error.message as string;
      assert.match(message, /executeAtUtc/, name);
      assert.match(message, /2026-11-12T04:00:00\.000Z/, `${name}: the CLI message carries the example`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("session profile set keeps the model in force: without --model it takes the confirmed active model, not a pending head that was never activated", async () => {
  const project = "00000000-0000-4000-8000-000000000051";
  const session = "00000000-0000-4000-8000-000000000052";
  const revision = "00000000-0000-4000-8000-000000000053";
  const operation = "00000000-0000-4000-8000-000000000054";
  const directory = await mkdtemp(join(tmpdir(), "evoloop-profile-set-"));
  let submitted: Record<string, unknown> | null = null;
  const fetch = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/session") return new Response(JSON.stringify({ principal: { actorId: "reviewer", projectIds: [project] } }));
    if (path === `/api/projects/${project}/runtime/sessions`)
      return new Response(JSON.stringify([{ id: session, version: 7, executionProfile: { activeModel: "deepseek/deepseek-flash",
        revision: { revisionId: revision, model: "deepseek/deepseek-v4-pro", reasoningEffort: "high" } } }]));
    if (path === "/api/commands") { submitted = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ status: "applied", operationId: operation, entityId: session, version: 8 })); }
    if (path === `/api/projects/${project}/operations/${operation}`) return new Response(JSON.stringify({ result: { status: "applied", operationId: operation, entityId: session, version: 8 } }));
    throw new Error(`Unexpected path ${path}`);
  });
  try {
    const result = await run(["session", "profile", "set", session, "--project", project, "--effort", "max", "--reason", "think harder", "--evidence-ref", "fixture://grant",
      "--operation", operation], { EVOLOOP_TOKEN: "fixture", EVOLOOP_STATE_DIR: directory });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(submitted?.model, "deepseek/deepseek-flash", "the model in force, not the pending head's");
    assert.equal(submitted?.reasoningEffort, "max");
    assert.equal(submitted?.expectedExecutionProfileRevisionId, revision);
    // An explicit --model still wins.
    submitted = null;
    await run(["session", "profile", "set", session, "--project", project, "--model", "deepseek/deepseek-v4-pro", "--effort", "max", "--reason", "x", "--evidence-ref", "fixture://grant",
      "--operation", "00000000-0000-4000-8000-000000000055"], { EVOLOOP_TOKEN: "fixture", EVOLOOP_STATE_DIR: directory });
    assert.equal(submitted?.model, "deepseek/deepseek-v4-pro");
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

test('read run carries what the Turn actually reported next to the configured profile, 未记录 when nothing was observed', async () => {
  const projectId = '00000000-0000-4000-8000-0000000000e1', runId = '00000000-0000-4000-8000-0000000000e2', other = '00000000-0000-4000-8000-0000000000e3';
  const directory = await mkdtemp(join(tmpdir(), 'evoloop-read-run-'));
  const base = `/api/projects/${projectId}/runtime/runs`;
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/session') return new Response(JSON.stringify({ principal: { actorId: 'reader', projectIds: [projectId] } }));
    if (path === `${base}/${runId}`) return new Response(JSON.stringify({ id: runId, state: 'completed', executionProfile: { model: 'opus', reasoningEffort: 'high' },
      actual: { model: 'claude-opus-5-5', reasoningEffort: null, subagentModels: ['claude-haiku-4-5'] } }));
    if (path === `${base}/${other}`) return new Response(JSON.stringify({ id: other, state: 'completed', executionProfile: { model: 'opus', reasoningEffort: 'high' } }));
    throw new Error(`Unexpected ${path}`);
  });
  const env = { EVOLOOP_TOKEN: 'fixture', EVOLOOP_STATE_DIR: directory };
  try {
    const seen = JSON.parse((await run(['read', 'run', runId, '--project', projectId], env)).stdout);
    assert.deepEqual(seen.actualView, { model: 'claude-opus-5-5', reasoningEffort: '未记录', effortRequested: null, subagentModels: ['claude-haiku-4-5'], configuredModel: 'opus', configuredEffort: 'high', recorded: true });
    const unseen = JSON.parse((await run(['read', 'run', other, '--project', projectId], env)).stdout);
    assert.equal(unseen.actualView.model, '未记录'); assert.equal(unseen.actualView.recorded, false); assert.equal(unseen.actualView.configuredModel, 'opus');
    assert.equal(unseen.state, 'completed', 'the Run itself is passed through unchanged');
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

test('session input CLI inserts into the running Turn, queues, names a missing grant, and reads back by the same input ID', async () => {
  const projectId = '00000000-0000-4000-8000-000000000021', sessionId = '00000000-0000-4000-8000-000000000022';
  const inputId = '00000000-0000-4000-8000-000000000023', operationId = '00000000-0000-4000-8000-000000000024';
  const queueId = '00000000-0000-4000-8000-000000000025', queueOperation = '00000000-0000-4000-8000-000000000026';
  const directory = await mkdtemp(join(tmpdir(), 'evoloop-input-cli-'));
  const base = `/api/projects/${projectId}`;
  let capability: Record<string, unknown> = { available: true, mode: 'steer', expectedTurnId: 'turn-7', reasonCode: 'READY_TO_STEER' };
  let submitted: Record<string, unknown> | null = null, posted: Record<string, unknown> | null = null, direct: Record<string, unknown> | null = null, queued_posted = false;
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/session') return new Response(JSON.stringify({ principal: { actorId: 'requirements', projectIds: [projectId] } }));
    if (path === `${base}/sessions/${sessionId}/direct-input-capability`) return new Response(JSON.stringify(capability));
    if (path === `${base}/sessions/${sessionId}/direct-inputs` && init?.method === 'POST') {
      submitted = JSON.parse(String(init.body));
      direct = { inputId, operationId, mode: 'steer', state: 'accepted', actualTurnId: 'turn-7', reason: null };
      return new Response(JSON.stringify(direct));
    }
    if (path.startsWith(`${base}/sessions/${sessionId}/direct-inputs/`)) {
      const found = path.endsWith(inputId) && direct;
      return new Response(JSON.stringify(found || { code: 'NOT_FOUND' }), { status: found ? 200 : 404 });
    }
    if (path === '/api/commands') { posted = JSON.parse(String(init?.body)); queued_posted = true; return new Response(JSON.stringify({ status: 'applied', operationId: queueOperation, entityId: queueId, version: 1 })); }
    if (path === `${base}/session-messages/${queueId}`) return new Response(JSON.stringify({ message: { id: queueId, state: 'queued' } }), { status: queued_posted ? 200 : 404 });
    if (path.startsWith(`${base}/session-messages/`)) return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404 });
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`);
  });
  const env = { EVOLOOP_TOKEN: 'fixture', EVOLOOP_STATE_DIR: directory };
  try {
    // insert while the Leader runs: the current Turn ID from the capability is the expected Turn
    const inserted = await run(['session', 'input', 'send', sessionId, '--project', projectId, '--mode', 'insert', '--content', 'Also check X', '--input', inputId, '--operation', operationId], env);
    assert.equal(inserted.code, 0, inserted.stderr);
    assert.deepEqual(submitted, { inputId, operationId, content: 'Also check X', expectedTurnId: 'turn-7' });
    const insertedBody = JSON.parse(inserted.stdout);
    assert.equal(insertedBody.outcome, 'inserted'); assert.equal(insertedBody.inputId, inputId);
    assert.match(inserted.stderr, new RegExp(inputId), 'the IDs are printed before the send, so a lost answer can be read back');
    // the same input ID reads back
    const shown = JSON.parse((await run(['session', 'input', 'show', sessionId, inputId, '--project', projectId], env)).stdout);
    assert.equal(shown.outcome, 'inserted'); assert.equal(shown.via, 'direct-input');
    // queue: an ordinary message with the same ID, read back as queued
    const queued = await run(['session', 'input', 'send', sessionId, '--project', projectId, '--mode', 'queue', '--content', 'After this Turn', '--input', queueId, '--operation', queueOperation], env);
    assert.equal(queued.code, 0, queued.stderr);
    assert.equal(posted?.type, 'session.message.post'); assert.equal(posted?.messageId, queueId); assert.equal(posted?.operationId, queueOperation);
    assert.equal(JSON.parse(queued.stdout).outcome, 'queued');
    const shownQueue = JSON.parse((await run(['session', 'input', 'show', sessionId, queueId, '--project', projectId], env)).stdout);
    assert.equal(shownQueue.outcome, 'queued'); assert.equal(shownQueue.via, 'message');
    // no direct input grant: refused before anything is sent, saying which item is missing
    capability = { available: false, mode: null, expectedTurnId: null, reasonCode: 'DIRECT_GRANT_MISSING',
      detail: 'Direct input refused; missing: direct input grant (steer or start) for this sender and Session' };
    submitted = null;
    const refused = await run(['session', 'input', 'send', sessionId, '--project', projectId, '--mode', 'insert', '--content', 'Hello'], env);
    assert.notEqual(refused.code, 0); assert.equal(submitted, null, 'nothing was sent');
    assert.match(refused.stderr, /missing: direct input grant/); assert.match(refused.stderr, /--mode queue/);
    // usage errors
    assert.equal((await run(['session', 'input', 'send', sessionId, '--project', projectId, '--mode', 'later', '--content', 'x'], env)).code, 2);
    assert.equal((await run(['session', 'input', 'send', sessionId, '--project', projectId, '--mode', 'queue'], env)).code, 2);
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

test('direct input outcomes read in the workbench words, including a steer queued after the Turn changed', async () => {
  const { directInputOutcome } = await import('../src/session-input.ts');
  assert.equal(directInputOutcome({ state: 'accepted', mode: 'steer' }).outcome, 'inserted');
  assert.equal(directInputOutcome({ state: 'accepted', mode: 'start' }).outcome, 'started');
  const changed = directInputOutcome({ state: 'rejected', mode: 'steer', queuedMessageId: 'm', reason: 'TURN_CHANGED: the Turn changed' });
  assert.equal(changed.outcome, 'queued_after_change'); assert.match(changed.summary, /same ID/); assert.match(changed.reason!, /TURN_CHANGED/);
  assert.equal(directInputOutcome({ state: 'rejected', mode: 'steer', queuedMessageId: null, reason: 'no' }).outcome, 'rejected');
  assert.equal(directInputOutcome({ state: 'unknown', mode: 'steer' }).outcome, 'unknown');
});

test('session input CLI: a repeat with a known ID answers from what was saved, never inserts and queues the same text, reconciles a missing native Item, and exits 3 on an unknown outcome', async () => {
  const projectId = '00000000-0000-4000-8000-000000000031', sessionId = '00000000-0000-4000-8000-000000000032';
  const sent = '00000000-0000-4000-8000-000000000033', converted = '00000000-0000-4000-8000-000000000034', lost = '00000000-0000-4000-8000-000000000035';
  const directory = await mkdtemp(join(tmpdir(), 'evoloop-input-retry-'));
  const base = `/api/projects/${projectId}`;
  const calls: string[] = [];
  let reconciled = false, capabilityCalls = 0, postMode: 'down' | 'ok' = 'ok';
  const accepted = (inputId: string, item: string | null) => ({ inputId, operationId: inputId, mode: 'steer', state: 'accepted', actualTurnId: 'turn-7', nativeItemId: item, reason: null });
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname; calls.push(`${init?.method ?? 'GET'} ${path}`);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === '/api/session') return json({ principal: { actorId: 'requirements', projectIds: [projectId] } });
    if (path === `${base}/sessions/${sessionId}/direct-input-capability`) { capabilityCalls++; return json({ available: true, mode: 'start', expectedTurnId: null, reasonCode: 'READY_TO_START' }); }
    if (path === `${base}/sessions/${sessionId}/direct-inputs/${sent}/reconcile`) { reconciled = true; return json(accepted(sent, 'item-9')); }
    if (path === `${base}/sessions/${sessionId}/direct-inputs/${sent}`) return json(accepted(sent, reconciled ? 'item-9' : null));
    if (path === `${base}/sessions/${sessionId}/direct-inputs/${converted}`) return json({ inputId: converted, operationId: converted, mode: 'steer', state: 'rejected', reason: 'TURN_CHANGED: the Turn changed before the input was added; saved as a queued ordinary message', queuedMessageId: converted });
    if (path.startsWith(`${base}/sessions/${sessionId}/direct-inputs/`)) return json({ code: 'NOT_FOUND' }, 404);
    if (path === `${base}/session-messages/${converted}`) return json({ message: { id: converted, state: 'queued' } });
    if (path.startsWith(`${base}/session-messages/`)) return json({ code: 'NOT_FOUND' }, 404);
    if (path === `${base}/sessions/${sessionId}/direct-inputs` && init?.method === 'POST') { if (postMode === 'down') return json({ message: 'down' }, 503); return json(accepted(lost, 'x')); }
    if (path === '/api/commands') return json({ status: 'applied', operationId: converted, entityId: converted, version: 1 });
    throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`);
  });
  const env = { EVOLOOP_TOKEN: 'fixture', EVOLOOP_STATE_DIR: directory };
  const send = (mode: string, input: string) => run(['session', 'input', 'send', sessionId, '--project', projectId, '--mode', mode, '--content', 'Also check X', '--input', input, '--operation', input], env);
  try {
    // 1. The reply to an insert was lost; the repeat finds the saved input and answers it, without reading the capability or sending again.
    const again = await send('insert', sent);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).outcome, 'inserted'); assert.equal(JSON.parse(again.stdout).repeated, true);
    assert.equal(capabilityCalls, 0); assert.equal(calls.some(call => call === `POST ${base}/sessions/${sessionId}/direct-inputs`), false);
    // 2. The same ID asked to queue: refused, nothing is posted.
    const queueAgain = await send('queue', sent);
    assert.notEqual(queueAgain.code, 0); assert.match(queueAgain.stderr, /INPUT_ID_IS_DIRECT_INPUT/);
    assert.equal(calls.some(call => call === 'POST /api/commands'), false, 'the text is not queued a second time');
    // 3. An input already turned into a queued message answers "queued after the Turn changed", for either way of asking.
    for (const mode of ['insert', 'queue']) {
      const result = await send(mode, converted);
      assert.equal(result.code, 0, result.stderr);
      const body = JSON.parse(result.stdout);
      assert.equal(body.outcome, 'queued_after_change'); assert.equal(body.receipt.queuedMessageId, converted);
    }
    assert.equal(calls.some(call => call === 'POST /api/commands'), false, 'no second message');
    // 4. show only reads (an accepted input without a native Item is reported as it is, with the explicit command to check it); reconcile is the
    //    explicit check that looks for the original once and then names the Item.
    const shown = JSON.parse((await run(['session', 'input', 'show', sessionId, sent, '--project', projectId], env)).stdout);
    assert.equal(shown.reconciled, false); assert.equal(shown.receipt.nativeItemId, null); assert.equal(shown.outcome, 'inserted'); assert.match(shown.next, /session input reconcile/);
    assert.equal(reconciled, false, 'show did not call reconcile');
    const checked = JSON.parse((await run(['session', 'input', 'reconcile', sessionId, sent, '--project', projectId], env)).stdout);
    assert.equal(checked.reconciled, true); assert.equal(checked.receipt.nativeItemId, 'item-9'); assert.equal(checked.outcome, 'inserted');
    // 5. An answer lost on a fresh insert exits 3 like every unconfirmed mutation and points at the same ID.
    postMode = 'down';
    const unknown = await run(['session', 'input', 'send', sessionId, '--project', projectId, '--mode', 'insert', '--content', 'new text', '--input', lost, '--operation', lost], env);
    assert.equal(unknown.code, 3, unknown.stderr); assert.match(unknown.stderr, /RESULT_UNCONFIRMED/); assert.match(unknown.stderr, new RegExp(lost));
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

// ---- Task e0bcde26 (follow-up to #350): session input ----------------------------------------------------------------------
type InputFake = { direct: Record<string, Record<string, unknown>>; messages: Set<string>; capability: Record<string, unknown>; calls: string[]; bodies: Record<string, unknown>[] };
const inputWorld = (projectId: string, sessionId: string, init: Partial<InputFake> = {}) => {
  const world: InputFake = { direct: {}, messages: new Set(), capability: { available: true, mode: 'start', expectedTurnId: null, reasonCode: 'READY_TO_START' }, calls: [], bodies: [], ...init };
  const base = `/api/projects/${projectId}`;
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request, req?: RequestInit) => {
    const path = new URL(String(url)).pathname, method = req?.method ?? 'GET';
    world.calls.push(`${method} ${path}`);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (path === '/api/session') return json({ principal: { actorId: 'requirements', projectIds: [projectId] } });
    if (path === `${base}/sessions/${sessionId}/direct-input-capability`) return json(world.capability);
    const reconcile = new RegExp(`^${base}/sessions/${sessionId}/direct-inputs/([0-9a-f-]{36})/reconcile$`).exec(path);
    if (reconcile && method === 'POST') return json({ ...world.direct[reconcile[1]!]!, state: 'unknown', reason: 'reconciled by the test' });
    const one = new RegExp(`^${base}/sessions/${sessionId}/direct-inputs/([0-9a-f-]{36})$`).exec(path);
    if (one) return world.direct[one[1]!] ? json(world.direct[one[1]!]) : json({ code: 'NOT_FOUND' }, 404);
    if (path === `${base}/sessions/${sessionId}/direct-inputs` && method === 'POST') {
      const body = JSON.parse(String(req!.body)); world.bodies.push(body);
      // The service decides under its lock: a refused-by-state steer comes back saved as one queued message.
      world.direct[body.inputId] = { inputId: body.inputId, operationId: body.operationId, mode: 'steer', state: 'rejected', queuedMessageId: body.inputId, reason: 'TURN_CHANGED: saved as a queued ordinary message' };
      world.messages.add(body.inputId);
      return json(world.direct[body.inputId]);
    }
    const message = new RegExp(`^${base}/session-messages/([0-9a-f-]{36})$`).exec(path);
    if (message) return world.messages.has(message[1]!) ? json({ message: { id: message[1], state: 'queued' } }) : json({ code: 'NOT_FOUND' }, 404);
    if (path === '/api/commands') { const body = JSON.parse(String(req!.body)); world.bodies.push(body); world.messages.add(body.messageId);
      if (world.direct[body.messageId]) world.direct[body.messageId] = { ...world.direct[body.messageId]!, queuedMessageId: body.messageId };
      return json({ status: 'applied', operationId: body.operationId, entityId: body.messageId, version: 1 }); }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  return { world, fetch, base };
};
const inputIds = { project: '00000000-0000-4000-8000-0000000000a1', session: '00000000-0000-4000-8000-0000000000a2' };
const cliInput = (...words: string[]) => run(['session', 'input', ...words], { EVOLOOP_TOKEN: 'fixture', EVOLOOP_STATE_DIR: '' });

test('item 1 (CLI): when the Turn has just ended the insert is still sent, and the service saves it as one queued message instead of the CLI refusing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evoloop-input-window-'));
  for (const reasonCode of ['NATIVE_TURN_NOT_ACTIVE', 'SESSION_BUSY']) {
    const { world, fetch } = inputWorld(inputIds.project, inputIds.session, { capability: { available: false, mode: null, expectedTurnId: null, reasonCode } });
    const id = reasonCode === 'SESSION_BUSY' ? '00000000-0000-4000-8000-0000000000b2' : '00000000-0000-4000-8000-0000000000b1';
    try {
      const result = await run(['session', 'input', 'send', inputIds.session, '--project', inputIds.project, '--mode', 'insert', '--content', 'Just after the Turn ended', '--input', id, '--operation', id],
        { EVOLOOP_TOKEN: 'fixture', EVOLOOP_STATE_DIR: directory });
      assert.equal(result.code, 0, `${reasonCode}: ${result.stderr}`);
      assert.equal(world.bodies.length, 1, 'the input was sent to the service once');
      assert.equal(world.bodies[0]!.expectedTurnId, null);
      assert.equal(JSON.parse(result.stdout).outcome, 'queued_after_change', 'told as saved-queued, with the same ID');
    } finally { fetch.mock.restore(); }
  }
  // A missing authorization is still refused before anything is sent (only the two timing readings go through).
  const { world, fetch } = inputWorld(inputIds.project, inputIds.session, { capability: { available: false, mode: null, expectedTurnId: null, reasonCode: 'DIRECT_GRANT_MISSING' } });
  try {
    const refused = await run(['session', 'input', 'send', inputIds.session, '--project', inputIds.project, '--mode', 'insert', '--content', 'x'], { EVOLOOP_TOKEN: 'fixture', EVOLOOP_STATE_DIR: directory });
    assert.notEqual(refused.code, 0); assert.equal(world.bodies.length, 0);
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

test('item 2 (CLI): the same ID whose insert was plainly refused can be queued, and the text then goes in once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evoloop-input-requeue-'));
  const id = '00000000-0000-4000-8000-0000000000c1';
  const { world, fetch } = inputWorld(inputIds.project, inputIds.session, { direct: { [id]: { inputId: id, operationId: id, mode: 'steer', state: 'rejected', queuedMessageId: null, reason: 'Native request was explicitly rejected' } } });
  const env = { EVOLOOP_TOKEN: 'fixture', EVOLOOP_STATE_DIR: directory };
  try {
    const queued = await run(['session', 'input', 'send', inputIds.session, '--project', inputIds.project, '--mode', 'queue', '--content', 'Refused earlier', '--input', id], env);
    assert.equal(queued.code, 0, queued.stderr);
    const post = world.bodies.find(body => body.type === 'session.message.post');
    assert.ok(post, 'an ordinary message was posted'); assert.equal(post!.messageId, id, 'under the same ID');
    assert.equal(JSON.parse(queued.stdout).outcome, 'queued');
    // Repeating the queue request (a lost answer) does not post a second message; asking to insert returns the saved result.
    const before = world.bodies.length;
    const repeat = await run(['session', 'input', 'send', inputIds.session, '--project', inputIds.project, '--mode', 'queue', '--content', 'Refused earlier', '--input', id], env);
    assert.equal(repeat.code, 0, repeat.stderr); assert.equal(world.bodies.length, before, 'no second message');
    const insertAgain = await run(['session', 'input', 'send', inputIds.session, '--project', inputIds.project, '--mode', 'insert', '--content', 'Refused earlier', '--input', id], env);
    assert.equal(insertAgain.code, 0, insertAgain.stderr); assert.equal(world.bodies.length, before, 'insert under a saved ID sends nothing');
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});

test('item 4 (CLI): show only reads; reconciling is its own explicit command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evoloop-input-show-'));
  const id = '00000000-0000-4000-8000-0000000000d1';
  const { world, fetch } = inputWorld(inputIds.project, inputIds.session, { direct: { [id]: { inputId: id, operationId: id, mode: 'steer', state: 'attempted', actualTurnId: null, nativeItemId: null, reason: null } } });
  const env = { EVOLOOP_TOKEN: 'fixture', EVOLOOP_STATE_DIR: directory };
  try {
    const shown = await run(['session', 'input', 'show', inputIds.session, id, '--project', inputIds.project], env);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(world.calls.some(call => call.startsWith('POST') && call.endsWith('/reconcile')), false, 'show did not reconcile');
    assert.equal(world.direct[id]!.state, 'attempted', 'the saved state is untouched');
    assert.equal(JSON.parse(shown.stdout).outcome, 'unknown'); assert.match(shown.stdout, /session input reconcile/);
    const reconciled = await run(['session', 'input', 'reconcile', inputIds.session, id, '--project', inputIds.project], env);
    assert.equal(reconciled.code, 0, reconciled.stderr);
    assert.equal(world.calls.filter(call => call.startsWith('POST') && call.endsWith('/reconcile')).length, 1, 'the explicit command reconciles once');
  } finally { fetch.mock.restore(); await rm(directory, { recursive: true, force: true }); }
});
