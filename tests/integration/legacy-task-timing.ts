import type { Transaction } from "@evoloop/contracts/ports";
import type { PostgresUnitOfWork } from "@evoloop/adapter-postgres";

/** Historical migration fixtures predate 057; remove only the optional timing port until upgrade. */
export function withoutTaskTimingBeforeMigration(uow: PostgresUnitOfWork, isLegacy: () => boolean): void {
  const transaction = uow.transaction.bind(uow);
  uow.transaction = <T>(projectId: string, action: (tx: Transaction) => Promise<T>) =>
    transaction(projectId, tx => {
      // The stage milestone and ownership side tables (118) do not exist in these historical schemas either.
      if (isLegacy()) Object.defineProperties(tx, { taskTiming: { value: undefined }, putStageMilestone: { value: undefined }, putTaskStage: { value: undefined }, clearTaskStage: { value: undefined }, getTaskStage: { value: undefined } });
      return action(tx);
    });
}
