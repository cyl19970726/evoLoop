import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeHistoryItem } from "@evoloop/contracts/runtime";
import { TurnLedger } from "../src/ledger.js";

/**
 * Regression for the post-release check 5c0f5f77: the real CLI streams the closing answer as an assistant text block (recorded
 * as commentary) and repeats it as the result (recorded as the final answer), so every completed Claude Turn showed its reply
 * twice. The ledger read keeps one item per answer, also for ledgers written before the fix.
 */
const project = "00000000-0000-4000-8000-000000000001", session = "00000000-0000-4000-8000-000000000002";
const at = "2026-11-12T00:00:00.000Z";

async function readItems(items: RuntimeHistoryItem[]): Promise<RuntimeHistoryItem[]> {
  const root = await mkdtemp(join(tmpdir(), "evoloop-ledger-answer-"));
  try {
    const ledger = new TurnLedger(root);
    await ledger.append(project, session, { kind: "turn.started", at, turnId: "t1", operationId: "op", input: "hi", resume: false });
    for (const item of items) await ledger.append(project, session, { kind: "item", at, turnId: "t1", item });
    await ledger.append(project, session, { kind: "turn.settled", at, turnId: "t1", status: "completed", completedAtUtc: at,
      usage: null, costUsd: null, cumulativeCostUsd: null, source: "result" });
    return (await ledger.read(project, session)).turns[0]!.items;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("a final answer replaces the commentary right before it when the text is the same, so the reply is kept once", async () => {
  const items = await readItems([
    { id: "m1:0", type: "reasoning", source: "thinking", text: "plan", redacted: false } as RuntimeHistoryItem,
    { id: "m2:0", type: "agentMessage", text: "Reading the task", phase: "commentary" },
    { id: "toolu_1", type: "toolCall", name: "Read" } as RuntimeHistoryItem,
    { id: "m3:0", type: "agentMessage", text: "All done.\n\nDetails here.", phase: "commentary" },
    { id: "r1", type: "agentMessage", text: "All done.\n\nDetails here.", phase: "final_answer" },
  ]);
  assert.deepEqual(items.map(item => item.id), ["m1:0", "m2:0", "toolu_1", "r1"]);
  const replies = items.filter(item => item.type === "agentMessage" && item.text === "All done.\n\nDetails here.");
  assert.equal(replies.length, 1, "the same reply text appears once in the Turn");
  assert.equal(replies[0]!.type === "agentMessage" && replies[0].phase, "final_answer");
});

test("only an identical commentary right before the final answer is merged; other text is kept", async () => {
  const different = await readItems([
    { id: "m1:0", type: "agentMessage", text: "Working on it", phase: "commentary" },
    { id: "r1", type: "agentMessage", text: "Done", phase: "final_answer" },
  ]);
  assert.deepEqual(different.map(item => item.id), ["m1:0", "r1"], "a different closing text is not an echo of the answer");
  const notAdjacent = await readItems([
    { id: "m1:0", type: "agentMessage", text: "Done", phase: "commentary" },
    { id: "toolu_1", type: "toolCall", name: "Read" } as RuntimeHistoryItem,
    { id: "r1", type: "agentMessage", text: "Done", phase: "final_answer" },
  ]);
  assert.deepEqual(notAdjacent.map(item => item.id), ["m1:0", "toolu_1", "r1"], "earlier words said before a tool call stay in the history");
});
