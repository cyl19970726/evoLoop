import type { NativeExecutionStartupPermit } from '@evoloop/contracts/native-execution';
import type { Transaction } from '@evoloop/contracts/ports';
import { DomainError } from '@evoloop/contracts/ports';

/** Called last in the existing Session/gate transaction, before its native-start intent. */
export async function permitNativeStartup(tx: Transaction,
  input: Omit<NativeExecutionStartupPermit, 'expectedEpoch'>, expectedEpoch?: number): Promise<void> {
  const control = tx.nativeExecution;
  if (!control) {
    if (expectedEpoch !== undefined)
      throw new DomainError('NATIVE_CONTROL_UNAVAILABLE', 'Native execution control is unavailable');
    return;
  }
  const environment = await control.getNativeExecutionEnvironment();
  if (!environment) {
    if (expectedEpoch !== undefined)
      throw new DomainError('NATIVE_CONTROL_UNAVAILABLE', 'Native execution control has not been adopted');
    return; // Legacy operation does not establish verified process ownership.
  }
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch! < 1)
    throw new DomainError('NATIVE_EPOCH_REQUIRED', 'A verified native environment epoch is required');
  await control.permitNativeStartup({ ...input, expectedEpoch: expectedEpoch! });
}
