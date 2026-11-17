import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import type { MachineCredentials } from "@evoloop/contracts";
import { logHubIdentityRejected } from "../src/hub/log.ts";
import { HubIdentityVerifier } from "../src/hub/identity.ts";
import { buildServer } from "../src/server.ts";

// Task b5fe71c8: a forwarded request the coordinator refuses gets only "转发身份未被接受。" (401); the reason must be in the machine's own log, on stderr.
const projectId = randomUUID(), machineId = randomUUID();

test("the rejection line goes to the process's real stderr, with the time and the reason and nothing else", () => {
  const code = `import { logHubIdentityRejected } from ${JSON.stringify(resolve("apps/coordinator/src/hub/log.ts"))}; logHubIdentityRejected("identity signed before this coordinator started");`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "", "not on stdout");
  assert.match(child.stderr, /^\d{4}-\d\d-\d\dT[\d:.]+Z Hub identity rejected: identity signed before this coordinator started\n$/);
  const lines: string[] = [];
  logHubIdentityRejected("multi\nline\r\nreason".repeat(50), line => lines.push(line), () => new Date("2026-11-17T02:45:00Z"));
  assert.equal(lines.length, 1); assert.ok(lines[0]!.length < 260 && lines[0]!.endsWith("\n") && lines[0]!.indexOf("\n") === lines[0]!.length - 1, "one line, bounded");
});

test("every way the verifier refuses an identity reaches the log through the real server path: a restart window, an unknown key, a missing header value", async t => {
  const keys = generateKeyPairSync("ed25519");
  const credentials = (): MachineCredentials => ({ version: 1, hubOrigin: "https://hub.example", machineId, name: "m", privateKey: "unused",
    hubPublicKeys: [{ kid: "k1", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }], allowedRoots: ["/srv"], joinedAt: new Date().toISOString() });
  const signed = (iat: number, kid = "k1") => {
    const url = `/api/projects/${projectId}/documents`;
    const payload = Buffer.from(JSON.stringify({ v: 1, kid, aud: machineId, jti: randomUUID(), iat, exp: iat + 60, sub: { actorId: "acct_alice", kind: "human", auth: "token" }, projectId,
      permissions: ["session"], decisions: false, sessionIds: [], method: "GET", target: createHash("sha256").update(url, "utf8").digest("base64url") })).toString("base64url");
    const signature = sign(null, Buffer.from(`evoloop-hub-identity-v1\n${payload}`), createPrivateKey(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toString("base64url");
    return `v1.${payload}.${signature}`;
  };
  const lines: string[] = [];
  const startedAt = Date.now();   // the coordinator "restarts" now
  const verifier = new HubIdentityVerifier({ credentials, isLocalProject: async () => true, localActorIds: () => new Set(), startedAt });
  const app = await buildServer({ service: new Proxy({}, { get: () => async () => undefined }) as never, credentials: [{ token: "t".repeat(32), actorId: "local-agent", projectIds: [projectId], permissions: ["task", "document", "session"] }], hubIdentity: { verifier, onRejected: reason => logHubIdentityRejected(reason, line => lines.push(line)) } } as never);
  t.after(() => app.close());
  const get = (identity: string) => app.inject({ method: "GET", url: `/api/projects/${projectId}/documents`, headers: { "x-evoloop-hub-identity": identity } });
  // Signed ten seconds before the restart, presented after it: refused, and the reason is logged.
  const early = await get(signed(Math.floor(startedAt / 1000) - 10));
  assert.equal(early.statusCode, 401); assert.equal(early.json<{ message: string }>().message, "转发身份未被接受。", "the caller is told nothing about the cause");
  assert.match(lines.at(-1)!, /Hub identity rejected: .*signed before this coordinator started/);
  assert.equal((await get(signed(Math.floor(startedAt / 1000) + 1, "nope"))).statusCode, 401); assert.match(lines.at(-1)!, /unknown Hub key/);
  assert.equal((await get("")).statusCode, 401); assert.match(lines.at(-1)!, /hub identity not usable here/);
  assert.equal(lines.length, 3, "one line per refusal");
});
