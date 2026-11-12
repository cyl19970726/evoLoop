import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderHoldListing, ProviderHoldView } from "@evoloop/contracts/provider-hold";
import { providerHoldNotices } from "../src/app/providerHoldNotice.ts";

const hold = (over: Partial<ProviderHoldView> = {}): ProviderHoldView => ({ projectId: "p", id: "h", provider: "codex", state: "held",
  category: "quota_exhausted", causeSessionId: "s1", causeMessageId: "m1", reason: "x", version: 3, openedAt: "2026-11-11T02:03:00.000Z",
  releasedAt: null, releasedBy: null, releaseReason: null, releaseSummary: null,
  impact: [{ sessionId: "s1", gatePhase: "blocked", blockedByQuotaFailure: true, queuedMessages: 0 },
    { sessionId: "s2", gatePhase: "open", blockedByQuotaFailure: false, queuedMessages: 3 },
    { sessionId: "s3", gatePhase: "open", blockedByQuotaFailure: false, queuedMessages: 0 }], queuedMessages: 3, ...over });
const listing = (...items: ProviderHoldView[]): ProviderHoldListing => ({ items, observedAtUtc: "2026-11-11T03:00:00.000Z" });

test("a held provider shows one blocking notice with who acts, what waits and how to release", () => {
  const [notice] = providerHoldNotices(listing(hold()), "/p/sessions");
  assert.equal(notice!.tone, "error");
  assert.match(notice!.text, /运行受阻.*Codex.*额度不足或欠费.*已暂停它的新 Turn/);
  assert.match(notice!.text, /2 个会话受影响（.*），3 条消息排队/, "only Sessions the hold touches are counted");
  assert.match(notice!.text, /账户使用者.*充值或重新授权/);
  assert.match(notice!.text, /runtime\.providerHold\.release.*暂停编号 h.*版本 3/);
  assert.equal(notice!.link?.href, "/p/sessions");
});

test("an authentication hold says so, each provider gets its own notice, and a released hold shows nothing", () => {
  const notices = providerHoldNotices(listing(hold({ category: "authentication_failed" }), hold({ provider: "claude", id: "h2" }),
    hold({ id: "h3", state: "released", provider: "codex" })), "/p/sessions");
  assert.equal(notices.length, 2);
  assert.match(notices[0]!.text, /Codex 鉴权失败/);
  assert.match(notices[1]!.text, /Claude/);
  assert.deepEqual(notices.map(n => n.key), ["provider-hold:codex", "provider-hold:claude"]);
});

test("no read yet, or nothing held, shows no notice", () => {
  assert.deepEqual(providerHoldNotices(undefined, "/p/sessions"), []);
  assert.deepEqual(providerHoldNotices(listing(), "/p/sessions"), []);
});

test("the notice lists the affected Sessions by name when known, by identifier otherwise, and only those the hold touches", () => {
  const names: Record<string, string> = { s1: "统筹", s2: "前端实现" };
  const [named] = providerHoldNotices(listing(hold()), "/p/sessions", id => names[id]);
  assert.match(named!.text, /2 个会话受影响（统筹、前端实现）/);
  const [plain] = providerHoldNotices(listing(hold()), "/p/sessions");
  assert.match(plain!.text, /会话 s1、会话 s2/);
  assert.doesNotMatch(plain!.text, /s3/, "a Session the hold does not touch is not listed");
  const many = hold({ impact: Array.from({ length: 7 }, (_, index) => ({ sessionId: `session-${index}`, gatePhase: "blocked", blockedByQuotaFailure: true, queuedMessages: 0 })) });
  assert.match(providerHoldNotices(listing(many), "/p/sessions")[0]!.text, /等 7 个/);
});

test("an unreadable hold list says the state is unknown, and tells the service's failure from a lost connection", async () => {
  const { providerHoldReadFailure } = await import("../src/app/providerHoldNotice.ts");
  const fail = (status: number | null) => providerHoldReadFailure(Object.assign(new Error("x"), status === null ? {} : { status }), "/p/sessions");
  assert.match(fail(503).text, /服务出错（HTTP 503）/); assert.doesNotMatch(fail(503).text, /连接中断/, "a 5xx is the service's failure, not a lost connection");
  assert.match(fail(0).text, /连接中断或超时/);
  assert.match(fail(403).text, /读取被拒绝/);
  for (const status of [503, 0, 403, null]) { assert.match(fail(status).text, /这不表示没有暂停/); assert.equal(fail(status).tone, "waiting"); }
});
