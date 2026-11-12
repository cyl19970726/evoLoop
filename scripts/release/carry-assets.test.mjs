import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANIFEST, carryAssets } from "./carry-assets.mjs";

// One release directory holds <dist>/assets/*; `files` maps a chunk name to its content.
const release = async (root, name, files) => {
  const dist = join(root, name, "dist"); await mkdir(join(dist, "assets"), { recursive: true });
  for (const [file, body] of Object.entries(files)) await writeFile(join(dist, "assets", file), body);
  return join(dist, "assets");
};
const names = async dir => (await readdir(dir)).sort();
const root = () => mkdtemp(join(tmpdir(), "carry-"));

test("files the new build lacks are copied; a same-named file of the new build is never overwritten", async () => {
  const dir = await root();
  const previous = await release(dir, "r1", { "Arrangement-OLD.js": "old arrangement", "shared-1.js": "from r1", "index-OLD.js": "old index" });
  const next = await release(dir, "r2", { "Arrangement-NEW.js": "new arrangement", "shared-1.js": "from r2", "index-NEW.js": "new index" });
  const result = await carryAssets({ previousAssets: previous, newAssets: next });
  assert.deepEqual(result.copied.sort(), ["Arrangement-OLD.js", "index-OLD.js"]);
  assert.deepEqual(result.unchanged, ["shared-1.js"]);
  assert.equal(await readFile(join(next, "shared-1.js"), "utf8"), "from r2", "the new build's file stands");
  assert.equal(await readFile(join(next, "Arrangement-OLD.js"), "utf8"), "old arrangement");
  assert.deepEqual(await names(next), ["Arrangement-NEW.js", "Arrangement-OLD.js", "index-NEW.js", "index-OLD.js", "shared-1.js"].sort());
  assert.equal(result.bytes, "old arrangement".length + "old index".length);
});

test("retention: with keep=3 a file lives for three builds and then expires, and the directory stops growing", async () => {
  const dir = await root();
  let previous = await release(dir, "r1", { "A-1.js": "a1" });
  const sizes = [];
  const seen = [];
  for (const [index, file] of [["2", "A-2.js"], ["3", "A-3.js"], ["4", "A-4.js"], ["5", "A-5.js"]]) {
    const next = await release(dir, `r${index}`, { [file]: file });
    const result = await carryAssets({ previousAssets: previous, newAssets: next, keep: 3 });
    seen.push({ index, expired: result.expired, files: await names(next) });
    sizes.push((await names(next)).length);
    previous = next;
  }
  assert.deepEqual(seen[0].files, ["A-1.js", "A-2.js"], "r2 carries r1");
  assert.deepEqual(seen[1].files, ["A-1.js", "A-2.js", "A-3.js"], "r3 carries r1 and r2");
  assert.deepEqual(seen[2].files, ["A-2.js", "A-3.js", "A-4.js"], "r4: r1 is now three builds old and goes");
  assert.deepEqual(seen[2].expired, ["A-1.js"]);
  assert.deepEqual(seen[3].files, ["A-3.js", "A-4.js", "A-5.js"]);
  assert.deepEqual(sizes, [2, 3, 3, 3], "bounded");
});

test("keep=1 carries nothing; a first release without a previous assets directory is fine", async () => {
  const dir = await root();
  const previous = await release(dir, "r1", { "A-1.js": "a1" });
  const next = await release(dir, "r2", { "A-2.js": "a2" });
  const none = await carryAssets({ previousAssets: previous, newAssets: next, keep: 1 });
  assert.deepEqual(none.copied, []); assert.deepEqual(none.expired, ["A-1.js"]);
  const first = await release(dir, "r0", { "A-0.js": "a0" });
  const result = await carryAssets({ previousAssets: join(dir, "missing", "assets"), newAssets: first });
  assert.deepEqual(result.copied, []); assert.match(result.skipped, /no previous assets directory/);
  assert.deepEqual(await names(first), ["A-0.js"]);
});

test("running the step again on the same build keeps what it already carried and copies nothing twice", async () => {
  const dir = await root();
  const previous = await release(dir, "r1", { "A-1.js": "a1" });
  const next = await release(dir, "r2", { "A-2.js": "a2" });
  await carryAssets({ previousAssets: previous, newAssets: next });
  const again = await carryAssets({ previousAssets: previous, newAssets: next });
  assert.deepEqual(again.copied, []);
  assert.deepEqual(JSON.parse(await readFile(join(next, "..", MANIFEST), "utf8")).carried, { "A-1.js": 0 });
  assert.deepEqual(await names(next), ["A-1.js", "A-2.js"]);
});

test("a bad keep or a build without assets is an error, not a silent no-op", async () => {
  const dir = await root();
  const previous = await release(dir, "r1", { "A-1.js": "a1" });
  const next = await release(dir, "r2", { "A-2.js": "a2" });
  await assert.rejects(carryAssets({ previousAssets: previous, newAssets: next, keep: 0 }), /keep/);
  await assert.rejects(carryAssets({ previousAssets: previous, newAssets: join(dir, "nowhere", "assets") }), /no assets directory/);
});
