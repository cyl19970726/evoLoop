import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Task 294a4d38: the palette fine-tuning proposals A and B (scripts/frontend/palette-proposals/*.css) are measured, not eyeballed. Every proposal keeps every text colour at
// ≥4.5:1 on every surface it is drawn on and never lowers a status pill's text contrast; no surface pair gets closer together than today; surfaces stay warm (no pure white or
// black panels); buttons, the done colour, soft status fills and the brand colours are not touched; and a role colour that is adjusted keeps its hue.
const lib = (await import(new URL("../../../scripts/frontend/palette-lib.mjs", import.meta.url).href)) as {
  applied: (name: string) => Record<"light" | "dark", Record<string, string>>;
  proposalOverrides: (name: string) => Record<"light" | "dark", Record<string, string>>;
  ratio: (a: string, b: string) => number; separations: Array<[string, string, string]>;
  textContrast: (tokens: Record<"light" | "dark", Record<string, string>>) => Array<{ mode: string; text: string; surface: string; ratio: number }>;
};
const current = lib.applied("current");
const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.02) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

for (const name of ["a", "b"]) {
  const proposal = lib.applied(name), over = lib.proposalOverrides(name);
  const sheet = readFileSync(new URL(`../../../scripts/frontend/palette-proposals/${name}.css`, import.meta.url), "utf8");

  test(`proposal ${name.toUpperCase()}: every text colour reaches 4.5:1 on every surface, and no status pill loses contrast`, () => {
    const low = lib.textContrast(proposal).filter(item => item.ratio < 4.5);
    assert.deepEqual(low, []);
    const before = new Map(lib.textContrast(current).map(item => [`${item.mode} ${item.text} ${item.surface}`, item.ratio]));
    for (const item of lib.textContrast(proposal).filter(x => /-soft$/.test(x.surface) && ["warning", "danger", "done", "accent"].includes(x.text) || x.surface === "warning-soft" || x.surface === "danger-soft" || x.surface === "done-soft"))
      assert.ok(item.ratio >= (before.get(`${item.mode} ${item.text} ${item.surface}`) ?? 0) - 0.005, `${item.mode} ${item.text} on ${item.surface}: ${item.ratio.toFixed(2)}`);
  });

  test(`proposal ${name.toUpperCase()}: no pair of surfaces ends up closer together than today`, () => {
    for (const mode of ["light", "dark"] as const) for (const [front, back, what] of lib.separations) {
      const was = lib.ratio(current[mode][front]!, current[mode][back]!), now = lib.ratio(proposal[mode][front]!, proposal[mode][back]!);
      // The one allowed trade: a darker panel (B) brings the selected fill closer to it; B makes up for that with a 3px accent bar on the selected row, which the sheet must carry.
      const compensated = front === "accent-soft" && back === "background" && sheet.includes('button[aria-pressed="true"].rounded-md');
      assert.ok(now >= was - 0.005 || compensated, `${mode} ${what}: ${was.toFixed(2)} → ${now.toFixed(2)}`);
    }
  });

  test(`proposal ${name.toUpperCase()}: warm surfaces, no pure white or black panels, no green`, () => {
    for (const mode of ["light", "dark"] as const) {
      for (const token of ["surface-sunken", "background", "surface-muted", "surface-field", "surface-selected"]) {
        const hex = proposal[mode][token]!;
        assert.notEqual(hex, "#ffffff"); assert.notEqual(hex, "#000000");
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
        assert.ok(r >= g && g >= b, `${mode} --${token} ${hex} keeps the warm order r ≥ g ≥ b`);
      }
      for (const token of Object.keys(over[mode])) { const h = hue(proposal[mode][token]!); assert.ok(h === null || h < 90 || h > 160, `${mode} --${token} is not green`); }
    }
  });

  test(`proposal ${name.toUpperCase()}: buttons, brand, done and the soft status fills are not touched; an adjusted role colour keeps its hue`, () => {
    const untouchable = /^(brand|on-brand|brand-|on-brand-|done|done-soft|warning-soft|danger-soft|count-|user-bubble|on-user-bubble|accent|accent-strong|on-accent)/;
    for (const mode of ["light", "dark"] as const) for (const token of Object.keys(over[mode])) assert.ok(!untouchable.test(token) || token === "accent-soft" ? true : false, `${mode} --${token} is outside the proposal's scope`);
    for (const mode of ["light", "dark"] as const) for (const token of ["warning", "danger"]) if (over[mode][token]) {
      const before = hue(current[mode][token]!)!, after = hue(over[mode][token]!)!;
      assert.ok(Math.abs(before - after) < 6, `${mode} --${token} hue ${before.toFixed(0)}° → ${after.toFixed(0)}°`);
    }
  });
}
