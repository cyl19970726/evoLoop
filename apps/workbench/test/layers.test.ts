// Dependency direction for the workbench and @evoloop/ui: app → features → shared → @evoloop/ui.
// The rules are written in docs/frontend/architecture.md ("代码分层"); this file is their executable form.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { test } from "node:test";

const repo = resolve(import.meta.dirname, "../../..");
const WORKBENCH = "apps/workbench/src";
const UI = "packages/ui/src";
const forbiddenInUi = ["@evoloop/contracts", "@evoloop/workbench"];

type Files = Map<string, string>;  // repository-relative POSIX path → text (empty for assets)

const statement = /^[ \t]*(?:import|export)(?:[ \t]+type)?[\w\s{},*$]*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gm;
const cssImport = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;

/** Comments that start a line are removed first, so an import list with a trailing note still parses. */
function withoutComments(text: string): string {
  return text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/(^|[ \t])\/\/[^\n]*/gm, "$1");
}

/** Module specifiers of one file; a statement that starts with `import` but is not understood is reported, never skipped. */
export function importsOf(path: string, text: string): { specifiers: string[]; unreadable: string[] } {
  if (path.endsWith(".css")) return { specifiers: [...text.matchAll(cssImport)].map(match => match[1]), unreadable: [] };
  const code = withoutComments(text);
  const specifiers: string[] = [];
  const understood = new Set<number>();
  for (const match of code.matchAll(statement)) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
    understood.add(match.index + (match[0].length - match[0].trimStart().length));
  }
  const unreadable = [...code.matchAll(/^[ \t]*import\b(?![ \t]*[(.])/gm)]
    .filter(match => !understood.has(match.index + match[0].length - match[0].trimStart().length))
    .map(match => code.slice(match.index, code.indexOf("\n", match.index)).trim());
  return { specifiers, unreadable };
}

