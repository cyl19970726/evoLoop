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

// Type size, corner radius and line height are token classes (text-caption … text-title; rounded-sm/md/lg/xl/full;
// leading-(--leading-reading|body|tight)), never a bracket value, an arbitrary property, an inline style, a modifier
// such as text-small/6, or Tailwind's own scale beside the tokens (text-sm, rounded-2xl, leading-5, leading-tight …).
// The stylesheets of @evoloop/ui other than tokens.css use var(--…) for them. A literal that is truly needed goes in
// this list with its reason.
const typeExceptions: ReadonlyArray<{ file: string; literal: string; reason: string }> = [
  { file: "packages/ui/src/base.css", literal: "font-size: 1em",
    reason: "code, kbd, samp and pre keep the size of the text around them (browsers shrink monospace text by default); it is a reset, not a new size." },
];
const sizeNames = "caption|label|small|body|heading|title|xs|sm|base|lg|[2-9]?xl";
const typeLiteralPatterns: ReadonlyArray<[RegExp, string]> = [
  [/(?<![\w-])text-\[(?:length:)?[\d.]+[a-z%]*\]/g, "font size"],
  [/(?<![\w-])text-(?:xs|sm|base|lg|[2-9]?xl)(?![\w/-])/g, "font size outside the token scale"],
  [new RegExp(`(?<![\\w-])text-(?:${sizeNames})/[^\\s"'\`]+`, "g"), "line height through a font-size modifier"],
  [/\b(?:fontSize|lineHeight|borderRadius)[=:]\s*["'{]?\d/g, "inline type size, line height or radius"],
  [/\[(?:font-size|line-height|border(?:-[a-z]+)*-radius):/g, "arbitrary property for type size, line height or radius"],
  [/(?<![\w-])rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?-\[[^\]\s]*\]/g, "radius"],
  [/(?<![\w-])rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(?:-(?:xs|2xl|3xl|4xl))?(?![\w[(-])/g, "radius outside the token scale"],
  [/(?<![\w-])leading-\[[^\]\s]*\]/g, "line height"],
  [/(?<![\w-])leading-(?:none|tight|snug|normal|relaxed|loose|[\d.]+)(?![\w.-])/g, "line height outside the token scale"],
];
const cssTypeLiteral = /(?<![\w-])(?:font-size|line-height|border(?:-[a-z]+)*-radius)\s*:\s*(?!\s|var\(|inherit\b|0\s*[;}])[^;}]+/g;

test("type size, radius and line height come from tokens in the workbench and @evoloop/ui", () => {
  const found = [...files(source, /\.tsx?$/), ...files(ui, /\.tsx?$/)].flatMap(file => {
    const text = withoutComments(readFileSync(file, "utf8"));
    const name = relative(join(workbench, "../.."), file);
    return typeLiteralPatterns.flatMap(([pattern, kind]) => [...text.matchAll(pattern)].map(match => ({ file: name, literal: match[0], kind })));
  });
  for (const file of [...files(source, /\.css$/), ...files(ui, /\.css$/)].filter(file => !file.endsWith(join("ui", "src", "tokens.css")))) {
    const text = withoutComments(readFileSync(file, "utf8"));
    for (const match of text.matchAll(cssTypeLiteral)) found.push({ file: relative(join(workbench, "../.."), file), literal: match[0].trim(), kind: "stylesheet value" });
  }
  const offenders = found.filter(item => !typeExceptions.some(allowed => item.file.endsWith(allowed.file) && item.literal === allowed.literal))
    .map(item => `${item.file}: ${item.literal} (${item.kind})`);
  assert.deepEqual(offenders, [], "Use the token classes in docs/frontend/foundations.md; a new value needs a token in tokens.css first.");
  for (const allowed of typeExceptions) assert.ok(allowed.reason.length > 0, `${allowed.file} ${allowed.literal} needs a reason`);
});

// Controls come from @evoloop/ui (docs/frontend/components.md): Button/IconButton, Select, Checkbox, RadioGroup and
// ConfirmDialog (or shared/confirm.ts askConfirm before the design system has loaded). Native controls that stay are
// listed here, each with its reason and count.
const nativeControlExceptions: ReadonlyArray<{ file: string; control: string; count: number; reason: string }> = [
  { file: "app/entry/AuthGate.tsx", control: "<button", count: 2,
    reason: "The login page is the first load, which must not carry @evoloop/ui's Button (tailwind-merge and icons, bundle-budget.test.ts); its classes follow Button." },
  { file: "app/router.tsx", control: "<button", count: 1,
    reason: "The router's error page is in the first load and must render even when a page chunk failed; no design-system import." },
  { file: "app/PageBoundary.tsx", control: "<button", count: 1,
    reason: "The page error boundary wraps every page from the first load; same reason as the router's error page." },
];
// JSX and createElement (h) alike; confirm() is the browser's (bare or on window), not a method of the same name.
const nativeControls: ReadonlyArray<[string, RegExp]> = [
  ["<button", /<button\b|\b(?:h|createElement)\(\s*["']button["']/g],
  ["<select", /<select\b|\b(?:h|createElement)\(\s*["']select["']/g],
  ["checkbox or radio input", /type[=:]\s*["'{]*(?:checkbox|radio)\b/g],
  ["window.confirm", /(?<![\w$.])confirm\(|\b(?:window|globalThis|self)\.confirm\(/g],
];

test("native buttons, selects, checkboxes, radios and confirm() are gone from the workbench, except the listed few", () => {
  const counts = new Map<string, number>();
  for (const file of files(source, /\.tsx?$/)) {
    const text = withoutComments(readFileSync(file, "utf8"));
    for (const [control, pattern] of nativeControls) {
      const count = text.match(pattern)?.length ?? 0;
      if (count) counts.set(`${relative(source, file)} ${control}`, count);
    }
  }
  const allowed = new Map(nativeControlExceptions.map(item => [`${item.file} ${item.control}`, item.count]));
  const offenders = [...counts].filter(([key, count]) => count > (allowed.get(key) ?? 0)).map(([key, count]) => `${key} ×${count}`);
  assert.deepEqual(offenders, [], "Use Button, IconButton, Select, Checkbox, RadioGroup or ConfirmDialog from @evoloop/ui.");
  const stale = nativeControlExceptions.filter(item => (counts.get(`${item.file} ${item.control}`) ?? 0) < item.count).map(item => `${item.file} ${item.control}`);
  assert.deepEqual(stale, [], "An exception that is no longer needed is removed from the list.");
  for (const item of nativeControlExceptions) assert.ok(item.reason.length > 20, `${item.file} needs a reason`);
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
