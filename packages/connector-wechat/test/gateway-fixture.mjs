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
  if (method === "inbox_claim") Object.assign(result, { status: "claimed", delivery_id: 4,
    owner: "fixture-owner", epoch: 1, token: mode === "missing_token" ? undefined : "synthetic-lease",
    cursor_start: 2, cursor_end: mode === "bad_range" ? 1 : 3 });
  if (method === "events") Object.assign(result, { events: [{ cursor: mode === "bad_cursor" ? 3 : 1 }],
    next_cursor: mode === "missing_cursor" ? undefined : 1, has_more: false });
  process.stdout.write(JSON.stringify({ protocol_version: 1, id: "fixture-correlation", ok: true, result }));
}
