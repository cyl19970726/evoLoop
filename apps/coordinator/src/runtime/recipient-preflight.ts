import { PreflightError } from "./preflight-report.js";

/** Independent acceptance needs a fixed signer before a native Turn consumes work. */
export function requireOrdinaryRecipient(
  acceptanceMode: string | null | undefined, recipient: string | null,
  cliActorId: string | null, taskId: string, taskRevisionId: string,
): void {
  if (acceptanceMode && (!recipient || cliActorId !== recipient))
    throw new PreflightError("RECIPIENT_UNBOUND", { kind: "task", id: taskId, revisionId: taskRevisionId });
}

/** A direct Run may fix its signer through the owned Session assignment. */
export function materialCliRecipientMatches(
  channelRecipients: string[], cliActorId: string,
  sessionActorId: string, fixedRecipient: string | null,
): boolean {
  if (channelRecipients.length > 1) return false;
  if (channelRecipients.length === 1) return channelRecipients[0] === cliActorId;
  return cliActorId === sessionActorId || fixedRecipient === cliActorId;
}
