import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const safeCommand = /^\/[A-Za-z0-9_./-]+(?: \/[A-Za-z0-9_./-]+)?$/;

/** Probe the exact configured wrapper before starting a v2 native Turn. */
export async function supportsFixedHandoff(command: string, actorId: string, projectId: string): Promise<boolean> {
  if (!safeCommand.test(command)) return false;
  const [executable, script] = command.split(" ");
  const args = script ? [script] : [];
  try {
    const options = { timeout: 5000, maxBuffer: 256 * 1024, encoding: "utf8" as const };
    const help = JSON.parse((await run(executable!, [...args, "help"], options)).stdout) as Record<string, unknown>;
    if (!Array.isArray(help.commands) || !help.commands.some(value =>
      typeof value === "string" && /^handoff RUN_UUID --project UUID --hash SHA256\b/.test(value))) return false;
    const session = JSON.parse((await run(executable!, [...args, "session"], options)).stdout) as
      { principal?: { actorId?: unknown; projectIds?: unknown; permissions?: unknown } };
    return session.principal?.actorId === actorId &&
      Array.isArray(session.principal.projectIds) && session.principal.projectIds.includes(projectId) &&
      Array.isArray(session.principal.permissions) && session.principal.permissions.includes("read");
  } catch { return false; }
}
