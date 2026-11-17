// Task bedd0ef3: the page names a message's sender class in the words the receiving Session is told; a class it does not know is shown as received, and none is shown as nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { senderClassLabel } from "../src/features/sessions/senderClassPresentation";

test("every class the service can send has words, and only the user's own is the user", () => {
  for (const kind of ["user", "leader", "requirements", "session", "system", "hub", "service", "unknown"]) assert.ok(senderClassLabel(kind), kind);
  assert.equal(senderClassLabel("user"), "使用者本人");
  for (const kind of ["hub", "service", "unknown"]) assert.match(senderClassLabel(kind)!, /不是使用者/, kind);
  assert.equal(senderClassLabel(undefined), null);
  assert.equal(senderClassLabel(""), null);
  assert.equal(senderClassLabel("constructor"), "未识别的类别（constructor）");
  assert.equal(senderClassLabel("future-kind"), "未识别的类别（future-kind）");
});
