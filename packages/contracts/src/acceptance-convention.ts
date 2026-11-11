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
  z.strictObject({ projectId: z.uuid(), operationId: z.uuid(), type: z.literal("task.acceptancePrecondition.mark"),
    taskId: z.uuid(), deliveryId: z.uuid(), evidence: z.string().trim().min(1).max(4000) }),
];
export type AcceptancePreconditionMarkCommand = z.infer<(typeof acceptanceConventionCommands)[number]>;
