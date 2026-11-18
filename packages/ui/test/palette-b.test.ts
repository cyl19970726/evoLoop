// Task a523f45e: palette B (chosen by the requirements Session on the report of Task 294a4d38). The values in tokens.css are measured against the palette before it, not eyeballed: surfaces and lines are
// further apart where B meant them to be and nowhere closer (but for the one allowed trade), warm and never pure white or black, no green, text at 4.5:1 everywhere, and what B must not touch — buttons, the
// brand, the done colour, the soft status fills, the accent — is exactly what it was. The component-level parts (notice bar, tab strip, flow links, the edge on the selected place) live in the component classes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");
const at = css.indexOf(':root[data-theme="dark"]');
const blocks = { light: css.slice(0, at), dark: css.slice(at) };
type Mode = "light" | "dark";
const token = (mode: Mode, name: string): string => {
  const match = blocks[mode].match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`)); assert.ok(match, `--${name} in ${mode}`); return match[1]!.toLowerCase();
};
const channel = (hex: string, i: number) => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
const ratio = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };
const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; if (d < 0.02) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360;
};

/** The palette before B (main at 94b93a89): [light, dark] of every token B changes. */
const before: Record<string, [string, string]> = {
  "surface-sunken": ["#efebe5", "#0c0b09"], "background": ["#fcfbf8", "#161412"], "surface-raised": ["#ffffff", "#24211f"], "surface-muted": ["#f5f2ed", "#1c1a18"],
  "surface-field": ["#e7e3dc", "#2a2725"], "surface-selected": ["#e3dcd3", "#322e2a"], "text-muted": ["#635d57", "#9f9a94"], "border": ["#e4dfd8", "#2a2826"],
  "border-strong": ["#d0c9c1", "#3e3b38"], "warning": ["#825805", "#e3b667"], "danger": ["#a3203a", "#ec8287"],
};
/** What B must not touch (DEC-051 buttons, the brand, done, the soft status fills, the accent, the text colours other than text-muted, the conversation and count colours). */
const untouched: Record<string, [string, string]> = {
  "text": ["#1c1714", "#eae7e3"], "text-secondary": ["#49423d", "#c0bbb6"], "on-accent": ["#ffffff", "#0f1216"], "accent": ["#2a52a8", "#90aef3"], "accent-strong": ["#1b4090", "#b2c9fb"], "accent-soft": ["#e5edfc", "#222d47"],
  "warning-soft": ["#fceed1", "#362913"], "danger-soft": ["#fde9e9", "#3f1e20"], "done": ["#72487c", "#c99dd3"], "done-soft": ["#f5eaf7", "#332337"],
  "brand": ["#b1582b", "#e18c5f"], "on-brand": ["#ffffff", "#15110d"], "brand-soft": ["#f6e6dc", "#3a2518"], "on-brand-soft": ["#8f431d", "#f0a77f"], "brand-hover": ["#9c4a22", "#ea9a70"],
  "brand-pressed": ["#8a3f1b", "#f0a984"], "brand-soft-hover": ["#f0d9ca", "#46301f"], "brand-soft-pressed": ["#e9ccb9", "#523a27"],
  "user-bubble": ["#1c1714", "#393633"], "on-user-bubble": ["#fcfbf8", "#eae7e3"], "count-bg": ["#1c1714", "#eae7e3"], "count-fg": ["#fcfbf8", "#161412"],
};
const tokensOf = (mode: Mode, overrides: Record<string, [string, string]> = {}) => {
  const names = ["surface-sunken", "background", "surface-raised", "surface-muted", "surface-field", "surface-selected", "text", "text-secondary", "text-muted", "border", "border-strong", "accent", "accent-strong", "accent-soft", "warning", "warning-soft", "danger", "danger-soft", "done", "done-soft", "brand", "on-brand", "brand-hover", "brand-pressed", "brand-soft", "on-brand-soft", "brand-soft-hover", "brand-soft-pressed"];
  return Object.fromEntries(names.map(name => [name, overrides[name] ? overrides[name]![mode === "light" ? 0 : 1] : token(mode, name)])) as Record<string, string>;
};
const was = (mode: Mode) => tokensOf(mode, { ...before, ...untouched });
const now = (mode: Mode) => tokensOf(mode);
const modes: Mode[] = ["light", "dark"];

test("what B must not touch is exactly what it was; what it changes is only the tokens of the report's table", () => {
  for (const mode of modes) for (const [name, pair] of Object.entries(untouched)) assert.equal(token(mode, name), pair[mode === "light" ? 0 : 1], `${mode} --${name}`);
  // Light surface-raised, light danger and dark warning are the entries B leaves alone, as the report's table says (＝); every other entry changes in both modes.
  const same = new Set(["light surface-raised", "light danger", "dark warning"]);
  for (const mode of modes) for (const [name, pair] of Object.entries(before)) assert.equal(token(mode, name) === pair[mode === "light" ? 0 : 1], same.has(`${mode} ${name}`), `${mode} --${name}`);
});

test("B's values are the report's: every changed token, light and dark", () => {
  const spec: Record<string, [string, string]> = { "surface-sunken": ["#e4ded4", "#090807"], "background": ["#faf8f3", "#171513"], "surface-raised": ["#ffffff", "#2f2c28"], "surface-muted": ["#eee9e0", "#232019"],
    "surface-field": ["#e1dbd0", "#363330"], "surface-selected": ["#dcd4c8", "#3c3833"], "text-muted": ["#5b554f", "#b0aba5"], "border": ["#d2cbc0", "#3d3a35"], "border-strong": ["#bbb1a4", "#55514b"],
    "warning": ["#775000", "#e3b667"], "danger": ["#a3203a", "#f08e92"] };
  for (const mode of modes) for (const [name, pair] of Object.entries(spec)) assert.equal(token(mode, name), pair[mode === "light" ? 0 : 1], `${mode} --${name}`);
});

test("every text colour reaches 4.5:1 on every surface it is drawn on, and no status pill loses contrast", () => {
  const surfaces = ["surface-sunken", "background", "surface-raised", "surface-muted", "surface-field", "surface-selected"];
  const pairs: Array<[string, string]> = [];
  for (const text of ["text", "text-secondary", "text-muted"]) for (const surface of surfaces) pairs.push([text, surface]);
  for (const role of ["accent", "accent-strong", "warning", "danger", "done"]) for (const surface of surfaces) pairs.push([role, surface]);
  pairs.push(["accent", "accent-soft"], ["accent-strong", "accent-soft"], ["warning", "warning-soft"], ["danger", "danger-soft"], ["done", "done-soft"], ["on-brand", "brand"], ["on-brand-soft", "brand-soft"],
    ["on-brand", "brand-hover"], ["on-brand", "brand-pressed"], ["on-brand-soft", "brand-soft-hover"], ["on-brand-soft", "brand-soft-pressed"], ["text", "accent-soft"], ["text-secondary", "accent-soft"],
    ["text-muted", "accent-soft"], ["warning", "accent-soft"], ["danger", "accent-soft"], ["done", "accent-soft"], ["text", "warning-soft"], ["text", "danger-soft"], ["text", "done-soft"],
    ["text-secondary", "warning-soft"], ["text-secondary", "danger-soft"], ["text-muted", "surface-selected"]);
  let lowest = { value: 99, label: "" };
  for (const mode of modes) for (const [text, surface] of pairs) {
    const value = ratio(now(mode)[text]!, now(mode)[surface]!);
    if (value < lowest.value) lowest = { value, label: `${mode} ${text} on ${surface}` };
    assert.ok(value >= 4.5, `${mode} ${text} on ${surface}: ${value.toFixed(2)}`);
    if (/-soft$/.test(surface)) assert.ok(value >= ratio(was(mode)[text]!, was(mode)[surface]!) - 0.005, `${mode} ${text} on ${surface} is not lower than before`);
  }
  console.log(`lowest text contrast ${lowest.value.toFixed(2)}:1 (${lowest.label}) over ${pairs.length * 2} combinations`);
});

test("no pair of surfaces ends up closer together than before, but for the one trade B makes (selected row on a darker panel, made up by the edge)", () => {
  const pairs: Array<[string, string]> = [["surface-raised", "background"], ["surface-muted", "background"], ["background", "surface-sunken"], ["surface-raised", "surface-sunken"], ["surface-field", "background"],
    ["accent-soft", "background"], ["border", "background"], ["border", "surface-sunken"], ["border-strong", "surface-sunken"]];
  for (const mode of modes) for (const [front, back] of pairs) {
    const before_ = ratio(was(mode)[front]!, was(mode)[back]!), after = ratio(now(mode)[front]!, now(mode)[back]!);
    const trade = front === "accent-soft" && back === "background";   // light 1.14 → 1.11, dark 1.34 → 1.33, as the report says
    assert.ok(after >= before_ - 0.005 || trade, `${mode} ${front}/${back}: ${before_.toFixed(2)} → ${after.toFixed(2)}`);
  }
  // The tab strip: the selected tab (accent-soft) against its track is further apart than against the old field grey.
  for (const mode of modes) {
    const trackNow = mode === "light" ? token("light", "surface-selected") : token("dark", "surface-sunken"), trackWas = was(mode)["surface-field"]!;
    assert.ok(ratio(now(mode)["accent-soft"]!, trackNow) > ratio(was(mode)["accent-soft"]!, trackWas), `${mode} selected tab / track`);
  }
  assert.ok(ratio(token("light", "surface-raised"), token("light", "background")) >= 1.06 - 0.005, "light cards lift from the panel (1.03 → 1.06)");
});

test("warm surfaces, no pure white or black panels, no green, and an adjusted role colour keeps its hue", () => {
  for (const mode of modes) {
    for (const name of ["surface-sunken", "background", "surface-muted", "surface-field", "surface-selected"]) {
      const hex = token(mode, name); assert.notEqual(hex, "#ffffff"); assert.notEqual(hex, "#000000");
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      assert.ok(r >= g && g >= b, `${mode} --${name} ${hex} keeps the warm order r ≥ g ≥ b`);
    }
    for (const name of Object.keys(before)) { const h = hue(token(mode, name)); assert.ok(h === null || h < 90 || h > 160, `${mode} --${name} is not green`); }
    for (const name of ["warning", "danger"]) assert.ok(Math.abs(hue(was(mode)[name]!)! - hue(now(mode)[name]!)!) < 6, `${mode} --${name} keeps its hue`);
  }
  assert.notEqual(token("dark", "surface-raised"), "#ffffff", "the one big white surface is the light card, as before");
});

const source = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
test("the component parts are in the component classes, not in a separate sheet", () => {
  assert.match(source("packages/ui/src/components/status.tsx"), /info: "bg-muted text-foreground shadow-\[inset_3px_0_0_var\(--accent\)\]"/, "the blue notice: a soft block with a 3px blue edge");
  const tabs = source("packages/ui/src/components/overlays.tsx");
  assert.match(tabs, /rounded-full bg-tab-track p-1/, "the tab strip rests on the track"); assert.match(tabs, /data-\[state=active\]:shadow-\[inset_0_0_0_1px_color-mix\(in_srgb,var\(--accent\)_55%,transparent\)\]/, "the selected tab carries a thin ring");
  assert.match(source("packages/ui/src/tokens.css"), /--tab-track: var\(--surface-selected\)/); assert.match(source("packages/ui/src/tokens.css"), /--tab-track: var\(--surface-sunken\)/);
  assert.match(source("packages/ui/src/theme.css"), /@utility selected-edge[\s\S]*aria-current="page"[\s\S]*inset 3px 0 0 var\(--accent\)/, "the 3px edge on the selected place");
  assert.match(source("apps/workbench/src/features/sessions/flow/FlowView.tsx"), /stroke="var\(--border-strong\)" strokeWidth=\{1\.5\}/, "the flow links: 1.5px border-strong");
  assert.match(source("packages/ui/src/components/button.tsx"), /row: "selected-edge /); assert.match(source("packages/ui/src/components/list.tsx"), /"selected-edge flex w-full/);
  for (const path of ["packages/ui/src/theme.css", "packages/ui/src/base.css"]) assert.doesNotMatch(source(path), /palette-proposals|\[role="status"\]\.bg-accent/, `${path} carries no proposal override`);
});
