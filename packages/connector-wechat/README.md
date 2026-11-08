# @evoloop/connector-wechat

Standalone provider boundary for the fixed wx-cli `wx-agent-gateway-client` command. The trusted host supplies an absolute executable path, an absolute private client config path, and an explicit method allowlist. The package runs one command per call with JSON parameters on stdin. It does not run a shell, start a dispatcher, send on its own, or retry.

```ts
import { WechatGatewayClient } from "@evoloop/connector-wechat";

const gateway = new WechatGatewayClient({
  executable: "/ABS/bin/wx-agent-gateway-client",
  configPath: "/ABS/private/gateway-client.json",
  allowedMethods: ["send_text", "result"]
});
const sent = await gateway.call("send_text", {
  conversation_id: "0123456789abcdef0123456789abcdef",
  request_id: "notice-001", text: "Synthetic notice"
});
const status = await gateway.call("result", {
  conversation_id: "0123456789abcdef0123456789abcdef",
  request_id: "notice-001"
});
```

`send_text` and `result` take the **same original local request ID**. The upstream application namespace is applied by wx-cli, and `businessRequestId` in every outcome retains the local ID. The command creates its own correlation ID; only a parsed response can provide `correlationId`. On timeout, process failure, invalid or oversized output, or gateway `result_unknown`, `operation_failed`, or `response_too_large`, the outcome is `unknown`. Inspect `result` with the original local ID before any further action. `pending` and `ui_observed` do not prove recipient receipt.

Supported inbox methods are `binding`, `inbox_status`, `inbox_claim`, `inbox_show`, `transport_status`, `reserve_turn`, `record_turn`, `finish_turn`, `events`, and `complete`. `binding` must return a non-empty `owner_session_ref` and `thread_id`; `inbox_show` must echo the requested delivery, owner, epoch, session and cursor range; `complete` must echo the requested delivery and its terminal inbox status. The four turn transport methods use the fixed gateway parameters: `transport_status` takes `conversation_id`; `reserve_turn` takes `conversation_id`, `delivery_id`, and the claim `token`; `record_turn` adds `turn_id` and uses the returned `transport_token`; `finish_turn` uses the transport token and a `completed`, `interrupted`, or `failed` status. The host still supplies an explicit method allowlist. This package does not start a turn or coordinate one.

`transport_status` validates each projected row's conversation, unique delivery ID, owner, epoch, session, transport token, and reserved or recorded turn identity. The upstream gateway intentionally lists only active `reserved|recorded` transports; `completed|interrupted|failed` are terminal ledger states read from the original `inbox_show`, so their absence from this list is not proof that finishing failed. A reserved row has null thread and turn IDs; a recorded row has both. Turn mutation receipts are checked against the requested delivery ID, `record_turn` turn ID, and `finish_turn` status. The fixed mutation receipts omit owner, epoch, transport token and, for `finish_turn`, turn ID; use the original delivery and its terminal `inbox_show` identity to reconcile uncertain mutations. An `already_reserved` receipt may report a later turn state and is not proof of a new reservation. Host authorization, session binding, owner/epoch checks, delivery scope, and permission to reply remain with the private gateway. Never log claim or transport tokens, successful data containing them, or the private config.

Validation is local and strict for supported methods and parameter names. Claimed inbox leases require the delivery identity, token and cursor bounds; event pages require a matching delivery and coherent cursor. A timeout, gateway `result_unknown`, malformed receipt, or identity mismatch remains `unknown`; query the original delivery via `transport_status` before deciding what happened. The spawned client receives only a small host environment allowlist; coordinator bearer tokens and Node injection flags are not inherited. The gateway remains authoritative for live scope, lease, cursor range, and send policy. This package has synthetic process tests only; it does not establish SSH, desktop, or recipient acceptance.
