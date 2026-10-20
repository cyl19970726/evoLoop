import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { FeishuBitableConnector, type FeishuConfig } from "../src/index.js";
import type { ProjectionIntent } from "../../contracts/src/collaboration.js";

const fields = { entityId: "Evo ID", localVersion: "Evo Version", operationId: "Evo Op", title: "Title", status: "Status" };
const intent: ProjectionIntent = { entityId: "task-1", localVersion: 1, operationId: "op-1", title: "First task", status: "ready", deliveryState: "not-sent" };
interface Stored { record_id: string; fields: Record<string, unknown>; last_modified_time: string }

async function fixture() {
  const records = new Map<string, Stored>();
  const calls: { method: string; path: string; body: unknown; auth: string | undefined }[] = [];
  let tokenCount = 0;
  let failNextGetWith401 = false;
  let rateLimitNext = false;
  let loseCreateReply = false;
  let loseUpdateReply = false;
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    let text = ""; for await (const chunk of req) text += chunk.toString();
    try { return JSON.parse(text); } catch { return text; }
  };
  const json = (res: ServerResponse, code: number, payload: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(payload)); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    const body = await readBody(req);
    calls.push({ method: req.method ?? "", path: url.pathname + url.search, body, auth: req.headers.authorization });
    if (url.pathname === "/oauth/v3/token") { tokenCount++; json(res, 200, { code: 0, access_token: `token-${tokenCount}`, expires_in: 3600 }); return; }
    if (failNextGetWith401 && req.method === "GET") { failNextGetWith401 = false; json(res, 401, { code: 1 }); return; }
    if (rateLimitNext) { rateLimitNext = false; json(res, 429, { code: 1 }, { "retry-after": "3" }); return; }
    const base = "/open-apis/bitable/v1/apps/app/tables/table/records";
    if (url.pathname === base && req.method === "GET") {
      const offset = Number(url.searchParams.get("page_token") ?? 0);
      const all = [...records.values()]; const items = all.slice(offset, offset + 1);
      json(res, 200, { code: 0, data: { items, has_more: offset + 1 < all.length, page_token: offset + 1 < all.length ? String(offset + 1) : undefined } }); return;
    }
    if (url.pathname === base && req.method === "POST") {
      const input = body as { fields: Record<string, unknown> };
      const record: Stored = { record_id: `rec-${records.size + 1}`, fields: input.fields, last_modified_time: "100" };
      records.set(record.record_id, record);
      if (loseCreateReply) { loseCreateReply = false; req.socket.destroy(); return; }
      json(res, 200, { code: 0, data: { record } }); return;
    }
    if (url.pathname.startsWith(base + "/")) {
      const id = url.pathname.slice(base.length + 1); const record = records.get(id);
      if (!record) { json(res, 404, { code: 1 }); return; }
      if (req.method === "GET") { json(res, 200, { code: 0, data: { record } }); return; }
      if (req.method === "PUT") {
        Object.assign(record.fields, (body as { fields: Record<string, unknown> }).fields);
        record.last_modified_time = "101";
        if (loseUpdateReply) { loseUpdateReply = false; req.socket.destroy(); return; }
        json(res, 200, { code: 0, data: { record } }); return;
      }
    }
    json(res, 404, { code: 1 });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config: FeishuConfig = { appId: "app-id", appSecret: "fixture-secret", appToken: "app", tableId: "table", fields, apiBaseUrl: baseUrl, authUrl: `${baseUrl}/oauth/v3/token` };
  return { records, calls, config, get tokenCount() { return tokenCount; }, setFail401: () => { failNextGetWith401 = true; }, setRateLimit: () => { rateLimitNext = true; }, setLoseCreateReply: () => { loseCreateReply = true; }, setLoseUpdateReply: () => { loseUpdateReply = true; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("create, readback, update, and stable wire fields", async t => {
  const fx = await fixture(); t.after(fx.close);
  const connector = new FeishuBitableConnector(fx.config);
  const created = await connector.project(intent, null);
  assert.equal(created.state, "confirmed"); if (created.state !== "confirmed") return;
  assert.equal(created.binding.remoteRecordId, "rec-1");
  const createCall = fx.calls.find(call => call.method === "POST" && call.path.startsWith("/open-apis/bitable"));
  assert.deepEqual(createCall?.body, { fields: { "Evo ID": "task-1", "Evo Version": 1, "Evo Op": "op-1", Title: "First task", Status: "ready" } });
  assert.match(createCall?.path ?? "", /client_token=[0-9a-f-]+/);
  const updated = await connector.project({ ...intent, localVersion: 2, operationId: "op-2", title: "Changed" }, created.binding);
  assert.equal(updated.state, "confirmed");
  const updateCall = fx.calls.find(call => call.method === "PUT");
  assert.deepEqual(updateCall?.body, { fields: { "Evo Version": 2, "Evo Op": "op-2", Title: "Changed", Status: "ready" } });
  assert.equal(fx.tokenCount, 1);
});

test("lost create reply is found by stable key, without second POST", async t => {
  const fx = await fixture(); t.after(fx.close); fx.setLoseCreateReply();
  const connector = new FeishuBitableConnector(fx.config);
  assert.equal((await connector.project(intent, null)).state, "unknown");
  const recovered = await connector.project({ ...intent, deliveryState: "unknown" }, null);
  assert.equal(recovered.state, "confirmed");
  assert.equal(fx.calls.filter(call => call.method === "POST" && call.path.startsWith("/open-apis/bitable")).length, 1);
});

test("lost update reply is reconciled without a second PUT", async t => {
  const fx = await fixture(); t.after(fx.close);
  const connector = new FeishuBitableConnector(fx.config);
  const created = await connector.project(intent, null); assert.equal(created.state, "confirmed"); if (created.state !== "confirmed") return;
  const next: ProjectionIntent = { ...intent, localVersion: 2, operationId: "op-2", title: "Changed" };
  fx.setLoseUpdateReply();
  assert.equal((await connector.project(next, created.binding)).state, "unknown");
  assert.equal((await connector.project({ ...next, deliveryState: "unknown" }, created.binding)).state, "confirmed");
  assert.equal(fx.calls.filter(call => call.method === "PUT").length, 1);
});

test("pagination, rate limit, and token refresh on read", async t => {
  const fx = await fixture(); t.after(fx.close);
  fx.records.set("rec-1", { record_id: "rec-1", fields: { "Evo ID": "other" }, last_modified_time: "1" });
  fx.records.set("rec-2", { record_id: "rec-2", fields: { "Evo ID": "task-1", "Evo Version": 1, "Evo Op": "op-1", Title: "First task", Status: "ready" }, last_modified_time: "2" });
  const connector = new FeishuBitableConnector(fx.config);
  fx.setFail401();
  const page = await connector.listRemote(); assert.equal(page.records.length, 1); assert.equal(page.nextCursor, "1");
  assert.equal((await connector.listRemote(page.nextCursor)).records[0]?.entityId, "task-1");
  assert.equal(fx.tokenCount, 2);
  fx.setRateLimit();
  const result = await connector.reconcile(intent, null);
  assert.deepEqual(result, { state: "rate-limited", retryAfterSeconds: 3 });
});

test("incoming changes preserve actor evidence, baseline, and loop suppression", async t => {
  const fx = await fixture(); t.after(fx.close);
  const connector = new FeishuBitableConnector(fx.config);
  const created = await connector.project(intent, null); assert.equal(created.state, "confirmed"); if (created.state !== "confirmed") return;
  const record = (await connector.listRemote()).records[0]!;
  assert.equal(connector.incoming(record, created.binding, null).reviewOnly, true);
  const edited = { ...record, title: "Human edit" };
  const unauth = connector.incoming(edited, created.binding, null);
  assert.equal(unauth.reviewOnly, true); assert.deepEqual(unauth.patch, { title: "Human edit" });
  const actor = { platformUserId: "ou_1", projectActorId: "user-1", sourceEventId: "evt-1", verified: true };
  assert.equal(connector.incoming(edited, created.binding, actor).reviewOnly, false);
  assert.equal(connector.incoming({ ...edited, localVersion: 99 }, created.binding, actor).reviewOnly, true);
});

test("remote deletion and changed baseline never silently recreate or overwrite", async t => {
  const fx = await fixture(); t.after(fx.close);
  const connector = new FeishuBitableConnector(fx.config);
  const created = await connector.project(intent, null); assert.equal(created.state, "confirmed"); if (created.state !== "confirmed") return;
  fx.records.get("rec-1")!.fields.Title = "Remote edit";
  assert.equal((await connector.project({ ...intent, localVersion: 2, operationId: "op-2" }, created.binding)).state, "conflict");
  fx.records.delete("rec-1");
  assert.equal((await connector.project({ ...intent, localVersion: 2, operationId: "op-2" }, created.binding)).state, "conflict");
  assert.equal(fx.calls.filter(call => call.method === "POST" && call.path.startsWith("/open-apis/bitable")).length, 1);
});
