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

Supported inbox methods are `binding`, `inbox_status`, `inbox_claim`, `inbox_show`, `events`, and `complete`. Host authorization, session binding, owner/epoch checks, delivery scope, and permission to reply remain with the private gateway. Inbox tokens may be returned in successful data so the caller can complete a claimed delivery; callers must keep those data and the private config out of logs. The client returns only bounded gateway JSON and safe error codes, never process stderr or the client token.

Validation is local and strict for supported methods and parameter names. Claimed inbox leases require the delivery identity, token and cursor bounds; event pages require a matching delivery and coherent cursor. The spawned client receives only a small host environment allowlist; coordinator bearer tokens and Node injection flags are not inherited. The gateway remains authoritative for live scope, lease, cursor range, and send policy. This package has synthetic process tests only; it does not establish SSH, desktop, or recipient acceptance.
