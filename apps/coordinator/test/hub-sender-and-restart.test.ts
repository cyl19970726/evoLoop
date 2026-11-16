import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import type { MachineCredentials } from "@evoloop/contracts";
import { ordinaryMessageGrantProblem, type OrdinaryMessageGrant } from "../src/session-messages/send-authority.ts";
import { createMessageExecutionReader } from "../src/session-messages/execution-capability.ts";
import { HubIdentityVerifier } from "../src/hub/identity.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), sessionId = id(2), roleId = id(3), cwd = "/srv/leader";
const session = { id: sessionId, roleId, cwd, authorizationScope: "project" };
const grant = (over: Partial<OrdinaryMessageGrant> = {}): OrdinaryMessageGrant => ({ enabled: true, projectId, sessionId, senderActorId: "acct_alice", receiverActorId: "leader", receiverRoleId: roleId, cwd, ...over });

// ---- Task 9ea06625 item 9: a Hub account sends only on an explicit grant ----
test("a Hub account's message is accepted only when its sender check passes on an explicit grant; the receiver is still checked in the token file", async () => {
  const hubGranted = (actor: string) => actor === "acct_alice";
  const check = (over: { sender?: string; grants?: OrdinaryMessageGrant[]; senderWriter?: (actor: string) => boolean } = {}) => ordinaryMessageGrantProblem({ projectId, senderActorId: over.sender ?? "acct_alice", session,
    sessionMessages: { enabled: true, grants: over.grants ?? [grant()] }, isProjectWriter: actor => actor === "leader", isSenderWriter: over.senderWriter ?? (actor => actor === "leader" || hubGranted(actor)) });
  assert.equal(await check(), null, "the granted Hub account can send");
  assert.match((await check({ sender: "acct_bob", grants: [grant({ senderActorId: "acct_bob" })] }))!.message, /发送者身份 acct_bob.*"senderKind":"hub"/, "a Hub account with no explicit grant is refused, and told what to add");
  assert.match((await check({ grants: [] }))!.message, /sessionMessages\.grants 里没有 acct_alice → 这个 Session/, "no message grant is still a refusal");
  assert.match((await check({ grants: [grant({ enabled: false })] }))!.message, /没有 acct_alice → 这个 Session/);
  // Without the sender-specific check nothing changes: the token file decides for sender and receiver alike.
  const old = await ordinaryMessageGrantProblem({ projectId, senderActorId: "acct_alice", session, sessionMessages: { enabled: true, grants: [grant()] }, isProjectWriter: actor => actor === "leader" });
  assert.match(old!.message, /发送者身份 acct_alice 在身份文件里对本项目没有 read 与 write/);
  // The receiver of a grant is never excused by a Hub grant.
  const receiverGone = await ordinaryMessageGrantProblem({ projectId, senderActorId: "acct_alice", session, sessionMessages: { enabled: true, grants: [grant()] },
    isProjectWriter: () => false, isSenderWriter: hubGranted });
  assert.match(receiverGone!.message, /接收方身份 leader 在身份文件里对本项目没有 read 与 write/);
});

