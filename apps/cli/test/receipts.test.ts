import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson } from "@evoloop/core";
import { ApiClient, CliApiError } from "../src/client.js";
import { dispatchMutation, reconcileReceipt, retryReceipt, ReceiptError, ReceiptStore, type Intent, type VerifiedActor } from "../src/receipts.js";

const apiUrl = "http://127.0.0.1:55337";
const token = "private-fixture-token";
const projectId = randomUUID();
const entityId = randomUUID();
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const client = (fetch: typeof globalThis.fetch) => new ApiClient({ apiUrl, token, fetch });
const clientFor = (credential: string, fetch: typeof globalThis.fetch) => new ApiClient({ apiUrl, token: credential, fetch });
const verifiedActor = (actorId: string, projectIds: string[] = [projectId]): VerifiedActor => ({ actorId, projectIds });
const coreIntent = (): Intent => {
  const operationId = randomUUID();
  return { id: randomUUID(), projectId, operationId, kind: "task.revise", path: "/api/commands",
    body: { projectId, operationId, type: "task.revise", taskId: entityId },
    recovery: { kind: "core", path: `/api/projects/${projectId}/operations/${operationId}` }, confirmation: "command" };
};
const retryableIntent = (): Intent => {
  const intent = coreIntent();
  return { ...intent, kind: "project.create", body: { projectId, operationId: intent.operationId,
    type: "project.create", title: "Recover the original intent" } };
};
const leaderPlanIntent = (): Intent => {
  const operationId = randomUUID();
  return { id: randomUUID(), projectId, operationId, kind: "work.plan.set", targetId: entityId,
    path: `/api/projects/${projectId}/work-management/tasks/${entityId}/plan`,
    body: { operationId, expectedTaskVersion: 1, expectedPlanVersion: 0, plannedStartAt: null,
      dueAt: null, priority: 2, reason: "Leader ordered this work" },
    recovery: { kind: "core", path: `/api/projects/${projectId}/operations/${operationId}` }, confirmation: "command" };
};
async function temporaryStore(t: import("node:test").TestContext): Promise<ReceiptStore> {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-receipts-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new ReceiptStore(directory);
}
const pendingError = (error: unknown): boolean => {
  assert.ok(error instanceof ReceiptError);
  assert.equal(error.code, "RESULT_UNCONFIRMED");
  return true;
};

test("lost successful POST response keeps its local ID and reconciles by the distinct backend operation ID", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  let posts = 0, gets = 0;
  const transport = client(async (url, init) => {
    if (init?.method === "POST") { posts++; throw new Error("reply lost after server commit"); }
    gets++;
    assert.equal((url as URL).pathname, intent.recovery.path);
    return response({ id: intent.operationId, projectId, result: { status: "applied", operationId: intent.operationId, entityId } });
  });
  await assert.rejects(() => dispatchMutation(transport, store, apiUrl, token, intent, () => {}), pendingError);
  await assert.rejects(() => dispatchMutation(transport, store, apiUrl, token, intent, () => {}), pendingError);
  assert.equal(posts, 1, "a pending intent must not be dispatched again");
  const recovered = await reconcileReceipt(transport, store, apiUrl, token, intent.id);
  assert.equal(recovered.state, "confirmed");
  assert.equal(gets, 1);
  assert.equal((await store.get(intent.id)).operationId, intent.operationId);
  assert.notEqual(intent.id, intent.operationId);
  assert.deepEqual(await dispatchMutation(transport, store, apiUrl, token, intent, () => {}), recovered.result);
  assert.equal(posts, 1);
});

test("a 404 during readback remains pending and never proves the write failed", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  const prepared = await store.prepare(apiUrl, token, intent);
  assert.equal(prepared.existing, false);
  const transport = client(async () => response({ code: "NOT_FOUND", message: "not indexed yet" }, 404));
  await assert.rejects(() => reconcileReceipt(transport, store, apiUrl, token, intent.id), pendingError);
  assert.equal((await store.get(intent.id)).state, "pending");
});

