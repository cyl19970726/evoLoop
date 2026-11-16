import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/application.ts";
import { hubOrigin, normalizeRoots } from "../src/machine.ts";

test("the Hub address is https, or http only to this machine; never with a path, credentials or fragment", () => {
  assert.equal(hubOrigin("https://hub.example"), "https://hub.example");
  assert.equal(hubOrigin("http://127.0.0.1:4319"), "http://127.0.0.1:4319");
  for (const value of ["http://hub.example", "https://hub.example/app", "https://user:pw@hub.example", "https://hub.example/?x=1", "https://hub.example/#a", "hub.example", undefined])
    assert.throws(() => hubOrigin(value), error => (error as { code?: string }).code === "INVALID_INPUT", String(value));
});

test("allowed roots must be real absolute directories, never the filesystem root; a root inside another is dropped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-machine-roots-"));
  try {
    await mkdir(join(directory, "a", "b"), { recursive: true });
    await writeFile(join(directory, "file"), "x");
    await symlink(join(directory, "a"), join(directory, "link"));
    const { realpath } = await import("node:fs/promises");
    const a = await realpath(join(directory, "a"));
    assert.deepEqual(await normalizeRoots(`${join(directory, "link")},${join(directory, "a", "b")}`), [a], "a link resolves to its real directory; a nested root is redundant");
    for (const value of ["relative/dir", join(directory, "missing"), join(directory, "file"), "/", ""])
      await assert.rejects(normalizeRoots(value), error => (error as { code?: string }).code === "INVALID_INPUT", value);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("machine commands need no coordinator token, refuse unknown options, and status of a machine that never joined says so", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-machine-cli-"));
  try {
    const run = async (args: string[]) => {
      let stdout = "", stderr = "";
      const code = await runCli(args, { EVOLOOP_MACHINE_DIR: join(directory, "none") }, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
      return { code, stdout, stderr };
    };
    const status = await run(["machine", "status"]);
    assert.equal(status.code, 0);
    assert.deepEqual(JSON.parse(status.stdout), { joined: false });
    assert.deepEqual(JSON.parse((await run(["machine", "leave"])).stdout), { left: false, reason: "This machine has not joined a Hub." });
    assert.equal((await run(["machine", "status", "--hub", "https://hub.example"])).code, 2);
    assert.equal((await run(["machine"])).code, 2);
    assert.equal((await run(["machine", "join", "--workspace-root", directory])).code, 2, "join needs the Hub address and code");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
