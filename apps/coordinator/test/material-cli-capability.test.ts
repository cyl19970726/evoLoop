import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportsFixedHandoff } from "../src/runtime/material-cli-capability.js";

test("v2 handoff preflight rejects an old CLI or mismatched identity before native start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-material-capability-"));
  const script = join(directory, "cli.mjs");
  const command = `${process.execPath} ${script}`;
  const projectId = "00000000-0000-4000-8000-000000000001";
  try {
    const fixture = async (hasHandoff: boolean, actorId = "recipient") => writeFile(script,
      `const action=process.argv[2];\n`+
      `if(action==='help')console.log(JSON.stringify({commands:${JSON.stringify(hasHandoff ?
        ["handoff RUN_UUID --project UUID --hash SHA256 (verified v2)"] : ["run-input RUN_UUID --project UUID --hash SHA256"])} }));\n`+
      `else if(action==='session')console.log(JSON.stringify({principal:{actorId:${JSON.stringify(actorId)},projectIds:[${JSON.stringify(projectId)}],permissions:['read']}}));\n`);
    await fixture(false);
    assert.equal(await supportsFixedHandoff(command, "recipient", projectId), false);
    await fixture(true, "other");
    assert.equal(await supportsFixedHandoff(command, "recipient", projectId), false);
    await fixture(true);
    assert.equal(await supportsFixedHandoff(command, "recipient", projectId), true);
    assert.equal(await supportsFixedHandoff("/bin/echo ;cat /private", "recipient", projectId), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
