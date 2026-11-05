#!/usr/bin/env node
// Synthetic one-shot gateway-client command. It never contacts wx-cli.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const params = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const method = process.argv[4];
const mode = /client-([a-z_]+)\.json$/.exec(process.argv[3] ?? "")?.[1];
if (mode === "timeout") setTimeout(() => {}, 60_000);
else if (mode === "error") process.exit(2);
else if (mode === "oversize") process.stdout.write("x".repeat(1024 * 1024 + 1));
else if (mode === "malformed") process.stdout.write("not json");
else if (mode === "env") process.stdout.write(JSON.stringify({ protocol_version: 1, id: "fixture-correlation", ok: true,
  result: { application_id: "fixture_app", conversation_id: params.conversation_id, request_id: `fixture_app.${params.request_id}`, leaked: process.env.EVOLOOP_TOKEN ?? null } }));
else if (mode === "empty_claim" && method === "inbox_claim") {
  process.stdout.write(JSON.stringify({ protocol_version: 1, id: "fixture-correlation", ok: true,
    result: { status: "empty" } }));
} else if (mode === "reject" || mode === "operation_failed" || mode === "response_too_large") {
  process.stdout.write(JSON.stringify({ protocol_version: 1, id: "fixture-correlation", ok: false,
    error: { code: mode === "reject" ? "permission_denied" : mode } }));
  process.exitCode = 1;
} else if (mode === "unknown") {
  process.stdout.write(JSON.stringify({ protocol_version: 1, id: "fixture-correlation", ok: false, error: { code: "result_unknown" } }));
  process.exitCode = 1;
} else {
  const result = { application_id: "fixture_app", conversation_id: params.conversation_id, ...(params.delivery_id ? { delivery_id: params.delivery_id } : {}),
    ...(params.request_id ? { request_id: `fixture_app.${mode === "wrong_id" ? "other" : params.request_id}` } : {}), status: "pending" };
  if (method === "transport_status") {
    const row = { delivery_id: 4, conversation_id: params.conversation_id, owner: "fixture-owner", epoch: 2,
      status: "claimed", turn_state: mode === "recorded" ? "recorded" : "reserved",
      session_ref: "codex:host:fixture", thread_id: mode === "recorded" ? "thread-1" : null,
      turn_id: mode === "recorded" ? "turn-1" : null, transport_token: "private-transport-token" };
    if (mode === "wrong_conversation") row.conversation_id = "f".repeat(32);
    if (mode === "missing_owner") delete row.owner;
    if (mode === "bad_epoch") row.epoch = 0;
    if (mode === "missing_transport_token") delete row.transport_token;
    if (mode === "bad_turn_identity") row.turn_id = "turn-1";
    Object.keys(result).forEach(key => delete result[key]);
    Object.assign(result, { conversation_id: params.conversation_id, deliveries: mode === "duplicate_delivery" ? [row, row] : [row] });
  }
  if (method === "reserve_turn") {
    Object.keys(result).forEach(key => delete result[key]);
    Object.assign(result, { delivery_id: params.delivery_id, turn_state: mode === "already_recorded" ? "recorded" : "reserved",
      session_ref: "codex:host:fixture", already_reserved: mode === "already_recorded" });
    if (mode === "wrong_delivery") result.delivery_id += 1;
    if (mode === "missing_session") delete result.session_ref;
    if (mode === "bad_reservation") result.turn_state = "recorded";
  }
  if (method === "record_turn") {
    Object.keys(result).forEach(key => delete result[key]);
    Object.assign(result, { delivery_id: params.delivery_id, turn_state: "recorded", thread_id: "thread-1", turn_id: params.turn_id });
    if (mode === "wrong_delivery") result.delivery_id += 1;
    if (mode === "wrong_turn") result.turn_id = "other-turn";
    if (mode === "missing_thread") delete result.thread_id;
  }
  if (method === "finish_turn") {
    Object.keys(result).forEach(key => delete result[key]);
    Object.assign(result, { delivery_id: params.delivery_id, turn_state: params.status });
    if (mode === "wrong_delivery") result.delivery_id += 1;
    if (mode === "wrong_status") result.turn_state = "failed";
  }
  if (method === "inbox_claim") Object.assign(result, { status: "claimed", delivery_id: 4,
    owner: "fixture-owner", epoch: 1, token: mode === "missing_token" ? undefined : "synthetic-lease",
    cursor_start: 2, cursor_end: mode === "bad_range" ? 1 : 3 });
  if (method === "events") Object.assign(result, { events: [{ cursor: mode === "bad_cursor" ? 3 : 1 }],
    next_cursor: mode === "missing_cursor" ? undefined : 1, has_more: false });
  process.stdout.write(JSON.stringify({ protocol_version: 1, id: "fixture-correlation", ok: true, result }));
}
