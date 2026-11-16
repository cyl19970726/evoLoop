// Task 6a959b42: a live read of a Session timeline that is not the shape the page iterates over (`{}` — what a proxy that blocks the live stream can answer) used to
// reach `mergeWorkspaceEntries` and take the whole page into the error boundary (“e is not iterable”). The shapes are checked where they come in, and the merges
// tolerate a non-list as a second line.
import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/shared/api";
import { checkedLiveRead, checkedTimelinePage } from "../src/shared/sessionShapes";
import { mergeWorkspaceEntries, mergeWorkspaceTurns } from "../src/features/sessions/workspaceTimelineModel";

test("a live read without a cursor is a failed read (the page keeps what it has); one with a cursor but missing lists is usable and says what was missing", () => {
  for (const bad of [{}, null, [], "x", { entries: [], turns: [] }, { cursor: 5 }]) assert.throws(() => checkedLiveRead(bad), (error: unknown) => error instanceof ApiError && /不是预期的格式/.test(error.message), JSON.stringify(bad));
  const partial = checkedLiveRead({ cursor: "7", freshness: "live" });
  assert.deepEqual([partial.entries, partial.turns, partial.cursor, partial.resetRequired], [[], [], "7", false]);
  assert.match(partial.limitations.join(""), /缺少 entries、turns/);
  const whole = checkedLiveRead({ cursor: "8", resetRequired: true, entries: [], turns: [], freshness: "live", limitations: ["a"], activeTurnId: "t" });
  assert.deepEqual([whole.limitations, whole.resetRequired, whole.activeTurnId], [["a"], true, "t"], "a whole read is passed on as it is");
  assert.equal(checkedLiveRead({ cursor: "1", freshness: "odd" }).freshness, "stale", "an unknown freshness is not taken for live");
});

test("a timeline page of the wrong shape: lists become empty with a limitation, a bad live part becomes unavailable, a non-object is refused", () => {
  assert.throws(() => checkedTimelinePage(null), ApiError);
  assert.throws(() => checkedTimelinePage([]), ApiError);
  const page = checkedTimelinePage({ sessionKey: "owned:s", sessionTitle: "t", live: {}, nextCursor: 3 });
  assert.deepEqual([page.entries, page.pending, page.turns, page.nextCursor, page.messagesCursor, page.live.freshness], [[], [], [], null, null, "unavailable"]);
  assert.match(page.limitations.join(""), /缺少 entries、pending、turns、live/);
  assert.equal(page.capabilities.live, false, "no capability is invented");
});

test("the merges tolerate a value that is not a list", () => {
  assert.deepEqual(mergeWorkspaceEntries(undefined as never, undefined as never), []);
  assert.deepEqual(mergeWorkspaceEntries([], {} as never), []);
  assert.deepEqual(mergeWorkspaceTurns(undefined as never, {} as never), []);
});
