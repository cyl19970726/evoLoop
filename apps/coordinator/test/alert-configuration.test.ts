import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadIntegrations } from "../src/configuration.js";
import { buildAlert } from "../src/ops-alerts/message.js";
import { sendAlert } from "../src/ops-alerts/outlet.js";

const load = async (alerts: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), "alert-config-"));
  try { const file = join(dir, "integrations.json"); await writeFile(file, JSON.stringify({ alerts })); return await loadIntegrations(file); } finally { await rm(dir, { recursive: true, force: true }); }
};

test("the alert outlet is private configuration: a webhook or an absolute local command, with bounded numbers and defaults", async () => {
  const hook = (await load({ enabled: true, outlet: { kind: "webhook", url: "https://hooks.example.test/x", headers: { authorization: "Bearer t" } } })).alerts!;
  assert.deepEqual([hook.pollIntervalMs, hook.stallMinutes, hook.outlet.kind], [15000, 30, "webhook"], "defaults: poll every 15 s, stall after 30 minutes");
  assert.equal((hook.outlet as { timeoutMs: number }).timeoutMs, 5000);
  const command = (await load({ enabled: true, stallMinutes: 45, outlet: { kind: "command", argv: ["/usr/local/bin/notify", "--urgent"] } })).alerts!;
  assert.equal(command.stallMinutes, 45);
  assert.equal((await load(undefined)).alerts, undefined, "off unless configured");
  for (const bad of [
    { enabled: true, outlet: { kind: "command", argv: ["notify"] } },                           // not an absolute path
    { enabled: true, outlet: { kind: "webhook", url: "file:///etc/passwd" } },                  // not http(s)
    { enabled: true, outlet: { kind: "webhook", url: "ftp://x.example.test/" } },
    { enabled: true, stallMinutes: 0, outlet: { kind: "webhook", url: "https://x.example.test/" } },
    { enabled: true, pollIntervalMs: 10, outlet: { kind: "webhook", url: "https://x.example.test/" } },
    { enabled: true, outlet: { kind: "webhook", url: "https://x.example.test/", extra: 1 } },
    { enabled: true },
  ]) await assert.rejects(load(bad), /Invalid integration configuration/, JSON.stringify(bad));
});

test("the message names what happened, since when, who is affected and what waits; provider text is redacted and cut; stall and recovery read plainly", () => {
  const opened = buildAlert({ projectId: "p", key: "hold:1", kind: "provider_hold", event: "opened", openedAt: "2026-11-13T05:23:00.000Z", resolvedAt: null,
    details: { provider: "claude", category: "authentication_failed", reason: `401 token=abcdef123456 at /Users/x/secret ${"y".repeat(400)}`, pending: { ready: 2, queued: 1, awaitingAcceptance: 3 },
      sessions: [{ sessionId: "11111111-2222-3333-4444-555555555555", role: "功能开发" }], sessionTotal: 9 } });
  assert.match(opened.text, /Claude 提供方已暂停（认证失败）/); assert.match(opened.text, /2026-11-13T05:23:00.000Z/);
  assert.match(opened.text, /9 个 Session 受影响：功能开发（11111111） 等另外 8 个/); assert.match(opened.text, /压着 6 件活（就绪未派 2，在队伍里排队 1，等验收 3）/);
  assert.doesNotMatch(opened.text, /abcdef123456|\/Users\/x/, "secrets and paths in the provider's text are redacted");
  assert.ok(opened.text.length < 700, "short enough for a chat message");
  const resolved = buildAlert({ projectId: "p", key: "hold:1", kind: "provider_hold", event: "resolved", openedAt: "2026-11-13T05:23:00.000Z", resolvedAt: "2026-11-14T15:55:00.000Z", details: { provider: "codex", releasedBy: "lead", releaseReason: "balance restored" } });
  assert.match(resolved.text, /Codex 提供方已放行，共暂停 34 小时 32 分钟/);
  const stall = buildAlert({ projectId: "p", key: "stall:x", kind: "stall", event: "opened", openedAt: "2026-11-14T10:00:00.000Z", resolvedAt: null, details: { stallMinutes: 30, lastRunAt: null, pending: { ready: 1, queued: 0, awaitingAcceptance: 0 } } });
  assert.match(stall.text, /项目里还没有 Run/);
});

test("the outlet never throws, never copies the address or the answer into its result, and does not follow a redirect", async () => {
  const message = buildAlert({ projectId: "p", key: "k", kind: "stall", event: "opened", openedAt: "2026-11-14T10:00:00.000Z", resolvedAt: null, details: {} });
  const seen: Array<{ redirect?: string }> = [];
  const result = await sendAlert({ kind: "webhook", url: "https://secret-host.example.test/token-in-path", headers: {}, timeoutMs: 500 }, message,
    (async (_url: unknown, init: { redirect?: string }) => { seen.push(init); throw Object.assign(new Error("connect ECONNREFUSED https://secret-host.example.test/token-in-path"), { name: "TypeError" }); }) as never);
  assert.deepEqual(result, { ok: false, error: "request failed: TypeError" });
  assert.equal(seen[0]?.redirect, "error");
  const timed = await sendAlert({ kind: "webhook", url: "https://x.example.test/", headers: {}, timeoutMs: 500 }, message, (async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); }) as never);
  assert.deepEqual(timed, { ok: false, error: "timed out" });
  assert.deepEqual(await sendAlert({ kind: "webhook", url: "https://x.example.test/", headers: {}, timeoutMs: 500 }, message, (async () => new Response("body with a token", { status: 503 })) as never), { ok: false, error: "HTTP 503" });
});
