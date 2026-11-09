import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drivenRuntimeProviders, loadIntegrations } from "../src/configuration.ts";

test("the claude provider needs its own config directory and excludes Codex-only features", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evoloop-claude-config-")), path = join(dir, "integrations.json");
  const write = (runtime: Record<string, unknown>) => writeFile(path, JSON.stringify({ runtime: { enabled: true, grants: [], ...runtime } }));
  try {
    await write({});
    assert.equal((await loadIntegrations(path)).runtime?.provider, "codex", "existing configurations keep Codex");
    await write({ provider: "claude", claude: { configRoot: "/srv/evoloop/claude", maxTurns: 40, maxBudgetUsd: 5 } });
    const runtime = (await loadIntegrations(path)).runtime;
    assert.equal(runtime?.provider, "claude");
    assert.deepEqual(runtime?.claude, { configRoot: "/srv/evoloop/claude", maxTurns: 40, maxBudgetUsd: 5,
      skillBundle: true, contextMode: "project" }, "each Turn loads the Role's selected skills; project settings stay read until explicit is chosen");
    const projectId = "00000000-0000-4000-8000-000000000001", roleId = "00000000-0000-4000-8000-000000000002";
    await write({ provider: "claude", claude: { configRoot: "/srv/evoloop/claude", contextMode: "explicit", skillBundle: false },
      roleSkills: [{ projectId, roleId, paths: [".agents/skills/evoloop-workflow/SKILL.md"], builtinSkills: ["code-review"] }] });
    const explicit = (await loadIntegrations(path)).runtime;
    assert.equal(explicit?.claude?.contextMode, "explicit");
    assert.equal(explicit?.claude?.skillBundle, false);
    assert.deepEqual(explicit?.roleSkills[0]?.builtinSkills, ["code-review"], "the superseded field still loads");
    for (const invalid of [
      { provider: "claude" },
      { provider: "claude", claude: { configRoot: "relative/claude" } },
      { provider: "claude", claude: { configRoot: "/srv/claude", apiKey: "sk-ant-not-accepted" } },
      { provider: "claude", nativeUserInput: true, claude: { configRoot: "/srv/claude" } },
      { provider: "claude", claude: { configRoot: "/srv/claude", contextMode: "user" } },
      { provider: "claude", claude: { configRoot: "/srv/claude" },
        roleSkills: [{ projectId, roleId, paths: [".agents/skills/evoloop-workflow/SKILL.md"], builtinSkills: ["../escape"] }] },
    ]) {
      await write(invalid);
      await assert.rejects(loadIntegrations(path), /Invalid integration configuration/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("one coordinator can drive Codex and Claude together; the default provider binds new Roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evoloop-providers-config-")), path = join(dir, "integrations.json");
  const write = (runtime: Record<string, unknown>) => writeFile(path, JSON.stringify({ runtime: { enabled: true, grants: [], ...runtime } }));
  const claude = { configRoot: "/srv/evoloop/claude" };
  try {
    await write({});
    assert.deepEqual(drivenRuntimeProviders((await loadIntegrations(path)).runtime!), ["codex"], "absent providers drive only the default");
    await write({ provider: "codex", providers: ["codex", "claude"], claude });
    const both = (await loadIntegrations(path)).runtime!;
    assert.equal(both.provider, "codex");
    assert.deepEqual(drivenRuntimeProviders(both), ["codex", "claude"]);
    await write({ provider: "claude", providers: ["claude", "codex"], claude, nativeUserInput: true, protocolVersion: "0.166.0-alpha.6" });
    assert.deepEqual(drivenRuntimeProviders((await loadIntegrations(path)).runtime!), ["claude", "codex"],
      "Codex-only features stay valid while Codex is driven too");
    for (const invalid of [
      { provider: "codex", providers: ["codex", "claude"] },
      { provider: "claude", providers: ["codex"], claude },
      { provider: "codex", providers: ["codex", "codex"] },
      { provider: "codex", providers: [] },
      { provider: "claude", providers: ["claude"], claude, nativeUserInput: true, protocolVersion: "0.166.0-alpha.6" },
    ]) {
      await write(invalid);
      await assert.rejects(loadIntegrations(path), /Invalid integration configuration/, JSON.stringify(invalid));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
