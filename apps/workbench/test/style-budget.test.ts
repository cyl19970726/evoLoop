// Keeps the workbench moving onto @evoloop/ui tokens: colour literals may only decrease and no CSS file
// defines design tokens on :root except the temporary legacy alias file.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const workbench = join(import.meta.dirname, "..");
const source = join(workbench, "src");
const budget = JSON.parse(readFileSync(join(workbench, "style-budget.json"), "utf8")) as { cssColorLiterals: number };

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const colourLiteral = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;

test("workbench CSS colour literals do not exceed the budget, and the budget tracks reductions", () => {
  const count = cssFiles(source).reduce((sum, file) => sum + (withoutComments(readFileSync(file, "utf8")).match(colourLiteral)?.length ?? 0), 0);
  assert.ok(count <= budget.cssColorLiterals, `Colour literals rose to ${count} (budget ${budget.cssColorLiterals}). Use @evoloop/ui tokens instead.`);
  assert.equal(count, budget.cssColorLiterals, `Colour literals fell to ${count}; lower cssColorLiterals in apps/workbench/style-budget.json to ${count}.`);
});

test("only the legacy alias file defines design tokens, on :root or any other selector", () => {
  const tokens = readFileSync(join(workbench, "../../packages/ui/src/tokens.css"), "utf8");
  const aliases = readFileSync(join(source, "legacy-tokens.css"), "utf8");
  const names = new Set([...`${tokens}\n${aliases}`.matchAll(/(--[a-z][\w-]*)\s*:/g)].map(match => match[1]));
  const offenders = cssFiles(source)
    .filter(file => !file.endsWith("legacy-tokens.css"))
    .flatMap(file => [...withoutComments(readFileSync(file, "utf8")).matchAll(/(--[a-z][\w-]*)\s*:/g)]
      .filter(match => names.has(match[1]))
      .map(match => `${relative(workbench, file)} ${match[1]}`));
  assert.deepEqual(offenders, [], "Design tokens are defined only in packages/ui/src/tokens.css (old names only in legacy-tokens.css).");
});

test("the design tokens named in docs/frontend/foundations.md exist in @evoloop/ui", () => {
  const tokens = readFileSync(join(workbench, "../../packages/ui/src/tokens.css"), "utf8");
  const foundations = readFileSync(join(workbench, "../../docs/frontend/foundations.md"), "utf8");
  for (const name of ["surface-sunken", "background", "surface-raised", "surface-muted", "surface-field", "surface-selected", "text",
    "text-secondary", "text-muted", "border", "border-strong", "accent", "accent-soft", "warning", "warning-soft", "danger", "danger-soft",
    "brand", "user-bubble", "font-caption", "font-label", "font-small", "font-body", "font-heading", "font-title", "leading-reading",
    "space-9", "radius-control", "radius-card", "radius-panel", "radius-pill", "shadow-panel", "shadow-control", "shadow-popover",
    "duration-fast", "duration-base", "duration-slow"]) {
    assert.match(tokens, new RegExp(`--${name}:`), `missing --${name}`);
  }
  for (const [, name] of foundations.matchAll(/^\| `([a-z][a-z0-9-]*)`(?: \/ `[a-z-]+`)? \|/gm)) {
    assert.match(tokens, new RegExp(`--${name}:`), `foundations.md names --${name}, which tokens.css does not define`);
  }
});

test("every light colour token has a dark value, and the logo files exist", () => {
  const tokens = readFileSync(join(workbench, "../../packages/ui/src/tokens.css"), "utf8");
  const [light, dark] = [/:root \{([\s\S]*?)\n\}/, /:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/].map(pattern => tokens.match(pattern)?.[1] ?? "");
  const colourNames = (block: string) => [...block.matchAll(/(--[a-z][\w-]*)\s*:\s*(#[0-9a-f]{3,8}|rgb\()/g)].map(match => match[1]);
  const missing = colourNames(light).filter(name => !dark.includes(`${name}:`));
  assert.deepEqual(missing, [], "Colour tokens defined for light must also be defined under [data-theme=\"dark\"].");
  for (const file of ["logo.svg", "logo-dark.svg", "logo-small.svg"]) readFileSync(join(workbench, "../../packages/ui/src", file), "utf8");
});
