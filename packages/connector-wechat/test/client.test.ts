import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { GatewayInputError, WechatGatewayClient, type GatewayMethod } from "../src/index.ts";

const executable = fileURLToPath(new URL("./gateway-fixture.mjs", import.meta.url));
chmodSync(executable, 0o755);
const cid = "0123456789abcdef0123456789abcdef";
const client = (allowedMethods: GatewayMethod[] = ["send_text", "result"], timeoutMs = 1000, mode = "ok") =>
  new WechatGatewayClient({ executable, configPath: `/synthetic/private/client-${mode}.json`, allowedMethods, timeoutMs });

test("allowlisted send and same original key result query", async () => {
  const gateway = client();
  const sent = await gateway.call("send_text", { conversation_id: cid, request_id: "notice-001", text: "Synthetic notice" });
  assert.equal(sent.state, "ok");
  assert.equal(sent.businessRequestId, "notice-001");
  assert.equal(sent.state === "ok" && sent.result.request_id, "fixture_app.notice-001");
  const queried = await gateway.call("result", { conversation_id: cid, request_id: "notice-001" });
  assert.equal(queried.state, "ok");
  assert.equal(queried.businessRequestId, sent.businessRequestId);
  assert.equal(queried.state === "ok" && queried.result.request_id, "fixture_app.notice-001");
});

test("deny method and excess or invalid params before process spawn", async () => {
  const gateway = client(["result"], 1000, "error");
  await assert.rejects(gateway.call("send_text", { conversation_id: cid, request_id: "n1", text: "x" }), GatewayInputError);
  await assert.rejects(gateway.call("result", { conversation_id: cid, request_id: "n1", owner: "unsafe" } as never), GatewayInputError);
  await assert.rejects(gateway.call("result", { conversation_id: "bad", request_id: "n1" }), GatewayInputError);
  await assert.rejects(gateway.call("result", { conversation_id: cid, request_id: "n1; echo x" }), GatewayInputError);
  await assert.rejects(gateway.call("send_image" as never, { conversation_id: cid } as never), GatewayInputError);
  await assert.rejects(client(["complete"]).call("complete", { conversation_id: cid, delivery_id: 1, token: "tok", decision: "reply" }), GatewayInputError);
  await assert.rejects(client(["events"]).call("events", { conversation_id: cid, delivery_id: 1, limit: 101 }), GatewayInputError);
});

test("transport errors remain unknown with original request key", async () => {
  for (const mode of ["timeout", "error", "oversize", "malformed", "unknown", "operation_failed", "response_too_large"]) {
    const outcome = await client(undefined, 100, mode).call("send_text", { conversation_id: cid, request_id: "same-key", text: "Synthetic" });
    assert.equal(outcome.state, "unknown", mode);
    assert.equal(outcome.businessRequestId, "same-key", mode);
  }
});

test("gateway refusals are explicit and do not echo private data", async () => {
  const outcome = await client(undefined, 1000, "reject").call("send_text", { conversation_id: cid, request_id: "n1", text: "Synthetic" });
  assert.deepEqual(outcome, { state: "rejected", method: "send_text", businessRequestId: "n1", correlationId: "fixture-correlation", code: "permission_denied" });
});

test("inbox methods validate scoped delivery and decision fields", async () => {
  const gateway = client(["binding", "inbox_claim", "events", "complete"]);
  assert.equal((await gateway.call("binding", { conversation_id: cid })).state, "ok");
  assert.equal((await gateway.call("inbox_claim", { conversation_id: cid, lease_seconds: 300 })).state, "ok");
  assert.equal((await gateway.call("events", { conversation_id: cid, delivery_id: 4, after: 0, limit: 50 })).state, "ok");
  assert.equal((await gateway.call("complete", { conversation_id: cid, delivery_id: 4, token: "lease-token", decision: "skip" })).state, "ok");
  await assert.rejects(gateway.call("inbox_claim", { conversation_id: cid, lease_seconds: 1 }), GatewayInputError);
  await assert.rejects(gateway.call("complete", { conversation_id: cid, delivery_id: 4, token: "lease-token", decision: "draft", text: "" }), GatewayInputError);
});

test("binding, inbox detail, and completion require exact saved identities",async()=>{
  for(const [method,mode,params] of [
    ["binding","missing_pin",{conversation_id:cid}],
    ["inbox_show","wrong_delivery",{conversation_id:cid,delivery_id:4}],
    ["inbox_show","missing_session",{conversation_id:cid,delivery_id:4}],
    ["complete","wrong_delivery",{conversation_id:cid,delivery_id:4,token:"lease-token",decision:"skip"}],
    ["complete","wrong_status",{conversation_id:cid,delivery_id:4,token:"lease-token",decision:"skip"}],
  ] as const){
    const outcome=await client([method],1000,mode).call(method,params);
    assert.equal(outcome.state,"unknown",`${method}/${mode}`);
  }
});

test("incomplete claimed leases and event pages cannot be consumed", async () => {
  const empty = await client(["inbox_claim"], 1000, "empty_claim").call("inbox_claim", { conversation_id: cid });
  assert.equal(empty.state, "ok");
  const missingToken = await client(["inbox_claim"], 1000, "missing_token").call("inbox_claim", { conversation_id: cid });
  assert.equal(missingToken.state, "unknown");
  const badRange = await client(["inbox_claim"], 1000, "bad_range").call("inbox_claim", { conversation_id: cid });
  assert.equal(badRange.state, "unknown");
  const missingCursor = await client(["events"], 1000, "missing_cursor").call("events", { conversation_id: cid, delivery_id: 4, after: 0 });
  assert.equal(missingCursor.state, "unknown");
  const badCursor = await client(["events"], 1000, "bad_cursor").call("events", { conversation_id: cid, delivery_id: 4, after: 0 });
  assert.equal(badCursor.state, "unknown");
});

