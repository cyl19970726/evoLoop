import { z } from "zod";

/** Navigation facts for one complete Document; the report body stays free-form. */
export const organizationReviewSchema = z.strictObject({
  observedFrom: z.iso.datetime({ offset: true }),
  observedTo: z.iso.datetime({ offset: true }),
  timeZone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; }
    catch { return false; }
  }, "Unknown observation time zone"),
  previous: z.strictObject({ documentId: z.uuid(), revisionId: z.uuid() }).nullable().optional(),
}).refine(value => Date.parse(value.observedFrom) < Date.parse(value.observedTo),
  "Observation start must be before its cutoff");

export type OrganizationReview = z.infer<typeof organizationReviewSchema>;
