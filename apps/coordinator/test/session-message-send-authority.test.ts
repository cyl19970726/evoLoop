import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowService } from "@evoloop/core";
import { buildServer } from "../src/server.ts";
import { ordinaryMessageGrantProblem, type OrdinaryMessageGrant } from "../src/session-messages/send-authority.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), sessionId = id(2), roleId = id(3), cwd = "/srv/leader";
const session = { id: sessionId, roleId, cwd, authorizationScope: "project" };
const grant = (over: Partial<OrdinaryMessageGrant> = {}): OrdinaryMessageGrant => ({ enabled: true, projectId, sessionId, senderActorId: "user-sim", receiverActorId: "leader", receiverRoleId: roleId, cwd, ...over });
const problem = (over: { sessionMessages?: { enabled: boolean; grants: OrdinaryMessageGrant[] }; writers?: string[]; session?: typeof session; sender?: string } = {}) =>
  ordinaryMessageGrantProblem({ projectId, senderActorId: over.sender ?? "user-sim", session: over.session ?? session,
    sessionMessages: "sessionMessages" in over ? over.sessionMessages : { enabled: true, grants: [grant()] }, isProjectWriter: actor => (over.writers ?? ["user-sim", "leader"]).includes(actor) });

test("a sender without the exact ordinary grant is refused at once, with what is missing and how to add it", async () => {
  assert.equal(await problem(), null, "the exact grant lets the message through");
  const none = await problem({ sessionMessages: { enabled: true, grants: [] } });
  assert.equal(none?.code, "MESSAGE_GRANT_MISSING");
  assert.match(none!.message, /sessionMessages\.grants 里没有 user-sim → 这个 Session/);
  assert.ok(none!.message.includes(`"senderActorId":"user-sim"`) && none!.message.includes(`"sessionId":"${sessionId}"`) && none!.message.includes(`"receiverRoleId":"${roleId}"`) && none!.message.includes(`"cwd":"${cwd}"`), "an entry to copy, with this Session's identifiers");
  assert.match(none!.message, /不需要重启/);
  assert.match(none!.message, /消息没有保存/);
  // Another sender's grant does not cover this sender; a disabled grant does not count.
  assert.match((await problem({ sessionMessages: { enabled: true, grants: [grant({ senderActorId: "someone" }), grant({ enabled: false })] } }))!.message, /没有 user-sim → 这个 Session/);
  // A grant that no longer matches the Session's Role or directory is named as such.
  assert.match((await problem({ sessionMessages: { enabled: true, grants: [grant({ cwd: "/elsewhere" })] } }))!.message, /与这个 Session 当前的职责或工作目录不一致/);
  assert.match((await problem({ sessionMessages: { enabled: false, grants: [grant()] } }))!.message, /sessionMessages\.enabled/);
  assert.match((await problem({ sessionMessages: undefined }))!.message, /sessionMessages\.enabled/);
  assert.match((await problem({ writers: ["leader"] }))!.message, /发送者身份 user-sim 在身份文件里对本项目没有 read 与 write/);
  assert.match((await problem({ writers: ["user-sim"] }))!.message, /接收方身份 leader 在身份文件里对本项目没有 read 与 write/);
  // A connector receiver Session uses route grants, which this check does not stand in for.
  assert.equal(await problem({ session: { ...session, authorizationScope: "connector-receiver:abc" }, sessionMessages: { enabled: true, grants: [] } }), null);
});

test("POST /api/commands refuses an ungranted session.message.post before anything is saved, and lets a replay or a granted post through", async () => {
  const executed: unknown[] = [];
  let known = false, blocked: { code: "MESSAGE_GRANT_MISSING"; message: string } | null = { code: "MESSAGE_GRANT_MISSING", message: "没有发送这条消息的授权：缺 grant" };
  const base = { getProject: async () => ({ id: projectId }), getOperation: async () => known ? { id: "op" } : null,
    execute: async (_principal: unknown, command: { operationId: string; messageId: string }) => { executed.push(command); return { status: "applied", operationId: command.operationId, entityId: command.messageId, version: 1 }; } } as Record<string, unknown>;
  // Routes bind many service methods at registration; only the two this test drives matter.
  const service = new Proxy(base, { get: (target, name) => name in target ? target[name as string] : async () => undefined }) as unknown as WorkflowService;
  const token = "t".repeat(40);
  const app = await buildServer({ service, credentials: [{ token, actorId: "user-sim", projectIds: [projectId], permissions: ["read", "write"] }],
    messageSendAuthority: async () => blocked });
  const post = (type = "session.message.post") => app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${token}` },
    payload: { type, projectId, operationId: id(10), messageId: id(11), target: { kind: "owned", sessionId }, content: "你好" } });
  try {
    const refused = await post();
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().code, "MESSAGE_GRANT_MISSING");
    assert.match(refused.json().message, /没有发送这条消息的授权/);
    assert.equal(executed.length, 0, "nothing was saved or queued");
    known = true;
    assert.equal((await post()).statusCode, 200, "a replay of an operation already journaled is answered by execute, not refused anew");
    known = false; blocked = null;
    assert.equal((await post()).statusCode, 200);
    assert.equal(executed.length, 2);
  } finally { await app.close(); }
});
