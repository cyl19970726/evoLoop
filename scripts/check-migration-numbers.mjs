// Fails when two different migrations share a number in the checked-out tree. In a pull request CI checks out the merge of
// the PR into main, so this finds a number the PR took that main (or another merged PR) already holds.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { checkMigrationNumbers, describeConflicts, readMigrationEntries } from "./lib/migration-numbers.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = checkMigrationNumbers(readMigrationEntries(root));
if (!result.ok) {
  console.error(describeConflicts(result));
  process.exit(1);
}
console.log(`Migration numbers are unique. Next free number: ${result.next}.`);
