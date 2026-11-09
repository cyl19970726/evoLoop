import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { conformance } from "./codex-conformance.mjs";

const run = promisify(execFile);
const surface = await import(new URL("../packages/adapter-codex-app-server/dist/index.js", import.meta.url).href);
const script = new URL("./codex-conformance.mjs", import.meta.url).pathname;

async function fakeCodex(t, version, schema) {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-conformance-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemaFile = join(directory, "schema.json");
  await writeFile(schemaFile, schema);
  const bin = join(directory, "codex");
  await writeFile(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi
if [ "$1" = "app-server" ] && [ "$2" = "generate-json-schema" ]; then
  while [ "$#" -gt 0 ]; do if [ "$1" = "--out" ]; then shift; cp '${schemaFile}' "$1/codex_app_server_protocol.v2.schemas.json"; exit 0; fi; shift; done
fi
printf 'app server must not start' >&2; exit 9
`, { mode: 0o700 });
  return bin;
}

test("conformance reports hashes, pinning and used-surface problems without starting the App Server", { skip: process.platform === "win32" }, async t => {
  const bin = await fakeCodex(t, "codex-cli 0.170.0", "{}");
  const report = await conformance({ bin, expected: "0.166.0-alpha.5.1", surface });
  assert.equal(report.version, "codex-cli 0.170.0");
  assert.equal(report.versionOrder, 1);
  assert.equal(report.exactVersionMatch, false);
  assert.equal(report.ok, false);
  assert.equal(report.schemas.standard.pinnedMatch, null);
  assert.match(report.schemas.standard.sha256, /^[0-9a-f]{64}$/);
  assert.ok(report.schemas.experimental.problems.includes("method turn/start is missing"));
  assert.equal(report.pinnedFeatures, null);
});

test("the CLI exits 1 on surface problems and 2 on usage errors", { skip: process.platform === "win32" }, async t => {
  const bin = await fakeCodex(t, "codex-cli 0.166.0-alpha.5.1", "not json");
  await assert.rejects(run(process.execPath, [script, "--bin", bin, "--json"]), error => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.deepEqual(report.schemas.standard.problems, ["schema is not JSON"]);
    assert.equal(report.schemas.standard.pinnedMatch, false);
    assert.equal(report.pinnedFeatures.workspace, true);
    return true;
  });
  await assert.rejects(run(process.execPath, [script, "--bin", "relative/codex"]), error => error.code === 2);
});
