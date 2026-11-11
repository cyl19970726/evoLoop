#!/usr/bin/env node
// Generic read-only checks run inside the release directory before anything is stopped.
import { access, readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";

export function duplicateMigrationNumbers(names) {
  const seen = new Map();
  for (const name of names) {
    const match = /^(\d+)_/.exec(name);
    if (!match) continue;
    seen.set(match[1], [...(seen.get(match[1]) ?? []), name]);
  }
  return [...seen].filter(([, files]) => files.length > 1).map(([number, files]) => ({ number, files }));
}

export async function preflight({ backupOut, env = process.env, migrationsDir = "packages/adapter-postgres/migrations" }) {
  const problems = [];
  if (!env.EVOLOOP_DATABASE_URL) problems.push("EVOLOOP_DATABASE_URL is not set");
  if (!backupOut || !isAbsolute(backupOut)) problems.push("backup target must be an absolute path");
  else if (await access(backupOut).then(() => true, () => false)) problems.push(`backup target already exists: ${backupOut}`);
  const duplicates = duplicateMigrationNumbers(await readdir(migrationsDir));
  for (const { number, files } of duplicates) problems.push(`migration number ${number} used by ${files.join(", ")}`);
  if (!/^v24\./.test(process.version)) problems.push(`Node 24 required, found ${process.version}`);
  return problems;
}

if (process.argv[1]?.endsWith("preflight.mjs")) {
  const { values } = parseArgs({ options: { "backup-out": { type: "string" } } });
  const problems = await preflight({ backupOut: values["backup-out"] });
  if (problems.length) { console.error(problems.map(problem => `preflight: ${problem}`).join("\n")); process.exit(1); }
  console.log("preflight ok");
}
