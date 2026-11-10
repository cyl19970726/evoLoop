import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowService } from "@evoloop/core";
import type { Document, DocumentRevisionMetadata, Page } from "@evoloop/contracts";
import { DomainError, type Reader, type UnitOfWork } from "@evoloop/contracts/ports";
import { buildServer } from "../src/server.js";
import { authConfigSchema } from "../src/auth.js";

const projectId = "00000000-0000-4000-8000-000000000101";
const foreignProjectId = "00000000-0000-4000-8000-000000000102";
const documentId = "00000000-0000-4000-8000-000000000103";
const foreignDocumentId = "00000000-0000-4000-8000-000000000104";
const [r1, r2] = ["00000000-0000-4000-8000-000000000105", "00000000-0000-4000-8000-000000000106"];
const reader = "r".repeat(40), writerOnly = "w".repeat(40);
const credentials = authConfigSchema.parse([
  { token: reader, actorId: "doc-reader", projectIds: [projectId], permissions: ["read"] },
  { token: writerOnly, actorId: "doc-writer", projectIds: [projectId], permissions: ["write"] },
]);
const head: Document = { projectId, id: documentId, title: "Spec", version: 3, currentRevisionId: r2,
  adoptedRevisionId: r1, kind: "spec", status: "published" };
const metadata = (id: string, revisionNumber: number, previousRevisionId: string | null): DocumentRevisionMetadata => ({
  projectId, documentId, id, revisionNumber, format: "markdown", mediaType: "text/markdown", originalName: `${documentId}.md`,
  payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: "a".repeat(64), author: "doc-writer",
  createdAt: `2026-11-10T00:00:0${revisionNumber}.000Z`, previousRevisionId, reason: `r${revisionNumber}` });

/** The real core read over a one-project store: documents of other projects are simply absent. */
function service(calls: Array<{ projectId: string; documentId: string; limit: number; cursor: string | undefined }>) {
  const uow = { read: async <T>(scope: string, action: (reader: Reader) => Promise<T>) => action({
    getProject: async () => scope === projectId ? { id: projectId, title: "P", createdAt: "2026-11-10T00:00:00.000Z" } : null,
    getDocument: async (id: string) => scope === projectId && id === documentId ? head : null,
    listDocumentRevisions: async (id: string, limit: number, cursor?: string): Promise<Page<DocumentRevisionMetadata> & { revisionCount: number }> => {
      calls.push({ projectId: scope, documentId: id, limit, cursor });
      if (cursor === "stale") throw new DomainError("INVALID_CURSOR", "cursor belongs to another document");
      return { items: [metadata(r2, 2, r1), metadata(r1, 1, null)], nextCursor: null, revisionCount: 2 };
    },
  } as unknown as Reader) } as unknown as UnitOfWork;
  return new WorkflowService({ uow, clock: { now: () => "2026-11-10T00:00:00.000Z" }, ids: { next: () => projectId }, hasher: { hash: () => "" } });
}

test("document revision list requires project read access and returns metadata pages", async () => {
  const calls: Array<{ projectId: string; documentId: string; limit: number; cursor: string | undefined }> = [];
  const app = await buildServer({ credentials, service: service(calls) });
  const get = (path: string, token?: string) => app.inject({ url: `/api/projects/${path}`,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  try {
    assert.equal((await get(`${projectId}/documents/${documentId}/revisions`)).statusCode, 401);
    const read = await get(`${projectId}/documents/${documentId}/revisions`, reader);
    assert.equal(read.statusCode, 200, read.body);
    const page = read.json();
    assert.deepEqual(page.items.map((item: { id: string; state: string; revisionNumber: number }) => [item.id, item.state, item.revisionNumber]),
      [[r2, "current", 2], [r1, "published", 1]]);
    assert.deepEqual(page.document, { id: documentId, title: "Spec", kind: "spec", version: 3, currentRevisionId: r2,
      adoptedRevisionId: r1, status: "published" });
    assert.equal(page.revisionCount, 2);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(calls.at(-1), { projectId, documentId, limit: 50, cursor: undefined }, "limit defaults to 50");
    const cursor = Buffer.from("opaque").toString("base64url");
    assert.equal((await get(`${projectId}/documents/${documentId}/revisions?limit=100&cursor=${cursor}`, reader)).statusCode, 200);
    assert.deepEqual(calls.at(-1), { projectId, documentId, limit: 100, cursor });

    const forbidden = await get(`${projectId}/documents/${documentId}/revisions`, writerOnly);
    assert.equal(forbidden.statusCode, 403, "write permission alone cannot read history");
    assert.equal((await get(`${foreignProjectId}/documents/${foreignDocumentId}/revisions`, reader)).statusCode, 403);
    const missing = await get(`${projectId}/documents/${foreignDocumentId}/revisions`, reader);
    assert.equal(missing.statusCode, 404, "a document outside this project is not found");
    assert.equal(missing.json().code, "NOT_FOUND");
    const stale = await get(`${projectId}/documents/${documentId}/revisions?cursor=stale`, reader);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, "INVALID_CURSOR");
    const before = calls.length;
    for (const query of ["limit=0", "limit=101", "limit=x", `cursor=${"c".repeat(513)}`])
      assert.equal((await get(`${projectId}/documents/${documentId}/revisions?${query}`, reader)).statusCode, 400, query);
    assert.equal((await get(`${projectId}/documents/not-an-id/revisions`, reader)).statusCode, 400);
    assert.equal(calls.length, before, "invalid requests never reach storage");
  } finally { await app.close(); }
});
