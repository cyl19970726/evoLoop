// Carry the previous release's workbench chunk files into a new build, so a browser tab opened before the release
// can still load a page it had not opened yet. The workbench is a single-page app whose pages are lazy chunks with
// content-hashed names (assets/ArrangementPage-BFkRO_z-.js); a release replaces them, and an old tab that asks for one
// gets a 404 ("Failed to fetch dynamically imported module"). Tabs live long (the token is kept in page memory, so a
// refresh means signing in again). Only files the new build lacks are copied, and a file is never overwritten.
//
// Retention: a release is one "generation", and the manifest next to the assets directory (assets-carry.json) records
// every generation still retained with its build time and the chunk files that build made. A generation is retained
// while it is among the newest `keep` generations (default 3) OR was built less than `keepDays` days ago (default 7):
// whichever keeps it longer. Counting generations alone failed (defect 581441ad): three releases in one day pushed the
// previous day's tab out, and its pages stopped loading. A file is kept as long as any retained generation uses it, so
// the directory still stops growing once old generations age out of both limits.
import { copyFile, constants, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_KEEP = 3;
export const DEFAULT_KEEP_DAYS = 7;
export const MANIFEST = "assets-carry.json";
const DAY = 24 * 60 * 60 * 1000;

const readJson = async path => { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const listFiles = async dir => { try { return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const mtimeOf = async (path, now) => { try { const time = (await stat(path)).mtime; return (time > now ? now : time).toISOString(); } catch { return null; } }; // never later than this build

/**
 * The generations the previous release retained. A manifest from before this change (no `generations` list) is read as
 * well as it can be: the previous build is one generation made of the files it did not carry, and each older origin
 * generation is made of the files carried from it. Their build times were not recorded, so they take the previous
 * manifest's own time (or the directory's), which keeps them at most `keepDays` longer than strictly needed.
 */
async function previousGenerations({ previousAssets, previousFiles, manifest, manifestPath, now }) {
  if (Array.isArray(manifest?.generations)) return { generation: manifest.generation, generations: manifest.generations };
  const fallbackTime = manifest ? (await mtimeOf(manifestPath, now)) ?? now.toISOString() : (await mtimeOf(previousAssets, now)) ?? now.toISOString();
  const generation = manifest?.generation ?? 0;
  const carried = manifest?.carried ?? {};
  const own = previousFiles.filter(name => !(name in carried));
  const generations = [{ generation, builtAt: manifest?.builtAt ?? fallbackTime, files: own }];
  const byOrigin = new Map();
  for (const [name, origin] of Object.entries(carried)) byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), name]);
  for (const [origin, files] of byOrigin) generations.push({ generation: origin, builtAt: fallbackTime, files });
  return { generation, generations };
}

/**
 * @param {string} previousAssets the previous release's assets directory (may not exist: nothing to carry)
 * @param {string} newAssets      the freshly built assets directory
 * @param {number} [keep]         newest generations always kept
 * @param {number} [keepDays]     generations built less than this many days ago are kept too
 * @param {Date}   [now]          the time of this build (a parameter so tests can move it)
 * @returns {Promise<{generation:number, copied:string[], expired:string[], unchanged:string[], bytes:number, retained:number, oldestUsable:{generation:number, builtAt:string}|null, skipped?:string}>}
 */
export async function carryAssets({ previousAssets, newAssets, keep = DEFAULT_KEEP, keepDays = DEFAULT_KEEP_DAYS, now = new Date() }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("carryAssets.keep must be a whole number of at least 1 (1 keeps only the new build)");
  if (typeof keepDays !== "number" || !Number.isFinite(keepDays) || keepDays < 0) throw new Error("carryAssets.keepDays must be a number of days, 0 or more (0 keeps by generation count only)");
  const previous = await listFiles(previousAssets);
  // Nothing to carry (a first release, or a previous version that had no workbench build): not an error.
  if (!previous) return { generation: 1, copied: [], expired: [], unchanged: [], bytes: 0, retained: 0, oldestUsable: null, skipped: `no previous assets directory at ${previousAssets}` };
  const listed = await listFiles(newAssets);
  if (!listed) throw new Error(`The new build has no assets directory at ${newAssets}`);
  const previousManifestPath = join(dirname(previousAssets), MANIFEST);
  const previousManifest = await readJson(previousManifestPath);
  const base = await previousGenerations({ previousAssets, previousFiles: previous, manifest: previousManifest, manifestPath: previousManifestPath, now });
  const generation = base.generation + 1;
  const manifestPath = join(dirname(newAssets), MANIFEST);
  // A rerun of the same build step on the same directory starts from what it already carried, not from nothing: the files it carried
  // are not this build's own output.
  const existing = await readJson(manifestPath);
  const rerun = existing?.generation === generation;
  const carried = rerun ? { ...existing.carried } : {};
  const own = listed.filter(name => !(name in carried));
  const builtAt = rerun && existing.builtAt ? existing.builtAt : now.toISOString();
  const all = [...base.generations.filter(item => item.generation !== generation), { generation, builtAt, files: own }];
  const cutoff = Date.parse(builtAt) - keepDays * DAY;
  const retained = all.filter(item => item.generation > generation - keep || Date.parse(item.builtAt) > cutoff);
  const wanted = new Map(); // file name -> the oldest retained generation that uses it
  for (const item of [...retained].sort((a, b) => a.generation - b.generation)) for (const name of item.files) if (!wanted.has(name)) wanted.set(name, item.generation);

  const result = { generation, copied: [], expired: [], unchanged: [], bytes: 0, retained: retained.length, oldestUsable: null };
  for (const name of previous) {
    if (listed.includes(name) && !(name in carried)) { result.unchanged.push(name); continue; } // same name = same content hash; the new build's file stands
    if (!wanted.has(name)) { result.expired.push(name); delete carried[name]; continue; }
    if (name in carried) continue; // already carried by an earlier attempt
    await copyFile(join(previousAssets, name), join(newAssets, name), constants.COPYFILE_EXCL); // throws rather than overwrite
    carried[name] = wanted.get(name);
    result.copied.push(name); result.bytes += (await stat(join(newAssets, name))).size;
  }
  // The readback the release step prints: the oldest retained generation whose every file is in the directory now, that is the oldest
  // entry (index.html of that build) whose tabs can still open any page.
  const present = new Set(await listFiles(newAssets));
  const usable = retained.filter(item => item.files.every(name => present.has(name))).sort((a, b) => a.generation - b.generation);
  if (usable[0]) result.oldestUsable = { generation: usable[0].generation, builtAt: usable[0].builtAt };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ generation, builtAt, keep, keepDays, generations: retained, carried }, null, 2));
  return result;
}
