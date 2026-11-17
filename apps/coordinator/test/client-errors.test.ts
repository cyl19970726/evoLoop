// Task c3a8e5d1: what the page boundary posts is bounded and redacted before it is stored, any project reader can leave and read it, and a body that carries more than the
// agreed fields is refused (so a page cannot send Session text by adding a field).
import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowService } from "@evoloop/core";
import type { Reader, UnitOfWork } from "@evoloop/contracts/ports";
import { buildServer } from "../src/server.js";
import { authConfigSchema } from "../src/auth.js";
import { clientRenderErrorSchema, redactTokenLike, sanitizeClientRenderError, type ClientErrorStore, type ClientRenderErrorRecord } from "../src/client-errors/index.js";

const projectId = "00000000-0000-4000-8000-000000000201", otherProject = "00000000-0000-4000-8000-000000000202";
const reader = "r".repeat(43), outsider = "o".repeat(43);
const credentials = authConfigSchema.parse([
  { token: reader, actorId: "viewer", projectIds: [projectId], permissions: [] },
  { token: outsider, actorId: "outsider", projectIds: [otherProject], permissions: [] },
]);
const now = new Date("2026-11-17T08:00:00.000Z");
const hubIdentity = `v1.${"a".repeat(60)}.${"b".repeat(40)}`;

test("token-like text is cut, ids and commits are kept", () => {
  assert.equal(redactTokenLike(`Authorization: Bearer ${reader} failed`), "Authorization: Bearer [已隐去] failed");
  assert.equal(redactTokenLike(`/sessions?session=owned%3A${"1".repeat(8)}-aaaa-4bbb-8ccc-${"2".repeat(12)}&token=${reader}`), `/sessions?session=owned%3A${"1".repeat(8)}-aaaa-4bbb-8ccc-${"2".repeat(12)}&token=[已隐去]`);
  assert.equal(redactTokenLike(`identity ${hubIdentity} rejected`), "identity [已隐去] rejected");
  assert.equal(redactTokenLike(`secret ${"Z9".repeat(20)}`), "secret [已隐去]", "a 40-character run is cut");
  const commit = "a5a397b0b28c77d1a9fde8f7c433d161924c991e", uuid = "3874b03b-4b0f-442b-9f9c-6118ab7f985f";
  assert.equal(redactTokenLike(`${commit} ${uuid} TypeError: x is not iterable`), `${commit} ${uuid} TypeError: x is not iterable`);
});

test("every field is bounded; the route loses its fragment; a bad commit or a future time is replaced", () => {
  const input = clientRenderErrorSchema.parse({ route: `/p/x/sessions?session=1#frag`, message: "word ".repeat(1000), componentStack: "\n    at A".repeat(1000), commit: "not-a-commit", occurredAt: "2027-01-01T00:00:00.000Z" });
  const value = sanitizeClientRenderError(input, now);
  assert.equal(value.route, "/p/x/sessions?session=1");
  assert.equal(value.message.length, 600); assert.ok(value.componentStack.length <= 2400);
  assert.equal(value.commit, null);
  assert.equal(value.occurredAt, now.toISOString(), "a time in the future is the time of receipt");
});

test("the body takes only the agreed fields", () => {
  assert.throws(() => clientRenderErrorSchema.parse({ route: "/", message: "m", sessionContent: "hello" }), /unrecognized|Unrecognized/i);
  assert.throws(() => clientRenderErrorSchema.parse({ route: "/" }));
});

function serviceFor() {
  const uow = { read: async <T>(scope: string, action: (reader: Reader) => Promise<T>) => action({
    getProject: async () => scope === projectId ? { id: projectId, title: "P", createdAt: "2026-11-10T00:00:00.000Z" } : null } as unknown as Reader) } as unknown as UnitOfWork;
  return new WorkflowService({ uow, clock: { now: () => now.toISOString() }, ids: { next: () => projectId }, hasher: { hash: () => "" } });
}
function memoryStore() {
  const rows: ClientRenderErrorRecord[] = [];
  const store: ClientErrorStore = { async record(_project, actorId, input) {
    const value = sanitizeClientRenderError(input, now), record = { id: `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`, actorId, ...value, recordedAt: now.toISOString() };
    rows.unshift(record); return { record, duplicate: false };
  }, async list(_project, limit = 20) { return rows.slice(0, limit); } } as ClientErrorStore;
  return { store, rows };
}

test("a project reader leaves a record and reads it back; the stored text is redacted; others are refused", async () => {
  const { store, rows } = memoryStore();
  const app = await buildServer({ credentials, service: serviceFor(), clientErrors: store });
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  try {
    const body = { route: `/p/${projectId}/sessions?session=owned%3A1`, message: `TypeError: boom while using Bearer ${reader}`, componentStack: "\n    at SessionWorkspace\n    at PageBoundary", commit: "a5a397b0b28c77d1a9fde8f7c433d161924c991e", occurredAt: now.toISOString() };
    assert.equal((await app.inject({ method: "POST", url: `/api/projects/${projectId}/client-errors`, payload: body })).statusCode, 401, "no login, no record");
    const posted = await app.inject({ method: "POST", url: `/api/projects/${projectId}/client-errors`, headers: headers(reader), payload: body });
    assert.equal(posted.statusCode, 200, posted.body);
    const id = posted.json().id;
    const listed = await app.inject({ url: `/api/projects/${projectId}/client-errors`, headers: headers(reader) });
    assert.equal(listed.statusCode, 200, listed.body);
    const [first] = listed.json().items;
    assert.equal(first.id, id); assert.equal(first.actorId, "viewer");
    assert.match(first.message, /Bearer \[已隐去\]/); assert.ok(!first.message.includes(reader), "the token is not in the stored message");
    assert.deepEqual([first.route, first.commit, first.componentStack], [body.route, body.commit, body.componentStack]);
    assert.equal(rows.length, 1);
    const extra = await app.inject({ method: "POST", url: `/api/projects/${projectId}/client-errors`, headers: headers(reader), payload: { ...body, sessionContent: "hello" } });
    assert.ok(extra.statusCode >= 400 && extra.statusCode < 500, "an extra field is refused");
    assert.equal(rows.length, 1);
    const foreign = await app.inject({ url: `/api/projects/${projectId}/client-errors`, headers: headers(outsider) });
    assert.ok(foreign.statusCode === 403 || foreign.statusCode === 404, `another project's member cannot read (${foreign.statusCode})`);
  } finally { await app.close(); }
});
