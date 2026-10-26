import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostLink } from "@evoloop/contracts/resident-hosts";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { sessionOpenHref, sessionOriginalRef } from "../src/sessions/SessionOpenEntry.tsx";

const id = "01a158d7-f842-7ca3-9899-ce1efc33c030";
const session = { kind: "external", capabilities: { open: { available: true, reason: null, ref: id } } } as ObservedSession;
const host = { host: { kind: "external", provider: "codex-desktop", ref: `codex://threads/${id}` }, state: "verified" } as HostLink;

test("Session workspace opens only verified Codex references, with no arbitrary protocol", () => {
  assert.equal(sessionOpenHref(session, host), `codex://threads/${id}`);
  assert.equal(sessionOpenHref(session, null), null);
  assert.equal(sessionOpenHref({ ...session, capabilities: { ...session.capabilities, open: { available: false, reason: "未核实", ref: id } } }, host), null);
  assert.equal(sessionOpenHref({ ...session, capabilities: { ...session.capabilities, open: { available: true, reason: null, ref: "javascript:alert(1)" } } }, host), null);
  assert.equal(sessionOpenHref(session, { ...host, host: { ...host.host, provider: "other" } }), null);
});

test("Session workspace retains a complete manual reference when opening is unavailable", () => {
  const unavailable = { ...session, capabilities: { ...session.capabilities, open: { available: false, reason: "未核实", ref: null } } };
  assert.equal(sessionOriginalRef(unavailable, host), `codex://threads/${id}`);
  assert.equal(sessionOriginalRef(unavailable, { ...host, host: { ...host.host, ref: id } }), `codex://threads/${id}`);
  assert.equal(sessionOriginalRef(unavailable, { ...host, host: { ...host.host, ref: "unrecognized-host-ref" } }), "unrecognized-host-ref");
});
