import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import type { SessionMessageService } from "@evoloop/core/session-messages";
import type { SessionObservationService } from "@evoloop/core/session-observation";
import { registerSessionMessageRoutes } from "../src/session-messages/routes.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), key = `owned:${id(2)}`;
test("message reads bind cursors to identity and recipient and enforce a UTF-8 byte budget", async () => {
  const app = Fastify();
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => {
    request.principal = { actorId: request.headers.authorization ?? "reader", projectIds: [projectId], permissions: ["read"] };
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 :
    error instanceof DomainError && error.code === "FORBIDDEN" ? 403 : 409).send({ code: error instanceof DomainError ? error.code : "INVALID_INPUT" }));
  const messages = Array.from({ length: 50 }, (_, i) => ({ projectId, id: id(i + 20), operationId: id(i + 100),
    target: { kind: "owned", sessionId: id(2) }, senderActorId: "sender", content: "界".repeat(16000),
    context: null, replyToMessageId: null, state: "queued", version: 1, blockedReason: "界".repeat(4000),
    readReceipt: { actorId: "receiver", evidence: "界".repeat(4000), at: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }));
  const processing = { projectId, id: id(3), messageId: messages[0]!.id, sessionId: id(2), operationId: id(4),
    state: "completed", nativeTurnId: "turn-1", response: "回".repeat(3000), failure: null, version: 2,
    startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  let reads = 0;
  registerSessionMessageRoutes(app, {
    workflow: { getProject: async (p: Principal, id: string) => { if (!p.projectIds.includes(id)) throw new DomainError("FORBIDDEN", "Wrong project"); } } as unknown as WorkflowService,
    observation: { snapshot: async () => ({ session: { key, target: { kind: "owned", sessionId: id(2) } } }) } as unknown as SessionObservationService,
    messages: {
      conversation: async () => { reads++; return { items: messages.map((message, index) => ({ ...message, processing: index === 0 ? processing : null })), nextCursor: null }; },
      list: async () => ({ items: messages, nextCursor: null }),
      detail: async () => ({ message: messages[0], processing: null }),
    } as unknown as SessionMessageService,
  });
  try {
    const url = `/api/projects/${projectId}/session-work/${encodeURIComponent(key)}/messages?limit=50`;
    const first = await app.inject({ url, headers: { authorization: "reader-a" } });
    assert.equal(first.statusCode, 200);
    assert.ok(Buffer.byteLength(first.body) <= 256 * 1024);
    const body = first.json();
    assert.ok(body.items.length > 0 && body.items.length < 50);
    assert.equal(body.items[0].contentTruncated, true);
    assert.equal(body.items[0].processing.response.length, 1200);
    assert.equal(body.items[0].responseTruncated, true);
    const parsed = JSON.parse(Buffer.from(body.nextCursor, "base64url").toString());
    assert.equal(parsed.position, body.items.at(-1).id);
    const crossIdentity = await app.inject({ url: `${url}&cursor=${encodeURIComponent(body.nextCursor)}`, headers: { authorization: "reader-b" } });
    assert.equal(crossIdentity.statusCode, 409);
    assert.equal(reads, 1);
    const wrongProject = await app.inject({ url: `/api/projects/${id(9)}/session-messages/${id(20)}` });
    assert.equal(wrongProject.statusCode, 403);
    const detail = await app.inject({ url: `/api/projects/${projectId}/session-messages/${id(20)}` });
    assert.equal(detail.json().message.content.length, 16000);
    assert.equal(detail.json().processing, null);
  } finally { await app.close(); }
});
