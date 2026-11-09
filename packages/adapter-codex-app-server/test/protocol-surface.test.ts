import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexAppServerAdapter, checkUsedSurface, compareCodexVersions, pinnedFeatures, versionAllowed } from "../src/index.js";
import { FEATURE_METHODS, USED_NOTIFICATIONS, USED_REQUESTS } from "../src/protocol-surface.js";

// Plan V1/V2: a minimum-version policy with a used-surface schema check, beside exact pinning.
const fixture = resolve(import.meta.dirname, "fixture.mjs");

/** Synthetic generated-schema shape: request variants discriminated by `method`, params by $ref. */
function schema(options: { drop?: string[]; require?: Record<string, string[]>; features?: string[] } = {}): unknown {
  const methods = [...Object.keys(USED_REQUESTS), ...(options.features ?? [])].filter(method => !options.drop?.includes(method));
  const definitions: Record<string, unknown> = {};
  const variants = methods.map((method, index) => {
    const name = `Params${index}`;
    const sent = USED_REQUESTS[method] ?? [];
    definitions[name] = { type: "object", properties: Object.fromEntries(sent.map(key => [key, {}])),
      required: [...sent.slice(0, 1), ...(options.require?.[method] ?? [])] };
    return { type: "object", properties: { id: {}, method: { type: "string", enum: [method] }, params: { $ref: `#/definitions/${name}` } } };
  });
  const notifications = USED_NOTIFICATIONS.filter(method => !options.drop?.includes(method))
    .map(method => ({ type: "object", properties: { method: { type: "string", enum: [method] }, params: {} } }));
  return { $schema: "http://json-schema.org/draft-07/schema#", definitions,
    oneOf: [{ title: "ClientRequest", oneOf: variants }, { title: "ServerNotification", oneOf: notifications }] };
}

test("the used surface passes when every sent method and notification is present", () => {
  const report = checkUsedSurface(schema());
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.features, { modern: false, workspace: false, compaction: false, directInput: false, capabilityLists: false });
});

test("a missing method, notification or newly required parameter is a problem", () => {
  const report = checkUsedSurface(schema({ drop: ["turn/interrupt", "item/completed"], require: { "turn/start": ["attestation"] } }));
  assert.ok(report.problems.includes("method turn/interrupt is missing"));
  assert.ok(report.problems.includes("notification item/completed is missing"));
  assert.ok(report.problems.includes("method turn/start now requires attestation"));
  assert.deepEqual(checkUsedSurface(null).problems, ["schema is not an object"]);
});

test("optional features are enabled only when all of their methods are present", () => {
  const all = Object.values(FEATURE_METHODS).flat();
  assert.deepEqual(checkUsedSurface(schema({ features: all })).features, { modern: true, workspace: true, compaction: true, directInput: true, capabilityLists: true });
  const partial = checkUsedSurface(schema({ features: ["thread/compact/start", "turn/steer"] })).features;
  assert.equal(partial.compaction, true);
  assert.equal(partial.directInput, false, "direct input needs both turn/steer and thread/settings/update");
});

test("Codex CLI versions compare by semantic version including prereleases", () => {
  assert.equal(compareCodexVersions("codex-cli 0.166.0-alpha.6", "codex-cli 0.166.0-alpha.5.1"), 1);
  assert.equal(compareCodexVersions("codex-cli 0.166.0-alpha.10", "codex-cli 0.166.0-alpha.9"), 1);
  assert.equal(compareCodexVersions("codex-cli 0.166.0", "codex-cli 0.166.0-alpha.6"), 1);
  assert.equal(compareCodexVersions("codex-cli 0.154.0", "codex-cli 0.164.0-alpha.11.1"), -1);
  assert.equal(compareCodexVersions("codex 0.1", "codex-cli 0.154.0"), null);
  assert.equal(versionAllowed("codex-cli 0.170.0", "codex-cli 0.166.0-alpha.5.1", []), true);
  assert.equal(versionAllowed("codex-cli 0.170.0", "codex-cli 0.166.0-alpha.5.1", ["codex-cli 0.170.0"]), false);
  assert.equal(versionAllowed("codex-cli 0.164.0-alpha.11.1", "codex-cli 0.166.0-alpha.5.1", []), false);
  assert.equal(versionAllowed("not a version", "codex-cli 0.154.0", []), false);
});

test("the reviewed feature table matches each pinned protocol", () => {
  assert.equal(pinnedFeatures("codex-cli 0.154.0")?.modern, false);
  assert.equal(pinnedFeatures("codex-cli 0.166.0-alpha.6")?.compaction, true);
  assert.equal(pinnedFeatures("codex-cli 0.167.0-alpha.3.2")?.compaction, false);
  assert.equal(pinnedFeatures("codex-cli 9.9.9"), null);
  assert.equal(new CodexAppServerAdapter({ expectedVersion: "codex-cli 0.166.0-alpha.6" }).capabilities().compaction.mode, "owned_request");
  assert.equal(new CodexAppServerAdapter({ expectedVersion: "codex-cli 0.167.0-alpha.3.2" }).capabilities().compaction.mode, "unavailable");
});

