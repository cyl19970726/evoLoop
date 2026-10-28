import { z } from "zod";

/** New queue Runs store pointers and changes; legacy Run.input remains untouched. */
export const queueHandoffSchema = z.strictObject({
  protocol: z.literal("evoloop-run-v2"),
  taskId: z.uuid(), taskRevisionId: z.uuid(), basisSetId: z.uuid(),
  kind: z.enum(["queue.claim", "queue.continue", "queue.retryFailed"]),
  reason: z.string().nullable(),
  previousRun: z.strictObject({ id: z.uuid(), taskRevisionId: z.uuid(), inputHash: z.hash("sha256") }).nullable(),
  /** Old input must be read by its own hash when a retry chain began on v1. */
  legacySource: z.strictObject({ id: z.uuid(), taskRevisionId: z.uuid(), inputHash: z.hash("sha256") }).nullable().optional(),
  answers: z.array(z.strictObject({ discussionId: z.uuid(), questionEventId: z.uuid(), messageEventId: z.uuid(),
    documentId: z.uuid(), revisionId: z.uuid(), contentHash: z.hash("sha256") })).max(100),
  channel: z.strictObject({ discussionId: z.uuid(), recipientActorId: z.string().min(1),
    issuerActorId: z.string().min(1) }),
});

export type QueueHandoff = z.infer<typeof queueHandoffSchema>;

export function parseQueueHandoff(input: string): QueueHandoff | null {
  const candidate=input.trimStart();
  if (!candidate.startsWith("{")) return null;
  let value: unknown;
  try { value = JSON.parse(candidate); }
  catch {
    if (candidate.slice(0, 128).includes('"evoloop-run-v2"')) throw new Error("Invalid fixed queue handoff");
    return null;
  }
  if (!value || typeof value !== "object" || (value as {protocol?:unknown}).protocol !== "evoloop-run-v2") return null;
  const parsed = queueHandoffSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid fixed queue handoff");
  return parsed.data;
}
