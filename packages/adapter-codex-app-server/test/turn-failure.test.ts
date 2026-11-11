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
