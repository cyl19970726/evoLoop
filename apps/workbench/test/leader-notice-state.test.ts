import assert from "node:assert/strict";
import test from "node:test";
import type { LeaderNotice } from "@evoloop/contracts/leader-notices";
import { noticeState } from "../src/features/workflow/TaskArrangement.tsx";

const base = { id: "n", projectId: "p", kind: "task_todo", sourceEventId: "e", taskId: "t", taskRevisionId: "r", sourceSessionId: null, sourceActorId: null, sourceRef: "s",
  occurredAt: "2026-11-11T00:00:00Z", state: "linked", messageId: "m", operationId: "o", linkedSessionId: "s", blockedReason: null, stale: false, messageState: null,
  messageBlockedReason: null, processingState: null, nativeTurnId: null, readAt: null, updatedAt: "2026-11-11T00:00:00Z", viaPacket: true } as unknown as LeaderNotice;
const inPacket = (itemState: string, extra: Record<string, unknown> = {}, packetState = "sent"): LeaderNotice =>
  ({ ...base, packet: { packetId: "pk", packetState, itemState, readBefore: false, disposition: null, deferUntil: null, withdrawnReason: null, itemVersion: 1, ...extra } }) as LeaderNotice;

test("a packet notice never says its own unused message was saved and not yet received", () => {
  const states = [inPacket("pending"), inPacket("delivered"), inPacket("seen"), inPacket("handled", { disposition: "handled" }),
    inPacket("handled", { disposition: "deferred", deferUntil: "2026-11-12T00:00:00Z" }), inPacket("withdrawn", { withdrawnReason: "TODO_SOURCE_SUPERSEDED" }),
    inPacket("unknown", {}, "blocked"), inPacket("unknown", {}, "unknown"), inPacket("unknown", { readBefore: true }, "returned"), { ...base, packet: null } as LeaderNotice];
  for (const item of states) assert.doesNotMatch(noticeState(item), /已保存给统筹的消息，还没有核到接收/);
});

test("each packet state is named in the workbench's words", () => {
  assert.match(noticeState(inPacket("pending")), /已并入通知包/);
  assert.match(noticeState(inPacket("delivered")), /开始读这包/);
  assert.match(noticeState(inPacket("seen")), /已看到.*还没有处置/);
  assert.match(noticeState(inPacket("handled", { disposition: "handled" })), /已处理/);
  assert.match(noticeState(inPacket("handled", { disposition: "deferred", deferUntil: "2026-11-12T00:00:00Z" })), /已延后/);
  assert.match(noticeState(inPacket("withdrawn", { withdrawnReason: "TODO_SOURCE_SUPERSEDED" })), /已撤回，没有送达.*TODO_SOURCE_SUPERSEDED/);
  assert.match(noticeState(inPacket("withdrawn", { withdrawnReason: "HUMAN_MESSAGE_FIRST" })), /有人的消息先送/);
  assert.match(noticeState(inPacket("unknown", {}, "blocked")), /受阻.*恢复/);
  assert.match(noticeState(inPacket("unknown", { readBefore: true }, "returned")), /下一包重送.*上一轮可能已读到过/);
  assert.match(noticeState({ ...base, packet: null } as LeaderNotice), /等待并入通知包/);
});

test("a notice from before packets keeps its one-notice-one-message wording", () => {
  assert.match(noticeState({ ...base, viaPacket: false } as LeaderNotice), /已保存给统筹的消息，还没有核到接收/);
});
