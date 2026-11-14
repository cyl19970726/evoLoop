import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
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

test("retention by count only (keepDays=0): with keep=3 a file lives for three builds and then expires, and the directory stops growing", async () => {
  const dir = await root();
  let previous = await release(dir, "r1", { "A-1.js": "a1" });
  const sizes = [];
  const seen = [];
  for (const [index, file] of [["2", "A-2.js"], ["3", "A-3.js"], ["4", "A-4.js"], ["5", "A-5.js"]]) {
    const next = await release(dir, `r${index}`, { [file]: file });
    const result = await carryAssets({ previousAssets: previous, newAssets: next, keep: 3, keepDays: 0 });
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
  const none = await carryAssets({ previousAssets: previous, newAssets: next, keep: 1, keepDays: 0 });
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

// Defect 581441ad: three releases in one day pushed the previous day's tab out under "three generations".
const at = (day, hour = 0) => new Date(Date.UTC(2026, 10, day, hour));

test("defect 581441ad: four releases with different chunks in one day still carry the first version's chunks", async () => {
  const dir = await root();
  let previous = await release(dir, "r1", { "Index-1.js": "i1", "Schedules-1.js": "s1" });
  let next;
  for (const [n, hour] of [[2, 9], [3, 12], [4, 15]]) {
    next = await release(dir, `r${n}`, { [`Index-${n}.js`]: `i${n}`, [`Schedules-${n}.js`]: `s${n}` });
    await carryAssets({ previousAssets: previous, newAssets: next, now: at(13, hour) });
    previous = next;
  }
  // The tab opened on version 1 asks for a page it had not visited: Schedules-1.js. After the 4th release it is still there.
  assert.deepEqual(await names(next), ["Index-1.js", "Index-2.js", "Index-3.js", "Index-4.js", "Schedules-1.js", "Schedules-2.js", "Schedules-3.js", "Schedules-4.js"]);
  assert.equal(await readFile(join(next, "Schedules-1.js"), "utf8"), "s1");
});

test("defect 581441ad: files are kept 7 days by time, then removed, so the directory stops growing", async () => {
  const dir = await root();
  let previous = await release(dir, "r1", { "A-1.js": "a1" });
  // r1 has no manifest: its time is its directory's, which is set to day 9
  await utimes(previous, at(9), at(9));
  const sizes = []; let last;
  const days = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  for (const [index, day] of days.entries()) {
    const n = index + 2;
    const next = await release(dir, `r${n}`, { [`A-${n}.js`]: `a${n}` });
    last = await carryAssets({ previousAssets: previous, newAssets: next, now: at(day) });
    sizes.push((await names(next)).length); previous = next;
  }
  // one release per day, 7 days kept: the directory holds about eight builds' files and no more
  assert.ok(Math.max(...sizes) <= 9, `bounded, saw ${sizes.join(",")}`);
  assert.deepEqual(sizes.slice(-3), [sizes.at(-1), sizes.at(-1), sizes.at(-1)], "steady once old builds age out");
  assert.ok(last.expired.length > 0, "something aged out");
  assert.ok(!(await names(previous)).includes("A-1.js") && !(await names(previous)).includes("A-2.js"), "builds older than 7 days are gone");
});

test("defect 581441ad: the generation limit still holds a quiet week; whichever keeps a build longer wins", async () => {
  const dir = await root();
  let previous = await release(dir, "r1", { "A-1.js": "a1" });
  await utimes(previous, new Date(Date.UTC(2025, 11, 1)), new Date(Date.UTC(2025, 11, 1)));
  // releases 30 days apart: by time everything but the newest is old, by count the newest 3 stay
  for (const [n, day] of [[2, 1], [3, 31], [4, 61]]) {
    const next = await release(dir, `r${n}`, { [`A-${n}.js`]: `a${n}` });
    await carryAssets({ previousAssets: previous, newAssets: next, now: new Date(Date.UTC(2026, 0, day)) });
    previous = next;
  }
  assert.deepEqual(await names(previous), ["A-2.js", "A-3.js", "A-4.js"]);
});

test("the oldest entry still usable is read back, and it is the oldest retained build whose files are all present", async () => {
  const dir = await root();
  const previous = await release(dir, "r1", { "A-1.js": "a1" });
  await utimes(previous, at(13, 8), at(13, 8));
  const next = await release(dir, "r2", { "A-2.js": "a2" });
  const result = await carryAssets({ previousAssets: previous, newAssets: next, now: at(13, 9) });
  assert.equal(result.oldestUsable.generation, 0);
  assert.equal(result.retained, 2);
  const third = await release(dir, "r3", { "A-3.js": "a3" });
  const again = await carryAssets({ previousAssets: next, newAssets: third, now: at(14, 9), keep: 1, keepDays: 1 });
  // keepDays=1: the build made at day 13 09:00 is 24h old at day 14 09:00, which is not "less than a day", so only the newest stays
  assert.equal(again.oldestUsable.generation, again.generation);
  assert.deepEqual(await names(third), ["A-3.js"]);
});

test("a manifest from before this change (generation numbers only) is still read, and bad keepDays is an error", async () => {
  const dir = await root();
  const previous = await release(dir, "r1", { "A-2.js": "a2", "A-1.js": "a1" });
  await writeFile(join(previous, "..", MANIFEST), JSON.stringify({ generation: 2, keep: 3, carried: { "A-1.js": 1 } }));
  const next = await release(dir, "r2", { "A-3.js": "a3" });
  const result = await carryAssets({ previousAssets: previous, newAssets: next, now: at(13, 9) });
  assert.equal(result.generation, 3);
  assert.deepEqual(await names(next), ["A-1.js", "A-2.js", "A-3.js"]);
  await assert.rejects(carryAssets({ previousAssets: previous, newAssets: next, keepDays: -1 }), /keepDays/);
});