test("explicit core retry reads back first and returns an already committed result without POST", async t => {
  const store = await temporaryStore(t), intent = retryableIntent();
  await store.prepare(apiUrl, token, intent, verifiedActor("original-agent"));
  let gets = 0;
  const transport = client(async (_url, init) => {
    assert.equal(init?.method, "GET"); gets++;
    return response({ id: intent.operationId, projectId, actorId: "original-agent", commandType: intent.kind,
      commandHash: createHash("sha256").update(canonicalJson({ actorId: "original-agent", command: intent.body })).digest("hex"),
      result: { status: "applied", operationId: intent.operationId, entityId } });
  });
  assert.equal((await retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, verifiedActor("original-agent"))).state, "confirmed");
  assert.equal((await retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, verifiedActor("original-agent"))).state, "confirmed");
  assert.equal(gets, 1);
});

test("explicit core retry after an unconfirmed missing operation sends the same ID and exact saved body once", async t => {
  const store = await temporaryStore(t), intent = retryableIntent();
  await store.prepare(apiUrl, token, intent, verifiedActor("original-agent"));
  const methods: string[] = [];
  const transport = client(async (url, init) => {
    methods.push(init!.method!);
    if (init?.method === "GET") {
      assert.equal((url as URL).pathname, intent.recovery.path);
      return response({ code: "OPERATION_NOT_FOUND" }, 404);
    }
    assert.equal((url as URL).pathname, "/api/commands");
    assert.deepEqual(JSON.parse(String(init?.body)), intent.body);
    return response({ status: "applied", operationId: intent.operationId, entityId });
  });
  const result = await retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, verifiedActor("original-agent"));
  assert.equal(result.state, "confirmed");
  assert.equal(result.operationId, intent.operationId);
  assert.equal(result.requestHash, (await store.get(intent.id)).requestHash);
  assert.deepEqual(methods, ["GET", "POST"]);
});

test("Leader planning requests reconcile and replay through their exact route", async t => {
  const store = await temporaryStore(t), intent = leaderPlanIntent(), actor = verifiedActor("original-agent");
  await store.prepare(apiUrl, token, intent, actor);
  const command = { ...intent.body as object, projectId, taskId: entityId };
  let gets = 0, posts = 0;
  const transport = client(async (url, init) => {
    if (init?.method === "GET") {
      gets++;
      return response({ code: "OPERATION_NOT_FOUND" }, 404);
    }
    posts++;
    assert.equal((url as URL).pathname, intent.path);
    assert.deepEqual(JSON.parse(String(init?.body)), intent.body);
    return response({ status: "applied", operationId: intent.operationId, entityId, version: 1 });
  });
  const published = await retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, actor);
  assert.equal(published.state, "confirmed");
  assert.equal(gets, 1);
  assert.equal(posts, 1);
  const replay = leaderPlanIntent(), actor2 = actor;
  await store.prepare(apiUrl, token, replay, actor2);
  const replayCommand = { ...replay.body as object, projectId, taskId: entityId };
  const committed = client(async (_url, init) => {
    assert.equal(init?.method, "GET");
    return response({ id: replay.operationId, projectId, actorId: "original-agent", commandType: replay.kind,
      commandHash: createHash("sha256").update(canonicalJson({ ...replayCommand, actorId: "original-agent" })).digest("hex"),
      result: { status: "applied", operationId: replay.operationId, entityId, version: 1 } });
  });
  assert.equal((await retryReceipt(committed, store, apiUrl, token, replay.id, () => {}, actor2)).state, "confirmed");
});

test("retry does not POST after unavailable, denied, malformed or unrelated not-found readback", async t => {
  for (const [body, status] of [[{ code: "UNAVAILABLE" }, 503], [{ code: "FORBIDDEN" }, 403],
    [{ code: "NOT_FOUND" }, 404], [{ id: randomUUID(), projectId, result: { status: "applied" } }, 200]] as const) {
    const store = await temporaryStore(t), intent = retryableIntent();
    await store.prepare(apiUrl, token, intent, verifiedActor("original-agent"));
    const transport = client(async (_url, init) => {
      assert.equal(init?.method, "GET"); return response(body, status);
    });
    await assert.rejects(() => retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, verifiedActor("original-agent")), pendingError);
    assert.equal((await store.get(intent.id)).state, "pending");
  }
});

