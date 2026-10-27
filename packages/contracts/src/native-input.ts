import { z } from "zod";

export interface NativeInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  options: null | { label: string; description: string }[];
}

export interface NativeInputCapture {
  projectId: string;
  sessionId: string;
  id: string;
  connectionId: string;
  nativeRequestId: string | number;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  method: "item/tool/requestUserInput" | "mcpServer/elicitation/request";
  questions: NativeInputQuestion[];
  isBlocking: boolean;
  supported: boolean;
  unavailableReason: string | null;
  observedAt: string;
}

export type NativeInputSource =
  | { kind: "run"; runId: string; operationId: string; actorId: string; taskId: string; taskRevisionId: string }
  | { kind: "message"; messageId: string; processingId: string; operationId: string; actorId: string };

export interface NativeInputResponse {
  operationId: string;
  actorId: string;
  answers: Record<string, string[]>;
  savedAt: string;
  attemptedAt: string | null;
  submittedAt: string | null;
  outcome: "pending" | "attempted" | "submitted" | "unknown";
}

export interface NativeInputRecord extends NativeInputCapture {
  version: number;
  state: "pending" | "response_saved" | "resolved" | "unavailable";
  source: NativeInputSource | null;
  response: NativeInputResponse | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NativeInputEvent =
  | { type: "requested"; request: NativeInputCapture }
  | { type: "closed"; projectId: string; id: string; connectionId: string; reason: "native_resolved" | "disconnected" | "unsupported"; observedAt: string };

export const nativeInputReplyCommand = z.strictObject({
  type: z.literal("session.input.reply"),
  projectId: z.uuid(),
  operationId: z.uuid(),
  inputRequestId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  answers: z.record(z.string().min(1).max(120), z.array(z.string().min(1).max(4000)).min(1).max(8)),
});

export interface NativeInputReader {
  get(projectId: string, id: string): Promise<NativeInputRecord | null>;
  list(projectId: string, sessionId: string, limit: number): Promise<NativeInputRecord[]>;
  pendingResponses(projectId: string, limit: number): Promise<NativeInputRecord[]>;
  unlinked(projectId: string, sessionId: string, limit: number): Promise<NativeInputRecord[]>;
  findSource(projectId: string, sessionId: string, turnId: string): Promise<NativeInputSource | null>;
}

export interface NativeInputTransaction extends NativeInputReader {
  insert(value: NativeInputRecord): Promise<void>;
  update(value: NativeInputRecord, expectedVersion: number): Promise<void>;
  invalidateConnections(projectId: string, currentConnectionId: string, at: string): Promise<void>;
}
