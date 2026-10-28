import { isAbsolute } from "node:path";
import { loadIntegrations } from "../apps/coordinator/dist/configuration.js";
import { supportsFixedHandoff } from "../apps/coordinator/dist/runtime/material-cli-capability.js";

const path = process.argv[2];
if (!path || !isAbsolute(path)) {
  process.stderr.write("Provide the intended successor integrations JSON path. Build packages first.\n");
  process.exit(2);
}
const config = await loadIntegrations(path);
const entries = config.runtime?.materialCli ?? [];
if (!entries.length) {
  process.stderr.write("No material CLI bindings found in the intended successor config.\n");
  process.exit(1);
}
let failed = false;
for (const entry of entries) {
  const ready = await supportsFixedHandoff(entry.command, entry.cliActorId, entry.projectId);
  process.stdout.write(`${ready ? "ready" : "incompatible"} session=${entry.sessionId} task=${entry.taskId ?? "*"} actor=${entry.cliActorId}\n`);
  if (!ready) failed = true;
}
if (failed) process.exitCode = 1;
