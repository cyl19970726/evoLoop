import { z } from "zod";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);

/** A business Session signs an intent while its ordinary Run is still active. */
export const ordinaryRunSubmissionSchema = z.strictObject({
  projectId: id,
  operationId: id,
  submissionId: id,
  runId: id,
  taskId: id,
  sessionId: id,
  taskRevisionId: id,
  runInputHash: z.string().regex(/^[a-f0-9]{64}$/i),
  deliveryOperationId: id,
  deliveryIntent: z.strictObject({
    artifactRef: text,
    artifactRevision: text,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
    technicalResult: z.enum(["passed", "failed"]),
    technicalEvidence: text,
    reason: text,
  }),
});

export type OrdinaryRunSubmissionCommand = z.infer<typeof ordinaryRunSubmissionSchema>;
export type OrdinaryRunDeliveryIntent = OrdinaryRunSubmissionCommand["deliveryIntent"];
export type OrdinaryRunSubmissionState = "submitted" | "blocked" | "sealing" | "unknown" | "sealed" | "rejected";
export interface OrdinaryRunSubmissionRecord {
  projectId: string;
  id: string;
  runId: string;
  taskId: string;
  sessionId: string;
  taskRevisionId: string;
  runInputHash: string;
  operationId: string;
  commandHash: string;
  deliveryOperationId: string;
  deliveryIntent: OrdinaryRunDeliveryIntent;
  submittedBy: string;
  state: OrdinaryRunSubmissionState;
  version: number;
  expectedTaskVersion: number | null;
  terminalRunVersion: number | null;
  sealedBy: string | null;
  deliveryId: string | null;
  reason: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}
