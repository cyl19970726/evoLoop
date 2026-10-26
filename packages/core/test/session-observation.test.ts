import assert from "node:assert/strict";
import test from "node:test";
import type { Principal } from "@evoloop/contracts";
import type { Reader, UnitOfWork } from "@evoloop/contracts/ports";
import { SessionObservationService } from "../src/session-observation/index.ts";

const projectId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const linkId = "00000000-0000-4000-8000-000000000003";
const key = `external:${linkId}`;
const principal: Principal = { actorId: "reader", projectIds: [projectId], permissions: ["write", "read"] };

function fixture() {
  let calls = 0;
  let scope = "";
  const snapshot = { session: { target: { kind: "external", linkId } } };
  const store = { getSessionProfile: async () => ({ displayName: "Specific chat" }),
    listSessionProfileHistory: async () => ({ items: [], nextCursor: null }),
    getTaskSessionAssignment: async () => ({ taskId, recipientActorId: "reader" }),
    listTaskSessionAssignmentHistory: async () => ({ items: [], nextCursor: null }) };
  const reader = { getProject: async () => ({ id: projectId }), getTask: async (value: string) => value === taskId ? { projectId, id: taskId } : null,
    sessionAssignments: store,
    sessionObservation: (value: string) => { scope = value; return {
      directory: async () => ({ items: [], nextCursor: null }),
      snapshot: async (value: string) => value === key ? snapshot : null,
      history: async (value: string) => value === key ? { items: [], nextCursor: null } : null,
      changes: async () => ({ items: [], nextCursor: "1", hasMore: false, resetRequired: false }),
    }; } } as unknown as Reader;
  const uow = { read: async (_project: string, action: (reader: Reader) => Promise<unknown>) => {
    calls++; return action(reader);
  } } as UnitOfWork;
  return { service: new SessionObservationService({ uow }), get calls() { return calls; }, get scope() { return scope; }, reader };
}

test("every read checks actual project scope before touching the store", async () => {
  const f = fixture();
  await assert.rejects(f.service.directory({ ...principal, projectIds: [] }, projectId, { limit: 50 }), { code: "FORBIDDEN" });
  await assert.rejects(f.service.assignment({ ...principal, permissions: ["write"] }, projectId, taskId), { code: "FORBIDDEN" });
  assert.equal(f.calls, 0);
  await f.service.directory(principal, projectId, { limit: 50 });
  assert.equal(f.calls, 1);
  assert.deepEqual(JSON.parse(f.scope), { actorId: "reader", permissions: ["read", "write"] });
});

test("profile resolves an exact Session target and unknown Session or Task fails closed", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.profile(principal, projectId, key), { displayName: "Specific chat" });
  await assert.rejects(f.service.profile(principal, projectId, `external:00000000-0000-4000-8000-000000000099`),
    { code: "NOT_FOUND" });
  await assert.rejects(f.service.assignment(principal, projectId, "00000000-0000-4000-8000-000000000099"),
    { code: "NOT_FOUND" });
});
