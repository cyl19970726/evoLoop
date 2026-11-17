import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { parseAuthConfig, principalFromAuthEntry, type MachineCredentials, type Principal } from "@evoloop/contracts";
import { ordinaryMessageGrantProblem, type OrdinaryMessageGrant } from "../src/session-messages/send-authority.ts";
import { createMessageExecutionReader } from "../src/session-messages/execution-capability.ts";
import { createSenderWriter } from "../src/session-messages/sender-writer.ts";
import { HubIdentityVerifier } from "../src/hub/identity.ts";

// Task e1f2b996: a `senderKind: "hub"` grant counts only for a principal the Hub signed (`Principal.origin === "hub"`, set by HubIdentityVerifier), never for a local token-file
// identity whose actor ID happens to match the grant. The principals here are made the way production makes them: the local one from a token-file entry
// (principalFromAuthEntry), the Hub one by the real verifier on a really signed identity. Each case goes through the send-time check and the execution check.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), sessionId = id(2), roleId = id(3), machineId = id(9), cwd = "/srv/leader";
const session = { id: sessionId, roleId, cwd, authorizationScope: "project" };
const messageGrant = (senderActorId: string, senderKind: "local" | "hub"): OrdinaryMessageGrant & { senderKind: string } =>
  ({ enabled: true, projectId, sessionId, senderActorId, receiverActorId: "leader", receiverRoleId: roleId, cwd, senderKind });

const hubKeys = generateKeyPairSync("ed25519");
const credentials = (): MachineCredentials => ({ version: 1, hubOrigin: "https://hub.example", machineId, name: "m", privateKey: "unused",
  hubPublicKeys: [{ kid: "k1", publicKey: hubKeys.publicKey.export({ type: "spki", format: "pem" }).toString() }], allowedRoots: ["/srv"], joinedAt: new Date().toISOString() });
async function hubPrincipal(actorId: string): Promise<Principal> {
  const url = `/api/projects/${projectId}/session-messages`, iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, kid: "k1", aud: machineId, jti: randomUUID(), iat, exp: iat + 60, sub: { actorId, kind: "human", auth: "token" }, projectId,
    permissions: ["session"], decisions: false, sessionIds: [], method: "POST", target: createHash("sha256").update(url, "utf8").digest("base64url") })).toString("base64url");
  const signature = sign(null, Buffer.from(`evoloop-hub-identity-v1\n${payload}`), createPrivateKey(hubKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toString("base64url");
  const verifier = new HubIdentityVerifier({ credentials, isLocalProject: async () => true, localActorIds: () => new Set(), startedAt: Date.now() - 60_000 });
  return (await verifier.verify(`v1.${payload}.${signature}`, { method: "POST", url })).principal;
}
// The token file: acct_alice is in it but cannot write (read only); "leader" is the writer that receives.
const tokenFile = parseAuthConfig([
  { token: "t".repeat(32), actorId: "acct_alice", projectIds: [projectId], permissions: ["task", "document", "session"], identityKind: "agent" },
  { token: "u".repeat(32), actorId: "leader", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true, identityKind: "agent" },
] as never);
const localPrincipal = (actorId: string) => principalFromAuthEntry(tokenFile.find(entry => entry.actorId === actorId)!);

function chain(grants: Array<OrdinaryMessageGrant & { senderKind: string }>, localWriters: string[]) {
  const sessionMessages = { enabled: true, grants };
  const isProjectWriter = async (_project: string, actor: string) => localWriters.includes(actor);
  const isSenderWriter = createSenderWriter({ isProjectWriter, loadSessionMessages: async () => sessionMessages as never });
  const sendCheck = (principal: Principal) => ordinaryMessageGrantProblem({ projectId, senderActorId: principal.actorId, senderOrigin: principal.origin, session, sessionMessages,
    isProjectWriter: actor => isProjectWriter(projectId, actor), isSenderWriter: (actor, origin) => isSenderWriter(projectId, actor, origin) });
  const reader = createMessageExecutionReader({ loadConfiguration: async () => ({ sessionMessages: { enabled: true, grants: grants.map(grant => ({ ...grant, maxTurns: 5 })) }, runtime: { enabled: true } }) as never,
    runtimeAvailable: () => true, isProjectWriter, isSenderWriter, canExecuteSession: async () => true,
    readSession: async () => ({ id: sessionId, projectId, roleId, cwd, authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never", state: "ready", nativeThreadId: "t", nativeSessionId: "n" }) as never,
    cwdIsCurrent: async () => true, turnsUsed: async () => 0 } as never);
  const observed = { kind: "owned", target: { kind: "owned", sessionId }, runtimeState: "ready", capabilities: { send: { available: true, mode: "owned-conversation" } }, busy: false } as never;
  const execution = async (principal: Principal) => ((await reader(principal, projectId, observed).catch((error: unknown) => ({ reasonCode: `THROWN ${String(error)}` }))) as { reasonCode?: string }).reasonCode;
  return { sendCheck, execution };
}

test("a. a local token-file identity is refused even when a hub grant names the same actor ID: it only goes through the local writer test", async () => {
  const { sendCheck, execution } = chain([messageGrant("acct_alice", "hub")], ["leader"]);   // acct_alice is not a local writer
  const local = localPrincipal("acct_alice");
  assert.equal(local.origin, undefined, "a principal made from the token file has no origin");
  const problem = await sendCheck(local);
  assert.equal(problem?.code, "MESSAGE_GRANT_MISSING"); assert.match(problem!.message, /发送者身份 acct_alice/);
  assert.equal(await execution(local), "MESSAGE_GRANT_MISSING", "the execution check refuses it as well");
});

test("b. a Hub-signed identity with an explicit hub grant is let through, by both checks", async () => {
  const { sendCheck, execution } = chain([messageGrant("acct_alice", "hub")], ["leader"]);
  const hub = await hubPrincipal("acct_alice");
  assert.equal(hub.origin, "hub", "the verifier marks what it verified");
  assert.equal(await sendCheck(hub), null);
  assert.notEqual(await execution(hub), "MESSAGE_GRANT_MISSING");
});

test("c. a Hub-signed identity with no hub grant is refused, by both checks (a local-kind grant for the same actor does not count)", async () => {
  for (const grants of [[], [messageGrant("acct_alice", "local")]]) {
    const { sendCheck, execution } = chain(grants, ["leader", "acct_alice"]);   // even if the actor ID is also a local writer: the origin decides, not the name
    const hub = await hubPrincipal("acct_alice");
    const problem = await sendCheck(hub);
    assert.equal(problem?.code, "MESSAGE_GRANT_MISSING", JSON.stringify(grants));
    assert.equal(await execution(hub), "MESSAGE_GRANT_MISSING");
  }
});

test("the origin comes from the verifier only: a token-file entry cannot carry it, and a local writer still sends without any hub grant", async () => {
  const forged = principalFromAuthEntry({ ...tokenFile[0]!, origin: "hub" } as never);
  assert.equal(forged.origin, undefined, "principalFromAuthEntry copies fields by name");
  const { sendCheck } = chain([messageGrant("leader", "local")], ["leader", "acct_alice"]);
  assert.equal(await sendCheck(localPrincipal("leader")), null, "a local writer is unchanged");
  // A local writer's sender check passes on the token file alone, with no hub grant at all.
  const none = chain([messageGrant("acct_alice", "local")], ["leader", "acct_alice"]);
  assert.equal(await none.sendCheck(localPrincipal("acct_alice")), null);
});
