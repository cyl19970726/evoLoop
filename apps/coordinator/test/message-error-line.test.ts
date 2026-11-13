import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DomainError } from "@evoloop/contracts/ports";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { RuntimeLocalBusyError, RuntimeServerError } from "@evoloop/adapter-codex-app-server";
import { throttledLog } from "../src/log-throttle.ts";
import { errorCode, isExpectedWait, keyedThrottledLog, messageErrorEntry, messageErrorLine, redact } from "../src/session-messages/error-line.ts";

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
  assert.match(messageErrorLine(new TypeError("boom"), m)!, /code=TypeError .*error=\(text withheld: TypeError\)/, "a plain error says only what kind it is");
  assert.ok(messageErrorLine(new DomainError("X_Y", "x".repeat(5000)), m)!.length < 600, "the summary is cut short");
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

const leaks = ["sk-live-0123456789abcdef", "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD", "/Users/gongshi006/.local/share/evoloop/private/secret.json", "C:\\Users\\me\\private\\key.pem",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0", "password=hunter2", "Bearer abc.def.ghi"];

test("defect d6dd0a1e rework 3: a plain Error never echoes its text — token, input and private path stay out of the log", () => {
  const m = message();
  const text = `request failed with Authorization: Bearer abc.def.ghi token=${leaks[0]} reading ${leaks[2]} and ${leaks[3]} for input "the user's private input text that is long enough to leak" ${leaks[5]}`;
  const line = messageErrorLine(new Error(text), m)!;
  for (const leak of [...leaks, "private input text", "request failed", "hunter2"]) assert.ok(!line.includes(leak), `${leak} must not appear: ${line}`);
  assert.match(line, /code=Error .*error=\(text withheld: Error\)/);
  class Strange extends Error { override name = "ConnectionResetByPeer"; code = "ECONNRESET"; }
  const strange = messageErrorLine(new Strange(`fetch ${leaks[2]} failed`), m)!;
  assert.match(strange, /code=ECONNRESET /); assert.ok(!strange.includes("/Users/"), strange);
});

test("defect d6dd0a1e rework 3: a DomainError or RuntimeServerError keeps a summary, but token-like strings, private paths and long quoted text are replaced", () => {
  const m = message();
  const domain = messageErrorLine(new DomainError("BAD_STATE", `cannot read ${leaks[2]} with token=${leaks[0]} and ${leaks[4]}, input "a long piece of private input text here" ${leaks[1]}`), m)!;
  const native = messageErrorLine(new RuntimeServerError("turn/start", 5, -32603, `internal error at ${leaks[2]} authorization: ${leaks[6]}`), m)!;
  for (const line of [domain, native]) {
    for (const leak of [...leaks, "private input text", "hunter2", ".local/share"]) assert.ok(!line.includes(leak), `${leak}: ${line}`);
  }
  assert.match(domain, /<path>.*<redacted>/, "the replacements are visible");
  assert.match(domain, /code=BAD_STATE .*cannot read <path>/, "the platform's own words stay readable");
  assert.equal(redact("plain words only"), "plain words only");
});

test("defect d6dd0a1e rework 1: the throttle key is message ID + error code, not the line: 70 one-second ticks with changing error text are one line a minute", () => {
  const written: string[] = []; let clock = 5_000_000;
  const log = keyedThrottledLog(line => written.push(line), 60_000, () => clock);
  const m = message(), other = message();
  const tick = (n: number, who = m, code = "VERSION_CONFLICT") => { const e = messageErrorEntry(new DomainError(code, `version ${n} is not current (expected ${n + 1}) at ${1_700_000_000 + n}`), who)!; log(e.key, e.line); clock += 1000; };
  for (let i = 0; i < 70; i++) tick(i);
  assert.equal(written.length, 2, "ticks 0..59 are one line; the line after the minute is the second: 70 s give two lines, not seventy");
  assert.match(written[1]!, /\(\d+ more of this error held back in the last 60s\)/); assert.match(written[1]!, /version 6\d is not current/, "the latest text is the one written");
  const before = written.length;
  tick(1, other); assert.equal(written.length, before + 1, "another message is its own line");
  tick(1, m, "OTHER_CODE"); assert.equal(written.length, before + 2, "another error code is its own line");
  assert.equal(messageErrorEntry(new DomainError("VERSION_CONFLICT", "a"), m)!.key, messageErrorEntry(new DomainError("VERSION_CONFLICT", "b"), m)!.key, "same message and code: same key whatever the text");
});
