import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { CodexAppServerAdapter } from "../src/index.js";

const fixture = resolve(import.meta.dirname, "fixture.mjs");
async function open(mode: string, expectedVersion = "codex-cli 0.166.0-alpha.6"): Promise<CodexAppServerAdapter> {
  const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs: [fixture, mode],
    expectedVersion, initializationTimeoutMs: 5000, requestTimeoutMs: 500 });
  await adapter.open();
  return adapter;
}

test("capability lists keep valid skills, installed plugins and MCP servers for one cwd", async t => {
  const adapter = await open("capability-lists"); t.after(() => adapter.close());
  const listed = await adapter.listCapabilities("/tmp/evoloop-fixture");
  assert.deepEqual(listed.skills.map(skill => [skill.name, skill.scope, skill.pluginId]),
    [["alpha", "repo", null], ["mine", "user", "tools@local"], ["skill-installer", "system", null]]);
  assert.equal(listed.skills[1]!.description!.length, 500, "descriptions are bounded");
  assert.deepEqual(listed.plugins, [{ name: "tools", enabled: true }, { name: "off", enabled: false }]);
  assert.deepEqual(listed.mcpServers, [{ name: "docs", auth: "oAuth" }]);
  assert.deepEqual(listed.errors, []);
  const skillsOnly = await adapter.listCapabilities("/tmp/evoloop-fixture", { skillsOnly: true });
  assert.equal(skillsOnly.skills.length, 3);
  assert.equal(skillsOnly.plugins, null);
  assert.equal(skillsOnly.mcpServers, null);
});

test("plugin and MCP lists are best effort; a failed list is named without its message", async t => {
  const adapter = await open("capability-lists-partial"); t.after(() => adapter.close());
  const listed = await adapter.listCapabilities("/tmp/evoloop-fixture");
  assert.equal(listed.skills.length, 3);
  assert.equal(listed.plugins, null);
  assert.equal(listed.mcpServers, null);
  assert.deepEqual(listed.errors, ["plugin/list", "mcpServerStatus/list"]);
  assert.ok(!JSON.stringify(listed).includes("private"));
  assert.equal(adapter.isReady(), true, "a timed-out list does not disconnect the App Server");
});

test("capability lists need a protocol that has them and an absolute normalized cwd", async t => {
  const old = await open("capability-lists", "codex-cli 0.164.0-alpha.11.1"); t.after(() => old.close());
  await assert.rejects(old.listCapabilities("/tmp/evoloop-fixture"), /newer Codex protocol/);
  const adapter = await open("capability-lists"); t.after(() => adapter.close());
  await assert.rejects(adapter.listCapabilities("relative/dir"), /invalid cwd/);
  await assert.rejects(adapter.listCapabilities("/tmp/../tmp/evoloop-fixture"), /invalid cwd/);
});
