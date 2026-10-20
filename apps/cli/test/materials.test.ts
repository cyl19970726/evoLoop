import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportOriginal, MaterialError, readOriginal, readTaskContext } from "../src/materials.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [projectId, documentId, documentRevisionId, taskId, taskRevisionId, gitId, wikiId] = [1, 2, 3, 4, 5, 6, 7].map(id);
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.from("\ufeffCafé\r\n原文\n", "utf8");
const asset = Buffer.from([0, 255, 1, 3]);
const revision = { projectId, documentId, id: documentRevisionId, previousRevisionId: null, format: "html", mediaType: "text/html",
  originalName: "index.html", body: null, payloadRef: id(9), contentHash: sha(bytes), entrypoint: "index.html",
  assetsManifest: [{ path: "images/icon.bin", blobId: id(10), contentHash: sha(asset), size: asset.length, mediaType: "application/octet-stream" }],
  author: "tester", reason: "initial", createdAt: "2026-01-01T00:00:00Z" };
const originalResponse = () => ({ status: "available", revision, body: bytes.toString("utf8"),
  assets: [{ path: "images/icon.bin", mediaType: "application/octet-stream", base64: asset.toString("base64") }] });
const originalPath = `/api/projects/${projectId}/documents/${documentId}/revisions/${documentRevisionId}/original`;
function client(responses: Record<string, unknown>) {
  const seen: string[] = [];
  return { seen, get: async (path: string): Promise<unknown> => {
    seen.push(path); if (!(path in responses)) throw new Error(`Missing ${path}`); return responses[path];
  } };
}