function resolveRelative(files: Files, from: string, specifier: string): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = base.replace(/\.js$/, "");
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`]) if (files.has(candidate)) return candidate;
  return null;
}

type Layer = { kind: "app" | "shared" | "outside" } | { kind: "feature"; name: string };
/** `src/` keeps only the entry, global type declarations and the legacy global stylesheets (removed in PR10); they count as app. */
function layerOf(path: string): Layer {
  const inside = path.slice(WORKBENCH.length + 1);
  const [first, second] = inside.split("/");
  if (first === "app") return { kind: "app" };
  if (first === "shared") return { kind: "shared" };
  if (first === "features" && second && inside.split("/").length > 2) return { kind: "feature", name: second };
  if (!inside.includes("/") && (inside === "main.tsx" || inside.endsWith(".d.ts") || inside.endsWith(".css"))) return { kind: "app" };
  return { kind: "outside" };
}

export function checkWorkbench(files: Files): { problems: string[]; features: Map<string, Set<string>> } {
  const problems: string[] = [];
  const features = new Map<string, Set<string>>();
  const sources = [...files.keys()].filter(path => path.startsWith(`${WORKBENCH}/`)).sort();
  for (const path of sources) {
    const from = layerOf(path);
    if (from.kind === "feature" && !features.has(from.name)) features.set(from.name, new Set());
    if (from.kind === "outside") { problems.push(`${path}: put it under app/, features/<name>/ or shared/`); continue; }
    if (!/\.(tsx?|css)$/.test(path)) continue;
    const { specifiers, unreadable } = importsOf(path, files.get(path) ?? "");
    for (const line of unreadable) problems.push(`${path}: import statement not understood by the layer check: ${line}`);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelative(files, path, specifier);
      if (!target) { problems.push(`${path}: cannot resolve ${specifier}`); continue; }
      if (!target.startsWith(`${WORKBENCH}/`)) { problems.push(`${path}: reaches ${target} by relative path; import the package by name`); continue; }
      const to = layerOf(target);
      if (from.kind === "shared" && (to.kind === "app" || to.kind === "feature"))
        problems.push(`${path}: shared must not import ${to.kind === "app" ? "app" : "features"} (${target})`);
      if (from.kind === "feature" && to.kind === "app") problems.push(`${path}: a feature must not import app (${target})`);
      if (from.kind === "feature" && to.kind === "feature" && to.name !== from.name) {
        if (target !== `${WORKBENCH}/features/${to.name}/index.ts`)
          problems.push(`${path}: import features/${to.name} through its index.ts, not ${target.slice(WORKBENCH.length + 1)}`);
        features.get(from.name)!.add(to.name);
      }
    }
  }
  for (const cycle of featureCycles(features)) problems.push(`features import each other in a cycle: ${cycle.join(" → ")}`);
  return { problems, features };
}

function featureCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "open" | "done">();
  const trail: string[] = [];
  const visit = (name: string) => {
    state.set(name, "open"); trail.push(name);
    for (const next of [...graph.get(name) ?? []].sort()) {
      if (state.get(next) === "open") cycles.push([...trail.slice(trail.indexOf(next)), next]);
      else if (!state.has(next)) visit(next);
    }
    trail.pop(); state.set(name, "done");
  };
  for (const name of [...graph.keys()].sort()) if (!state.has(name)) visit(name);
  return cycles;
}

/** @evoloop/ui knows nothing about the workbench or the business contracts, and never makes requests. */
export function checkUi(files: Files, packageJson: { dependencies?: object; devDependencies?: object; peerDependencies?: object }): string[] {
  const problems: string[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const)
    for (const name of Object.keys(packageJson[field] ?? {}))
      if (forbiddenInUi.includes(name)) problems.push(`packages/ui/package.json: ${field} must not include ${name}`);
  for (const [path, text] of files) {
    if (!path.startsWith(`${UI}/`) || !/\.(tsx?|css)$/.test(path)) continue;
    const { specifiers, unreadable } = importsOf(path, text);
    for (const line of unreadable) problems.push(`${path}: import statement not understood by the layer check: ${line}`);
    for (const specifier of specifiers) {
      if (forbiddenInUi.some(name => specifier === name || specifier.startsWith(`${name}/`))) problems.push(`${path}: must not import ${specifier}`);
      if (specifier.startsWith(".") && !posix.normalize(posix.join(posix.dirname(path), specifier)).startsWith("packages/ui/"))
        problems.push(`${path}: reaches outside packages/ui (${specifier})`);
    }
    if (!path.endsWith(".css") && /\b(fetch|XMLHttpRequest|EventSource|WebSocket)\s*\(|new\s+(XMLHttpRequest|EventSource|WebSocket)\b/.test(withoutComments(text)))
      problems.push(`${path}: @evoloop/ui must not make requests; pass data in through props`);
  }
  return problems;
}

function read(dir: string): Files {
  const files: Files = new Map();
  const walk = (absolute: string) => {
    for (const name of readdirSync(absolute)) {
      const child = join(absolute, name);
      if (statSync(child).isDirectory()) walk(child);
      else files.set(relative(repo, child).split("\\").join("/"), /\.(tsx?|css)$/.test(name) ? readFileSync(child, "utf8") : "");
    }
  };
  walk(join(repo, dir));
  return files;
}

test("the workbench follows app → features → shared, features meet only through index.ts, and features do not form cycles", t => {
  const { problems, features } = checkWorkbench(read(WORKBENCH));
  assert.deepEqual(problems, []);
  t.diagnostic([...features].filter(([, uses]) => uses.size).map(([name, uses]) => `${name} → ${[...uses].sort().join(", ")}`).join("; "));
});

test("@evoloop/ui does not depend on the workbench or @evoloop/contracts and makes no requests", () => {
  const packageJson = JSON.parse(readFileSync(join(repo, "packages/ui/package.json"), "utf8"));
  assert.deepEqual(checkUi(read(UI), packageJson), []);
});

const W = (path: string) => `${WORKBENCH}/${path}`;
const workbench = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([path, text]) => [W(path), text]));

test("the layer check reports each kind of violation", () => {
  const { problems } = checkWorkbench(workbench({
    "main.tsx": `import { App } from "./app/App";`,
    "app/App.tsx": `import { Page } from "../features/a/Page";`,
    "shared/api.ts": `import type { Status } from "../features/a/status";`,
    "shared/ok.ts": `export const ok = 1;`,
    "features/a/Page.tsx": `import { ok } from "../../shared/ok";\nimport { B } from "../b";\nexport const Page = 1;`,
    "features/a/status.ts": `export type Status = string;`,
    "features/a/index.ts": `export { Page } from "./Page";`,
    "features/b/index.ts": `export { B } from "./B";`,
    "features/b/B.tsx": `import {\n  Page, // the other feature's page\n} from "../a/Page";\nimport { App } from "../../app/App";\nexport const B = 1;`,
    "features/c/C.tsx": `const lazyA = () => import("../a");\nexport const C = lazyA;`,
    "features/c/index.ts": `import "../b";`,
    "stray/thing.ts": `export const thing = 1;`,
  }));
  const has = (text: string) => assert.ok(problems.some(problem => problem.includes(text)), `expected a problem mentioning: ${text}\n${problems.join("\n")}`);
  has("shared/api.ts: shared must not import features");
  has("features/b/B.tsx: import features/a through its index.ts, not features/a/Page.tsx");
  has("features/b/B.tsx: a feature must not import app");
  has("stray/thing.ts: put it under app/");
  assert.ok(!problems.some(problem => problem.startsWith(W("app/App.tsx"))), "app is the composition root and may import page modules");
  assert.ok(!problems.some(problem => problem.startsWith(W("features/c/"))), "dynamic and side-effect imports through index.ts are allowed");
  const cycle = checkWorkbench(workbench({
    "features/a/index.ts": `export { b } from "../b";`,
    "features/b/index.ts": `export { a } from "../a";`,
  })).problems;
  assert.deepEqual(cycle, ["features import each other in a cycle: a → b → a"]);
});

test("an import the layer check cannot read fails instead of passing silently", () => {
  const { problems } = checkWorkbench(workbench({ "shared/x.ts": `import /* odd */ { y } from "./y";` }));
  assert.ok(problems.some(problem => problem.includes("not understood")), problems.join("\n"));
});

test("the @evoloop/ui check reports contracts, workbench paths and requests", () => {
  const problems = checkUi(new Map([
    [`${UI}/a.tsx`, `import type { Task } from "@evoloop/contracts";`],
    [`${UI}/b.ts`, `import { x } from "../../../apps/workbench/src/shared/api";`],
    [`${UI}/c.ts`, `export const load = () => fetch("/api/x");`],
    [`${UI}/d.ts`, `// fetch() is mentioned in a comment only\nexport const d = 1;`],
  ]), { dependencies: { "@evoloop/contracts": "0.1.0" } });
  assert.deepEqual(problems, [
    "packages/ui/package.json: dependencies must not include @evoloop/contracts",
    `${UI}/a.tsx: must not import @evoloop/contracts`,
    `${UI}/b.ts: reaches outside packages/ui (../../../apps/workbench/src/shared/api)`,
    `${UI}/c.ts: @evoloop/ui must not make requests; pass data in through props`,
  ]);
});
