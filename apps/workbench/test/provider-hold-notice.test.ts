import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderHoldListing, ProviderHoldView } from "@evoloop/contracts/provider-hold";
import { holdFacts, holdIdentifiers, holdIsHere, holdLine, holdSummary, holdTarget } from "../src/shared/providerHoldPresentation.ts";
import { providerHoldReadFailure } from "../src/app/providerHoldNotice.ts";

const hold = (over: Partial<ProviderHoldView> = {}): ProviderHoldView => ({ projectId: "p", id: "h", provider: "codex", state: "held",
  category: "quota_exhausted", causeSessionId: "s1", causeMessageId: "m1", reason: "x", version: 3, openedAt: "2026-11-11T02:03:00.000Z",
  releasedAt: null, releasedBy: null, releaseReason: null, releaseSummary: null,
  impact: [{ sessionId: "s1", gatePhase: "blocked", blockedByQuotaFailure: true, queuedMessages: 0 },
    { sessionId: "s2", gatePhase: "open", blockedByQuotaFailure: false, queuedMessages: 3 },
    { sessionId: "s3", gatePhase: "open", blockedByQuotaFailure: false, queuedMessages: 0 }], queuedMessages: 3, ...over });
const listing = (...items: ProviderHoldView[]): ProviderHoldListing => ({ items, observedAtUtc: "2026-11-11T03:00:00.000Z" });

test("a held provider is one plain line: who is stopped, what the person does, no command name, hold number or version", () => {
  const summary = holdSummary(listing(hold()))!;
  assert.deepEqual(summary.sessionIds, ["s1", "s2"], "only Sessions the hold touches are counted");
  assert.equal(holdLine(summary, "统筹"), "模型服务 Codex 额度用完，统筹 等 2 个智能体停着：需要你充值或重新授权");
  assert.doesNotMatch(holdLine(summary, "统筹"), /runtime\.providerHold|暂停编号|版本|\bh\b/);
  assert.equal(holdLine(holdSummary(listing(hold({ impact: [hold().impact[0]!] })))!, "统筹"), "模型服务 Codex 额度用完，统筹停着：需要你充值或重新授权");
  assert.match(holdLine(summary), /^模型服务 Codex 额度用完，2 个智能体停着/, "without a name the count still says who");
});

test("an authentication hold says so; each provider is named; a Session under two holds counts once; released or unread shows nothing", () => {
  const summary = holdSummary(listing(hold({ category: "authentication_failed" }), hold({ provider: "claude", id: "h2" }), hold({ id: "h3", state: "released" })))!;
  assert.equal(summary.holds.length, 2);
  assert.match(holdLine(summary, "统筹"), /Codex 鉴权失败、Claude 额度用完，统筹 等 2 个智能体停着/);
  assert.equal(summary.sessionIds.length, 2, "s1 and s2 are under both holds and counted once: the line's number is the list's row count");
  assert.equal(holdSummary(undefined), null);
  assert.equal(holdSummary(listing()), null);
  assert.equal(holdSummary(listing(hold({ state: "released" }))), null);
});

test("the link goes to the one affected agent, else to 待我处理; the page turns it red only on an affected agent's own page", () => {
  const several = holdSummary(listing(hold()))!;
  const one = holdSummary(listing(hold({ impact: [hold().impact[0]!] })))!;
  assert.equal(holdTarget("p", several), "/p/p/inbox");
  assert.equal(holdTarget("p", one), "/p/p/sessions?session=owned%3As1");
  assert.equal(holdIsHere(several, { section: "sessions", session: "owned:s2" }), true);
  assert.equal(holdIsHere(several, { section: "sessions", session: "owned:s3" }), false, "a Session the hold does not touch stays neutral");
  assert.equal(holdIsHere(several, { section: "work" }), false);
  assert.equal(holdIsHere(several, { section: "sessions" }), false);
  assert.equal(holdTarget("p", holdSummary(listing(hold({ impact: [] })))!), "/p/p/inbox", "a hold with no affected Session still has a place to go");
  assert.match(holdLine(holdSummary(listing(hold({ impact: [] })))!), /新的运行已暂停/);
});

test("the source layer carries hold number, version and the release command; the full facts are told in words", () => {
  const summary = holdSummary(listing(hold()))!;
  const rows = holdIdentifiers(summary);
  assert.deepEqual(rows.map(row => row.value), ["h", "3", "runtime.providerHold.release"]);
  assert.match(holdFacts(summary.holds[0]!), /Codex 额度用完.*已暂停它的新 Turn.*2 个智能体受影响.*3 条消息排队.*充值或重新授权.*复核者一次放行/);
});

test("an unreadable hold list says the state is unknown, and tells the service's failure from a lost connection", () => {
  const fail = (status: number | null) => providerHoldReadFailure(Object.assign(new Error("x"), status === null ? {} : { status }), "/p/sessions");
  assert.match(fail(503).text, /服务出错（HTTP 503）/); assert.doesNotMatch(fail(503).text, /连接中断/, "a 5xx is the service's failure, not a lost connection");
  assert.match(fail(0).text, /连接中断或超时/);
  assert.match(fail(403).text, /读取被拒绝/);
  for (const status of [503, 0, 403, null]) { assert.match(fail(status).text, /这不表示没有暂停/); assert.equal(fail(status).tone, "waiting"); }
});