test("mid-Turn input is declared exactly where the pinned protocol can steer", () => {
  const declared = (version: string) => new CodexAppServerAdapter({ expectedVersion: version }).capabilities().delivery.midTurnInput;
  assert.equal(declared("codex-cli 0.166.0-alpha.6"), true);
  for (const version of ["codex-cli 0.154.0", "codex-cli 0.164.0-alpha.11.1", "codex-cli 0.166.0-alpha.5.1", "codex-cli 0.167.0-alpha.3.2"])
    assert.equal(declared(version), false, version);
  assert.equal(new CodexAppServerAdapter().capabilities().delivery.midTurnInput, false, "the default pin cannot steer");
});

test("invalid surface policy options are refused at construction", () => {
  assert.throws(() => new CodexAppServerAdapter({ protocolCheck: "loose" as "exact" }), /protocolCheck/);
  assert.throws(() => new CodexAppServerAdapter({ protocolCheck: "surface", minimumVersion: "latest" }), /minimumVersion/);
  assert.throws(() => new CodexAppServerAdapter({ protocolCheck: "surface", blockedVersions: ["0.170"] }), /blockedVersions/);
});

async function fakeCodex(t: { after(fn: () => unknown): void }, version: string, body: unknown): Promise<{ executable: string; started: string }> {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-protocol-surface-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemaFile = join(directory, "schema.json");
  const started = join(directory, "started");
  await writeFile(schemaFile, JSON.stringify(body));
  const executable = join(directory, "fake-codex");
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi
if [ "$1" = "app-server" ] && [ "$2" = "generate-json-schema" ]; then
  while [ "$#" -gt 0 ]; do if [ "$1" = "--out" ]; then shift; mkdir -p "$1"; cp '${schemaFile}' "$1/codex_app_server_protocol.v2.schemas.json"; exit 0; fi; shift; done
fi
printf 'started' > '${started}'
exec '${process.execPath}' '${fixture}' normal
`, { mode: 0o700 });
  return { executable, started };
}

test("surface check runs a newer CLI whose schema covers the used surface and records its version", { skip: process.platform === "win32" }, async t => {
  const { executable, started } = await fakeCodex(t, "codex-cli 0.170.0", schema({ features: ["thread/compact/start"] }));
  const adapter = new CodexAppServerAdapter({ executable, expectedVersion: "codex-cli 0.154.0", protocolCheck: "surface",
    minimumVersion: "codex-cli 0.166.0-alpha.5.1", requestTimeoutMs: 5_000 });
  t.after(() => adapter.close());
  await adapter.open();
  assert.equal(adapter.isReady(), true);
  await stat(started);
  assert.equal(adapter.capabilities().compaction.mode, "owned_request");
  assert.equal(adapter.capabilities().naming, false);
  assert.equal(adapter.capabilities().delivery.midTurnInput, false, "the schema lacks turn/steer");
});

test("surface check declares mid-Turn input only when the schema has every direct input method", { skip: process.platform === "win32" }, async t => {
  const { executable } = await fakeCodex(t, "codex-cli 0.170.0", schema({ features: [...FEATURE_METHODS.directInput] }));
  const adapter = new CodexAppServerAdapter({ executable, expectedVersion: "codex-cli 0.154.0", protocolCheck: "surface",
    minimumVersion: "codex-cli 0.166.0-alpha.5.1", requestTimeoutMs: 5_000 });
  t.after(() => adapter.close());
  await adapter.open();
  assert.equal(adapter.capabilities().delivery.midTurnInput, true);
});

test("surface check refuses an old, blocked or surface-breaking CLI before App Server startup", { skip: process.platform === "win32" }, async t => {
  const cases: [string, unknown, string[], RegExp][] = [
    ["codex-cli 0.164.0-alpha.11.1", schema(), [], /below/],
    ["codex-cli 0.170.0", schema(), ["codex-cli 0.170.0"], /blocked/],
    ["codex-cli 0.170.0", schema({ require: { "thread/start": ["workspaceId"] } }), [], /now requires workspaceId/],
    ["codex-cli 0.170.0", schema({ drop: ["thread/read"] }), [], /thread\/read is missing/],
  ];
  for (const [version, body, blockedVersions, expected] of cases) {
    const { executable, started } = await fakeCodex(t, version, body);
    const adapter = new CodexAppServerAdapter({ executable, protocolCheck: "surface",
      minimumVersion: "codex-cli 0.166.0-alpha.5.1", blockedVersions, requestTimeoutMs: 5_000 });
    await assert.rejects(() => adapter.open(), expected);
    await assert.rejects(() => stat(started), { code: "ENOENT" });
  }
});

test("surface check refuses a schema without the feature an enabled option needs", { skip: process.platform === "win32" }, async t => {
  const { executable, started } = await fakeCodex(t, "codex-cli 0.170.0", schema());
  const adapter = new CodexAppServerAdapter({ executable, expectedVersion: "codex-cli 0.166.0-alpha.5.1", protocolCheck: "surface",
    nativeUserInput: true, requestTimeoutMs: 5_000 });
  await assert.rejects(() => adapter.open(), /nativeUserInput requires a modern/);
  await assert.rejects(() => stat(started), { code: "ENOENT" });
});
