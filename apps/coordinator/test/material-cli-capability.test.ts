import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportsFixedHandoff, supportsMaterialCli } from "../src/runtime/material-cli-capability.js";

test("v2 handoff preflight rejects an old CLI or mismatched identity before native start", async () => {
  // The probe only runs a command made of [A-Za-z0-9_./-] (see safeCommand). The fixture is therefore a wrapper script at such a
  // path that execs the interpreter, exactly like a real CLI wrapper does. Putting process.execPath into the command itself made
  // this test fail on any host whose Node lives under a path with other characters (Homebrew's node@24 has an "@"), where the
  // probe rejects the command before running it and every positive assertion below becomes false.
  const directory = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "evoloop-material-capability-"));
  const script = join(directory, "cli.mjs");
  const command = join(directory, "evoloop");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  assert.match(command, /^\/[A-Za-z0-9_./-]+$/, "the fixture wrapper must itself be a path the probe accepts");
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

test("a command outside [A-Za-z0-9_./-] is rejected before it is run, whatever it points at", async () => {
  const directory = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "evoloop-material-capability-"));
  const marker = join(directory, "ran");
  try {
    // A real, working wrapper that would leave a marker if it were ever executed.
    const script = join(directory, "evoloop");
    await writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho '{}'\n`, { mode: 0o755 });
    for (const unsafe of [`${directory}/node@24/evoloop`, `${directory}/with space/evoloop`, `${directory}/a+b/evoloop`, `${script};true`, `$(touch ${marker})`, `relative/evoloop`]) {
      assert.equal(await supportsFixedHandoff(unsafe, "recipient", "00000000-0000-4000-8000-000000000001"), false, unsafe);
    }
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(marker), "no unsafe command was executed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