test("retry refuses external mutations, altered saved intents and a different authenticated actor", async t => {
  const store = await temporaryStore(t), intent = retryableIntent();
  const actor = verifiedActor("original-agent");
  await store.prepare(apiUrl, token, intent, actor);
  const transport = client(async () => { throw new Error("no network mutation is permitted"); });
  await assert.rejects(() => retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, verifiedActor("other-agent")),
    error => error instanceof ReceiptError && error.code === "RECEIPT_SCOPE_MISMATCH");
  const external = { ...retryableIntent(), path: `/api/projects/${projectId}/documents/import` };
  await store.prepare(apiUrl, token, external);
  await assert.rejects(() => retryReceipt(transport, store, apiUrl, token, external.id, () => {}),
    error => error instanceof ReceiptError && error.code === "RETRY_UNSUPPORTED");
  const receipt = await store.get(intent.id);
  await writeFile(join(store.directory, `${intent.id}.json`), JSON.stringify({ ...receipt,
    body: { ...receipt.body as object, title: "Changed after the failure" } }));
  await assert.rejects(() => retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, actor),
    error => error instanceof ReceiptError && error.code === "INVALID_RECEIPT");
});

test("retry requires both a recorded original actor and a matching verified current actor", async t => {
  const store = await temporaryStore(t), legacy = retryableIntent(), current = retryableIntent();
  await store.prepare(apiUrl, token, legacy);
  await store.prepare(apiUrl, token, current, verifiedActor("original-agent"));
  const transport = client(async () => { throw new Error("unverified actor must not read or replay a receipt"); });
  for (const [intent, actor] of [[legacy, verifiedActor("remapped-token-actor")], [current, undefined]] as const) {
    await assert.rejects(() => retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, actor),
      error => error instanceof ReceiptError && error.code === "RETRY_UNSUPPORTED");
    assert.equal((await store.get(intent.id)).state, "pending");
  }
});

test("a replayed command can reject its original baseline without changing or resubmitting the intent", async t => {
  const store = await temporaryStore(t), intent = retryableIntent();
  await store.prepare(apiUrl, token, intent, verifiedActor("original-agent"));
  let posts = 0;
  const transport = client(async (_url, init) => {
    if (init?.method === "GET") return response({ code: "OPERATION_NOT_FOUND" }, 404);
    posts++; assert.deepEqual(JSON.parse(String(init?.body)), intent.body);
    return response({ status: "rejected", operationId: intent.operationId, code: "VERSION_CONFLICT", currentVersion: 4 }, 409);
  });
  await assert.rejects(() => retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, verifiedActor("original-agent")),
    error => error instanceof ReceiptError && error.code === "OPERATION_REJECTED");
  assert.equal((await store.get(intent.id)).state, "rejected");
  assert.equal((await retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, verifiedActor("original-agent"))).state, "rejected");
  assert.equal(posts, 1);
});

test("a retry-time HTTP denial cannot settle an earlier unknown command", async t => {
  const store = await temporaryStore(t), intent = retryableIntent();
  await store.prepare(apiUrl, token, intent, verifiedActor("original-agent"));
  const transport = client(async (_url, init) => init?.method === "GET"
    ? response({ code: "OPERATION_NOT_FOUND" }, 404) : response({ code: "FORBIDDEN" }, 403));
  await assert.rejects(() => retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, verifiedActor("original-agent")), pendingError);
  assert.equal((await store.get(intent.id)).state, "pending");
});

test("a same-ID operation for a different saved command cannot confirm or trigger a retry", async t => {
  const store = await temporaryStore(t), intent = retryableIntent(), actor = verifiedActor("original-agent");
  await store.prepare(apiUrl, token, intent, actor);
  const transport = client(async (_url, init) => {
    assert.equal(init?.method, "GET");
    return response({ id: intent.operationId, projectId, actorId: actor.actorId, commandType: intent.kind, commandHash: "0".repeat(64),
      result: { status: "applied", operationId: intent.operationId, entityId } });
  });
  await assert.rejects(() => retryReceipt(transport, store, apiUrl, token, intent.id, () => {}, actor), pendingError);
  assert.equal((await store.get(intent.id)).state, "pending");
});

