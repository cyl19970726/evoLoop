// Measurement for the palette proposals (task 294a4d38): reads tokens.css and a proposal sheet, applies the sheet's token overrides, and computes (a) the luminance
// ratio of the surface pairs the report is about and (b) the WCAG contrast of every text colour on every surface it is drawn on. Same pairs as packages/ui/test/palette.test.ts.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
export const read = relative => readFileSync(join(repo, relative), "utf8");

const hexValues = text => Object.fromEntries([...text.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map(match => [match[1], match[2].toLowerCase()]));
/** `{ light, dark }` token values of a stylesheet: the plain `:root` block and the `:root[data-theme="dark"]` block. */
export function tokensOf(css) {
  const darkAt = css.indexOf(':root[data-theme="dark"]');
  return darkAt < 0 ? { light: hexValues(css), dark: {} } : { light: hexValues(css.slice(0, darkAt)), dark: hexValues(css.slice(darkAt)) };
}
export const base = () => tokensOf(read("packages/ui/src/tokens.css"));
export const proposalOverrides = name => tokensOf(read(`scripts/frontend/palette-proposals/${name}.css`));
/** The token values with a proposal applied; `tab-track` is the fill behind the tab strip (today the field grey; the proposals give it their own, see the sheets). */
export const applied = name => {
  const over = name === "current" ? { light: {}, dark: {} } : proposalOverrides(name), b = base();
  const merged = { light: { ...b.light, ...over.light }, dark: { ...b.dark, ...over.dark } };
  for (const mode of ["light", "dark"]) merged[mode]["tab-track"] = name === "current" ? merged[mode]["surface-field"] : merged[mode][mode === "light" ? "surface-selected" : "surface-sunken"];
  return merged;
};

const channel = (hex, at) => { const v = parseInt(hex.slice(at, at + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export const luminance = hex => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
export const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

/** The surface pairs the report is about: [front, back, what it is]. */
export const separations = [
  ["surface-raised", "background", "卡片 / 面板"], ["surface-muted", "background", "柔底块 / 面板"], ["background", "surface-sunken", "面板 / 侧栏底"],
  ["surface-raised", "surface-sunken", "动态图节点 / 画布"], ["surface-field", "background", "输入底 / 面板"], ["accent-soft", "tab-track", "选中页签 / 页签条"],
  ["accent-soft", "background", "选中行 / 面板"], ["border", "background", "边线 / 面板"], ["border", "surface-sunken", "边线 / 侧栏底"], ["border-strong", "surface-sunken", "动态图连线 / 画布"],
];

const surfaces = ["surface-sunken", "background", "surface-raised", "surface-muted", "surface-field", "surface-selected"];
export const textPairs = [];
for (const text of ["text", "text-secondary", "text-muted"]) for (const surface of surfaces) textPairs.push([text, surface]);
for (const role of ["accent", "accent-strong", "warning", "danger", "done"]) for (const surface of surfaces) textPairs.push([role, surface]);
textPairs.push(["accent", "accent-soft"], ["accent-strong", "accent-soft"], ["warning", "warning-soft"], ["danger", "danger-soft"], ["done", "done-soft"], ["on-brand", "brand"],
  ["on-brand-soft", "brand-soft"], ["on-brand", "brand-hover"], ["on-brand", "brand-pressed"], ["on-brand-soft", "brand-soft-hover"], ["on-brand-soft", "brand-soft-pressed"],
  ["text", "accent-soft"], ["text-secondary", "accent-soft"], ["text-muted", "accent-soft"], ["warning", "accent-soft"], ["danger", "accent-soft"], ["done", "accent-soft"],
  ["text", "warning-soft"], ["text", "danger-soft"], ["text", "done-soft"], ["text-secondary", "warning-soft"], ["text-secondary", "danger-soft"], ["text-muted", "surface-selected"]);

/** Every text pair of a token set, per mode, with its contrast. */
export const textContrast = tokens => ["light", "dark"].flatMap(mode => textPairs.map(([text, surface]) => ({ mode, text, surface, ratio: ratio(tokens[mode][text], tokens[mode][surface]) })));
