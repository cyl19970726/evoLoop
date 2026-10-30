export const reviewDocumentKind = "organization_review";

/** These are Document navigation facts, never an encoding of the report body. */
export function observationPeriod({ observedFrom, observedTo, timeZone, previous }) {
  const timestamp = value => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
  if (!timestamp(observedFrom) || !timestamp(observedTo) || Date.parse(observedFrom) >= Date.parse(observedTo))
    throw new Error("Provide the observation start and cutoff, with time zones");
  if (!timeZone) throw new Error("Provide the observation time zone");
  try { new Intl.DateTimeFormat("en", { timeZone }).format(); } catch { throw new Error("Unknown observation time zone"); }
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (previous && (!id.test(previous.documentId) || !id.test(previous.revisionId))) throw new Error("Previous review needs a fixed Document reference");
  return { observedFrom, observedTo, timeZone, ...(previous ? { previous } : {}) };
}
