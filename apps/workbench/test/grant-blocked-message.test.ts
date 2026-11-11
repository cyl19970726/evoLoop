import assert from "node:assert/strict";
import { test } from "node:test";
import { grantBlockText, grantBlockedNotice } from "../src/features/sessions/queuedMessagePresentation.ts";

const reason = "MESSAGE_GRANT_MISSING: 没有发送这条消息的授权：没有 user-sim → 这个 Session 的授权。在 sessionMessages.grants 加一项 {…}。";
const entry = (over: Record<string, unknown> = {}) => ({ kind: "message", role: "input", state: "pending", blockedReason: null, author: { id: "user-sim", label: "user-sim" }, ...over });

test("a message waiting only for its sender's grant is named, with the grant's own words and without the queue's code", () => {
  assert.equal(grantBlockText(reason), "没有发送这条消息的授权：没有 user-sim → 这个 Session 的授权。在 sessionMessages.grants 加一项 {…}。");
  assert.equal(grantBlockText("Waiting for one ready Task turn"), null);
  assert.equal(grantBlockText(null), null);
  const notice = grantBlockedNotice([entry({ blockedReason: reason }), entry({ blockedReason: reason, author: { id: "other", label: "other" } }), entry({ blockedReason: reason }),
    entry(), entry({ blockedReason: "Waiting for one ready Task turn" }), entry({ state: "completed", blockedReason: reason }), { kind: "tool" }, entry({ role: "assistant", blockedReason: reason })]);
  assert.deepEqual([notice?.count, notice?.senders], [3, ["user-sim", "other"]], "only pending input messages blocked by a grant count; each sender once");
  assert.match(notice!.reason, /^没有发送这条消息的授权/);
  assert.equal(grantBlockedNotice([entry(), entry({ blockedReason: "Waiting for one ready Task turn" })]), null, "no notice when nothing waits for a grant");
  assert.equal(grantBlockedNotice([]), null);
});
