// Carry the previous release's workbench chunk files into a new build, so a browser tab opened before the release
// can still load a page it had not opened yet. The workbench is a single-page app whose pages are lazy chunks with
// content-hashed names (assets/ArrangementPage-BFkRO_z-.js); a release replaces them, and an old tab that asks for one
// gets a 404 ("Failed to fetch dynamically imported module"). Tabs live long (the token is kept in page memory, so a
// refresh means signing in again). Only files the new build lacks are copied, and a file is never overwritten.
//
// Retention: a release is one "generation". A carried file keeps the generation of the build that made it and is dropped
// once it is `keep` generations old (keep=3: the new build plus the two before it). The manifest next to the assets
// directory (assets-carry.json) records each carried file's origin generation, so nothing accumulates without bound.
import { copyFile, constants, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_KEEP = 3;
export const MANIFEST = "assets-carry.json";

const readJson = async path => { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const listFiles = async dir => { try { return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };

/**
 * @param {string} previousAssets the previous release's assets directory (may not exist: nothing to carry)
 * @param {string} newAssets      the freshly built assets directory
 * @returns {Promise<{generation:number, copied:string[], expired:string[], unchanged:string[], bytes:number, skipped?:string}>}
 */
export async function carryAssets({ previousAssets, newAssets, keep = DEFAULT_KEEP }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("carryAssets.keep must be a whole number of at least 1 (1 keeps only the new build)");
  const previous = await listFiles(previousAssets);
  // Nothing to carry (a first release, or a previous version that had no workbench build): not an error.
  if (!previous) return { generation: 1, copied: [], expired: [], unchanged: [], bytes: 0, skipped: `no previous assets directory at ${previousAssets}` };
  const own = await listFiles(newAssets);
  if (!own) throw new Error(`The new build has no assets directory at ${newAssets}`);
  const previousManifest = await readJson(join(dirname(previousAssets), MANIFEST)) ?? { generation: 0, carried: {} };
  const generation = previousManifest.generation + 1;
  const manifestPath = join(dirname(newAssets), MANIFEST);
  // A rerun of the same build step on the same directory starts from what it already carried, not from nothing.
  const existing = await readJson(manifestPath);
  const carried = existing?.generation === generation ? { ...existing.carried } : {};
  const result = { generation, copied: [], expired: [], unchanged: [], bytes: 0 };
  for (const name of previous) {
    if (own.includes(name) && !(name in carried)) { result.unchanged.push(name); continue; } // same name = same content hash; the new build's file stands
    const origin = previousManifest.carried[name] ?? previousManifest.generation;
    if (origin <= generation - keep) { result.expired.push(name); delete carried[name]; continue; }
    if (name in carried) continue; // already carried by an earlier attempt
    await copyFile(join(previousAssets, name), join(newAssets, name), constants.COPYFILE_EXCL); // throws rather than overwrite
    carried[name] = origin;
    result.copied.push(name); result.bytes += (await stat(join(newAssets, name))).size;
  }
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ generation, keep, carried }, null, 2));
  return result;
}
