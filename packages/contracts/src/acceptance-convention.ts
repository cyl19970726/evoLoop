import { z } from "zod";

/** What must happen before the delivery can be checked at its real entrance. `none` means it can be checked as delivered. */
export const acceptancePreconditionSchema = z.enum(["none", "refresh", "release", "migration", "config_restart"]);
export type AcceptancePrecondition = z.infer<typeof acceptancePreconditionSchema>;

export const preconditionText: Record<Exclude<AcceptancePrecondition, "none">, string> = {
  refresh: "刷新", release: "发布", migration: "迁移", config_restart: "改配置并重启",
};

/**
 * Readiness of a delivery for acceptance. `waiting_precondition`: the Task declared a precondition and nobody has marked it
 * met for the current delivery. The mark is explicit (see task.acceptancePrecondition.mark): the repository has no deployed-version
 * read to derive it from yet, and a derived guess would show "ready" when it is not.
 */
export type AcceptanceReadiness = "ready" | "waiting_precondition";

/** `none` or undeclared needs nothing; any other precondition holds the delivery back until its mark exists. */
export const acceptanceReadiness = (precondition: string | null | undefined, marked: boolean): AcceptanceReadiness =>
  !precondition || precondition === "none" || marked ? "ready" : "waiting_precondition";

export const acceptanceConventionCommands = [
  /**
   * `satisfiedAt` is when the release (refresh, migration, restart) the evidence names took place. The service refuses a time earlier than the Delivery was recorded (an earlier
   * release cannot contain it) or in the future, so a mark that cites the wrong release is refused instead of being kept for good (Task e7b2d9a4). It proves "not earlier", not
   * "contains this Delivery": which release carries which change is still the marker's statement, in `evidence`.
   */
  z.strictObject({ projectId: z.uuid(), operationId: z.uuid(), type: z.literal("task.acceptancePrecondition.mark"),
    taskId: z.uuid(), deliveryId: z.uuid(), evidence: z.string().trim().min(1).max(4000), satisfiedAt: z.iso.datetime() }),
  /** Withdraws the Delivery's current mark so it can be marked again. The mark and its evidence stay readable, with who withdrew it, when and why; nothing is overwritten. */
  z.strictObject({ projectId: z.uuid(), operationId: z.uuid(), type: z.literal("task.acceptancePrecondition.void"),
    taskId: z.uuid(), deliveryId: z.uuid(), reason: z.string().trim().min(1).max(4000) }),
];
export type AcceptancePreconditionMarkCommand = z.infer<(typeof acceptanceConventionCommands)[number]>;
