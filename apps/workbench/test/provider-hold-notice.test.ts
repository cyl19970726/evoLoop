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
  assert.match(notice!.text, /2 个会话受影响，3 条消息排队/, "only Sessions the hold touches are counted");
  assert.match(notice!.text, /账户使用者.*充值或重新授权/);
  assert.match(notice!.text, /runtime\.providerHold\.release.*版本 3/);
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
