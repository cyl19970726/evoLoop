import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import type { ConnectorRouteRecord } from "@evoloop/contracts/message-connectors";
import { registerConnectorRouteReads, type ConnectorRouteReader } from "../src/message-connectors/routes.ts";
import { buildServer } from "../src/server.ts";
import { authConfigSchema } from "../src/auth.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), bindingId = id(2);
const operationId = id(4), updateOperationId = id(5);
const route = { projectId, bindingId,
  source: { provider: "wechat", connectionId: "test-connection", conversationId: "a".repeat(32) },
  targetSessionId: id(3), targetActorId: "restricted-receiver", senderActorId: "connector-sender",
  owner: "test-owner", epoch: 1, sessionRef: "test-session", mode: "standard" as const,
  sendTargets: ["a".repeat(32)], internalTargets: [], state: "disabled" as const,
  capabilities: { history: true, search: false, subscribe: true, sendText: true,
    sendMedia: false, receipt: "local_observed" as const }, policyHash: "a".repeat(64) };
const record = { ...route, version: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };

test("connector route HTTP preserves project and reviewer boundaries while keeping a disabled saved route readable", async () => {
  const app = Fastify();
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => {
    const role = request.headers.authorization;
    request.principal = role === "none" ? null : { actorId: role ?? "reader", projectIds: [projectId],
      permissions: role === "reviewer" ? ["read", "write", "review"] : role === 'restricted-receiver'
        ? ['read','write']: ["read"] } as Principal;
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError && error.code === "FORBIDDEN" ? 403 : 409)
    .send({ code: error instanceof DomainError ? error.code : "INVALID_INPUT" }));
  let writes = 0;
  let transferred:unknown=null;
  let saved: ConnectorRouteRecord = record;
  const routes: ConnectorRouteReader = {
    get: async () => saved,
    list: async () => ({ items: [saved], nextCursor: null }),
    operation: async (_projectId, id) => id === operationId ? { projectId, id, actorId: "reviewer", requestHash: "b".repeat(64),
      kind: "create", bindingId, result: record, createdAt: record.createdAt } : null,
    create: async (input, id, actorId) => { assert.equal(id, operationId); assert.equal(actorId, "reviewer");
      writes++; saved = { ...input, version: 1, createdAt: record.createdAt, updatedAt: record.updatedAt }; return saved; },
    update: async (input, expectedVersion, id, actorId) => { assert.equal(expectedVersion, 1);
      assert.equal(id, updateOperationId); assert.equal(actorId, "reviewer");
      if (input.state !== "disabled") throw new DomainError("CONNECTOR_ROUTE_UNVERIFIED", "Route is not active");
      writes++; saved = { ...input, state: "disabled", createdAt: record.createdAt,
        updatedAt: record.updatedAt }; return saved; }
  };
  registerConnectorRouteReads(app, { getProject: async () => ({}),execute:async(principal:Principal,command:unknown)=>{
      transferred={principal,command};return{status:'applied',operationId,entityId:id(11),version:1};}
    } as unknown as WorkflowService, routes, () => true,
    {listRecent:async()=>[{deliveryId:12,eventCount:1,latestMessageState:'replied',decision:null}],
      messages:async()=>[{eventCursor:2,messageId:id(10),nativeTurnId:'native-turn'}],get:async()=>null},
    {getByMessageId:async()=>({bindingId,source:{eventCursor:2,source:{conversationId:'a'.repeat(32)}}})});
  try {
    const path = `/api/projects/${projectId}/message-connectors/routes`;
    assert.equal((await app.inject({ method: "POST", url: path, payload: { operationId, route }, headers: { authorization: "reader" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: path, payload: { operationId, route: { ...route, projectId: id(9) } },
      headers: { authorization: "reviewer" } })).json().code, "CONNECTOR_PROJECT_MISMATCH");
    assert.equal(writes, 0);
    const created = await app.inject({ method: "POST", url: path, payload: { operationId, route }, headers: { authorization: "reviewer" } });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().route.state, "disabled");
    assert.equal((await app.inject({ url: path, headers: { authorization: "reader" } })).json().items[0].bindingId, bindingId);
    assert.equal((await app.inject({ url: `${path}/${bindingId}`, headers: { authorization: "none" } })).statusCode, 403);
    assert.equal((await app.inject({url:`${path}/${bindingId}/deliveries`,headers:{authorization:'none'}})).statusCode,403);
    assert.equal((await app.inject({url:`${path}/${bindingId}/deliveries`,headers:{authorization:'reader'}})).json().items[0].deliveryId,12);
    assert.equal((await app.inject({url:`${path}/${bindingId}/deliveries/12`,headers:{authorization:'reader'}})).json().messages[0].nativeTurnId,'native-turn');
    assert.equal((await app.inject({ url: `/api/projects/${projectId}/message-connectors/operations/${operationId}` })).json().result.bindingId,
      bindingId);
    const missingOperation = await app.inject({ url: `/api/projects/${projectId}/message-connectors/operations/${id(99)}` });
    assert.equal(missingOperation.json().code, "CONNECTOR_OPERATION_UNCONFIRMED");
    const paused = await app.inject({ method: "PUT", url: `${path}/${bindingId}`, headers: { authorization: "reviewer" },
      payload: { operationId: updateOperationId, expectedVersion: 1, route: { ...route, version: 2, state: "paused" } } });
    assert.equal(paused.json().code, "CONNECTOR_ROUTE_UNVERIFIED");
    assert.equal(writes, 1);
    const updated = await app.inject({ method: "PUT", url: `${path}/${bindingId}`, headers: { authorization: "reviewer" },
      payload: { operationId: updateOperationId, expectedVersion: 1, route: { ...route, version: 2 } } });
    assert.equal(updated.json().route.version, 2);
    assert.equal(writes, 2);
    const premature = await app.inject({method:'PUT',url:`${path}/${bindingId}`,headers:{authorization:'reviewer'},
      payload:{operationId:id(15),expectedVersion:2,route:{...route,version:3,state:'active'}}});
    assert.equal(premature.json().code,'CONNECTOR_ACTIVATION_UNAVAILABLE');
    assert.equal(writes,2);
    const restricted = await app.inject({ method: "PUT", url: `${path}/${bindingId}`, headers: { authorization: "reviewer" },
      payload: { operationId: id(7), expectedVersion: 2, route: { ...route, mode: "restricted", version: 3, state: "active" } } });
    assert.equal(restricted.json().code, "CONNECTOR_RECEIVER_UNPROVEN");
    assert.equal(writes, 2);
    const wrong = await app.inject({ method: "PUT", url: `${path}/${bindingId}`, headers: { authorization: "reviewer" },
      payload: { operationId: id(6), expectedVersion: 2, route: { ...route, bindingId: id(8), version: 3 } } });
    assert.equal(wrong.json().code, "CONNECTOR_ROUTE_IDENTITY");
    assert.equal(writes, 2);
    saved={...saved,state:'active',internalTargets:[id(12)]};
    const transferPath=`${path}/${bindingId}/transfers`;
    const transfer={operationId:id(13),sourceMessageId:id(10),newMessageId:id(11),targetSessionId:id(12),content:'Please review'};
    assert.equal((await app.inject({method:'POST',url:transferPath,headers:{authorization:'reviewer'},payload:transfer})).json().code,
      'CONNECTOR_TRANSFER_REFUSED');
    assert.equal((await app.inject({method:'POST',url:transferPath,headers:{authorization:'restricted-receiver'},
      payload:{...transfer,targetSessionId:id(20)}})).json().code,'CONNECTOR_TRANSFER_REFUSED');
    assert.equal((await app.inject({method:'POST',url:transferPath,headers:{authorization:'restricted-receiver'},
      payload:transfer})).json().status,'applied');
    assert.match((transferred as {command:{content:string}}).command.content,/untrusted data/);
  } finally { await app.close(); }
});

test("production server registers scoped connector status and refuses writes after lease loss", async () => {
  const token = "c".repeat(40);
  const credentials = authConfigSchema.parse([{ token, actorId: "reviewer", projectIds: [projectId],
    permissions: ["read", "write", "review"] }]);
  let writes = 0;
  const app = await buildServer({ credentials,
    service: { getProject: async () => ({}), listRoleRevisions: async () => [], listRoleReviews: async () => [],
      listRoleHandoffs: async () => [], listRoleSessionBindings: async () => [] } as unknown as WorkflowService,
    connectorRoutes: { get: async () => record, list: async () => ({ items: [record], nextCursor: null }),
      operation: async () => null,
      create: async () => { writes++; return record; }, update: async () => { writes++; return record; } },
    canWrite: () => false });
  try {
    const path = `/api/projects/${projectId}/message-connectors/routes`;
    assert.equal((await app.inject({ url: path })).statusCode, 401);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ url: path, headers })).json().items[0].bindingId, bindingId);
    const blocked = await app.inject({ method: "POST", url: path, headers,
      payload: { operationId, route } });
    assert.equal(blocked.json().code, "UNAVAILABLE");
    assert.equal(writes, 0);
  } finally { await app.close(); }
});
