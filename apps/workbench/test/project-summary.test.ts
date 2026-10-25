import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResidentQueue, ResidentQueueEntry } from "@evoloop/contracts/queues";
import { scanProjectTasks, selectSummary, taskMatchesQueue } from "../src/overview/summary";

const queueId = "q", projectId = "p", sessionId = "s", roleId = "r";
function entry(id: string, position: number, state: ResidentQueueEntry["state"], holdCode: ResidentQueueEntry["holdCode"] = null): ResidentQueueEntry {
  return { projectId, queueId, id, taskId: id, taskRevisionId: id, sourceInputJson: "{}", sessionId, roleId, position,
    dependsOn: [], consumerId: "consumer", useRequired: true, releaseRule: "accepted", state, holdCode, holdReason: null, claimId: null, version: 1 };
}
function queue(entries: ResidentQueueEntry[], adoptedVersion: number | null = 2): ResidentQueue {
  return { projectId, id: queueId, version: 2, adoptedVersion, maxRuns: 6, reason: "reason", actorId: "lead", entries };
}

test("summary distinguishes claimed, next, held and excludes unadopted candidates", () => {
  const rows = [entry("a", 0, "claimed"), entry("b", 1, "held", "awaiting_acceptance"), entry("c", 2, "queued")];
  const selected = selectSummary([queue(rows)]);
  assert.deepEqual(selected.current.map(item => item.entry.id), ["a"]);
  assert.deepEqual(selected.held.map(item => item.entry.id), ["b"]);
  assert.deepEqual(selected.next.map(item => item.entry.id), []);
  assert.deepEqual(selectSummary([queue([entry("c", 0, "queued")], null)]).next, []);
  assert.deepEqual(selectSummary([queue([entry("c", 0, "queued")])]).next.map(item => item.entry.id), ["c"]);
});

test("summary name-read scope remains bounded", () => {
  const rows = Array.from({ length: 20 }, (_, n) => entry(String(n), n, "held", "manual_review"));
  const result = selectSummary([queue(rows)]);
  assert.equal(result.held.length, 12);
  assert.equal(result.omitted, 8);
});

test("a full current slice does not turn undisplayed held and next items into empty categories", () => {
  const claimed = Array.from({ length: 12 }, (_, n) => ({ ...entry(`current-${n}`, n, "claimed"), sessionId:`session-${n}` }));
  const rows = [...claimed,
    { ...entry("held-13", 12, "held", "manual_review"), sessionId:"session-13" },
    { ...entry("next-14", 13, "queued"), sessionId:"session-14" }];
  const result = selectSummary([queue(rows)]);
  assert.equal(result.current.length, 12);
  assert.equal(result.held.length, 0);
  assert.equal(result.next.length, 0);
  assert.deepEqual(result.total, { current:12, held:1, next:1 });
  assert.deepEqual(result.omittedByKind, { current:0, held:1, next:1 });
  assert.equal(result.omitted, 2);
});

test("claimed queue entry is not accepted as a current Task when owner or revision changed", () => {
  const claimed = entry("a", 0, "claimed");
  const task = { id:"a", projectId, currentRevisionId:"a", state:"in_progress", owner:roleId } as Parameters<typeof taskMatchesQueue>[0];
  assert.equal(taskMatchesQueue(task, claimed), true);
  assert.equal(taskMatchesQueue({ ...task, owner:"other" }, claimed), false);
  assert.equal(taskMatchesQueue({ ...task, currentRevisionId:"new" }, claimed), false);
});

test("project tasks scan reaches later pages and marks a capped scan incomplete", async () => {
  const make = (id: string, state: "todo" | "in_progress") => ({ id, projectId, state, title:id, owner:"logicalactor" } as Parameters<typeof taskMatchesQueue>[0]);
  const pages = new Map<string | undefined, {items: ReturnType<typeof make>[]; nextCursor:string|null}>([
    [undefined, {items:Array.from({length:50},(_,n)=>make(`todo-${n}`,"todo")),nextCursor:"next"}],
    ["next", {items:[make("active-later","in_progress")],nextCursor:null}],
  ]);
  const read = async (cursor?: string) => pages.get(cursor)!;
  const complete = await scanProjectTasks(projectId, read, new AbortController().signal);
  assert.equal(complete.items.find(task=>task.id === "active-later")?.state,"in_progress");
  assert.equal(complete.truncated,false);
  const capped = await scanProjectTasks(projectId, read, new AbortController().signal, 1);
  assert.equal(capped.truncated,true);
  assert.equal(capped.items.some(task=>task.state === "in_progress"),false);
  await assert.rejects(scanProjectTasks(projectId, async () => ({items:[{...make("foreign","in_progress"),projectId:"foreign"}],nextCursor:null}), new AbortController().signal), /当前项目/);
  await assert.rejects(scanProjectTasks(projectId, async () => ({items:[],nextCursor:"same"}), new AbortController().signal), /游标重复/);
});
