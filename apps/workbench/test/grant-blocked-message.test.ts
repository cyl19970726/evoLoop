import assert from "node:assert/strict";
import { test } from "node:test";
import { grantBlockText, grantBlockedNotice } from "../src/features/sessions/queuedMessagePresentation.ts";

const reason = "MESSAGE_GRANT_MISSING: 没有发送这条消息的授权：没有 user-sim → 这个 Session 的授权。在 sessionMessages.grants 加一项 {…}。";
const entry = (over: Record<string, unknown> = {}) => ({ kind: "message", role: "input", state: "pending", blockedReason: null, author: { id: "user-sim", label: "user-sim" }, ...over });

test("a message waiting only for its sender's grant is named, with the grant's own words and without the queue's code", () => {
  assert.match(grantBlockText(reason)!, /^没有发送这条消息的授权：没有 user-sim → 这个 Session 的授权。这个智能体还没有给你发消息的授权/);
  assert.doesNotMatch(grantBlockText(reason)!, /[{}]/, "no configuration text");
  assert.equal(grantBlockText("Waiting for one ready Task turn"), null);
  assert.equal(grantBlockText(null), null);
  const notice = grantBlockedNotice([entry({ blockedReason: reason }), entry({ blockedReason: reason, author: { id: "other", label: "other" } }), entry({ blockedReason: reason }),
    entry(), entry({ blockedReason: "Waiting for one ready Task turn" }), entry({ state: "completed", blockedReason: reason }), { kind: "tool" }, entry({ role: "assistant", blockedReason: reason })]);
  assert.deepEqual([notice?.count, notice?.senders], [3, ["user-sim", "other"]], "only pending input messages blocked by a grant count; each sender once");
  assert.match(notice!.reason, /^没有发送这条消息的授权/);
  assert.equal(grantBlockedNotice([entry(), entry({ blockedReason: "Waiting for one ready Task turn" })]), null, "no notice when nothing waits for a grant");
  assert.equal(grantBlockedNotice([]), null);
});

import { describeFailure, grantRefusalText } from "../src/shared/errorPresentation.ts";

// The answers the service gives an agent (send-authority.ts): the fix as a JSON example with this machine's working directory.
const example = '{"enabled":true,"projectId":"p","sessionId":"s","senderActorId":"user-sim","receiverActorId":"<接收方 Session 的业务身份>","receiverRoleId":"r","cwd":"/Users/gongshi006/.local/share/evoloop/workspaces/leader"}';
const serviceAnswers = [
  `没有发送这条消息的授权：私有配置 sessionMessages.grants 里没有 user-sim → 这个 Session（s）的授权。在 sessionMessages.grants 加一项 ${example}（使用时重读，不需要重启）。消息没有保存。`,
  `没有发送这条消息的授权：已有的授权与这个 Session 当前的职责或工作目录不一致（授权的职责/工作目录须是 r / /Users/gongshi006/.local/share/evoloop/workspaces/leader）。在 sessionMessages.grants 加一项 ${example}（使用时重读，不需要重启）。消息没有保存。`,
  "没有发送这条消息的授权：服务的私有配置里 sessionMessages 没有启用（sessionMessages.enabled）。消息没有保存。",
];

test("a refused send says one sentence of what is missing and who sets it up, with no configuration text and no local path; the code is the detail", () => {
  for (const answer of serviceAnswers) {
    const description = describeFailure(answer, "MESSAGE_GRANT_MISSING", 409);
    assert.match(description.text, /^没有发送这条消息的授权/);
    assert.match(description.text, /维护者/, "who sets it up");
    assert.match(description.text, /sessionMessages\.grants/, "where");
    assert.doesNotMatch(description.text, /[{}"]/, "no JSON");
    assert.doesNotMatch(description.text, /\/Users|\/srv|\/home|workspaces/, "no local path");
    assert.equal(description.detail, "MESSAGE_GRANT_MISSING", "the original code stays available in the expandable detail");
    assert.equal(description.detail!.includes("/"), false);
  }
  // The cause survives: which of the three things is missing.
  assert.match(grantRefusalText(serviceAnswers[0]!), /里没有 user-sim → 这个 Session/);
  assert.match(grantRefusalText(serviceAnswers[1]!), /与这个 Session 当前的职责或工作目录不一致/);
  assert.match(grantRefusalText(serviceAnswers[2]!), /sessionMessages\.enabled/);
  // A message that is not about a grant is untouched.
  assert.equal(describeFailure("服务暂时出错", "INTERNAL", 500).text, "服务暂时出错");
});

test("a queued message waiting for a grant shows the same sentence in its waiting reason, not the configuration text", () => {
  const stored = `MESSAGE_GRANT_MISSING: ${serviceAnswers[1]}`;
  const text = grantBlockText(stored)!;
  assert.doesNotMatch(text, /[{}"]|\/Users|workspaces/);
  assert.match(text, /维护者/);
});
