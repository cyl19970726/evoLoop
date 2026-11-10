// Colour, type and spacing come from @evoloop/ui tokens (docs/frontend/foundations.md). Since #229 PR10 these are fixed
// rules rather than a shrinking budget: the workbench has one stylesheet, the Tailwind entry, with no rules of its own;
// colour literals exist only in packages/ui/src/tokens.css (and the avatar illustrations, which foundations.md keeps in
// avatar.tsx); and no old markup marker (`data-legacy`) is left.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const workbench = join(import.meta.dirname, "..");
const source = join(workbench, "src");
const ui = join(workbench, "../../packages/ui/src");

function files(dir: string, extension: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, extension);
    return extension.test(name) ? [path] : [];
  });
}
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const colourLiteral = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(/g;
const literals = (file: string) => withoutComments(readFileSync(file, "utf8")).match(colourLiteral)?.length ?? 0;

test("the workbench has one stylesheet, the Tailwind entry, and it holds no rules", () => {
  assert.deepEqual(files(source, /\.css$/).map(file => relative(source, file)), ["main.css"],
    "Style pages with utilities on @evoloop/ui tokens; element defaults belong in packages/ui/src/base.css.");
  const statements = withoutComments(readFileSync(join(source, "main.css"), "utf8")).split(";").map(part => part.trim()).filter(Boolean);
  const rules = statements.filter(statement => !/^@(layer|import|source|plugin|custom-variant)\s[^{}]*$/.test(statement));
  assert.deepEqual(rules, [], "main.css only imports and configures; it defines no selectors.");
});

test("colour literals appear only in packages/ui/src/tokens.css", () => {
  const offenders = [...files(source, /\.(css|tsx?)$/), ...files(ui, /\.(css|tsx?)$/)]
    .filter(file => !file.endsWith(join("ui", "src", "tokens.css")) && !file.endsWith(join("components", "avatar.tsx")))
    .map(file => [relative(join(workbench, "../.."), file), literals(file)] as const)
    .filter(([, count]) => count > 0);
  assert.deepEqual(offenders, [], "Use a token (packages/ui/src/tokens.css) instead of a colour literal.");
  assert.ok(literals(join(ui, "tokens.css")) > 0, "the token file is where the colour values live");
});

test("no old markup marker is left: no data-legacy region and no Legacy wrapper", () => {
  const offenders = [...files(source, /\.(css|tsx?)$/), ...files(ui, /\.(css|tsx?)$/)]
    .filter(file => /data-legacy|<Legacy\b/.test(readFileSync(file, "utf8")))
    .map(file => relative(join(workbench, "../.."), file));
  assert.deepEqual(offenders, [], "Every page is drawn on @evoloop/ui; old markup regions were removed in #229 PR10.");
});

test("the design tokens named in docs/frontend/foundations.md exist in @evoloop/ui", () => {
  const tokens = readFileSync(join(ui, "tokens.css"), "utf8");
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
  const tokens = readFileSync(join(ui, "tokens.css"), "utf8");
  const [light, dark] = [/:root \{([\s\S]*?)\n\}/, /:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/].map(pattern => tokens.match(pattern)?.[1] ?? "");
  const colourNames = (block: string) => [...block.matchAll(/(--[a-z][\w-]*)\s*:\s*(#[0-9a-f]{3,8}|rgb\()/g)].map(match => match[1]);
  const missing = colourNames(light).filter(name => !dark.includes(`${name}:`));
  assert.deepEqual(missing, [], "Colour tokens defined for light must also be defined under [data-theme=\"dark\"].");
  for (const file of ["logo.svg", "logo-dark.svg", "logo-small.svg"]) readFileSync(join(ui, file), "utf8");
});