test("known 409 preserves server code and rejection, without retry", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  let posts = 0;
  const transport = client(async () => { posts++; return response({ code: "VERSION_CONFLICT", currentVersion: 4 }, 409); });
  await assert.rejects(() => dispatchMutation(transport, store, apiUrl, token, intent, () => {}), error => {
    assert.ok(error instanceof CliApiError);
    assert.equal(error.code, "VERSION_CONFLICT");
    assert.equal(error.unconfirmed, false);
    return true;
  });
  assert.equal((await store.get(intent.id)).state, "rejected");
  await assert.rejects(() => dispatchMutation(transport, store, apiUrl, token, intent, () => {}), error =>
    error instanceof ReceiptError && error.code === "OPERATION_REJECTED");
  assert.equal(posts, 1);
});

test("private receipt retains the intent body but never stores the auth token", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  await store.prepare(apiUrl, token, intent);
  const path = join(store.directory, `${intent.id}.json`);
  const raw = await readFile(path, "utf8");
  assert.match(raw, /task\.revise/);
  assert.doesNotMatch(raw, /private-fixture-token/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(store.directory)).mode & 0o077, 0);
});

test("same local receipt ID cannot silently change recovery, confirmation, or backend operation", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  await store.prepare(apiUrl, token, intent);
  for (const changed of [
    { ...intent, recovery: { kind: "manual" as const, path: "/api/other" } },
    { ...intent, confirmation: "ack" as const },
    { ...intent, operationId: randomUUID() },
  ]) {
    await assert.rejects(() => store.prepare(apiUrl, token, changed), error =>
      error instanceof ReceiptError && error.code === "OPERATION_REUSE");
  }
  await assert.rejects(() => store.prepare("https://other.test", token, intent), error =>
    error instanceof ReceiptError && error.code === "RECEIPT_SCOPE_MISMATCH");
});

test("exclusive concurrent prepare yields one complete intent without a partial read", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => store.prepare(apiUrl, token, intent)));
  assert.ok(attempts.every(item => item.status === "fulfilled"), JSON.stringify(attempts.filter(item => item.status === "rejected").map(item => String(item.reason))));
  assert.equal(attempts.filter(item => item.status === "fulfilled" && !item.value.existing).length, 1);
  assert.equal((await store.get(intent.id)).state, "pending");
});

test("terminal receipt cannot regress to another terminal state through a stale update", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  const { receipt } = await store.prepare(apiUrl, token, intent);
  await store.update(receipt, { state: "confirmed", result: { status: "applied", operationId: intent.operationId, entityId } });
  const stale = await store.update(receipt, { state: "rejected", result: { status: "rejected", operationId: intent.operationId } });
  assert.equal(stale.state, "confirmed");
  assert.equal((await store.get(intent.id)).state, "confirmed");
});

test("knowledge publish readback uses its dedicated reconcile route, never a core operation receipt", async t => {
  const store = await temporaryStore(t), operationId = randomUUID();
  const intent: Intent = { id: randomUUID(), projectId, operationId, kind: "knowledge.publish",
    path: `/api/projects/${projectId}/knowledge/candidates/${randomUUID()}/publish`, body: { operationId },
    recovery: { kind: "publish", path: `/api/projects/${projectId}/knowledge/operations/${operationId}/reconcile` },
    confirmation: "publish" };
  await store.prepare(apiUrl, token, intent);
  const paths: string[] = [];
  let phase: "unknown" | "conflict" | "published" = "unknown";
  const transport = client(async (url, init) => {
    paths.push((url as URL).pathname);
    assert.equal(init?.method, "POST");
    return response({ result: phase === "unknown" ? { status: "unknown", operationId, reason: "pending" } :
      phase === "conflict" ? { status: "conflict", operationId, currentRevision: randomUUID() } :
        { status: "published", operationId, revision: randomUUID() } });
  });
  await assert.rejects(() => reconcileReceipt(transport, store, apiUrl, token, intent.id), pendingError);
  assert.equal((await store.get(intent.id)).state, "pending");
  phase = "published";
  const done = await reconcileReceipt(transport, store, apiUrl, token, intent.id);
  assert.equal(done.state, "confirmed");
  assert.deepEqual(paths, [intent.recovery.path, intent.recovery.path]);
});

