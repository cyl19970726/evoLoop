import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { parseAuthConfig, principalFromAuthEntry, type MachineCredentials, type Principal } from "@evoloop/contracts";
import { findDispatchGrant, ordinaryMessageGrantProblem, type OrdinaryMessageGrant } from "../src/session-messages/send-authority.ts";
import { createMessageExecutionReader } from "../src/session-messages/execution-capability.ts";
import { createSenderWriter } from "../src/session-messages/sender-writer.ts";
import { HubIdentityVerifier } from "../src/hub/identity.ts";

// Task db48f6cd (after e1f2b996 / #485): the dispatcher must judge a stored message by the origin recorded when it was posted, the same way the send check and the work snapshot judge the live principal.
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


// The dispatch side exactly as main.ts grantFor builds it: sender test with the STORED origin, then the grant entry that matches the Session.
function dispatch(grants: Array<OrdinaryMessageGrant & { senderKind: string }>, localWriters: string[]) {
  const sessionMessages = { enabled: true, grants };
  const isProjectWriter = async (_project: string, actor: string) => localWriters.includes(actor);
  const senderWriter = createSenderWriter({ isProjectWriter, loadSessionMessages: async () => sessionMessages as never });
  return async (message: { senderActorId: string; senderOrigin?: "hub" | null }) => {
    if (!await senderWriter(projectId, message.senderActorId, message.senderOrigin ?? undefined)) return null;
    const grant = findDispatchGrant(sessionMessages, { projectId, senderActorId: message.senderActorId }, session);
    return grant && await isProjectWriter(projectId, grant.receiverActorId) ? grant : null;
  };
}
// What the service stores for a principal (packages/core session-messages post): `hub` only for the verifier's mark.
const storedOrigin = (principal: Principal): "hub" | null => principal.origin === "hub" ? "hub" : null;

test("1. a Hub-signed sender with a hub grant: send check, snapshot and dispatch all say yes, and the message keeps its origin", async () => {
  const grants = [messageGrant("acct_alice", "hub")], hub = await hubPrincipal("acct_alice");
  const { sendCheck, execution } = chain(grants, ["leader"]);
  assert.equal(await sendCheck(hub), null);
  assert.notEqual(await execution(hub), "MESSAGE_GRANT_MISSING");
  assert.ok(await dispatch(grants, ["leader"])({ senderActorId: "acct_alice", senderOrigin: storedOrigin(hub) }), "dispatch agrees with send and snapshot");
});

test("2. the defect: the dispatcher used the local identity file for a Hub account; with the stored origin the same message dispatches, and without it (old behaviour) it would not", async () => {
  const grants = [messageGrant("acct_alice", "hub")];
  const go = dispatch(grants, ["leader"]);   // acct_alice is not in the local identity file
  assert.ok(await go({ senderActorId: "acct_alice", senderOrigin: "hub" }));
  assert.equal(await go({ senderActorId: "acct_alice", senderOrigin: null }), null, "same actor ID stored as local gets nothing from a hub grant (#485)");
});

test("3. #485 at dispatch: a local identity with the same actor ID and no local write permission cannot dispatch through a hub grant", async () => {
  const grants = [messageGrant("acct_alice", "hub")], local = localPrincipal("acct_alice");
  const { sendCheck } = chain(grants, ["leader"]);
  assert.equal((await sendCheck(local))?.code, "MESSAGE_GRANT_MISSING", "refused at send");
  // Even if such a message were stored (older rows, or any other writer of the table), it carries no origin and is refused at dispatch.
  assert.equal(await dispatch(grants, ["leader"])({ senderActorId: "acct_alice", senderOrigin: storedOrigin(local) }), null);
  assert.equal(await dispatch(grants, ["leader"])({ senderActorId: "acct_alice" }), null, "a message stored before the origin column existed is a local one");
});

test("4. revoked after sending: a Hub message stored while the grant existed is refused at dispatch once the grant is gone or disabled", async () => {
  const hub = await hubPrincipal("acct_alice"), message = { senderActorId: "acct_alice", senderOrigin: storedOrigin(hub) };
  assert.ok(await dispatch([messageGrant("acct_alice", "hub")], ["leader"])(message));
  assert.equal(await dispatch([], ["leader"])(message), null, "grant removed");
  assert.equal(await dispatch([{ ...messageGrant("acct_alice", "hub"), enabled: false }], ["leader"])(message), null, "grant disabled");
  assert.equal(await dispatch([messageGrant("acct_alice", "local")], ["leader", "acct_alice"])(message), null, "a local-kind grant does not carry a Hub message, whatever the actor ID");
  const { sendCheck } = chain([], ["leader"]);
  assert.equal((await sendCheck(hub))?.code, "MESSAGE_GRANT_MISSING", "and a new send is refused too");
});

test("5. a local writer is unchanged: sends and dispatches with no hub grant, and its stored origin is empty", async () => {
  const grants = [messageGrant("leader2", "local")], local = principalFromAuthEntry({ ...tokenFile[1]!, actorId: "leader2" } as never);
  assert.equal(storedOrigin(local), null);
  assert.ok(await dispatch(grants, ["leader", "leader2"])({ senderActorId: "leader2", senderOrigin: null }));
  assert.equal(await dispatch(grants, ["leader"])({ senderActorId: "leader2", senderOrigin: null }), null, "a local sender that lost its identity-file write permission is refused");
});

test("6. consistency matrix: for every combination of principal, grants and writers, send check, snapshot and dispatch reach the same yes/no", async () => {
  const principals = [["hub", await hubPrincipal("acct_alice")], ["local", localPrincipal("acct_alice")]] as const;
  const grantSets = [[], [messageGrant("acct_alice", "hub")], [messageGrant("acct_alice", "local")], [{ ...messageGrant("acct_alice", "hub"), enabled: false }]];
  const writerSets = [["leader"], ["leader", "acct_alice"]];
  let combos = 0;
  for (const [name, principal] of principals) for (const grants of grantSets) for (const writers of writerSets) {
    const { sendCheck, execution } = chain(grants, writers);
    const send = await sendCheck(principal) === null, snapshot = await execution(principal) !== "MESSAGE_GRANT_MISSING";
    const dispatched = !!await dispatch(grants, writers)({ senderActorId: principal.actorId, senderOrigin: storedOrigin(principal) });
    const label = `${name} grants=${JSON.stringify(grants.map(g => [g.senderKind, g.enabled]))} writers=${writers.join(",")}`;
    assert.equal(send, snapshot, `send vs snapshot: ${label}`);
    assert.equal(send, dispatched, `send vs dispatch: ${label}`);
    combos += 1;
  }
  assert.equal(combos, 16);
});
