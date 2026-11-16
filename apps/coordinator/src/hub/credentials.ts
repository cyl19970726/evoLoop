import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MACHINE_CREDENTIALS_FILE, machineCredentialsSchema, type MachineCredentials } from "@evoloop/contracts";

/** The machine's private state directory: `EVOLOOP_MACHINE_DIR`, else `~/.evoloop/machine`. */
export function machineDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVOLOOP_MACHINE_DIR?.trim() || join(homedir(), ".evoloop", "machine");
}

/**
 * The machine's credentials as the file says *now*. The file is looked at on every use (a stat; it is re-read only when it changed), so
 * `machine leave` takes effect on the very next request: a deleted file means no Hub identity is accepted and the connector stops.
 */
export class MachineCredentialSource {
  private cached: { key: string; value: MachineCredentials } | null = null;
  readonly path: string;
  constructor(directory: string = machineDirectory()) {
    this.path = join(directory, MACHINE_CREDENTIALS_FILE);
  }

  current(): MachineCredentials | null {
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
