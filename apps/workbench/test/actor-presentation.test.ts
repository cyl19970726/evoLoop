// Who recorded something (shared/actorPresentation.ts): an account name stays; an identity known only by an
// identifier is said in words, never whole or shortened, and its full value goes to 完整标识.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actorIdentifier, actorKind, actorRow, actorText } from "../src/shared/actorPresentation.ts";
import { revisionOrigin } from "../src/shared/revisionPresentation.ts";
import { assessmentName } from "../src/features/evaluation/presentation.ts";
import { activityPresentation } from "../src/features/sessions/activityPresentation.ts";

const uuid = "30000002-0000-4000-8000-000000000002";
const worker = `worker-${uuid}`;
const anyId = /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{8}/i;

test("an account name is shown as written", () => {
  assert.equal(actorText("zhang-reviewer"), "zhang-reviewer");
  assert.equal(actorText(" lead "), "lead");
  assert.equal(actorIdentifier("zhang-reviewer"), null, "nothing more to keep");
  assert.deepEqual(actorRow("登记者", "lead"), { label: "登记者", value: null });
  assert.equal(actorKind("lead"), "account");
});

test("an identity known only by a UUID is 未登记名称的身份, its value under 完整标识", () => {
  assert.equal(actorText(uuid), "未登记名称的身份");
  assert.doesNotMatch(actorText(uuid), anyId);
  assert.equal(actorIdentifier(uuid), uuid);
  assert.deepEqual(actorRow("登记者", uuid), { label: "登记者", value: uuid });
});

test("a coordinator worker credential is 自动执行方, its value under 完整标识", () => {
  assert.equal(actorKind(worker), "worker");
  assert.equal(actorText(worker), "自动执行方");
  assert.doesNotMatch(actorText(worker), anyId);
  assert.equal(actorIdentifier(worker), worker);
});

test("a schedule, the reader and a missing actor", () => {
  assert.equal(actorText(`schedule:${uuid}`), "日程");
  assert.equal(actorIdentifier(`schedule:${uuid}`), `schedule:${uuid}`);
  assert.equal(actorText("lead", "lead"), "我");
  assert.equal(actorIdentifier(uuid, uuid), null, "the reader is 我");
  assert.equal(actorText(""), "未记录");
  assert.equal(actorText(null), "未记录");
  assert.equal(actorIdentifier(undefined), null);
});

test("revision authors, assessments and activity sources use the same words", () => {
  const revision = revisionOrigin({ actorId: worker, reason: "Initial task" });
  assert.equal(revision.author, "自动执行方");
  assert.doesNotMatch(revision.line, anyId);
  assert.ok(revision.identifiers.some(row => row.value === worker), "the worker's value is kept for 完整标识");
  const opaque = revisionOrigin({ actorId: uuid, reason: "人工修订" });
  assert.equal(opaque.line, "未登记名称的身份 · 人工修订");
  assert.ok(opaque.identifiers.some(row => row.value === uuid));
  assert.equal(revisionOrigin({ actorId: "lead", reason: "人工修订" }).line, "lead · 人工修订");
  assert.deepEqual(revisionOrigin({ actorId: "lead", reason: "人工修订" }).identifiers, []);
  const line = assessmentName({ attemptId: "a", assessorKind: "agent", actorId: worker, createdAt: "2026-11-10T00:00:00.000Z" },
    { definition: { conditions: [] } } as never, [], iso => iso);
  assert.match(line, /智能体 自动执行方/);
  assert.doesNotMatch(line, anyId);
  const activity = activityPresentation({ actorId: worker, source: { kind: "session", id: "s", evidence: "project-record" } } as never, "p");
  assert.match(activity.sourceLabel, /登记者 自动执行方/);
  assert.doesNotMatch(activity.sourceLabel, anyId);
});
