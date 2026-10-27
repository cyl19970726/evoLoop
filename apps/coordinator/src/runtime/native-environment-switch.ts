import type { NativeExecutionEnvironment, NativeExecutionOwner, NativeExecutionTransaction,
  NativeExecutionTransition } from '@evoloop/contracts/native-execution';
import { DomainError } from '@evoloop/contracts/ports';

export interface NativeEnvironmentSwitchHost {
  /** Pause new admission only. Already admitted RPCs, approvals and readback must keep settling. */
  pauseNewStartup(): () => void;
  /** Return false at the deadline; requested Runs without a native permit are not active Turns. */
  drainAdmitted(deadlineMs: number, signal: AbortSignal): Promise<boolean>;
  /** Resolve only from a confirmed child exit; never infer it from unsubscribe or an RPC EOF. */
  closeCurrent(): Promise<string>;
  /** Record the spawned owner before initialize/resume can load an owned Thread. */
  startAndVerify(target: NativeExecutionEnvironment,
    recordOwner: (owner: NativeExecutionOwner) => Promise<void>): Promise<{
      owner: NativeExecutionOwner; targetPolicyHash: string; policyHash: string; evidenceRef: string;
    }>;
}
export type NativeEnvironmentSwitchResult =
  | {kind:'ready';environment:NativeExecutionEnvironment}
  | {kind:'waiting';environment:NativeExecutionEnvironment;reason:'drain_timeout'};

/** Only coordinates process switching. Run/message operations retain all dispatch and outcome authority. */
export class NativeEnvironmentSwitcher {
  private busy = false;
  private releaseAdmission: (() => void) | null = null;
  constructor(private readonly deps: {
    control<T>(work: (store: NativeExecutionTransaction) => Promise<T>): Promise<T>;
    host: NativeEnvironmentSwitchHost;
    maxDrainWaitMs: number;
    now(): number;
  }) {
    if (!Number.isSafeInteger(deps.maxDrainWaitMs) || deps.maxDrainWaitMs < 1 || deps.maxDrainWaitMs > 2_147_483_647)
      throw new Error('maxDrainWaitMs must be a positive integer');
  }

  async prepare(input: NativeExecutionTransition): Promise<NativeEnvironmentSwitchResult> {
    if (this.busy) throw new DomainError('NATIVE_SWITCH_BUSY', 'A native environment switch is already in progress');
    this.busy = true;
    let transition: NativeExecutionEnvironment | null = null;
    try {
      // This transaction touches only the global control row, never a Session/queue/gate row.
      transition = await this.deps.control(store => store.beginTransition(input));
      this.releaseAdmission ??= this.deps.host.pauseNewStartup();
      const deadline = this.deps.now() + this.deps.maxDrainWaitMs;
      if (!await this.drain(deadline)) {
        const restored = await this.deps.control(store => store.cancelPreparation(
          transition!.epoch, input.operationId, 'Drain deadline reached; original queued message has not been dispatched'));
        this.releaseIfBusiness(restored);
        return {kind:'waiting',environment:restored,reason:'drain_timeout'};
      }
      await this.deps.control(store => store.markNativeAttempt(transition!.epoch,input.operationId));
      const exitEvidence = await this.deps.host.closeCurrent();
      if (!exitEvidence.trim()) throw new Error('Confirmed child exit evidence is required');
      await this.deps.control(store => store.recordOldOwnerExit(transition!.epoch,input.operationId,exitEvidence));
      let recordedOwner: NativeExecutionOwner | null = null;
      let ownerRegistrationStarted = false;
      const observed = await this.deps.host.startAndVerify(transition, async owner => {
        if (ownerRegistrationStarted) throw new Error('A switch cannot record a second native child');
        ownerRegistrationStarted = true;
        await this.deps.control(store => store.recordSpawnedOwner(transition!.epoch,input.operationId,owner));
        recordedOwner = {...owner};
      });
      if (!recordedOwner) throw new Error('Native owner was not persisted before verification');
      if (observed.targetPolicyHash !== input.expectedPolicyHash)
        throw new Error('Native verification did not cover the original target policy');
      const verified = await this.deps.control(store => store.verifyEnvironment(
        transition!.epoch,input.operationId,observed.owner,observed.policyHash,observed.evidenceRef,observed.targetPolicyHash));
      this.releaseIfBusiness(verified);
      return {kind:'ready',environment:verified};
    } catch (error) {
      if (transition) {
        // No retry, replacement child or automatic business restore on a lost acknowledgement.
        await this.deps.control(store => store.markEnvironmentUnknown(transition!.epoch,
          'Native environment switch was not confirmed; reconcile the original control and operation'));
      }
      throw error;
    } finally { this.busy = false; }
  }

  private async drain(deadline: number): Promise<boolean> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.deps.host.drainAdmitted(deadline,abort.signal),
        new Promise<boolean>(resolve => { timer = setTimeout(()=>resolve(false),this.deps.maxDrainWaitMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); abort.abort(); }
  }

  private releaseIfBusiness(environment: NativeExecutionEnvironment): void {
    if (environment.mode !== 'business_verified') return;
    const release = this.releaseAdmission;
    this.releaseAdmission = null;
    release?.();
  }
}
