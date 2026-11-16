#!/usr/bin/env node
// Before merge: fails when another OPEN pull request takes the same migration number as this one (or, without --pr, when any two open PRs do).
// `check:migrations` looks at one merged tree and cannot see two open PRs that were both branched before either landed (#442 and #448 both took 110).
//   node scripts/check-open-pr-migrations.mjs [--pr NUMBER] [--repo OWNER/NAME] [--base origin/main]
// Needs the gh CLI with read access to the repository's pull requests (in CI: GH_TOKEN) and the base branch fetched.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describeOpenPrConflicts, openPrMigrationConflicts } from "./lib/migration-numbers.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Reads the open PRs and the base branch's migration files; `exec` is replaced in tests. */
export function readOpenPrState({ repo, base = "origin/main", exec = execFileSync } = {}) {
  const run = (file, args) => exec(file, args, { encoding: "utf8", maxBuffer: 128 << 20, cwd: root });
  const prs = JSON.parse(run("gh", ["pr", "list", ...(repo ? ["--repo", repo] : []), "--state", "open", "--limit", "200", "--json", "number,title,isDraft,files"]));
  const mainFiles = run("git", ["ls-tree", "-r", "--name-only", base, "--", "packages/adapter-postgres/migrations", "packages/adapter-postgres/schema"]).split("\n").filter(Boolean);
  return { prs, mainFiles };
}

const isMain = () => process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain()) {
  const { values } = parseArgs({ options: { pr: { type: "string" }, repo: { type: "string" }, base: { type: "string", default: "origin/main" } } });
  const only = values.pr === undefined ? null : Number(values.pr);
  if (only !== null && !Number.isInteger(only)) { console.error("--pr must be a pull request number"); process.exit(2); }
  try {
    const state = readOpenPrState({ repo: values.repo ?? process.env.GITHUB_REPOSITORY, base: values.base });
    const result = openPrMigrationConflicts({ ...state, only });
    if (result.conflicts.length) { console.error(describeOpenPrConflicts(result)); process.exit(1); }
    console.log(`No open pull request shares a migration number${only === null ? "" : ` with #${only}`} (${state.prs.length} open PRs read). Next free number: ${result.next}.`);
  } catch (error) { console.error(`open PR migration check could not run: ${String(error.message).split("\n")[0]}`); process.exit(2); }
}
