import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChildDetailSink } from "../src/runtime/child-detail-log.ts";

const detail = (n: number) => ({ startId: `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`, pid: 100 + n, startedAtUtc: "2026-11-16T10:00:00.000Z", exitedAtUtc: `2026-11-16T10:0${n}:00.000Z`,
  exitCode: 0, exitSignal: null, firstLossReason: "stdout_closed" as const, stopReason: "process_exited" as const,
  stderrTail: `boom private path /Users/someone/project ${n}\n${"y".repeat(2000)}`, stderrTruncated: false,
  recentProtocol: [{ at: "2026-11-16T10:00:00.000Z", direction: "out" as const, kind: "request" as const, method: "turn/start", id: 7 }] });

test("a child's private detail is one 0600 file in a 0700 directory; the log line names the file and carries none of the stderr; only the newest stay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-child-detail-"));
  try {
    const lines: string[] = [];
    const sink = createChildDetailSink({ directory: join(directory, "diag"), keep: 2, log: line => lines.push(line) });
    for (const n of [1, 2, 3]) sink(detail(n));
    const files = (await readdir(join(directory, "diag"))).sort();
    assert.equal(files.length, 2, "the oldest was removed");
    assert.ok(files.every(name => /^codex-child-\d{14}-0000000[23]\.json$/.test(name)), files.join(","));
    assert.equal((await stat(join(directory, "diag"))).mode & 0o777, 0o700);
    const path = join(directory, "diag", files.at(-1)!);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.match(saved.stderrTail, /boom private path/);
    assert.ok(saved.stderrTail.split("\n").every((line: string) => line.length <= 601), "long lines are cut");
    assert.deepEqual(saved.recentProtocol[0].method, "turn/start");
    assert.equal(lines.length, 3);
    assert.match(lines[2]!, /Codex child ended: startId=00000003 pid=103 exit=0 firstLoss=stdout_closed .*detail=.*codex-child-/);
    assert.doesNotMatch(lines.join("\n"), /boom|private path/, "the public log never carries stderr");
    // A sink that cannot write says so without throwing into the transport.
    const broken: string[] = [];
    // The directory would have to be made inside a regular file (ENOTDIR on every platform; a path under /proc can make a recursive mkdir spin on Linux).
    await writeFile(join(directory, "blocker"), "x");
    createChildDetailSink({ directory: join(directory, "blocker", "diag"), log: line => broken.push(line) })(detail(4));
    assert.match(broken[0] ?? "", /private detail could not be written/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
