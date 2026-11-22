import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The design language of 2026-11-22 (process Document 71eed733, revision 38872c80, section two: neutral grey with ink green). tokens.css must hold these values exactly,
// and every text colour must reach 4.5:1 on every surface it is drawn on (WCAG AA, small text). Both checks read tokens.css itself, so a changed token fails here in CI.
const tokensPath = join(dirname(fileURLToPath(import.meta.url)), "../src/tokens.css");
const css = readFileSync(tokensPath, "utf8");
const darkAt = css.indexOf(':root[data-theme="dark"]');
const blocks = { light: css.slice(0, darkAt), dark: css.slice(darkAt) };

function valueOf(mode: "light" | "dark", name: string): string {
  const match = blocks[mode].match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\b`));
  assert.ok(match, `--${name} has no hex value in the ${mode} block`);
  const hex = match[1]!.toLowerCase();
  return hex.length === 4 ? `#${[...hex.slice(1)].map(c => c + c).join("")}` : hex;
}

const specification: Array<[string, string, string]> = [
  ["surface-sunken", "#f4f4f3", "#1a1a1a"],
  ["background", "#ffffff", "#212121"],
  ["surface-raised", "#ffffff", "#282828"],
  ["surface-muted", "#f7f7f6", "#252525"],
  ["surface-field", "#f2f2f1", "#282828"],
  ["surface-selected", "#ececea", "#333333"],
  ["selected-on-shell", "#e4e4e2", "#333333"],
  ["border", "#e6e6e4", "#343434"],
  ["border-strong", "#d0d0cd", "#474747"],
  ["text", "#171717", "#e8e8e8"],
  ["text-secondary", "#525252", "#adadad"],
  ["text-muted", "#666666", "#9c9c9c"],
  ["accent", "#0b6b52", "#6fd3ae"],
  ["accent-strong", "#095843", "#8fe0c2"],
  ["accent-soft", "#ececea", "#333333"],
  ["on-accent", "#ffffff", "#0c1a15"],
  ["running", "#2456c8", "#8fb0ff"],
  ["warning", "#775000", "#e3b667"],
  ["warning-soft", "#fceed1", "#2e2413"],
  ["danger", "#a3203a", "#f08e92"],
  ["danger-soft", "#fde9e9", "#351b1d"],
  ["done", "#525252", "#adadad"],
  ["done-soft", "#f2f2f1", "#282828"],
  ["brand", "#0f6b53", "#5cc9a3"],
  ["on-brand", "#ffffff", "#0c1a15"],
  ["brand-hover", "#0c5c47", "#72d3b1"],
  ["brand-pressed", "#0a4d3c", "#88dcbf"],
  ["brand-soft", "#ffffff", "#282828"],
  ["on-brand-soft", "#171717", "#e8e8e8"],
  ["brand-soft-hover", "#f2f2f1", "#333333"],
  ["brand-soft-pressed", "#ececea", "#3d3d3d"],
  ["logo", "#2a52a8", "#90aef3"],
  ["on-logo", "#ffffff", "#0f1216"],
  ["user-bubble", "#ececea", "#333333"],
  ["on-user-bubble", "#171717", "#e8e8e8"],
  ["count-bg", "#171717", "#e8e8e8"],
  ["count-fg", "#ffffff", "#212121"],
];

test("tokens.css holds the specified light and dark value of every colour token", () => {
  const diff: string[] = [];
  for (const [name, light, dark] of specification) {
    for (const [mode, want] of [["light", light], ["dark", dark]] as const) {
      const got = valueOf(mode, name);
      console.log(`${got === want ? "ok  " : "DIFF"} ${mode.padEnd(5)} --${name.padEnd(17)} ${got} ${got === want ? "=" : "!="} ${want}`);
      if (got !== want) diff.push(`${mode} --${name}: ${got}, specified ${want}`);
    }
  }
  assert.deepEqual(diff, []);
});

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// Every text colour with every surface it is drawn on. Neutral text and role colours go on all surfaces, the selected fills included.
const surfaces = ["surface-sunken", "background", "surface-raised", "surface-muted", "surface-field", "surface-selected", "selected-on-shell"];
const pairs: Array<[string, string]> = [];
for (const text of ["text", "text-secondary", "text-muted"]) for (const surface of surfaces) pairs.push([text, surface]);
for (const role of ["accent", "accent-strong", "running", "warning", "danger", "done"]) for (const surface of surfaces) pairs.push([role, surface]);
pairs.push(["warning", "warning-soft"], ["danger", "danger-soft"], ["done", "done-soft"], ["text", "warning-soft"], ["text", "danger-soft"], ["text-secondary", "warning-soft"], ["text-secondary", "danger-soft"],
  ["on-accent", "accent"], ["on-brand", "brand"], ["on-brand", "brand-hover"], ["on-brand", "brand-pressed"], ["on-user-bubble", "user-bubble"], ["count-fg", "count-bg"], ["on-logo", "logo"],
  ["on-brand-soft", "brand-soft"], ["on-brand-soft", "brand-soft-hover"], ["on-brand-soft", "brand-soft-pressed"],
  ["text", "accent-soft"], ["text-secondary", "accent-soft"], ["text-muted", "accent-soft"], ["accent", "accent-soft"]);

