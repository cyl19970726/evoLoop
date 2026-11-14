import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// DEC-049: light "xuan paper" and dark "pine soot". The values below are section 3 of the colour specification
// (process Document 8a853985, revision bf9f93e5, hash 1e91efbf); tokens.css must match them exactly, and every text colour must reach 4.5:1
// on every surface it is drawn on (WCAG AA, small text). Both checks read tokens.css itself, so a changed token fails here in CI.
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
  ["surface-sunken", "#efebe5", "#0c0b09"],
  ["background", "#fcfbf8", "#161412"],
  ["surface-raised", "#ffffff", "#24211f"],
  ["surface-muted", "#f5f2ed", "#1c1a18"],
  ["surface-field", "#e7e3dc", "#2a2725"],
  ["surface-selected", "#e3dcd3", "#322e2a"],
  ["text", "#1c1714", "#eae7e3"],
  ["text-secondary", "#49423d", "#c0bbb6"],
  ["text-muted", "#635d57", "#9f9a94"],
  ["border", "#e4dfd8", "#2a2826"],
  ["border-strong", "#d0c9c1", "#3e3b38"],
  ["accent", "#2a52a8", "#90aef3"],
  ["accent-strong", "#1b4090", "#b2c9fb"],
  ["accent-soft", "#e5edfc", "#222d47"],
  ["on-accent", "#ffffff", "#0f1216"],
  ["warning", "#906106", "#e3b667"],
  ["warning-soft", "#fceed1", "#362913"],
  ["danger", "#a3203a", "#ec8287"],
  ["danger-soft", "#fde9e9", "#3f1e20"],
  ["done", "#72487c", "#c99dd3"],
  ["done-soft", "#f5eaf7", "#332337"],
  ["brand", "#b1582b", "#e18c5f"],
  ["on-brand", "#ffffff", "#15110d"],
  ["user-bubble", "#1c1714", "#393633"],
  ["on-user-bubble", "#fcfbf8", "#eae7e3"],
  ["count-bg", "#1c1714", "#eae7e3"],
  ["count-fg", "#fcfbf8", "#161412"],
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

// Every text colour with every surface it is drawn on. Neutral text goes on all six surfaces; role colours on the plain surfaces and their own soft fill.
const surfaces = ["surface-sunken", "background", "surface-raised", "surface-muted", "surface-field", "surface-selected"];
const pairs: Array<[string, string]> = [];
for (const text of ["text", "text-secondary", "text-muted"]) for (const surface of surfaces) pairs.push([text, surface]);
for (const role of ["accent", "accent-strong", "warning", "danger", "done"]) for (const surface of ["background", "surface-raised", "surface-muted"]) pairs.push([role, surface]);
pairs.push(["accent", "accent-soft"], ["accent-strong", "accent-soft"], ["warning", "warning-soft"], ["danger", "danger-soft"], ["done", "done-soft"],
  ["on-accent", "accent"], ["on-brand", "brand"], ["on-user-bubble", "user-bubble"], ["count-fg", "count-bg"],
  ["text", "accent-soft"], ["text", "warning-soft"], ["text", "danger-soft"], ["text", "done-soft"], ["text-secondary", "warning-soft"], ["text-secondary", "danger-soft"],
  ["text-muted", "surface-selected"]);

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

test("no green status colour: no role colour has a hue between 90 and 160 degrees", () => {
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.04) return null;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const mode of ["light", "dark"] as const) for (const name of ["accent", "accent-strong", "warning", "danger", "done", "brand"]) {
    const h = hue(valueOf(mode, name));
    assert.ok(h === null || h < 90 || h > 160, `${mode} --${name} is green-ish (hue ${h?.toFixed(0)})`);
  }
});

test("the failure colour and the count dot are different colours, and the count dot is not the brand colour", () => {
  for (const mode of ["light", "dark"] as const) {
    assert.notEqual(valueOf(mode, "count-bg"), valueOf(mode, "danger"));
    assert.notEqual(valueOf(mode, "count-bg"), valueOf(mode, "brand"));
    assert.notEqual(valueOf(mode, "done"), valueOf(mode, "danger"));
  }
});