test("fixed original verifies exact UTF-8 BOM/CRLF bytes and exports a new complete directory", async () => {
  const api = client({ [originalPath]: originalResponse() });
  const original = await readOriginal(api, projectId, documentId, documentRevisionId);
  assert.equal(original.status, "complete");
  assert.equal(original.totalBytes, bytes.length + asset.length);
  const parent = await mkdtemp(join(tmpdir(), "evoloop-cli-original-"));
  try {
    const destination = join(parent, "bundle");
    assert.equal(await exportOriginal(original, destination), destination);
    assert.deepEqual(await readFile(join(destination, "index.html")), bytes);
    assert.deepEqual(await readFile(join(destination, "images/icon.bin")), asset);
    const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
    assert.equal(manifest.revision.contentHash, sha(bytes));
    assert.equal(manifest.assets[0].base64, undefined);
    await assert.rejects(exportOriginal(original, destination), /already exists/);
    assert.deepEqual((await readdir(parent)).sort(), ["bundle"]);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("rejects tampered, missing, duplicated and unsafe original resources before export", async () => {
  const variants = [
    { ...originalResponse(), body: "changed" },
    { ...originalResponse(), assets: [] },
    { ...originalResponse(), assets: [{ path: "images/icon.bin", mediaType: "application/octet-stream", base64: "AA==" }] },
    { ...originalResponse(), assets: [{ path: "../escape", mediaType: "application/octet-stream", base64: asset.toString("base64") }] },
    { ...originalResponse(), assets: [...originalResponse().assets, ...originalResponse().assets] },
  ];
  for (const response of variants) await assert.rejects(readOriginal(client({ [originalPath]: response }), projectId, documentId, documentRevisionId));
  const original = await readOriginal(client({ [originalPath]: originalResponse() }), projectId, documentId, documentRevisionId);
  const parent = await mkdtemp(join(tmpdir(), "evoloop-cli-unsafe-"));
  try {
    original.assets[0]!.path = "../outside";
    await assert.rejects(exportOriginal(original, join(parent, "bundle")), /unsafe/);
    assert.deepEqual(await readdir(parent), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("direct original integrity failure has a material error code, while filesystem errors stay native", async () => {
  const tampered = { ...originalResponse(), body: "altered" };
  await assert.rejects(readOriginal(client({ [originalPath]: tampered }), projectId, documentId, documentRevisionId), error => {
    assert.ok(error instanceof MaterialError);
    assert.equal(error.code, "MATERIAL_UNAVAILABLE");
    assert.match(error.message, /SHA-256/);
    return true;
  });
  const original = await readOriginal(client({ [originalPath]: originalResponse() }), projectId, documentId, documentRevisionId);
  const missing = join(tmpdir(), `no-such-evoloop-parent-${id(77)}`, "bundle");
  await assert.rejects(exportOriginal(original, missing), error => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    assert.equal(error instanceof MaterialError, false);
    return true;
  });
});

test("context pins Task revision, full basis original, Git and Wiki; stale Wiki yields partial", async () => {
  const root = `/api/projects/${projectId}`;
  const task = { projectId, id: taskId, version: 1, currentRevisionId: taskRevisionId, title: "Task", content: bytes.toString("utf8"), contentDocumentId: documentId, contentRevisionId: documentRevisionId, kind: null, acceptance: "Accept", owner: "Agent", state: "in_progress" };
  const selected = { projectId, taskId, id: taskRevisionId, version: 1, title: "Task", content: bytes.toString("utf8"), contentDocumentId: documentId, contentRevisionId: documentRevisionId, kind: null, acceptance: "Accept", owner: "Agent", state: "in_progress", basisSetId: id(8), actorId: "owner", reason: "initial", createdAt: "2026-01-01T00:00:00Z" };
  const basis = { projectId, taskId, taskRevisionId, id: id(8), sealed: true, members: [{ documentId, revisionId: documentRevisionId }] };
  const gitBody = "Git fixed source\n";
  const wikiBody = "Wiki fixed source\n";
  const git = { projectId, id: id(11), taskId, taskRevisionId, slotId: id(12), version: 1, decision: "adopt", kind: "git", referenceId: gitId, revision: "a".repeat(40), contentHash: sha(gitBody), reason: "read", actionImpact: "change", actorId: "owner", createdAt: "2026-01-01T00:00:00Z", observedCurrentRevision: "a".repeat(40), observedCurrentHash: sha(gitBody), observedCurrentValidity: "valid" };
  const wiki = { ...git, id: id(13), slotId: id(14), kind: "wiki", referenceId: wikiId, revision: id(15), contentHash: sha(wikiBody), observedCurrentRevision: id(15), observedCurrentHash: sha(wikiBody) };
  const page = { projectId, knowledgeId: wikiId, revision: id(15), body: wikiBody, contentHash: sha(wikiBody), validity: "valid", observedValidity: "valid" };
  const responses: Record<string, unknown> = {
    [`${root}/tasks/${taskId}`]: { task, revision: selected, basis },
    [`${root}/tasks/${taskId}/revisions`]: [{ revision: selected, basis }],
    [originalPath]: originalResponse(),
    [`${root}/references/tasks/${taskId}/revisions/${taskRevisionId}`]: [git, wiki],
    [`${root}/references/git/${gitId}`]: { status: "available", ref: { projectId, commit: git.revision, contentHash: git.contentHash }, base64: Buffer.from(gitBody).toString("base64") },
    [`${root}/knowledge/pages/${wikiId}?revision=${wiki.revision}`]: page,
    [`${root}/knowledge/pages/${wikiId}`]: page,
  };
  const api = client(responses);
  const complete = await readTaskContext(api, projectId, taskId);
  assert.equal(complete.status, "complete");
  assert.equal(complete.documents[0]?.body, bytes.toString("utf8"));
  assert.deepEqual(complete.externalReferences.map(x => x.body), [gitBody, wikiBody]);
  assert.equal(api.seen.every(path => path.startsWith("/api/")), true);
  responses[`${root}/knowledge/pages/${wikiId}`] = { ...page, revision: id(16) };
  const partial = await readTaskContext(client(responses), projectId, taskId);
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.externalReferences.map(x => x.body), [gitBody]);
  assert.equal(partial.failures[0]?.kind, "wiki");
});

test("a missing fixed basis original never becomes a complete context", async () => {
  const root = `/api/projects/${projectId}`;
  const task = { projectId, id: taskId, version: 2, currentRevisionId: id(20), title: "Task", content: bytes.toString("utf8"), contentDocumentId: documentId, contentRevisionId: documentRevisionId, kind: null, acceptance: "Accept", owner: "Agent", state: "in_progress" };
  const current = { projectId, taskId, id: id(20), version: 2, basisSetId: null, content: bytes.toString("utf8"), contentDocumentId: documentId, contentRevisionId: documentRevisionId };
  const old = { projectId, taskId, id: taskRevisionId, version: 1, basisSetId: id(8), content: bytes.toString("utf8"), contentDocumentId: documentId, contentRevisionId: documentRevisionId };
  const basis = { projectId, taskId, taskRevisionId, id: id(8), sealed: true, members: [{ documentId, revisionId: documentRevisionId }] };
  const api = client({
    [`${root}/tasks/${taskId}`]: { task, revision: current, basis: null },
    [`${root}/tasks/${taskId}/revisions/${taskRevisionId}`]: { revision: old, basis },
    [`${root}/tasks/${taskId}/revisions`]: [{ revision: old, basis }, { revision: current, basis: null }],
    [`${root}/references/tasks/${taskId}/revisions/${taskRevisionId}`]: [],
  });
  const context = await readTaskContext(api, projectId, taskId, taskRevisionId);
  assert.equal(context.taskRevisionId, taskRevisionId);
  assert.equal(context.status, "partial");
  assert.equal(context.documents.length, 0);
  assert.equal(context.failures[0]?.kind, "document");
  assert.equal(api.seen.some(path => path.includes(`/documents/${documentId}/revisions/${documentRevisionId}/original`)), true);
  assert.equal(api.seen.some(path => path.includes(`/references/tasks/${taskId}/revisions/${id(20)}`)), false);
});

test("combined basis originals over 16 MiB stay partial with every omitted fixed revision named", async () => {
  const root = `/api/projects/${projectId}`;
  const largeBody = "x".repeat(8 * 1024 * 1024 + 1);
  const members = [31, 32, 33].map((n, index) => ({ documentId: id(n), revisionId: id(n + 10), index }));
  const task = { projectId, id: taskId, version: 1, currentRevisionId: taskRevisionId };
  const selected = { projectId, taskId, id: taskRevisionId, version: 1, basisSetId: id(8), content: largeBody, contentDocumentId: members[0]!.documentId, contentRevisionId: members[0]!.revisionId };
  const basis = { projectId, taskId, taskRevisionId, id: id(8), sealed: true,
    members: members.map(({ documentId, revisionId }) => ({ documentId, revisionId })) };
  const responses: Record<string, unknown> = {
    [`${root}/tasks/${taskId}`]: { task, revision: selected, basis },
    [`${root}/tasks/${taskId}/revisions`]: [{ revision: selected, basis }],
    [`${root}/references/tasks/${taskId}/revisions/${taskRevisionId}`]: [],
  };
  for (const member of members) responses[`${root}/documents/${member.documentId}/revisions/${member.revisionId}/original`] = {
    status: "available", body: largeBody, assets: [], revision: { projectId, documentId: member.documentId, id: member.revisionId,
      format: "markdown", mediaType: "text/markdown", originalName: "source.md", body: largeBody, payloadRef: null,
      contentHash: sha(largeBody), assetsManifest: [], entrypoint: null },
  };
  const api = client(responses);
  const result = await readTaskContext(api, projectId, taskId);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.documents.map(item => item.revision.id), [members[0]!.revisionId]);
  assert.deepEqual(result.failures.map(item => [item.id, item.revisionId]), members.slice(1).map(item => [item.documentId, item.revisionId]));
  assert.match(result.failures[0]!.reason, /16 MiB/);
  assert.match(result.failures[1]!.reason, /not read/);
  assert.equal(api.seen.includes(`${root}/documents/${members[2]!.documentId}/revisions/${members[2]!.revisionId}/original`), false);
});


test("todo context reads the fixed primary without precreated reference docs and detects projection drift", async () => {
  const root = `/api/projects/${projectId}`;
  const selected = { projectId, taskId, id: taskRevisionId, version: 1, basisSetId: null,
    content: bytes.toString("utf8"), contentDocumentId: documentId, contentRevisionId: documentRevisionId };
  const task = { projectId, id: taskId, currentRevisionId: taskRevisionId, state: "todo", ...selected };
  const responses: Record<string, unknown> = {
    [`${root}/tasks/${taskId}`]: { task: { ...task, id: taskId }, revision: selected, basis: null },
    [`${root}/tasks/${taskId}/revisions`]: [{ revision: selected, basis: null }],
    [`${root}/references/tasks/${taskId}/revisions/${taskRevisionId}`]: [], [originalPath]: originalResponse(),
  };
  const result = await readTaskContext(client(responses), projectId, taskId);
  assert.equal(result.status, "complete");
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0]!.revision.id, documentRevisionId);
  responses[`${root}/tasks/${taskId}`] = { task: { ...task, id: taskId }, revision: { ...selected, content: "different projection" }, basis: null };
  const partial = await readTaskContext(client(responses), projectId, taskId);
  assert.equal(partial.status, "partial");
  assert.match(partial.failures[0]!.reason, /projection differs/);
});