test("every text colour reaches 4.5:1 on its background, in both modes", () => {
  const low: string[] = [];
  let lowest = { ratio: Infinity, label: "" };
  for (const mode of ["light", "dark"] as const) {
    for (const [text, surface] of pairs) {
      const ratio = contrast(valueOf(mode, text), valueOf(mode, surface));
      if (ratio < lowest.ratio) lowest = { ratio, label: `${mode} --${text} on --${surface}` };
      if (ratio < 4.5) low.push(`${mode} --${text} on --${surface}: ${ratio.toFixed(2)}`);
    }
  }
  console.log(`checked ${pairs.length * 2} combinations; lowest ${lowest.ratio.toFixed(2)} (${lowest.label})`);
  assert.deepEqual(low, []);
});

test("green is for links, focus and the primary button only: running, done, warning and danger are not green, and done is a neutral grey", () => {
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.04) return null;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const mode of ["light", "dark"] as const) {
    for (const name of ["running", "warning", "danger", "logo"]) {
      const h = hue(valueOf(mode, name));
      assert.ok(h === null || h < 90 || h > 160, `${mode} --${name} is green-ish (hue ${h?.toFixed(0)})`);
    }
    assert.equal(hue(valueOf(mode, "done")), null, `${mode} --done is a neutral grey`);
    assert.notEqual(valueOf(mode, "running"), valueOf(mode, "accent"), `${mode} running blue is not the link green`);
    for (const name of ["surface-sunken", "background", "surface-raised", "surface-selected", "border", "text"]) assert.equal(hue(valueOf(mode, name)), null, `${mode} --${name} is a neutral grey`);
  }
});

test("the shapes: two radii (6 for containers, 4 for controls), no shadow but on floating layers, no edge bar and no pill in the components", () => {
  const read = (path: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), path), "utf8");
  const radii = Object.fromEntries(["inline", "control", "card", "panel", "pill"].map(name => [name, css.match(new RegExp(`--radius-${name}:\\s*(\\d+)px`))?.[1]]));
  assert.deepEqual(radii, { inline: "4", control: "4", card: "6", panel: "6", pill: "4" });
  assert.match(css, /--shadow-panel: 0 0 #0000/); assert.match(css, /--shadow-control: 0 0 #0000/);
  const theme = read("../src/theme.css");
  assert.doesNotMatch(theme, /inset 3px/, "the selected place has no edge bar"); assert.doesNotMatch(theme, /selected-edge/);
  const button = read("../src/components/button.tsx");
  assert.doesNotMatch(button, /rounded-full/, "buttons are not pills"); assert.doesNotMatch(button, /color-mix/, "a selected tab has no accent outline");
  assert.match(button, /bg-brand text-on-brand/); assert.match(button, /secondary: "bg-brand-soft text-on-brand-soft shadow-\[inset_0_0_0_1px_var\(--border-strong\)\]/);
  assert.doesNotMatch(read("../src/components/status.tsx"), /rounded-full px-2\.5/, "a status is not a capsule");
  assert.match(theme, /@utility selected-mark[\s\S]*font-weight: 600/, "a selected row is a neutral fill with heavier text");
});

test("hover and pressed are solid fills, not opacity, on the primary and secondary button", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/components/button.tsx"), "utf8");
  const line = (variant: string) => source.split("\n").find(l => l.trim().startsWith(`${variant}:`)) ?? "";
  for (const variant of ["primary", "secondary"]) {
    assert.match(line(variant), /hover:bg-/, `${variant} has a solid hover fill`);
    assert.match(line(variant), /active:bg-/, `${variant} has a solid pressed fill`);
    assert.doesNotMatch(line(variant), /opacity/, `${variant} does not use opacity for hover or pressed`);
  }
});

test("the failure colour and the count dot are different colours, and the count dot is not the brand colour", () => {
  for (const mode of ["light", "dark"] as const) {
    assert.notEqual(valueOf(mode, "count-bg"), valueOf(mode, "danger"));
    assert.notEqual(valueOf(mode, "count-bg"), valueOf(mode, "brand"));
    assert.notEqual(valueOf(mode, "done"), valueOf(mode, "danger"));
  }
});
