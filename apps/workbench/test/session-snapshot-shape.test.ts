// Task c3a8e5d1: a Session snapshot whose lists or resource block are missing, null or of the wrong type used to take the whole Session page into the error boundary
// (found by sending each top-level field of the snapshot as null and as the wrong type: assignments, roleTasks, queue, results, questions, resources, metadata each did).
// The shape is checked where it comes in: a snapshot with no Session is a failed read, anything else is usable with what was missing named in `metadata.limitations`.
import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/shared/api";
import { checkedSessionSnapshot } from "../src/shared/sessionShapes";

const whole = () => ({ session: { key: "owned:s", target: { kind: "owned", sessionId: "s" } }, observationCursor: "3", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [],
  resources: Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"].map(name => [name, { value: 1, unit: "x", source: "s", scope: "session", observedAt: null, interval: null, unavailableReason: null }])),
  metadata: { generatedAt: "2026-11-17T00:00:00.000Z", sourceObservedAt: null, partial: false, limitations: ["a"] } });

test("a snapshot with no Session is a failed read, whatever else it carries", () => {
  for (const bad of [null, {}, [], "x", 0, { ...whole(), session: null }, { ...whole(), session: {} }, { ...whole(), session: { key: "owned:s" } }])
    assert.throws(() => checkedSessionSnapshot(bad), (error: unknown) => error instanceof ApiError && /不是预期的格式/.test(error.message));
});

test("a whole snapshot is passed on as it is", () => {
  const value = whole(), checked = checkedSessionSnapshot(value);
  assert.deepEqual(checked.metadata, value.metadata); assert.deepEqual(checked.resources, value.resources);
  assert.deepEqual([checked.assignments, checked.queue, checked.results], [[], [], []]);
});

test("each list, the resource block and the metadata block, null or of the wrong type, becomes usable and says what was missing", () => {
  for (const field of ["assignments", "roleTasks", "queue", "results", "questions", "activity"] as const) for (const bad of [null, {}, "x", 0]) {
    const checked = checkedSessionSnapshot({ ...whole(), [field]: bad });
    assert.deepEqual(checked[field], [], `${field}=${JSON.stringify(bad)} is an empty list`);
    assert.equal(checked.metadata.partial, true); assert.match(checked.metadata.limitations.join(""), new RegExp(`缺少 ${field}`));
    assert.deepEqual(checked.metadata.limitations[0], "a", "what the service said is kept");
  }
  for (const bad of [null, [], "x", 0]) {
    const checked = checkedSessionSnapshot({ ...whole(), resources: bad });
    assert.equal(checked.resources.cost.value, null); assert.match(checked.resources.cost.unavailableReason ?? "", /没有返回/);
    assert.match(checked.metadata.limitations.join(""), /缺少 resources/);
    const noMeta = checkedSessionSnapshot({ ...whole(), metadata: bad });
    assert.deepEqual([noMeta.metadata.generatedAt, noMeta.metadata.partial], ["", true]); assert.match(noMeta.metadata.limitations.join(""), /缺少 metadata/);
  }
  const oneResource = checkedSessionSnapshot({ ...whole(), resources: { ...whole().resources, cost: null } });
  assert.equal(oneResource.resources.inputTokens.value, 1, "the resources that are there are kept"); assert.equal(oneResource.resources.cost.value, null);
  assert.match(oneResource.metadata.limitations.join(""), /缺少 resources.cost/);
});
