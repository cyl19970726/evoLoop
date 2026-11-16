import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/** Whether `real` is the root itself or lies under it, by path components (so `/work-evil` is not inside `/work`). */
export function isInsideRoot(root: string, real: string): boolean {
  const path = relative(root, real);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path) && !path.split(sep).includes(".."));
}

/** The real path of `directory`, or null when it is not inside any allowed root (or does not exist). Symlinks are resolved first, so a link cannot lead out. */
export async function realPathInsideRoots(roots: readonly string[], directory: string): Promise<string | null> {
  let real: string;
  try { real = await realpath(directory); } catch { return null; }
  return roots.some(root => isInsideRoot(root, real)) ? real : null;
}
