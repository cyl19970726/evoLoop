import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NativeChildExitDetail } from "@evoloop/adapter-codex-app-server";

/** Where this host keeps the private detail of ended native children: `EVOLOOP_DIAGNOSTICS_DIR`, else `~/.evoloop/diagnostics`. */
export const privateDiagnosticsDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
  env.EVOLOOP_DIAGNOSTICS_DIR?.trim() || join(homedir(), ".evoloop", "diagnostics");

const FILE = /^codex-child-.*\.json$/;
const LINE_LIMIT = 600;

/**
 * The private side of a native child's end (defect 5766e9e3): one JSON file per child with its exit, the tail of its stderr and its last protocol lines.
 * The file lives on this host only, mode 0600 in a 0700 directory; stderr can hold private paths or content, so it is never put in the database, an API
 * answer or the public log. The log gets one line: what ended and which file to read. The newest `keep` files stay.
 */
export function createChildDetailSink(options: { directory?: string; keep?: number; log?: (line: string) => void } = {}): (detail: NativeChildExitDetail) => void {
  const directory = options.directory ?? privateDiagnosticsDirectory(), keep = options.keep ?? 20, log = options.log ?? (line => console.error(line));
  return detail => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const stamp = detail.exitedAtUtc.replace(/[^0-9]/g, "").slice(0, 14);
      const path = join(directory, `codex-child-${stamp}-${detail.startId.slice(0, 8)}.json`);
      const stderrTail = detail.stderrTail.split("\n").map(line => line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}…` : line).join("\n");
      writeFileSync(path, `${JSON.stringify({ ...detail, stderrTail }, null, 2)}\n`, { mode: 0o600 });
      for (const stale of readdirSync(directory).filter(name => FILE.test(name)).sort().slice(0, -keep)) rmSync(join(directory, stale), { force: true });
      log(`Codex child ended: startId=${detail.startId.slice(0, 8)} pid=${detail.pid ?? "?"} exit=${detail.exitCode ?? detail.exitSignal ?? "unknown"} firstLoss=${detail.firstLossReason ?? "none"} stderrBytes=${Buffer.byteLength(detail.stderrTail)} detail=${path}`);
    } catch {
      log(`Codex child ended: startId=${detail.startId.slice(0, 8)} exit=${detail.exitCode ?? detail.exitSignal ?? "unknown"}; its private detail could not be written.`);
    }
  };
}
