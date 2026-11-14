import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOrigin, assertSameOrigin, loadHubDatabaseUrl } from "../src/config.js";
import { clearSessionCookie, parseCookie, sessionCookie } from "../src/cookies.js";
import { csrfTokenFor, hashToken, tokenMatches } from "../src/ids.js";
import { hashPassword, passwordHashAlgorithm, verifyPassword } from "../src/password.js";
import { errorPage, oneTimeSecretPage } from "../src/pages.js";
import { parseServiceIdentityBody } from "../src/service.js";
import { emailField, memberInput, sessionIdsFrom } from "../src/validation.js";

test("passwords use Argon2id with per-password salts and constant-time verification", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.equal(passwordHashAlgorithm(first), "argon2id");
  assert.match(first, /^\$argon2id\$v=19\$m=32768,t=2,p=1\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password entirely", first), false);
  assert.equal(await verifyPassword("correct horse battery staple", "not-a-hash"), false);
});

test("session cookies are host-only, HttpOnly, Secure and SameSite", () => {
  const cookie = sessionCookie("opaque-session-token", 7200);
  assert.match(cookie, /^__Host-hub_session=opaque-session-token;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=7200/);
  assert.doesNotMatch(cookie, /Domain=/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});

test("CSRF derivation is stable per session token and token hashes do not contain the token", () => {
  const first = csrfTokenFor("session-token");
  assert.equal(first, csrfTokenFor("session-token"));
  assert.notEqual(first, csrfTokenFor("another-session-token"));
  assert.equal(tokenMatches(first, csrfTokenFor("session-token")), true);
  assert.equal(tokenMatches(first, csrfTokenFor("another-session-token")), false);
  const token = "plain-secret-token";
  const digest = hashToken(token);
  assert.equal(digest.length, 64);
  assert.equal(digest.includes(token), false);
});

test("cookie parsing reads only the exact cookie name", () => {
  assert.equal(parseCookie("a=1; __Host-hub_session=abc%2Fdef; b=2", "__Host-hub_session"), "abc/def");
  assert.equal(parseCookie("x=1", "__Host-hub_session"), null);
  assert.equal(parseCookie(undefined, "__Host-hub_session"), null);
});

test("public origin validation rejects paths, credentials and bad schemes", () => {
  assert.equal(normalizeOrigin("https://hub.example.test/"), "https://hub.example.test");
  assert.throws(() => normalizeOrigin("https://hub.example.test/path"), /bare origin/);
  assert.throws(() => normalizeOrigin("https://user:pass@hub.example.test"), /credentials/);
  assert.throws(() => normalizeOrigin("file:///tmp/hub"), /http or https/);
  assert.doesNotThrow(() => assertSameOrigin("https://hub.example.test", "https://hub.example.test"));
  assert.throws(() => assertSameOrigin(undefined, "https://hub.example.test"), error => (error as { code?: string }).code === "ORIGIN_REQUIRED");
  assert.throws(() => assertSameOrigin("https://evil.example.test", "https://hub.example.test"), error => (error as { code?: string }).code === "ORIGIN_MISMATCH");
});

test("Hub migrations and service use a database separate from the project database", () => {
  const project = "postgres://evoloop@127.0.0.1:5432/evoloop";
  assert.throws(
    () =>
      loadHubDatabaseUrl({
        HUB_DATABASE_URL: "postgresql://another@127.0.0.1:5432/evoloop",
        EVOLOOP_DATABASE_URL: project,
      }),
    /separate from EVOLOOP_DATABASE_URL/,
  );
  assert.equal(
    loadHubDatabaseUrl({
      HUB_DATABASE_URL: "postgres://evoloop@127.0.0.1:5432/evoloop_hub",
      EVOLOOP_DATABASE_URL: project,
    }),
    "postgres://evoloop@127.0.0.1:5432/evoloop_hub",
  );
});

test("member input keeps the three permissions and an explicit Session list", () => {
  const input = memberInput({
    permissions: { task: true, document: false, session: true },
    sessionIds: ["s1", "s1", "s2"],
    isProjectAdmin: false,
  });
  assert.deepEqual(input, {
    canTask: true,
    canDocument: false,
    canSession: true,
    sessionIds: ["s1", "s2"],
    isProjectAdmin: false,
  });
  assert.deepEqual(sessionIdsFrom("s1, s2"), ["s1", "s2"]);
  assert.equal(emailField({ email: "A@Example.Test " }), "a@example.test");
  assert.throws(() => emailField({ email: "not-an-email" }), /valid email/);
});

test("a single form project scope is accepted as one UUID", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const parsed = parseServiceIdentityBody({
    displayName: "Service",
    ownerAccountId: "22222222-2222-4222-8222-222222222222",
    purpose: "Form test",
    projectIds: projectId,
  });
  assert.deepEqual(parsed.projectIds, [projectId]);
});

test("one-time secrets and errors are HTML-escaped", () => {
  const page = oneTimeSecretPage("t", "token", "<script>alert(1)</script>");
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(errorPage(400, "<bad>"), /&lt;bad&gt;/);
});
