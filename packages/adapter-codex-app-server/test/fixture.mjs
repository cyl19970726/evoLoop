import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const thread = { id: "thread-owned", sessionId: "thread-owned", cwd: "/tmp/evoloop-fixture" };
const lines = createInterface({ input: process.stdin });
let initialized = false;
let approvalId = 800;
let pendingCreateId = null;
let turnListReads = 0;
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialized") { initialized = true; continue; }
  if (message.id === approvalId && pendingCreateId !== null) {
    const expected = mode === "prebind-unsupported" ? message.error?.code === -32000 : message.result?.decision === "decline";
    if (!expected) { process.exit(2); }
    send({ id: pendingCreateId, result: { thread } });
    pendingCreateId = null;
    continue;
  }
  if (message.id === approvalId) { send({ method: "fixture/approvalDecision", params: { threadId: thread.id, decision: message.result?.decision ?? null } }); continue; }
  const { id, method, params } = message;
  if (method === "initialize") { send({ id, result: { userAgent: "fixture", platformFamily: "unix" } }); continue; }
  if (!initialized) { send({ id, error: { code: -32000, message: "not initialized" } }); continue; }
  if (mode === "malformed" && method === "turn/start") { process.stdout.write("{broken\n"); continue; }
  if (mode === "disconnect" && method === "turn/start") { process.exit(0); }
  if (mode === "timeout" && method === "turn/start") continue;
  if (mode === "reject-start" && method === "turn/start") { send({ id, error: { code: -32602, message: "invalid params: private fixture detail" } }); continue; }
  if (method === "thread/start") {
    if (mode.startsWith("prebind-")) {
      pendingCreateId = id;
      send({ id: approvalId, method: mode === "prebind-unsupported" ? "fixture/unsupportedRequest" : "item/commandExecution/requestApproval",
        params: { threadId: thread.id, command: "echo fixture" } });
      continue;
    }
    send({ id, result: { thread } }); continue;
  }
  if (method === "thread/resume" && mode === "resume-rejected") { send({ id, error: { code: -32000, message: "thread resume unavailable: private fixture detail" } }); continue; }
  if (method === "thread/resume" || method === "thread/read") { send({ id, result: { thread: mode === "changed-session" ? { ...thread, sessionId: "different-session" } : thread } }); continue; }
  if (method === "thread/turns/list") {
    turnListReads++;
    send({ id, result: { data: [{ id: "turn-1",
      status: mode === "transient-interrupted" && turnListReads === 1 ? "interrupted" : mode === "failed-turn" ? "failed" : "completed",
      completedAt: mode === "transient-interrupted" && turnListReads === 1 ? null : mode === "invalid-completed-at" ? "not-a-timestamp" : 1792498484,
      ...(mode === "failed-turn" ? { error: { message: JSON.stringify({ status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account. Private fixture detail" } }) } } : {})
    }], nextCursor: null } }); continue;
  }
  if (method === "thread/items/list") { send({ id, result: { data: [{ turnId: mode === "wrong-turn-items" ? "foreign-turn" : params.turnId, item: { id: "item-1", type: "agentMessage", text: "fixture final answer" } }], nextCursor: null } }); continue; }
  if (method === "turn/interrupt") { send({ id, result: {} }); send({ method: "turn/completed", params: { threadId: thread.id, turn: { id: params.turnId, status: "interrupted" } } }); continue; }
  if (method === "turn/start") {
    send({ id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/started", params: { threadId: "unowned", turnId: "x" } });
    send({ method: "turn/started", params: { threadId: thread.id, turn: { id: "turn-1", status: "inProgress" } } });
    if (mode === "approval") send({ id: approvalId, method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: "turn-1", command: "echo fixture" } });
    continue;
  }
  send({ id, error: { code: -32601, message: "unknown method" } });
}
