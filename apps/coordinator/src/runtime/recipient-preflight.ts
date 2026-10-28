import { PreflightError } from "./preflight-report.js";

/** Independent acceptance needs a fixed signer before a native Turn consumes work. */
export function requireOrdinaryRecipient(
  acceptanceMode: string | null | undefined, recipient: string | null,
  cliActorId: string | null, taskId: string, taskRevisionId: string,
): void {
  if (acceptanceMode && (!recipient || cliActorId !== recipient))
    throw new PreflightError("RECIPIENT_UNBOUND", { kind: "task", id: taskId, revisionId: taskRevisionId });
}
