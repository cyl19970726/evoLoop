import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const safeCommand = /^\/[A-Za-z0-9_./-]+(?: \/[A-Za-z0-9_./-]+)?$/;

/** Probe the exact configured wrapper before starting a native Turn. */
export async function supportsMaterialCli(command: string, actorId: string, projectId: string,
  required: { fixedHandoff: boolean; ordinarySubmit: boolean }): Promise<boolean> {
  if (!safeCommand.test(command)) return false;
  const [executable, script] = command.split(" ");
  const args = script ? [script] : [];
  try {
    const options = { timeout: 5000, maxBuffer: 256 * 1024, encoding: "utf8" as const };
    const help = JSON.parse((await run(executable!, [...args, "help"], options)).stdout) as Record<string, unknown>;
    if (required.fixedHandoff && (!Array.isArray(help.commands) || !help.commands.some(value =>
      typeof value === "string" && /^handoff RUN_UUID --project UUID --hash SHA256\b/.test(value)))) return false;
    const session = JSON.parse((await run(executable!, [...args, "session"], options)).stdout) as
      { principal?: { actorId?: unknown; projectIds?: unknown; permissions?: unknown } };
    if (!(session.principal?.actorId === actorId &&
      Array.isArray(session.principal.projectIds) && session.principal.projectIds.includes(projectId) &&
      Array.isArray(session.principal.permissions) && session.principal.permissions.includes("read") &&
      (!required.ordinarySubmit || session.principal.permissions.includes("write")))) return false;
    if (!required.ordinarySubmit) return true;
    // Older wrappers advertise generic `request schema NAME` but do not know ordinary.submit.
    const schema = JSON.parse((await run(executable!, [...args, "request", "schema", "ordinary.submit"], options)).stdout) as
      { type?: unknown; required?: unknown; properties?: { deliveryIntent?: { required?: unknown } } };
    const fields = ["projectId", "operationId", "submissionId", "runId", "taskId", "sessionId",
      "taskRevisionId", "runInputHash", "deliveryOperationId", "deliveryIntent"];
    const intentFields = ["artifactRef", "artifactRevision", "contentHash", "technicalResult", "technicalEvidence", "reason"];
    const requiredFields = schema.required, requiredIntent = schema.properties?.deliveryIntent?.required;
    return schema.type === "object" && Array.isArray(requiredFields) && fields.every(field => requiredFields.includes(field)) &&
      Array.isArray(requiredIntent) && intentFields.every(field => requiredIntent.includes(field));
  } catch { return false; }
}

export const supportsFixedHandoff = (command: string, actorId: string, projectId: string) =>
  supportsMaterialCli(command, actorId, projectId, { fixedHandoff: true, ordinarySubmit: false });