test("candidate readback confirms only the exact fixed candidate revision and content", async t => {
  const store = await temporaryStore(t), operationId = randomUUID(), candidateId = randomUUID();
  const candidateRevision = randomUUID(), knowledgeId = randomUUID(), body = "fixed candidate body";
  const intent: Intent = { id: randomUUID(), projectId, operationId, kind: "knowledge.propose",
    path: `/api/projects/${projectId}/knowledge/candidates`,
    body: { projectId, operationId, candidateId, candidateRevision, knowledgeId, body },
    recovery: { kind: "candidate", path: `/api/projects/${projectId}/knowledge/candidates/${candidateId}` },
    confirmation: "candidate" };
  await store.prepare(apiUrl, token, intent);
  const paths: string[] = [];
  const observed = { operationId, candidateId, candidateRevision, knowledgeId,
    contentHash: createHash("sha256").update(body).digest("hex") };
  let mismatched = true;
  const transport = client(async (url, init) => {
    paths.push((url as URL).pathname);
    assert.equal(init?.method, "GET");
    return response(mismatched ? { ...observed, candidateRevision: randomUUID() } : observed);
  });
  await assert.rejects(() => reconcileReceipt(transport, store, apiUrl, token, intent.id), pendingError);
  assert.equal((await store.get(intent.id)).state, "pending");
  mismatched = false;
  assert.equal((await reconcileReceipt(transport, store, apiUrl, token, intent.id)).state, "confirmed");
  assert.deepEqual(paths, [intent.recovery.path, intent.recovery.path]);
});

test("knowledge publish conflict is rejected and manual recovery remains observational", async t => {
  const store = await temporaryStore(t), operationId = randomUUID();
  const publish: Intent = { id: randomUUID(), projectId, operationId, kind: "knowledge.publish", path: "/api/publish",
    body: { operationId }, recovery: { kind: "publish", path: "/api/knowledge/reconcile" }, confirmation: "publish" };
  await store.prepare(apiUrl, token, publish);
  const conflict = await reconcileReceipt(client(async () => response({ result: { status: "conflict", operationId, currentRevision: randomUUID() } })),
    store, apiUrl, token, publish.id);
  assert.equal(conflict.state, "rejected");
  const manual: Intent = { ...coreIntent(), id: randomUUID(), operationId: null, kind: "runtime.reconcile",
    recovery: { kind: "manual", path: "/api/projects/manual/status" }, confirmation: "ack" };
  await store.prepare(apiUrl, token, manual);
  await assert.rejects(() => reconcileReceipt(client(async () => response({ status: "completed" })), store, apiUrl, token, manual.id), pendingError);
  assert.equal((await store.get(manual.id)).state, "pending");
});

test("an unrecognized successful acknowledgement does not confirm a mutation", async t => {
  const store = await temporaryStore(t);
  const intent: Intent = { id: randomUUID(), projectId, operationId: null, kind: "runtime.recover",
    path: `/api/projects/${projectId}/runtime/recover`, body: {},
    recovery: { kind: "manual", path: `/api/projects/${projectId}/runtime` }, confirmation: "ack" };
  const transport = client(async () => response({ arbitrary: "object without an acknowledgement" }));
  await assert.rejects(() => dispatchMutation(transport, store, apiUrl, token, intent, () => {}), pendingError);
  assert.equal((await store.get(intent.id)).state, "pending");
});

test("runtime reconcile partial receipt acknowledges an exact no-op, never another Run or version", async t => {
  const store = await temporaryStore(t), runId = randomUUID();
  const intent: Intent = { id: randomUUID(), projectId, targetId: runId, operationId: null, kind: "runtime.reconcile",
    path: `/api/projects/${projectId}/runtime/runs/${runId}/reconcile`,
    body: { expectedVersion: 4, reason: "review" }, recovery: { kind: "manual", path: `/api/projects/${projectId}/runtime/runs/${runId}/events` },
    confirmation: "runtime-reconcile" };
  const partial = { status: "partial", changed: false, projectId, runId, nativeTurnId: "turn-old",
    expectedVersion: 4, nextTurnCursor: "older", reason: "review" };
  const accepted = await dispatchMutation(client(async () => response(partial)), store, apiUrl, token, intent, () => {});
  assert.deepEqual(accepted, partial);
  assert.equal((await store.get(intent.id)).state, "confirmed");
  assert.equal((await store.get(intent.id)).result && (await store.get(intent.id)).result?.status, "partial");
  const wrong = { ...intent, id: randomUUID() };
  await assert.rejects(() => dispatchMutation(client(async () => response({ ...partial, runId: randomUUID() })),
    store, apiUrl, token, wrong, () => {}), pendingError);
  const wrongVersion = { ...intent, id: randomUUID() };
  await assert.rejects(() => dispatchMutation(client(async () => response({ ...partial, expectedVersion: 5 })),
    store, apiUrl, token, wrongVersion, () => {}), pendingError);
});