test("a successful envelope with the wrong outbox key remains unknown", async () => {
  const outcome = await client(undefined, 1000, "wrong_id").call("result", { conversation_id: cid, request_id: "notice-001" });
  assert.equal(outcome.state, "unknown");
  assert.equal(outcome.businessRequestId, "notice-001");
});

test("gateway child does not inherit coordinator bearer credentials", async () => {
  const previous = process.env.EVOLOOP_TOKEN;
  process.env.EVOLOOP_TOKEN = "synthetic-secret";
  try {
    const outcome = await client(undefined, 1000, "env").call("result", { conversation_id: cid, request_id: "n1" });
    assert.equal(outcome.state, "ok");
    assert.equal(outcome.state === "ok" && outcome.result.leaked, null);
  } finally {
    if (previous === undefined) delete process.env.EVOLOOP_TOKEN;
    else process.env.EVOLOOP_TOKEN = previous;
  }
});

test("a process start failure is unknown and retains the query key", async () => {
  const gateway = new WechatGatewayClient({ executable: "/synthetic/missing-gateway-client", configPath: "/synthetic/private/client.json", allowedMethods: ["result"] });
  const outcome = await gateway.call("result", { conversation_id: cid, request_id: "notice-001" });
  assert.deepEqual(outcome, { state: "unknown", method: "result", businessRequestId: "notice-001", correlationId: null, reason: "process_error" });
});

test("transport status retains scoped owner, epoch, token and turn identity", async () => {
  for (const mode of ["ok", "recorded"]) {
    const outcome = await client(["transport_status"], 1000, mode).call("transport_status", { conversation_id: cid });
    assert.equal(outcome.state, "ok", mode);
    if (outcome.state !== "ok") continue;
    const row = (outcome.result.deliveries as Array<Record<string, unknown>>)[0];
    assert.equal(row.owner, "fixture-owner");
    assert.equal(row.epoch, 2);
    assert.equal(row.delivery_id, 4);
    assert.equal(row.transport_token, "private-transport-token");
    assert.equal(row.turn_id, mode === "recorded" ? "turn-1" : null);
  }
  for (const mode of ["wrong_conversation", "missing_owner", "bad_epoch", "missing_transport_token",
    "bad_turn_identity", "duplicate_delivery", "terminal_transport"]) {
    const outcome = await client(["transport_status"], 1000, mode).call("transport_status", { conversation_id: cid });
    assert.equal(outcome.state, "unknown", mode);
    assert.equal(outcome.state === "unknown" && outcome.reason, "response_unknown", mode);
  }
});

test("turn receipts require the requested delivery, turn and terminal state", async () => {
  const reserve = { conversation_id: cid, delivery_id: 4, token: "private-claim-token" };
  const recorded = { ...reserve, turn_id: "turn-1" };
  const finish = { ...reserve, status: "completed" as const };
  assert.equal((await client(["reserve_turn"]).call("reserve_turn", reserve)).state, "ok");
  assert.equal((await client(["reserve_turn"], 1000, "already_recorded").call("reserve_turn", reserve)).state, "ok");
  assert.equal((await client(["record_turn"]).call("record_turn", recorded)).state, "ok");
  assert.equal((await client(["finish_turn"]).call("finish_turn", finish)).state, "ok");
  for (const [method, params, mode] of [
    ["reserve_turn", reserve, "wrong_delivery"], ["reserve_turn", reserve, "missing_session"],
    ["reserve_turn", reserve, "bad_reservation"], ["record_turn", recorded, "wrong_delivery"],
    ["record_turn", recorded, "wrong_turn"], ["record_turn", recorded, "missing_thread"],
    ["finish_turn", finish, "wrong_delivery"], ["finish_turn", finish, "wrong_status"]
  ] as const) {
    const outcome = await client([method], 1000, mode).call(method, params);
    assert.equal(outcome.state, "unknown", `${method}/${mode}`);
    assert.equal(outcome.state === "unknown" && outcome.reason, "response_unknown", `${method}/${mode}`);
  }
});

test("turn methods reject invalid local fields and preserve unknown mutations", async () => {
  const reserve = { conversation_id: cid, delivery_id: 4, token: "private-claim-token" };
  await assert.rejects(client(["reserve_turn"], 1000, "error").call("reserve_turn", { ...reserve, owner: "extra" } as never), GatewayInputError);
  await assert.rejects(client(["reserve_turn"], 1000, "error").call("reserve_turn", { ...reserve, token: "" }), GatewayInputError);
  await assert.rejects(client(["record_turn"], 1000, "error").call("record_turn", { ...reserve, turn_id: "bad turn" }), GatewayInputError);
  await assert.rejects(client(["finish_turn"], 1000, "error").call("finish_turn", { ...reserve, status: "pending" } as never), GatewayInputError);
  await assert.rejects(client(["result"], 1000, "error").call("reserve_turn", reserve), GatewayInputError);
  for (const method of ["reserve_turn", "record_turn", "finish_turn"] as const) {
    const params = method === "record_turn" ? { ...reserve, turn_id: "turn-1" }
      : method === "finish_turn" ? { ...reserve, status: "completed" as const } : reserve;
    for (const mode of ["timeout", "unknown"]) {
      const outcome = await client([method], 100, mode).call(method, params);
      assert.equal(outcome.state, "unknown", `${method}/${mode}`);
      assert.equal(outcome.businessRequestId, null);
    }
  }
});
