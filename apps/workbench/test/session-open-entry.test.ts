import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostLink } from "@evoloop/contracts/resident-hosts";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { sessionOpenHref, sessionOriginalRef } from "../src/sessions/SessionOpenEntry.tsx";

const threadId = "01a158d7-f842-7ca3-9899-ce1efc33c030";
const linkId = "1000000b-0000-4000-8000-000000000011";
const projectId = "10000001-0000-4000-8000-000000000001";
const ref = `codex://threads/${threadId}`;
const stamp = "2026-10-25T00:00:00.000Z";
const session: ObservedSession = {
  key: `external:${linkId}`, target: { kind: "external", linkId }, aliases: [],
  title: "原聊天", profile: null, kind: "external", roles: [], membership: "current",
  membershipReason: "HostLink 已核实", runtimeState: null, busy: null,
  currentTask: null, latestBusinessRun: null, lastProgressAt: null,
  capabilities: {
    observe: { available: true, reason: null },
    send: { available: false, reason: "需人工交接", mode: "manual-handoff" },
    open: { available: true, reason: null, ref: threadId },
    interrupt: { available: false, reason: "外部聊天" },
    close: { available: false, reason: "外部聊天" },
  },
  source: { kind: "host-link", id: linkId, revision: null, evidence: "project-record", href: "#/" },
  metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] },
};
const host: HostLink = {
  projectId, id: linkId, roleId: "10000002-0000-4000-8000-000000000002", version: 2,
  host: { kind: "external", provider: "codex-desktop", ref },
  claimedCapabilities: ["open", "read"], verifiedCapabilities: ["open"],
  evidence: "人工核实", observer: "lead", observedAtUtc: stamp,
  state: "verified", actorId: "lead", createdAtUtc: stamp,
};

test("Session workspace opens only when the current HostLink verifies the same Codex reference", () => {
  assert.equal(sessionOpenHref(session, host), ref);
  assert.equal(sessionOpenHref(session, null), null);
  assert.equal(sessionOpenHref(session, { ...host, id: "other" }), null);
  assert.equal(sessionOpenHref(session, { ...host, host: { ...host.host, ref: "codex://threads/another" } }), null);
  assert.equal(sessionOpenHref({ ...session, capabilities: { ...session.capabilities, open: { available: false, reason: "未核实", ref: threadId } } }, host), null);
  assert.equal(sessionOpenHref({ ...session, capabilities: { ...session.capabilities, open: { available: true, reason: null, ref: "javascript:alert(1)" } } }, host), null);
});

test("newer registration, revocation, or lost open capability overrides a previously openable snapshot", () => {
  for (const latest of [
    { ...host, state: "registered" as const },
    { ...host, state: "revoked" as const },
    { ...host, verifiedCapabilities: ["read" as const] },
  ]) {
    assert.equal(sessionOpenHref(session, latest), null);
    assert.equal(sessionOriginalRef(session, latest), ref);
  }
});

test("Session workspace retains a complete manual reference when opening is unavailable", () => {
  const unavailable = { ...session, capabilities: { ...session.capabilities, open: { available: false, reason: "未核实", ref: null } } };
  assert.equal(sessionOriginalRef(unavailable, host), ref);
  assert.equal(sessionOriginalRef(unavailable, { ...host, host: { ...host.host, ref: threadId } }), ref);
  assert.equal(sessionOriginalRef(unavailable, { ...host, host: { ...host.host, ref: "unrecognized-host-ref" } }), "unrecognized-host-ref");
});
