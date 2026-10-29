import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportsFixedHandoff, supportsMaterialCli } from "../src/runtime/material-cli-capability.js";

test("v2 handoff preflight rejects an old CLI or mismatched identity before native start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-material-capability-"));
  const script = join(directory, "cli.mjs");
  const command = `${process.execPath} ${script}`;
  const projectId = "00000000-0000-4000-8000-000000000001";
  try {
    const oldCommandTable = [
      "handoff RUN_UUID --project UUID --hash SHA256 (verified v2 goal, full acceptance, changes and fixed material catalog)",
      "request types", "request schema NAME",
      "request NAME --project UUID --file JSON_FILE [--id UUID] [--receipt UUID for endpoints without server operation IDs]",
    ]; // e95c68c apps/cli/src/application.ts:82-95; generic request schema is not ordinary.submit.
    const fixture = async (hasHandoff: boolean, actorId = "recipient", hasSubmission = false,
      permissions = ["read", "write"]) => writeFile(script,
      `const action=process.argv[2];\n`+
      `if(action==='help')console.log(JSON.stringify({commands:${JSON.stringify(hasHandoff ? oldCommandTable :
        ["run-input RUN_UUID --project UUID --hash SHA256"])} }));\n`+
      `else if(action==='session')console.log(JSON.stringify({principal:{actorId:${JSON.stringify(actorId)},projectIds:[${JSON.stringify(projectId)}],permissions:${JSON.stringify(permissions)}}}));\n`+
      `else if(action==='request'&&process.argv[3]==='schema'&&process.argv[4]==='ordinary.submit')${hasSubmission ?
        `console.log(JSON.stringify({type:'object',required:['projectId','operationId','submissionId','runId','taskId','sessionId','taskRevisionId','runInputHash','deliveryOperationId','deliveryIntent'],properties:{deliveryIntent:{required:['artifactRef','artifactRevision','contentHash','technicalResult','technicalEvidence','reason']}}}));` :
        `process.exit(2);`}\n`);
    await fixture(false);
    assert.equal(await supportsFixedHandoff(command, "recipient", projectId), false);
    await fixture(true, "other");
    assert.equal(await supportsFixedHandoff(command, "recipient", projectId), false);
    await fixture(true);
    assert.equal(await supportsFixedHandoff(command, "recipient", projectId), true);
    assert.equal(await supportsMaterialCli(command, "recipient", projectId,
      {fixedHandoff:true,ordinarySubmit:true}), false, "e95c68c wrapper has handoff but cannot submit");
    assert.equal(await supportsMaterialCli(command, "recipient", projectId,
      {fixedHandoff:false,ordinarySubmit:true}), false, "static Runs also reject the old wrapper");
    await fixture(true, "recipient", true, ["read"]);
    assert.equal(await supportsMaterialCli(command, "recipient", projectId,
      {fixedHandoff:true,ordinarySubmit:true}), false, "the signer needs project write");
    await fixture(true, "recipient", true);
    assert.equal(await supportsMaterialCli(command, "recipient", projectId,
      {fixedHandoff:true,ordinarySubmit:true}), true);
    assert.equal(await supportsMaterialCli(command, "recipient", projectId,
      {fixedHandoff:false,ordinarySubmit:true}), true);
    assert.equal(await supportsFixedHandoff("/bin/echo ;cat /private", "recipient", projectId), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
