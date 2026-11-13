import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DomainError } from "@evoloop/contracts/ports";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { RuntimeLocalBusyError, RuntimeServerError } from "@evoloop/adapter-codex-app-server";
import { throttledLog } from "../src/log-throttle.ts";
import { errorCode, isExpectedWait, messageErrorLine } from "../src/session-messages/error-line.ts";

const projectId = randomUUID(), sessionId = randomUUID();
const message = (id = randomUUID()): SessionMessageRecord => ({ projectId, id, operationId: randomUUID(), target: { kind: "owned", sessionId }, senderActorId: "sender",
  content: "SECRET MESSAGE BODY sk-should-never-be-logged", context: null, replyToMessageId: null, state: "queued", version: 1, blockedReason: null, readReceipt: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

test("a real error is logged with its code, the message, the Session, the project and a short summary — never the message text", () => {
  const m = message();
  const line = messageErrorLine(new DomainError("VERSION_CONFLICT", "message changed\nwhile reading"), m)!;
  assert.match(line, /^Session message needs reconciliation: code=VERSION_CONFLICT /);
  for (const part of [`message=${m.id}`, `session=${sessionId}`, `project=${projectId}`, "state=queued", "error=message changed while reading"]) assert.ok(line.includes(part), part);
  assert.ok(!line.includes("SECRET") && !line.includes("sk-"), "no message text or secret");
  assert.ok(!line.includes("\n"), "one line");
  assert.match(messageErrorLine(new RuntimeServerError("turn/start", 3, -32603, "internal"), m)!, /code=RuntimeServerError\(-32603\)|code=.*32603/);
  assert.match(messageErrorLine(new TypeError("boom"), m)!, /code=TypeError .*error=boom/);
  assert.ok(messageErrorLine(new Error("x".repeat(5000)), m)!.length < 500, "the summary is cut short");
  assert.match(messageErrorLine("odd", null)!, /message=unknown/);
});

test("a message that only waits is not an error: nothing is logged for the normal waits", () => {
  const m = message();
  for (const code of ["SESSION_BUSY", "PROVIDER_HELD", "MESSAGE_GRANT_MISSING", "MESSAGE_BUDGET_EXHAUSTED", "SESSION_NOT_READY", "MESSAGE_NOT_QUEUED"])
    assert.equal(messageErrorLine(new DomainError(code, "waits"), m), null, code);
  assert.equal(messageErrorLine(new RuntimeLocalBusyError("another send owns the Session"), m), null);
  assert.equal(isExpectedWait(new DomainError("INVALID_CURSOR", "x")), false);
  assert.equal(errorCode(new DomainError("X_Y", "t")), "X_Y");
});

test("the same error on the same message writes once a minute; another message or another code is its own line", () => {
  const written: string[] = []; let clock = 1_000_000;
  const log = throttledLog(line => written.push(line), 60_000, () => clock);
  const a = message(), b = message();
  const err = () => new DomainError("VERSION_CONFLICT", "changed");
  for (let i = 0; i < 30; i++) { log(messageErrorLine(err(), a)!); clock += 1000; }   // 30 ticks of one second
  assert.equal(written.length, 1, "30 identical errors in 30 s: one line");
  log(messageErrorLine(err(), b)!); assert.equal(written.length, 2, "another message is not suppressed");
  log(messageErrorLine(new DomainError("OTHER", "changed"), a)!); assert.equal(written.length, 3, "another code is not suppressed");
  clock += 60_000; log(messageErrorLine(err(), a)!);
  assert.equal(written.length, 4); assert.match(written[3]!, /held back \d+ more time/, "after the minute the line says how many were held back");
});
