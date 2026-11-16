#!/usr/bin/env node
// Prints the token revision table and the separation readings of the palette proposals as Markdown (task 294a4d38):  node scripts/frontend/palette-measure.mjs
import { applied, base, proposalOverrides, ratio, separations, textContrast } from "./palette-lib.mjs";

const variants = { current: applied("current"), a: applied("a"), b: applied("b") };
const names = ["a", "b"];
console.log("## Token 修订表（旧值 → 方案 A / 方案 B；只列有改动的 token）\n");
console.log("| token | 浅色 旧 | 浅色 A | 浅色 B | 深色 旧 | 深色 A | 深色 B |\n|---|---|---|---|---|---|---|");
const changed = new Set(names.flatMap(n => ["light", "dark"].flatMap(mode => Object.keys(proposalOverrides(n)[mode]))));
const order = Object.keys(base().light);
for (const token of order.filter(t => changed.has(t))) {
  const cell = (mode, v) => variants[v][mode][token] ?? "—";
  const mark = (mode, v) => cell(mode, v) === cell(mode, "current") ? "＝" : cell(mode, v);
  console.log(`| \`${token}\` | ${cell("light", "current")} | ${mark("light", "a")} | ${mark("light", "b")} | ${cell("dark", "current")} | ${mark("dark", "a")} | ${mark("dark", "b")} |`);
}
console.log("\n## 关键表面对的分离读数（亮度比，不是文字对比度）\n");
console.log("| 表面对 | 浅色 现状 | 浅色 A | 浅色 B | 深色 现状 | 深色 A | 深色 B |\n|---|---|---|---|---|---|---|");
for (const [front, back, what] of separations) {
  const row = mode => ["current", "a", "b"].map(v => ratio(variants[v][mode][front], variants[v][mode][back]).toFixed(2));
  console.log(`| ${what}（${front} / ${back}） | ${row("light").join(" | ")} | ${row("dark").join(" | ")} |`);
}
console.log("\n## 文字对比度（所有文字色在所有它出现的表面上，WCAG）\n");
console.log("| 变体 | 组合数 | 最低 | 最低出现在 | 低于 4.5 的 |\n|---|---|---|---|---|");
for (const v of ["current", "a", "b"]) {
  const all = textContrast(variants[v]), low = all.reduce((m, x) => x.ratio < m.ratio ? x : m);
  console.log(`| ${v} | ${all.length} | ${low.ratio.toFixed(2)} | ${low.mode} ${low.text} 在 ${low.surface} | ${all.filter(x => x.ratio < 4.5).length} |`);
}
