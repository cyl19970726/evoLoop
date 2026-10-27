import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Principal, RuntimeRunRecord } from "@evoloop/contracts";
import type { DocumentPayloadRevision } from "@evoloop/contracts/process-documents";
import { fixedDocumentMaterial, fixedDocumentSummary } from "../src/runtime/materials.js";
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

test("normal Run sends a bounded fixed manifest for an 11.8 KiB HTML and 1.4 MB image", async () => {
  const run = { projectId, taskId: randomUUID(), taskRevisionId: randomUUID(), basisSetId: randomUUID(),
    id: randomUUID(), sessionId: randomUUID(), operationId: randomUUID(), input: "work", inputHash: hash("work") } as RuntimeRunRecord;
  const contentDocumentId = randomUUID(), contentRevisionId = randomUUID(), content = "# Goal";
  const primary: DocumentPayloadRevision = { projectId, documentId: contentDocumentId, id: contentRevisionId,
    previousRevisionId: null, format: "markdown", mediaType: "text/markdown", originalName: "task.md",
    body: content, payloadRef: null, contentHash: hash(content), entrypoint: null, assetsManifest: [],
    author: principal.actorId, reason: "fixture", createdAt: new Date().toISOString() };
  const fixed = { revision: { projectId, taskId: run.taskId, id: run.taskRevisionId, title: "Task", content,
      contentDocumentId, contentRevisionId, acceptance: "Done" },
    basis: { id: run.basisSetId, taskRevisionId: run.taskRevisionId,
      members: [{ documentId: contentDocumentId, revisionId: contentRevisionId }, { documentId, revisionId }] } };
  const current = { impacts: [], decisions: [] };
  const workflow = { getTaskRevision: async () => fixed, getTask: async () => current,
    validateTaskRevisionBasis: async (_principal: Principal, selectedProjectId: string,
      selectedTaskId: string, selectedRevisionId: string, selectedBasisId: string) => {
      assert.equal(selectedProjectId, projectId); assert.equal(selectedTaskId, run.taskId);
      assert.equal(selectedRevisionId, run.taskRevisionId); assert.equal(selectedBasisId, run.basisSetId);
    },
    getDocument: async () => ({ document: { adoptedRevisionId: revisionId } }),
    getDocumentPayloadRevision: async (_principal: Principal, _projectId: string, requestedDocumentId: string) =>
      requestedDocumentId === contentDocumentId ? primary : revision };
  const designHtml = `${html}${" ".repeat(11_762 - Buffer.byteLength(html, "utf8"))}`;
  const png = Buffer.alloc(1_409_136, 7);
  const fixedDesign = { ...revision, contentHash: hash(designHtml),
    assetsManifest: [{ path: "approved.png", blobId: randomUUID(), mediaType: "image/png", size: png.length, contentHash: hash(png) }] };
  const designRunner = new RuntimeRunner({ runtimeFactory: () => ({}) as never,
    workflow: { ...workflow, getDocumentPayloadRevision: async (_principal: Principal, _projectId: string, requestedDocumentId: string) =>
      requestedDocumentId === contentDocumentId ? primary : fixedDesign } as never,
    trusted: {} as never, principals: [principal], canWrite: () => true,
    cliEntryForRun: async () => ({command:"/usr/local/bin/python3 /private/fixed-cli.py",actorId:"recipient"}),
    allowedCwd: async () => true, hasGrant: () => true,
    readDocumentOriginal: async () => { throw new Error("normal first input must not read original bytes"); } });
  const packet = await (designRunner as unknown as { lightweightInput(p: Principal, r: RuntimeRunRecord): Promise<{ input: string; byteLength: number; contentHash: string }> }).lightweightInput(principal, run);
  assert.ok(packet.byteLength < 16_000);
  assert.equal(packet.contentHash, hash(packet.input));
  assert.match(packet.input, /evoloop-lightweight-v1/);
  assert.match(packet.input, /approved\.png|"assetCount":1/);
  assert.doesNotMatch(packet.input, /base64|"body":"/i);
  assert.ok(!packet.input.includes(designHtml));
  assert.deepEqual(fixedDocumentSummary(fixedDesign).assetBytes, png.length);
});
