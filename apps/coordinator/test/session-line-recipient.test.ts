import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveLineRecipient, type LineRecipientConfig } from "../src/session-line/recipient.js";

const projectId = randomUUID(), roleId = randomUUID();
const dev2 = { projectId, id: randomUUID(), roleId, actorId: "session-dev-2" };
const accept = { projectId, id: randomUUID(), roleId, actorId: "session-acceptance" };
const accept2 = { projectId, id: randomUUID(), roleId, actorId: "session-acceptance-2" };
const writers = new Set(["dev-claude-2-agent", "acceptance-claude-agent", "acceptance-2-claude-agent", "dev-claude-agent"]);
const writer = async (_project: string, actor: string) => writers.has(actor);
const config: LineRecipientConfig = {
  // The Role-level actor is the dev identity, as in the formal instance where it made every entry go to dev-claude-agent.
  roleActors: [{ projectId, roleId, actorId: "dev-claude-agent" }],
  materialCli: [
    { projectId, sessionId: dev2.id, sessionActorId: dev2.actorId, cliActorId: "dev-claude-2-agent" },
    { projectId, sessionId: accept.id, sessionActorId: accept.actorId, cliActorId: "acceptance-claude-agent" },
    { projectId, sessionId: accept2.id, sessionActorId: accept2.actorId, cliActorId: "acceptance-2-claude-agent" },
  ],
};

test("Sessions that share one Role each get their own signing identity, never the Role's actor", async () => {
  assert.deepEqual(await resolveLineRecipient(dev2, config, 3, writer), { actorId: "dev-claude-2-agent" });
  assert.deepEqual(await resolveLineRecipient(accept, config, 3, writer), { actorId: "acceptance-claude-agent" });
  assert.deepEqual(await resolveLineRecipient(accept2, config, 3, writer), { actorId: "acceptance-2-claude-agent" });
});

test("a Session shared with others and without its own entry is refused, naming it, rather than given the Role's actor", async () => {
  const third = { projectId, id: randomUUID(), roleId, actorId: "session-unmapped" };
  const result = await resolveLineRecipient(third, config, 4, writer);
  assert.ok("unresolved" in result);
  assert.match(result.unresolved, new RegExp(third.id)); assert.match(result.unresolved, /3 other live Session/); assert.match(result.unresolved, /runtime\.materialCli/);
  assert.match(result.unresolved, /not guessed from the Role/);
});

test("the Role's actor is still used when the Role has exactly one live Session (single-Session setups do not regress)", async () => {
  const only = { projectId, id: randomUUID(), roleId, actorId: "session-only" };
  assert.deepEqual(await resolveLineRecipient(only, { roleActors: config.roleActors, materialCli: [] }, 1, writer), { actorId: "dev-claude-agent" });
  const roleEntry: LineRecipientConfig = { roleActors: [], materialCli: [{ projectId, roleId, sessionActorId: only.actorId, cliActorId: "dev-claude-2-agent" }] };
  assert.deepEqual(await resolveLineRecipient(only, roleEntry, 1, writer), { actorId: "dev-claude-2-agent" });
  const none = await resolveLineRecipient(only, { roleActors: [], materialCli: [] }, 1, writer);
  assert.ok("unresolved" in none); assert.match(none.unresolved, /no configured business identity/);
});

test("a configured identity that is not a current project writer is refused before anything is assigned", async () => {
  const result = await resolveLineRecipient(accept, config, 3, async (_p, actor) => actor !== "acceptance-claude-agent");
  assert.ok("unresolved" in result); assert.match(result.unresolved, /acceptance-claude-agent.*not a current project writer/);
});

test("an entry for another Session or another native actor never matches", async () => {
  const wrongActor = { ...accept, actorId: "someone-else" };
  const result = await resolveLineRecipient(wrongActor, config, 3, writer);
  assert.ok("unresolved" in result, "the entry is bound to the Session's native actor as well as its ID");
  const taskScoped: LineRecipientConfig = { roleActors: [], materialCli: [{ projectId, sessionId: dev2.id, taskId: randomUUID(), sessionActorId: dev2.actorId, cliActorId: "dev-claude-2-agent" }] };
  assert.ok("unresolved" in await resolveLineRecipient(dev2, taskScoped, 2, writer), "a Task-scoped entry is not the Session's line identity");
});