test("rotating a token for the same verified actor and project recovers a pending write without replay", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  const actor = verifiedActor(randomUUID());
  const rotatedToken = "rotated-private-fixture-token";
  let posts = 0, gets = 0;
  const oldClient = client(async (_url, init) => {
    assert.equal(init?.method, "POST");
    posts++;
    throw new Error("reply lost after server commit");
  });
  await assert.rejects(() => dispatchMutation(oldClient, store, apiUrl, token, intent, () => {}, actor), pendingError);
  const rotatedClient = clientFor(rotatedToken, async (url, init) => {
    assert.equal(init?.method, "GET");
    assert.equal((url as URL).pathname, intent.recovery.path);
    gets++;
    return response({ id: intent.operationId, projectId, result: { status: "applied", operationId: intent.operationId, entityId } });
  });
  await assert.rejects(() => dispatchMutation(rotatedClient, store, apiUrl, rotatedToken, intent, () => {}, actor), pendingError);
  assert.equal(posts, 1, "a rotated token must not replay an unknown POST");
  assert.equal(gets, 0, "dispatch remains pending until explicit reconciliation");
  const recovered = await reconcileReceipt(rotatedClient, store, apiUrl, rotatedToken, intent.id, actor);
  assert.equal(recovered.state, "confirmed");
  assert.equal(recovered.actorId, actor.actorId);
  assert.equal(gets, 1);
  assert.equal(posts, 1);
  const raw = await readFile(join(store.directory, `${intent.id}.json`), "utf8");
  assert.doesNotMatch(raw, /private-fixture-token/);
});

test("verified actor, project grant, and origin still fence reconciliation after token rotation", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  const actorId = randomUUID();
  await store.prepare(apiUrl, token, intent, verifiedActor(actorId));
  let requests = 0;
  const rotatedToken = "rotated-private-fixture-token";
  const transport = clientFor(rotatedToken, async () => {
    requests++;
    throw new Error("readback must be denied before transport");
  });
  const denied = async (origin: string, credential: string, actor: VerifiedActor) => {
    await assert.rejects(() => reconcileReceipt(transport, store, origin, credential, intent.id, actor), error =>
      error instanceof ReceiptError && error.code === "RECEIPT_SCOPE_MISMATCH");
  };
  await denied(apiUrl, rotatedToken, verifiedActor(randomUUID()));
  await denied(apiUrl, rotatedToken, verifiedActor(actorId, [randomUUID()]));
  await denied("https://other-origin.invalid", rotatedToken, verifiedActor(actorId));
  await denied(apiUrl, token, verifiedActor(randomUUID()));
  await denied(apiUrl, token, verifiedActor(actorId, []));
  assert.equal(requests, 0);
  assert.equal((await store.get(intent.id)).state, "pending");
});

test("a legacy receipt without verified actor retains its original-token recovery boundary", async t => {
  const store = await temporaryStore(t), intent = coreIntent();
  const { receipt } = await store.prepare(apiUrl, token, intent);
  assert.equal(receipt.actorId, undefined);
  const actor = verifiedActor(randomUUID());
  let requests = 0;
  const readClient = client(async () => {
    requests++;
    return response({ id: intent.operationId, projectId, result: { status: "applied", operationId: intent.operationId, entityId } });
  });
  await assert.rejects(() => reconcileReceipt(readClient, store, apiUrl, "rotated-private-fixture-token", intent.id, actor), error =>
    error instanceof ReceiptError && error.code === "RECEIPT_SCOPE_MISMATCH");
  assert.equal(requests, 0);
  assert.equal((await reconcileReceipt(readClient, store, apiUrl, token, intent.id, actor)).state, "confirmed");
  assert.equal(requests, 1);
});
