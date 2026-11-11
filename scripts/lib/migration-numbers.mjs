import { readdirSync } from "node:fs";
import { join } from "node:path";

/** `NNN_name.ext` -> { number, stem }. Anything else is not a numbered migration file. */
const parse = name => {
  const match = /^(\d{3})_(.+)\.(mjs|sql)$/.exec(name);
  return match ? { number: Number(match[1]), stem: match[2] } : null;
};
const pad = number => String(number).padStart(3, "0");

/**
 * Migrations run in number order, so one number must name one migration. A migration is a pair (`migrations/NNN_x.mjs`
 * wrapper + `schema/NNN_x.sql`) that shares its number and name; two different names under one number are a conflict.
 * `entries` are `{ dir, name }` for every file of both directories as they exist in the tree being checked.
 */
export function checkMigrationNumbers(entries) {
  const byNumber = new Map();
  for (const { dir, name } of entries) {
    const parsed = parse(name);
    if (!parsed) continue;
    const group = byNumber.get(parsed.number) ?? new Map();
    group.set(parsed.stem, [...(group.get(parsed.stem) ?? []), `${dir}/${name}`]);
    byNumber.set(parsed.number, group);
  }
  const conflicts = [...byNumber].filter(([, stems]) => stems.size > 1)
    .map(([number, stems]) => ({ number: pad(number), files: [...stems.values()].flat().sort() }))
    .sort((a, b) => a.number.localeCompare(b.number));
  const highest = Math.max(0, ...byNumber.keys());
  return { ok: conflicts.length === 0, conflicts, next: pad(highest + 1) };
}

/** What a failing check says: each clashing number with its files, and the number a new migration should take. */
export function describeConflicts({ conflicts, next }) {
  return [
    ...conflicts.map(({ number, files }) => `Migration number ${number} is used by different migrations:\n${files.map(file => `  - ${file}`).join("\n")}`),
    `Rename the migration you added (the .mjs wrapper and its .sql file, and any reference to them) to the next free number: ${next}.`,
  ].join("\n");
}

export function readMigrationEntries(root) {
  return ["migrations", "schema"].flatMap(dir => readdirSync(join(root, "packages/adapter-postgres", dir)).map(name => ({ dir, name })));
}
