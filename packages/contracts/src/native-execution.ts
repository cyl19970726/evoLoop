/** One persisted control fact for the coordinator's single, shared App Server child. */
export type NativeExecutionMode = "business_verified" | "message_verified" | "transition" | "unknown";
export type NativeExecutionPurpose = "business" | "message";
export type NativeStartupKind = "run" | "message" | "session-create";

export interface NativeExecutionEnvironment {
  epoch: number;
  mode: NativeExecutionMode;
  previousMode: NativeExecutionMode | null;
  targetPurpose: NativeExecutionPurpose | null;
  targetProjectId: string | null;
  targetSessionId: string | null;
  targetThreadId: string | null;
  targetMessageId: string | null;
  /** Stable transition identity; it does not replace a Run or message operation ID. */
  operationId: string | null;
  ownerNonce: string | null;
  ownerPid: number | null;
  ownerStartIdentity: string | null;
  expectedPolicyHash: string | null;
  observedPolicyHash: string | null;
  oldOwnerExitEvidenceRef: string | null;
  spawnedOwnerRecordedAt: string | null;
  verificationEvidenceRef: string | null;
  nativeAttemptedAt: string | null;
  verifiedAt: string | null;
  reason: string;
  updatedAt: string;
}

export interface NativeExecutionTransition {
  expectedEpoch: number;
  operationId: string;
  purpose: NativeExecutionPurpose;
  projectId: string;
  sessionId: string;
  nativeThreadId: string;
  /** Required for a message switch; absent for a business switch. */
  messageId: string | null;
  expectedPolicyHash: string;
  reason: string;
}

export interface NativeExecutionOwner {
  nonce: string;
  pid: number;
  /** OS-verifiable process start identity, not a PID alone. */
  startIdentity: string;
}

export interface NativeExecutionStartupPermit {
  kind: NativeStartupKind;
  expectedEpoch: number;
  projectId: string;
  sessionId: string;
  operationId: string;
  /** The exact original queued message, when kind is message. */
  messageId?: string;
}

export interface NativeExecutionReader {
  /** Missing row means legacy unverified operation, never verified ownership. */
  getNativeExecutionEnvironment(): Promise<NativeExecutionEnvironment | null>;
}

export interface NativeExecutionTransaction extends NativeExecutionReader {
  /** Explicit opt-in; no migration may infer a verified mode from a ready Session. */
  adoptUnknown(reason: string): Promise<NativeExecutionEnvironment>;
  /** Only the global control row is locked by switch transactions. */
  beginTransition(input: NativeExecutionTransition): Promise<NativeExecutionEnvironment>;
  /** Persist one native-action intent before closing or spawning a child. */
  markNativeAttempt(expectedEpoch: number, operationId: string): Promise<NativeExecutionEnvironment>;
  recordOldOwnerExit(expectedEpoch: number, operationId: string, evidenceRef: string): Promise<NativeExecutionEnvironment>;
  /** Persist the new process identity before any resume/Turn; this does not verify its environment. */
  recordSpawnedOwner(expectedEpoch: number, operationId: string, owner: NativeExecutionOwner): Promise<NativeExecutionEnvironment>;
  verifyEnvironment(expectedEpoch: number, operationId: string, owner: NativeExecutionOwner,
    observedPolicyHash: string, evidenceRef: string, verifiedTargetPolicyHash: string): Promise<NativeExecutionEnvironment>;
  markEnvironmentUnknown(expectedEpoch: number, reason: string): Promise<NativeExecutionEnvironment>;
  /** Only before a native action; never clears a lost acknowledgement. */
  cancelPreparation(expectedEpoch: number, operationId: string, reason: string): Promise<NativeExecutionEnvironment>;
  /** Call last, after the caller's existing Session slot and recovery-gate locks. */
  permitNativeStartup(input: NativeExecutionStartupPermit): Promise<void>;
}
