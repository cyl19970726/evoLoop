import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@evoloop/contracts";
import { AcceptanceRelayService } from "../src/acceptance-relay/service.js";

const projectId = "40000006-0000-4000-8000-000000000001";
const principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "review"] } as unknown as Principal;
const row = (id: string, actor: string) => ({ session_id: id, role_id: "role", actor_id: actor, cwd: "/work", state: "ready", native_thread_id: "t",
  tenure: "resident", active_runs: 0, pending_messages: 0, queue_entries: 0, open_assignments: 0, open_acceptance: 0 });

/** Grants are keyed by receiver actor, as in main.ts: a missing grant is reported only for the identity actually named. */
function service(rows: ReturnType<typeof row>[], bound: Record<string, string | null>, granted: Set<string>) {
  const seen: string[] = [];
  const svc = new AcceptanceRelayService({
    pool: { query: async () => ({ rows }) } as never,
    workflow: { getRuntimeSession: async (_p: unknown, _project: string, id: string) => ({ id, actorId: rows.find(r => r.session_id === id)!.actor_id }) } as never,
    messages: {} as never, principals: async () => [], canWrite: () => true, leaderSession: async () => null, qualify: async () => null,
    capabilities: async ({ session, receiverActorId }) => {
      seen.push(`${session.id}:${receiverActorId}`);
      const problems: string[] = [];
      if (bound[session.id] !== receiverActorId) problems.push("RECIPIENT_BINDING_MISSING");
      if (!granted.has(`${session.id}:${receiverActorId}`)) problems.push("MESSAGE_GRANT_MISSING");
      return problems;
    },
    boundRecipient: async (_project, session) => bound[session.id] ?? null,
  });
  return { svc, seen };
}

test("capacity names the Session's CLI-bound identity as recipient, so a Session that passes arrangement is not reported missing", async () => {
  const { svc, seen } = service([row("s1", "target-owner")], { s1: "dev-claude-agent" }, new Set(["s1:dev-claude-agent"]));
  const [view] = await svc.capacity(principal, projectId) as { missingCapabilities: string[]; readyForAcceptance: boolean }[];
  assert.deepEqual(seen, ["s1:dev-claude-agent"], "the creator identity is not used");
  assert.deepEqual(view!.missingCapabilities, []);
  assert.equal(view!.readyForAcceptance, true);
});

test("capacity still reports a real missing grant, and a Session with no CLI binding keeps RECIPIENT_BINDING_MISSING", async () => {
  const { svc } = service([row("granted", "owner"), row("nogrant", "owner"), row("unbound", "owner")],
    { granted: "cli-a", nogrant: "cli-b", unbound: null }, new Set(["granted:cli-a"]));
  const views = await svc.capacity(principal, projectId) as { sessionId: string; missingCapabilities: string[]; readyForAcceptance: boolean }[];
  const by = Object.fromEntries(views.map(v => [v.sessionId, v]));
  assert.deepEqual(by.granted!.missingCapabilities, []);
  assert.deepEqual(by.nogrant!.missingCapabilities, ["MESSAGE_GRANT_MISSING"], "a genuinely missing grant is not hidden");
  assert.ok(by.unbound!.missingCapabilities.includes("RECIPIENT_BINDING_MISSING"));
  assert.equal(by.nogrant!.readyForAcceptance, false);
  assert.equal(by.unbound!.readyForAcceptance, false);
});
