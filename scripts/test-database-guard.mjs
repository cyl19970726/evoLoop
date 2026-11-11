// Load before any test that may open TEST_DATABASE_URL (`node --import ./scripts/test-database-guard.mjs …`, or as the
// first import of the test file): the process stops, with the reason, when that URL points at a live or shared server.
import { assertDevelopmentDatabase } from "./lib/database-target.mjs";

const url = process.env.TEST_DATABASE_URL;
if (url) {
  try { await assertDevelopmentDatabase(url); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(78); }
}
