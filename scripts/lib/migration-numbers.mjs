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

const MIGRATION_FILE = /^packages\/adapter-postgres\/(?:migrations|schema)\/(\d{3})_(.+)\.(?:mjs|sql)$/;

/**
 * Open pull requests that take the same migration number. `prs` are `{ number, title, isDraft, files: [{ path } | path] }` as `gh pr list --json files`
 * gives them; `mainFiles` are the migration paths that exist on the base branch. A PR takes a number when it has a migration file at that number that the
 * base branch does not have; two PRs taking one number cannot both land, whatever the names are. `only` limits the answer to conflicts that involve that PR.
 * Returns { conflicts: [{ number, prs: [{ number, title, isDraft, files }] }], next } where `next` is a number nobody (base or any open PR) holds.
 */
export function openPrMigrationConflicts({ prs, mainFiles, only = null }) {
  const onMain = new Set(mainFiles);
  const claims = new Map();
  for (const pr of prs) {
    const paths = (pr.files ?? []).map(file => (typeof file === "string" ? file : file.path));
    for (const path of paths) {
      const match = MIGRATION_FILE.exec(path);
      if (!match || onMain.has(path)) continue;
      const group = claims.get(match[1]) ?? new Map();
      const entry = group.get(pr.number) ?? { number: pr.number, title: pr.title ?? "", isDraft: Boolean(pr.isDraft), files: [] };
      entry.files.push(path.split("/").slice(-2).join("/"));
      group.set(pr.number, entry);
      claims.set(match[1], group);
    }
  }
  const conflicts = [...claims].filter(([, group]) => group.size > 1 && (only === null || group.has(only)))
    .map(([number, group]) => ({ number, prs: [...group.values()].sort((a, b) => a.number - b.number) }))
    .sort((a, b) => a.number.localeCompare(b.number));
  const held = [...mainFiles.map(path => MIGRATION_FILE.exec(path)?.[1]), ...claims.keys()].filter(Boolean).map(Number);
  return { conflicts, next: String(Math.max(0, ...held) + 1).padStart(3, "0") };
}

/** What a failing check says: the number, both (or all) PRs by number and title, and a free number to move to. */
export function describeOpenPrConflicts({ conflicts, next }) {
  return [
    ...conflicts.map(({ number, prs }) => `迁移号 ${number} 同时被多个开放 PR 使用:\n${prs.map(pr => `  - PR #${pr.number}${pr.isDraft ? "(草稿)" : ""} ${pr.title}（${pr.files.join("、")}）`).join("\n")}`),
    `先合并的保留这个号;其余的把迁移文件(.mjs 包装和 .sql)改成下一个没人用的号:${next}。`,
  ].join("\n");
}
