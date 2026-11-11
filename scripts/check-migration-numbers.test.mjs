import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkMigrationNumbers, describeConflicts, readMigrationEntries } from "./lib/migration-numbers.mjs";

const pair = (number, stem) => [{ dir: "migrations", name: `${number}_${stem}.mjs` }, { dir: "schema", name: `${number}_${stem}.sql` }];

test("one migration (wrapper and schema sharing number and name) is not a conflict, and the next free number follows the highest", () => {
  const result = checkMigrationNumbers([...pair("068", "role_runtime"), ...pair("069", "document_history"), { dir: "migrations", name: "README.md" }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.next, "070");
});

test("two different migrations under one number fail, naming every file involved and the next free number", () => {
  const result = checkMigrationNumbers([...pair("069", "document_history"), ...pair("070", "feature_a"), ...pair("070", "feature_b")]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, [{ number: "070", files: [
    "migrations/070_feature_a.mjs", "migrations/070_feature_b.mjs", "schema/070_feature_a.sql", "schema/070_feature_b.sql"] }]);
  assert.equal(result.next, "071");
  const text = describeConflicts(result);
  assert.match(text, /number 070/);
  assert.match(text, /schema\/070_feature_b\.sql/);
  assert.match(text, /next free number: 071/);
});

test("a clash in only one directory is still found, and several clashes are all reported in order", () => {
  const result = checkMigrationNumbers([...pair("070", "a"), { dir: "schema", name: "070_other.sql" }, ...pair("072", "c"), ...pair("072", "d")]);
  assert.deepEqual(result.conflicts.map(item => item.number), ["070", "072"]);
  assert.equal(result.next, "073");
});

test("files that are not numbered migrations are ignored", () => {
  assert.equal(checkMigrationNumbers([{ dir: "schema", name: "notes.sql" }, { dir: "schema", name: "70_short.sql" }]).ok, true);
  assert.equal(checkMigrationNumbers([]).next, "001");
});

test("the real repository has unique migration numbers", () => {
  const root = join(import.meta.dirname, "..");
  assert.equal(checkMigrationNumbers(readMigrationEntries(root)).ok, true);
});

test("the CLI exits non-zero with the conflict in a tree that has one, and zero in one that does not", () => {
  const root = mkdtempSync(join(tmpdir(), "evoloop-migno-"));
  try {
    for (const dir of ["migrations", "schema"]) mkdirSync(join(root, "packages/adapter-postgres", dir), { recursive: true });
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    const script = join(import.meta.dirname, "check-migration-numbers.mjs");
    const lib = join(import.meta.dirname, "lib/migration-numbers.mjs");
    const run = () => {
      // The script resolves the repository from its own location, so run a copy placed inside the temporary tree.
      copyFileSync(script, join(root, "scripts/check-migration-numbers.mjs"));
      copyFileSync(lib, join(root, "scripts/lib/migration-numbers.mjs"));
      return spawnSync(process.execPath, [join(root, "scripts/check-migration-numbers.mjs")], { encoding: "utf8" });
    };
    writeFileSync(join(root, "packages/adapter-postgres/schema/001_first.sql"), "");
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /unique.*002/);
    writeFileSync(join(root, "packages/adapter-postgres/schema/001_second.sql"), "");
    const clash = run();
    assert.equal(clash.status, 1);
    assert.match(clash.stderr, /number 001[\s\S]*001_first\.sql[\s\S]*001_second\.sql[\s\S]*next free number: 002/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
