import { z } from "zod";

const id = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** An owner supplied, exact delegation boundary. Existing single Role grants never imply one. */
export const delegationTemplateSchema = z.strictObject({
  id, revision: z.number().int().positive(), projectId: id, goalId: id, loopId: id,
  existingRoleIds: z.array(id).max(20),
  newRoleAllocation: z.strictObject({ maxTotal: z.literal(1), requiredState: z.literal("trial") }).nullable(),
  firstTaskId: id, actorId: z.string().min(1).max(100), authorizationScopeId: z.string().min(1).max(4000),
  decisionActorIds: z.array(z.string().min(1).max(100)).min(1).max(20),
  allowedChoices: z.array(z.enum(["same-role-instance", "temporary-assignment", "new-role"])).min(1).max(3),
  cwd: z.string().startsWith("/").max(1024), model: z.string().min(1).max(100),
  sandbox: z.enum(["read-only", "workspace-write"]), networkAccess: z.boolean(),
  approvalPolicy: z.enum(["on-request", "untrusted"]),
  expiresAtUtc: z.iso.datetime({ offset: false }),
});
export type DelegationTemplate = z.infer<typeof delegationTemplateSchema>;
export const delegationTemplateRefSchema = z.strictObject({ id, revision: z.number().int().positive(), hash });
export type DelegationTemplateRef = z.infer<typeof delegationTemplateRefSchema>;

export interface RuntimeRoleBinding {
  projectId: string; id: string; loopId: string; goalId: string; roleId: string;
  choice: "same-role-instance" | "temporary-assignment" | "new-role";
  actorId: string; authorizationScopeId: string; decisionOperationId: string;
  sourceEventId: string; parentDispatchId: string; firstTaskId: string; firstTaskVersion: number;
  documentId: string; documentRevisionId: string; documentContentHash: string;
  template: DelegationTemplateRef; grant: DelegationTemplate;
  runtime: Pick<DelegationTemplate, "cwd" | "model" | "sandbox" | "networkAccess" | "approvalPolicy" | "expiresAtUtc">;
  decidedBy: string; createdAtUtc: string;
}
export interface LoopPolicyRevision {
  projectId: string; id: string; loopId: string; version: number; previousId: string | null;
  allowedBusinessRoleIds: string[]; bindingByRole: Record<string, string>;
  changedBindingId: string | null; decisionOperationId: string | null; actorId: string; createdAtUtc: string;
}
