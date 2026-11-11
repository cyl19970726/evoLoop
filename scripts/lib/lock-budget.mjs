// PostgreSQL keeps every lock a transaction takes until it ends, in one server-wide table sized
// max_locks_per_transaction x (max_connections + max_prepared_transactions). The integration suite
// runs several test files at once, each in its own database but sharing that table.
//
// Measured on postgres:18.6 with default settings (docs/development/local-run.md#集成测试与-postgresql-锁表):
//   - migrating one test schema (single transaction)      ~2.2k lock rows
//   - DROP SCHEMA ... CASCADE of a migrated test schema   ~4.7k lock rows (713 relation + ~3.96k object locks)
//   - "out of shared memory" appears between 17.3k and 21.8k rows at the default nominal size of 6400,
//     so the usable ceiling is about 2.7x (safe lower bound) to 3.4x the nominal size.
export const DROP_SCHEMA_LOCK_ROWS = 4_700;
export const CEILING_FACTOR = 2.7;
// One file can hold a drop while another migrates or drops: leave 1.5x one drop of room per running file.
export const LOCK_ROWS_PER_RUNNING_FILE = Math.round(DROP_SCHEMA_LOCK_ROWS * 1.5);

export function nominalLockSlots({ maxLocksPerTransaction, maxConnections, maxPreparedTransactions = 0 }) {
  return maxLocksPerTransaction * (maxConnections + maxPreparedTransactions);
}

/** Largest number of concurrently running test files this server's lock table can carry, at least 1. */
export function lockSafeConcurrency(settings) {
  return Math.max(1, Math.floor((CEILING_FACTOR * nominalLockSlots(settings)) / LOCK_ROWS_PER_RUNNING_FILE));
}
