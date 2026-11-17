import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MACHINE_CREDENTIALS_FILE, machineCredentialsSchema, type MachineCredentials } from "@evoloop/contracts";

/** Where `evoloop machine join` keeps the credentials when no directory is named. A coordinator never reads this by default (see `machineDirectory`). */
export function defaultMachineDirectory(): string { return join(homedir(), ".evoloop", "machine"); }

/**
 * The machine's private state directory for a coordinator: `EVOLOOP_MACHINE_DIR`, and nothing else. A coordinator started without it (a test, an isolated or
 * local instance) must not pick up the credentials of the machine's real coordinator from the default location: two processes on one credential replace each
 * other's Hub connection and answer each other's requests (Task b8460d62). So there is no default: null means "no machine credentials for this process".
 */
export function machineDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.EVOLOOP_MACHINE_DIR?.trim() || null;
}

/** What to tell the operator at start when no directory is named: whether credentials exist at the default location that this process is deliberately not using. */
export function unusedDefaultCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (machineDirectory(env)) return false;
  try { statSync(join(defaultMachineDirectory(), MACHINE_CREDENTIALS_FILE)); return true; } catch { return false; }
}

/**
 * The machine's credentials as the file says *now*. The file is looked at on every use (a stat; it is re-read only when it changed), so
 * `machine leave` takes effect on the very next request: a deleted file means no Hub identity is accepted and the connector stops.
 */
export class MachineCredentialSource {
  private cached: { key: string; value: MachineCredentials } | null = null;
  /** The credentials file this source reads; null when no directory was named (then it never reads anything). */
  readonly path: string | null;
  constructor(directory: string | null = machineDirectory()) {
    this.path = directory ? join(directory, MACHINE_CREDENTIALS_FILE) : null;
  }

  current(): MachineCredentials | null {
    if (!this.path) return null;
    let key: string;
    try {
      const stat = statSync(this.path);
      key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch {
      this.cached = null;
      return null;
    }
    if (this.cached?.key === key) return this.cached.value;
    try {
      const value = machineCredentialsSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      this.cached = { key, value };
      return value;
    } catch {
      // An unreadable or invalid file is not a machine: fail closed, say nothing about its content.
      this.cached = null;
      return null;
    }
  }
}
