import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeFailureClass } from "@evoloop/contracts/runtime";
import { turnFailure } from "../src/index.ts";

const classify = (message: string, codexErrorInfo?: unknown) => turnFailure({ message, ...(codexErrorInfo === undefined ? {} : { codexErrorInfo }) });

test("the real 402 text (not a JSON envelope) is a quota failure the account owner must fix", () => {
  const failure = classify("402 Payment Required: {\"error\":{\"message\":\"Insufficient Balance\"}}");
  assert.equal(failure?.category, "quota_exhausted");
  assert.equal(failure?.httpStatus, 402);
  assert.equal(nativeFailureClass(failure?.category), "quota_or_auth");
  assert.match(failure!.summary, /top up/);
});

test("quota is recognized from the JSON envelope, the status alone, and common balance wording", () => {
  assert.equal(classify(JSON.stringify({ status: 402, error: { type: "billing", message: "Insufficient Balance" } }))?.category, "quota_exhausted");
  assert.equal(classify(JSON.stringify({ error: { type: "insufficient_quota", message: "You exceeded your current quota" } }))?.category, "quota_exhausted");
  assert.equal(classify("insufficient quota for this account")?.category, "quota_exhausted");
});

test("authentication, context length, connection loss and rate limit are told apart", () => {
  const auth = classify("401 Unauthorized: invalid api key");
  assert.equal(auth?.category, "authentication_failed");
  assert.equal(nativeFailureClass(auth?.category), "quota_or_auth");
  const context = classify("anything", "contextWindowExceeded");
  assert.equal(context?.category, "context_window_exceeded");
  assert.equal(nativeFailureClass(context?.category), "context_too_long");
  const connection = classify("stream disconnected before completion: connection reset");
  assert.equal(connection?.category, "connection_lost");
  assert.equal(nativeFailureClass(connection?.category), "connection");
  assert.equal(classify(JSON.stringify({ status: 429, error: { type: "rate_limit" } }))?.category, "rate_limited");
  assert.equal(classify(JSON.stringify({ status: 503 }))?.category, "provider_unavailable");
});

test("an unclassified native failure stays other, never quota", () => {
  const other = classify("Something else went wrong");
  assert.equal(other?.category, "native_failure");
  assert.equal(nativeFailureClass(other?.category), "other");
  assert.equal(nativeFailureClass(null), null);
  assert.notEqual(classify("HTTP 4020 oddity")?.category, "quota_exhausted", "402 inside another number is not a payment error");
});

test("counter-examples: a number inside other text is not an HTTP status, and a rate limit is not a balance problem", () => {
  // "Requested 401." in a rate-limit message, a request ID that contains 402, and a hex ID are not statuses.
  const limited = classify(JSON.stringify({ status: 429, error: { type: "rate_limit_exceeded", message: "Rate limit reached. Requested 401. Please try again in 20s." } }));
  assert.equal(limited?.category, "rate_limited");
  assert.notEqual(nativeFailureClass(limited?.category), "quota_or_auth", "a per-minute limit never pauses the provider");
  for (const text of ["request req_4021abc failed upstream", "trace id 0x402a7f9c did not finish", "failed after 4020 ms", "item 401 of 500 was rejected",
    "Stream closed while waiting; request id 8f402b11-aaaa-bbbb-cccc-000000000401"]) {
    const failure = classify(text);
    assert.notEqual(nativeFailureClass(failure?.category), "quota_or_auth", `${text} -> ${failure?.category}`);
  }
});

test("429 wins over quota wording, unless the provider says insufficient_quota by code", () => {
  const perMinute = classify(JSON.stringify({ status: 429, error: { type: "rate_limit_exceeded", message: "Rate limit reached: quota exceeded for this minute" } }));
  assert.equal(perMinute?.category, "rate_limited");
  assert.equal(classify("429 Too Many Requests: you have exceeded the quota for requests per minute")?.category, "rate_limited");
  const billing = classify(JSON.stringify({ status: 429, error: { type: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details" } }));
  assert.equal(billing?.category, "quota_exhausted", "OpenAI reports a spent balance as 429 with the code insufficient_quota");
});

test("the structured Codex error fields decide before any text", () => {
  assert.equal(classify("anything at all", "usageLimitExceeded")?.category, "quota_exhausted");
  assert.equal(classify("anything at all", "unauthorized")?.category, "authentication_failed");
  const byStatus = (status: number) => classify("upstream failed", { httpConnectionFailed: { httpStatusCode: status } });
  assert.equal(byStatus(402)?.category, "quota_exhausted"); assert.equal(byStatus(402)?.httpStatus, 402);
  assert.equal(byStatus(401)?.category, "authentication_failed");
  assert.equal(byStatus(429)?.category, "rate_limited");
  assert.equal(byStatus(403)?.category, "provider_rejected", "a 403 is a rejected request, not a reason to pause every Session");
  assert.equal(byStatus(503)?.category, "provider_unavailable");
  assert.equal(classify("overloaded", "serverOverloaded")?.category, "provider_unavailable");
  assert.equal(classify("the stream ended", { responseStreamDisconnected: { httpStatusCode: null } })?.category, "connection_lost");
  assert.equal(classify("403 Forbidden: region not supported")?.category, "provider_rejected");
});

test("only an explicit status line counts as text evidence", () => {
  assert.equal(classify("402 Payment Required: Insufficient Balance")?.category, "quota_exhausted");
  assert.equal(classify("401 Unauthorized: bad token")?.category, "authentication_failed");
  assert.equal(classify("The proxy answered with a banner containing 402 somewhere in the middle")?.category, "native_failure");
});
