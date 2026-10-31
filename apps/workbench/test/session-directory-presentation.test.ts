import assert from "node:assert/strict";
import test from "node:test";
import type { ObservedRole, ObservedSession } from "@evoloop/contracts/session-observation";
import { groupSessionsByClass, sessionClass, sessionClassReason } from "../src/sessions/sessionDirectoryPresentation.ts";

const role = (id: string, roleClass: ObservedRole["roleClass"]): ObservedRole => ({
  id, title: id, state: "active", roleClass, templateKey: null, responsibility: `${id} responsibility`,
});
const session = (key: string, roles: ObservedRole[]): ObservedSession => ({
  key, target: { kind: "external", linkId: `00000000-0000-4000-8000-${String(key.length).padStart(12, "0")}` },
  aliases: [], title: key, profile: null, kind: "external", roles, membership: "current", membershipReason: "verified",
  runtimeState: null, busy: null, currentTask: null, latestBusinessRun: null, lastProgressAt: null,
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "manual-handoff" },
    open: { available: false, reason: null, ref: null }, interrupt: { available: false, reason: null },
    close: { available: false, reason: null } },
  source: { kind: "host-link", id: key, revision: null, evidence: "project-record", href: "" },
  metadata: { generatedAt: "2026-10-31T00:00:00.000Z", sourceObservedAt: null, partial: false, limitations: [] },
});

test("Session directory groups only complete formal Role classes and keeps ambiguity unclassified", () => {
  const business = session("business", [role("产品", "business")]);
  const system = session("system", [role("Leader", "system")]);
  const crossClass = session("cross", [role("Leader", "system"), role("功能开发", "business")]);
  const missing = session("missing", []);
  const unknown = session("unknown", [role("未核职责", null)]);
  assert.equal(sessionClass(business), "business");
  assert.equal(sessionClass(system), "system");
  assert.equal(sessionClass(crossClass), "unclassified");
  assert.equal(sessionClass(missing), "unclassified");
  assert.equal(sessionClass(unknown), "unclassified");
  assert.match(sessionClassReason(crossClass), /跨类/);
  assert.match(sessionClassReason(missing), /不按名称猜测/);
  const groups = groupSessionsByClass([business, system, crossClass, missing, unknown]);
  assert.deepEqual(groups.business.map(item => item.key), ["business"]);
  assert.deepEqual(groups.system.map(item => item.key), ["system"]);
  assert.deepEqual(groups.unclassified.map(item => item.key), ["cross", "missing", "unknown"]);
});
