import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Principal, RuntimeRunRecord } from "@evoloop/contracts";
import type { DocumentPayloadRevision } from "@evoloop/contracts/process-documents";
import { fixedDocumentMaterial } from "../src/runtime/materials.js";
import { RuntimeRunner } from "../src/runtime/runner.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const projectId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID();
const principal: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const html = "<!doctype html><html><body><img src='figure.svg'><script>alert('inert')</script></body></html>";
const asset = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
const revision: DocumentPayloadRevision = {
  projectId, documentId, id: revisionId, previousRevisionId: null, format: "html", mediaType: "text/html",
  originalName: "page.html", body: null, payloadRef: randomUUID(), contentHash: hash(html), entrypoint: "page.html",
  assetsManifest: [{ path: "figure.svg", blobId: randomUUID(), contentHash: hash(asset), size: asset.length, mediaType: "image/svg+xml" }],
  author: principal.actorId, reason: "fixture", createdAt: new Date().toISOString(),
};
const original = { status: "available" as const, body: html,
  assets: [{ path: "figure.svg", mediaType: "image/svg+xml", base64: asset.toString("base64") }] };

test("fixed HTML material contains the complete inert original and verified resources", async () => {
  const material = await fixedDocumentMaterial(principal, revision, async () => original);
  assert.match(material, /immutable revision/);
  const encoded = JSON.parse(material.slice(material.indexOf("\n") + 1));
  assert.equal(encoded.body, html);
  assert.equal(encoded.resources[0].base64, asset.toString("base64"));
  await assert.rejects(fixedDocumentMaterial(principal, revision, async () => ({ ...original, assets: [] })), /manifest/);
  await assert.rejects(fixedDocumentMaterial(principal, revision, async () => ({ ...original,
    assets: [{ ...original.assets[0]!, base64: Buffer.from("tampered").toString("base64") }] })), /SHA256/);
  await assert.rejects(fixedDocumentMaterial(principal, revision), /reader_not_configured/);
});

test("runtime input admits fixed HTML and rejects a complete context above 256 KiB", async () => {
  const run = { projectId, taskId: randomUUID(), taskRevisionId: randomUUID(), basisSetId: randomUUID(),
    operationId: randomUUID(), input: "work" } as RuntimeRunRecord;
  const fixed = { revision: { id: run.taskRevisionId, title: "Task", goal: "Goal", acceptance: "Done" },
    basis: { id: run.basisSetId, members: [{ documentId, revisionId }] } };
  const current = { impacts: [], decisions: [] };
  const workflow = { getTaskRevision: async () => fixed, getTask: async () => current,
    getDocument: async () => ({ document: { adoptedRevisionId: revisionId } }),
    getDocumentPayloadRevision: async () => revision };
  const runner = new RuntimeRunner({
    runtimeFactory: () => ({}) as never, workflow: workflow as never, trusted: {} as never,
    principals: [principal], canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true,
    readDocumentOriginal: async () => original,
  });
  const readInput = (runner as unknown as { input(p: Principal, r: RuntimeRunRecord): Promise<string> }).input.bind(runner);
  const input = await readInput(principal, run);
  assert.match(input, /"format":"html"/);
  assert.match(input, /figure.svg/);
  assert.match(input, /Authorized task input:\nwork/);
  const huge = { ...original, body: html + "x".repeat(270_000) };
  const hugeRevision = { ...revision, contentHash: hash(huge.body) };
  const largeRunner = new RuntimeRunner({
    runtimeFactory: () => ({}) as never,
    workflow: { ...workflow, getDocumentPayloadRevision: async () => hugeRevision } as never,
    trusted: {} as never, principals: [principal], canWrite: () => true,
    allowedCwd: async () => true, hasGrant: () => true, readDocumentOriginal: async () => huge,
  });
  await assert.rejects((largeRunner as unknown as { input(p: Principal, r: RuntimeRunRecord): Promise<string> }).input(principal, run), /input limit/);
});
