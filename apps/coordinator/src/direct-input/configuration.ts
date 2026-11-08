import { z } from "zod";

/** Separate, opt-in permission on top of the existing ordinary Session grant. */
export const directInputConfigurationSchema=z.strictObject({
  enabled:z.boolean().default(false),
  grants:z.array(z.strictObject({
    projectId:z.uuid(),sessionId:z.uuid(),senderActorId:z.string().trim().min(1).max(240),
    canSteer:z.boolean(),canStart:z.boolean(),
  })).default([]),
});
export type DirectInputConfiguration=z.infer<typeof directInputConfigurationSchema>;
