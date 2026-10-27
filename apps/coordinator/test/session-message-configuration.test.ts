import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIntegrations, selectMaterialCli } from "../src/configuration.ts";

test("native input is a default-off capability of the fixed 0.164 child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evoloop-input-config-")), path = join(dir, "integrations.json");
  try {
    await writeFile(path, JSON.stringify({ runtime: { enabled: true, grants: [] } }));
    assert.equal((await loadIntegrations(path)).runtime?.nativeUserInput, false);
    await writeFile(path, JSON.stringify({ runtime: { enabled: true, nativeUserInput: true, grants: [] } }));
    assert.equal((await loadIntegrations(path)).runtime?.nativeUserInput, true);
    await writeFile(path, JSON.stringify({ runtime: { enabled: true, nativeUserInput: true, protocolVersion: "0.154.0", grants: [] } }));
    await assert.rejects(loadIntegrations(path), /Invalid integration configuration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("material CLI entry follows exact Session and recipient across Tasks, with optional Task override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evoloop-material-cli-config-")), path = join(dir, "integrations.json");
  const entry = { projectId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    sessionActorId: "requesting-owner", cliActorId: "actual-recipient", command: "/usr/local/bin/python3 /private/approved-cli.py" };
  try {
    await writeFile(path, JSON.stringify({runtime:{enabled:true,grants:[],materialCli:[entry]}}));
    assert.deepEqual((await loadIntegrations(path)).runtime?.materialCli[0], entry);
    const firstTask = "00000000-0000-4000-8000-000000000003", secondTask = "00000000-0000-4000-8000-000000000004";
    assert.deepEqual(selectMaterialCli([entry], entry.projectId, entry.sessionId, entry.sessionActorId, firstTask), entry);
    assert.deepEqual(selectMaterialCli([entry], entry.projectId, entry.sessionId, entry.sessionActorId, secondTask), entry,
      "one recipient CLI serves the next Task on the same Session");
    assert.equal(selectMaterialCli([entry], entry.projectId, entry.sessionId, "other-actor", secondTask), null);
    const override = {...entry,taskId:secondTask,command:"/private/other-cli"};
    assert.deepEqual(selectMaterialCli([entry,override],entry.projectId,entry.sessionId,entry.sessionActorId,secondTask),override);
    await writeFile(path, JSON.stringify({runtime:{enabled:true,grants:[],materialCli:[entry,entry]}}));
    await assert.rejects(loadIntegrations(path), /Invalid integration configuration/);
    await writeFile(path, JSON.stringify({runtime:{enabled:true,grants:[],materialCli:[{...entry,command:"/usr/local/bin/python3 /private/x.py;cat /secret"}]}}));
    await assert.rejects(loadIntegrations(path), /Invalid integration configuration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ordinary message grants have independent bounds, actual receiver identity without an obsolete readonly switch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evoloop-message-config-"));
  const path = join(dir, "integrations.json");
  const grant = { projectId: "00000000-0000-4000-8000-000000000001", sessionId: "00000000-0000-4000-8000-000000000002",
    senderActorId: "lead", receiverActorId: "actual-worker", receiverRoleId: "role", cwd: dir, maxTurns: 2, enabled: true };
  try {
    await writeFile(path, JSON.stringify({ sessionMessages: { enabled: true, grants: [grant] } }));
    const config = await loadIntegrations(path);
    assert.equal(config.sessionMessages?.readOnlyProtocolVerified, undefined);
    assert.equal(config.sessionMessages?.grants[0]?.maxTurns, 2);
    assert.equal(config.residentQueue, undefined);
    await writeFile(path, JSON.stringify({ sessionMessages: { enabled: true, grants: [{ ...grant, maxTurns: 0 }] } }));
    await assert.rejects(loadIntegrations(path), /Invalid integration configuration/);
    await writeFile(path, JSON.stringify({ sessionMessages: { enabled: true, grants: [grant, grant] } }));
    await assert.rejects(loadIntegrations(path), /Invalid integration configuration/);
    const { receiverActorId: _receiver, ...missingReceiver } = grant;
    await writeFile(path, JSON.stringify({ sessionMessages: { enabled: true, grants: [missingReceiver] } }));
    await assert.rejects(loadIntegrations(path), /Invalid integration configuration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