test("the execution check treats the sender like the send check: the explicit Hub grant counts for the sender and not for the receiver", async () => {
  const configuration = { sessionMessages: { enabled: true, grants: [{ ...grant(), maxTurns: 5 }] }, runtime: { enabled: true } };
  const make = (senderWriter?: (projectId: string, actor: string) => Promise<boolean>) => createMessageExecutionReader({
    loadConfiguration: async () => configuration as never, runtimeAvailable: () => true, isProjectWriter: async (_p, actor) => actor === "leader",
    ...(senderWriter ? { isSenderWriter: senderWriter } : {}), canExecuteSession: async () => true,
    readSession: async () => ({ id: sessionId, projectId, roleId, cwd, authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never", state: "ready", nativeThreadId: "t", nativeSessionId: "n" }) as never,
    cwdIsCurrent: async () => true, turnsUsed: async () => 0 } as never);
  const principal = { actorId: "acct_alice", projectIds: [projectId], permissions: ["session" as const] };
  const observed = { kind: "owned", target: { kind: "owned", sessionId }, runtimeState: "ready", capabilities: { send: { available: true, mode: "owned-conversation" } }, busy: false } as never;
  const granted = await make(async (_p, actor) => actor === "acct_alice")(principal, projectId, observed).catch((error: unknown) => ({ failure: String(error) }));
  const refused = await make()(principal, projectId, observed).catch((error: unknown) => ({ failure: String(error) }));
  const status = (value: unknown) => (value as { reasonCode?: string }).reasonCode ?? (value as { failure?: string }).failure;
  assert.notEqual(status(granted), "MESSAGE_GRANT_MISSING", `the granted Hub sender passes the writer test (${status(granted)})`);
  assert.equal(status(refused), "MESSAGE_GRANT_MISSING", "without the explicit grant the Hub sender is refused as before");
});

// ---- Task 9ea06625 item 10: a signed identity is single use across a restart ----
const machineId = id(9);
const hubKeys = generateKeyPairSync("ed25519");
const credentials = (): MachineCredentials => ({ version: 1, hubOrigin: "https://hub.example", machineId, name: "m", privateKey: "unused",
  hubPublicKeys: [{ kid: "k1", publicKey: hubKeys.publicKey.export({ type: "spki", format: "pem" }).toString() }], allowedRoots: ["/srv"], joinedAt: new Date().toISOString() });
const identityFor = (iat: number, url: string) => {
  const payload = Buffer.from(JSON.stringify({ v: 1, kid: "k1", aud: machineId, jti: randomUUID(), iat, exp: iat + 60, sub: { actorId: "acct_alice", kind: "human", auth: "token" }, projectId,
    permissions: ["session"], decisions: true, sessionIds: [], method: "GET", target: createHash("sha256").update(url, "utf8").digest("base64url") })).toString("base64url");
  const signature = sign(null, Buffer.from(`evoloop-hub-identity-v1\n${payload}`), createPrivateKey(hubKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toString("base64url");
  return `v1.${payload}.${signature}`;
};
const verifier = (now: () => number, startedAt?: number) => new HubIdentityVerifier({ credentials, isLocalProject: async () => true, localActorIds: () => new Set(), now, ...(startedAt === undefined ? {} : { startedAt }) });

test("an identity captured before a coordinator restart is refused after it, used or not; one signed after the restart is accepted", async () => {
  const url = `/api/projects/${projectId}/documents`;
  let clock = Date.parse("2026-11-17T10:00:00Z");
  const before = new HubIdentityVerifier({ credentials, isLocalProject: async () => true, localActorIds: () => new Set(), now: () => clock });
  const signedAt = Math.floor(clock / 1000);
  const used = identityFor(signedAt, url), unused = identityFor(signedAt, url);
  await before.verify(used, { method: "GET", url });
  await assert.rejects(before.verify(used, { method: "GET", url }), /already used/, "inside one run the second use is refused (the in-memory record)");
  // The coordinator restarts ten seconds later: a new verifier has an empty record, yet neither identity is accepted.
  clock += 10_000;
  const after = new HubIdentityVerifier({ credentials, isLocalProject: async () => true, localActorIds: () => new Set(), now: () => clock });
  await assert.rejects(after.verify(used, { method: "GET", url }), /signed before this coordinator started/, "the used one cannot be replayed after the restart");
  await assert.rejects(after.verify(unused, { method: "GET", url }), /signed before this coordinator started/, "nor can one that was never presented");
  const fresh = identityFor(Math.floor(clock / 1000), url);
  assert.equal((await after.verify(fresh, { method: "GET", url })).principal.actorId, "acct_alice", "an identity signed after the restart works once");
  await assert.rejects(after.verify(fresh, { method: "GET", url }), /already used/);
  // The start time can also be given: an identity from the very second the coordinator started is not "before".
  const started = Date.parse("2026-11-17T11:00:00Z");
  const exact = verifier(() => started + 1000, started);
  assert.equal((await exact.verify(identityFor(Math.floor(started / 1000), url), { method: "GET", url })).principal.actorId, "acct_alice");
  await assert.rejects(verifier(() => started + 1000, started).verify(identityFor(Math.floor(started / 1000) - 1, url), { method: "GET", url }), /signed before/);
});
