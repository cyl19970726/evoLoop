import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Principal } from "@evoloop/contracts";
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import { readExternalMaterials } from "../src/references/materials.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const projectId = randomUUID(), taskId = randomUUID(), taskRevisionId = randomUUID();
const principal: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const body = "# fixed knowledge\n";
const fixed: TaskExternalReferenceRecord = { projectId, taskId, taskRevisionId, id: randomUUID(), slotId: randomUUID(),
  version: 2, decision: "retain", kind: "wiki", referenceId: randomUUID(), revision: "wiki-rev-1",
  contentHash: hash(body), observedCurrentRevision: "wiki-rev-2", observedCurrentHash: hash("# current\n"),
  observedCurrentValidity: "valid", reason: "retain reviewed old source", actionImpact: "keep the prior constraint",
  actorId: principal.actorId, createdAt: new Date().toISOString() };
const page = (revision: string, text: string) => ({ projectId, knowledgeId: fixed.referenceId,
  revision, body: text, contentHash: hash(text), validity: "valid", observedValidity: "valid" });
function options(currentText = "# current\n", validity = "valid") {
  return { uow: { read: async (_projectId: string, action: (reader: unknown) => Promise<unknown>) =>
    action({ listTaskExternalSnapshot: async () => [fixed] }) },
    gitForPrincipal: async () => ({ read: async () => ({ status: "unavailable" }) }),
    knowledgeForPrincipal: async () => ({ get: async (_projectId: string, _id: string, revision?: string) =>
      revision ? page("wiki-rev-1", body) : { ...page("wiki-rev-2", currentText), validity, observedValidity: validity } }) } as never;
}
test("only an explicitly retained fixed Wiki revision enters context at its observed current baseline", async () => {
  const text = await readExternalMaterials(principal, projectId, taskId, taskRevisionId, options());
  assert.match(text, /fixed knowledge/);
  await assert.rejects(readExternalMaterials(principal, projectId, taskId, taskRevisionId,
    options("# later\n")), /changed/);
  await assert.rejects(readExternalMaterials(principal, projectId, taskId, taskRevisionId,
    options("# current\n", "withdrawn")), /changed/);
  const noRetain = { ...fixed, decision: "adopt" as const };
  const mismatched = { ...options(), uow: { read: async (_projectId: string, action: (reader: unknown) => Promise<unknown>) =>
    action({ listTaskExternalSnapshot: async () => [noRetain] }) } } as never;
  await assert.rejects(readExternalMaterials(principal, projectId, taskId, taskRevisionId, mismatched), /changed/);
});

test("Git material requires the registered immutable commit, current permission and exact bytes", async () => {
  const commit = "a".repeat(40), text = "# formal\n";
  const gitRecord: TaskExternalReferenceRecord = { ...fixed, kind: "git", decision: "adopt",
    referenceId: randomUUID(), revision: commit, contentHash: hash(text),
    observedCurrentRevision: commit, observedCurrentHash: hash(text) };
  const make = (bytes: Uint8Array, allowed = true) => ({
    uow: { read: async (_projectId: string, action: (reader: unknown) => Promise<unknown>) =>
      action({ listTaskExternalSnapshot: async () => [gitRecord], getGitSourceRef: async () =>
        ({ state: "reachable", ref: { projectId, commit, contentHash: hash(text) } }) }) },
    gitForPrincipal: async () => ({ read: async () => allowed ? { status: "available", bytes } : { status: "unavailable", reason: "permission" } }),
    knowledgeForPrincipal: async () => ({}) }) as never;
  assert.match(await readExternalMaterials(principal,projectId,taskId,taskRevisionId,make(Buffer.from(text))), /formal/);
  await assert.rejects(readExternalMaterials(principal,projectId,taskId,taskRevisionId,make(Buffer.from("tampered"))), /hash mismatched/);
  await assert.rejects(readExternalMaterials(principal,projectId,taskId,taskRevisionId,make(Buffer.from(text),false)), /unavailable/);
  await assert.rejects(readExternalMaterials({ ...principal, permissions: [] },projectId,taskId,taskRevisionId,make(Buffer.from(text))), /permission/);
});
