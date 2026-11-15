import assert from "node:assert/strict";
import test from "node:test";
import {
  hasAnyDecisionAuthority,
  hasAnyObjectPermission,
  hasDecisionAuthority,
  hasPermission,
  isProjectMember,
  mayAccessSession,
  type Principal,
} from "@evoloop/contracts";
import { requireReferencePrincipal } from "@evoloop/contracts/references";
import {
  authConfigSchema,
  credentialGrants,
  credentialMayReadSession,
  hasCurrentStudyReviewer,
  isProjectWriter,
} from "../src/auth.js";
import { projectMembers } from "../src/project-configuration/local.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const otherProjectId = "00000000-0000-4000-8000-000000000002";
const sessionX = "00000000-0000-4000-8000-000000000010";
const sessionY = "00000000-0000-4000-8000-000000000011";
const token = (letter: string) => letter.repeat(40);

const config = authConfigSchema.parse([
  { token: token("a"), actorId: "reader", projectIds: [projectId], permissions: [] },
  { token: token("b"), actorId: "task-writer", projectIds: [projectId], permissions: ["task"] },
  { token: token("c"), actorId: "scoped-session", projectIds: [projectId], permissions: ["session"], sessionIds: [sessionX] },
  { token: token("d"), actorId: "human-task", projectIds: [projectId], permissions: ["task"], identityKind: "human" },
  { token: token("e"), actorId: "incomplete-reviewer", projectIds: [projectId], permissions: ["management"], decisions: true },
  { token: token("f"), actorId: "incomplete-reviewer", projectIds: [projectId], permissions: ["management"], decisions: false },
  { token: token("g"), actorId: "complete-reviewer", projectIds: [projectId], permissions: ["management"], decisions: true },
  { token: token("h"), actorId: "complete-reviewer", projectIds: [projectId], permissions: ["management"], decisions: true },
  { token: token("i"), actorId: "split-writer", projectIds: [projectId], permissions: ["task"] },
  { token: token("j"), actorId: "split-writer", projectIds: [projectId], permissions: ["document"] },
  { token: token("k"), actorId: "foreign-manager", projectIds: [otherProjectId], permissions: ["management"], decisions: true },
]);

const principal = (actorId: string, patch: Partial<Principal> = {}): Principal => ({
  actorId, projectIds: [projectId], permissions: ["task"], ...patch,
});

test("former writer and reviewer bypasses use the same object and decision checks", () => {
  assert.equal(hasPermission(principal("task-writer"), projectId, "task"), true);
  assert.equal(hasPermission(principal("reader", { permissions: [] }), projectId, "task"), false);
  assert.equal(isProjectMember(principal("reader", { permissions: [] }), projectId), true, "membership reads ordinary objects");
  assert.equal(hasAnyObjectPermission(principal("reader", { permissions: [] }), projectId), false);
  assert.equal(hasAnyObjectPermission(principal("task-writer"), projectId), true);
  assert.equal(hasPermission(principal("foreign-manager", { projectIds: [otherProjectId], permissions: ["management"] }),
    projectId, "management"), false);

  assert.equal(hasDecisionAuthority(principal("task-writer"), projectId, "task"), false);
  assert.equal(hasDecisionAuthority(principal("task-writer", { decisions: true }), projectId, "task"), true);
  assert.equal(hasDecisionAuthority(principal("human-task", { identityKind: "human" }), projectId, "task"), true);
  assert.equal(hasAnyDecisionAuthority(principal("task-writer", { decisions: true }), projectId), true);
  assert.equal(hasAnyDecisionAuthority(principal("task-writer"), projectId), false);

  const scoped = principal("scoped-session", { permissions: ["session"], sessionIds: [sessionX] });
  assert.equal(mayAccessSession(scoped, projectId, sessionX), true);
  assert.equal(mayAccessSession(scoped, projectId, sessionY), false);
  assert.equal(mayAccessSession(principal("all-sessions", { permissions: ["session"] }), projectId, sessionY), true);
  assert.equal(mayAccessSession(principal("task-writer"), projectId, sessionY), false);

  assert.equal(isProjectWriter(config, projectId, "task-writer"), true);
  assert.equal(isProjectWriter(config, projectId, "reader"), false);
  assert.equal(isProjectWriter(config, projectId, "foreign-manager"), false);

  assert.equal(credentialGrants(config, projectId, "task-writer", ["task"]), true);
  assert.equal(credentialGrants(config, projectId, "task-writer", ["task", "document"]), false,
    "permissions from two credentials are never added together");
  assert.equal(credentialGrants(config, projectId, "task-writer", ["task"], { decisions: true }), false);
  assert.equal(credentialGrants(config, projectId, "human-task", ["task"], { decisions: true }), true,
    "a human receives decision authority with the class");

  assert.equal(hasCurrentStudyReviewer(config, projectId, "incomplete-reviewer"), false,
    "one rotating credential without decision authority cannot be hidden by another");
  assert.equal(hasCurrentStudyReviewer(config, projectId, "complete-reviewer"), true);
  assert.equal(hasCurrentStudyReviewer(config, projectId, "task-writer"), false);

  assert.equal(credentialMayReadSession(config, projectId, "scoped-session", sessionX), true);
  assert.equal(credentialMayReadSession(config, projectId, "scoped-session", sessionY), false);
  assert.equal(credentialMayReadSession(config, projectId, "task-writer", sessionX), false);
});

test("reference reads require the exact actor, project membership and requested object class", () => {
  requireReferencePrincipal(principal("task-writer"), projectId, "task-writer", "task");
  assert.throws(() => requireReferencePrincipal(principal("task-writer"), projectId, "someone-else", "task"),
    /Project reference authority/);
  assert.throws(() => requireReferencePrincipal(principal("task-writer"), otherProjectId, "task-writer", "task"),
    /Project reference authority/);
  assert.throws(() => requireReferencePrincipal(principal("task-writer"), projectId, "task-writer", "document"),
    /Project reference authority/);
  requireReferencePrincipal(principal("reader", { permissions: [] }), projectId, "reader");
});

test("member readback exposes the same classes, decision flag, kind and Session scope", () => {
  const view = projectMembers(config, config, projectId);
  const byId = new Map(view.items.map(item => [item.actorId, item]));
  assert.deepEqual(byId.get("reader"), {
    actorId: "reader", identityKind: "agent", canRead: true, permissions: [], decisions: false,
    projectIds: [projectId], sessionIds: [], canWrite: false, canReview: false, pending: null,
  });
  assert.deepEqual(byId.get("scoped-session"), {
    actorId: "scoped-session", identityKind: "agent", canRead: true, permissions: ["session"], decisions: false,
    projectIds: [projectId], sessionIds: [sessionX], canWrite: true, canReview: false, pending: null,
  });
  assert.deepEqual(byId.get("human-task"), {
    actorId: "human-task", identityKind: "human", canRead: true, permissions: ["task"], decisions: true,
    projectIds: [projectId], sessionIds: [], canWrite: true, canReview: false, pending: null,
  });
  assert.equal(byId.get("complete-reviewer")?.decisions, true);
  assert.equal(byId.get("complete-reviewer")?.canReview, true);
  assert.equal(byId.get("incomplete-reviewer")?.decisions, false);
  assert.equal(byId.get("incomplete-reviewer")?.canReview, false);
  assert.equal(byId.has("foreign-manager"), false, "another project's member is not disclosed");
});
