import type { Transaction } from "@evoloop/contracts/ports";
import type { PostgresUnitOfWork } from "@evoloop/adapter-postgres";

/** Historical migration fixtures predate 057; remove only the optional timing port until upgrade. */
export function withoutTaskTimingBeforeMigration(uow: PostgresUnitOfWork, isLegacy: () => boolean): void {
  const transaction = uow.transaction.bind(uow);
  uow.transaction = <T>(projectId: string, action: (tx: Transaction) => Promise<T>) =>
    transaction(projectId, tx => {
      if (isLegacy()) Object.defineProperty(tx, "taskTiming", { value: undefined });
      return action(tx);
    });
}
