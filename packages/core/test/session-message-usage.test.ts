import assert from "node:assert/strict";
import test from "node:test";
import { SessionMessageService } from "../src/session-messages/index.ts";

test("a settled Claude message records cache reads and cache creation inside ledger input", async () => {
  const projectId = "00000000-0000-4000-8000-000000000001";
  const sessionId = "00000000-0000-4000-8000-000000000002";
  const messageId = "00000000-0000-4000-8000-000000000003";
  const processing = { projectId, sessionId, messageId, nativeTurnId: "turn-1", state: "running", version: 1 };
  const message = { state: "processing", version: 1 };
  const added: unknown[][] = [];
  const tx = {
    sessionMessages: {
      getSessionMessageProcessing: async () => processing,
      updateSessionMessageProcessing: async (next: object) => Object.assign(processing, next),
      getSessionMessage: async () => message,
      updateSessionMessage: async (next: object) => Object.assign(message, next),
      markSessionMessageSettled: async () => {},
    },
    getRuntimeSession: async () => ({ runtimeProvider: "claude" }),
    usage: { addUsage: async (...args: unknown[]) => { added.push(args); } },
  };
  const service = new SessionMessageService({
    uow: { transaction: async (_projectId: string, action: (value: unknown) => Promise<unknown>) => action(tx) },
    clock: { now: () => "2026-11-13T01:00:00.000Z" },
    ids: { next: () => "00000000-0000-4000-8000-000000000004" },
    grantFor: async () => null,
  } as never);
  await service.settle(projectId, messageId, {
    id: "turn-1",
    status: "completed",
    completedAtUtc: "2026-11-13T00:59:00.000Z",
    usage: { inputTokens: 1_000, outputTokens: 500, cacheReadInputTokens: 8_000, cacheCreationInputTokens: 2_000 },
  } as never, "done");
  assert.deepEqual(added, [[projectId, sessionId, "2026-11-13",
    { inputTokens: 11_000, outputTokens: 500, cachedInputTokens: 10_000, costUsd: 0, costReported: false }]]);
});
