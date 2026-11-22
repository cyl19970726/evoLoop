#!/usr/bin/env node
// Prints the token table, the surface separations and the text contrast of the two theme orientations next to what is live (Task 0a8b17a6) as Markdown:
//   node scripts/frontend/theme-measure.mjs [--lowest]
import { applied, base, proposalOverrides, ratio, separations, textContrast } from "./theme-lib.mjs";

const names = ["warm", "cool"];
const variants = { current: applied("current"), warm: applied("warm"), cool: applied("cool") };
const changed = new Set(names.flatMap(n => ["light", "dark"].flatMap(mode => Object.keys(proposalOverrides(n)[mode]))));
console.log("## Token 对照（现在 → 暖调收紧 / 冷调中性；＝表示不变；只列有改动的 token）\n");
console.log("| token | 浅色 现在 | 浅色 暖 | 浅色 冷 | 深色 现在 | 深色 暖 | 深色 冷 |\n|---|---|---|---|---|---|---|");
for (const token of Object.keys(base().light).filter(t => changed.has(t))) {
  const cell = (mode, v) => variants[v][mode][token] ?? "—";
  const mark = (mode, v) => cell(mode, v) === cell(mode, "current") ? "＝" : cell(mode, v);
  console.log(`| \`${token}\` | ${cell("light", "current")} | ${mark("light", "warm")} | ${mark("light", "cool")} | ${cell("dark", "current")} | ${mark("dark", "warm")} | ${mark("dark", "cool")} |`);
}
console.log("\n## 表面分离（亮度比）\n");
console.log("| 表面对 | 浅 现在 | 浅 暖 | 浅 冷 | 深 现在 | 深 暖 | 深 冷 |\n|---|---|---|---|---|---|---|");
for (const [front, back, what] of separations) {
  const row = mode => ["current", "warm", "cool"].map(v => ratio(variants[v][mode][front], variants[v][mode][back]).toFixed(2));
  console.log(`| ${what} | ${row("light").join(" | ")} | ${row("dark").join(" | ")} |`);
}
console.log("\n## 文字对比度（每个文字色在它出现的每个表面上，WCAG）\n");
console.log("| 取向 | 组合数 | 最低 | 最低出现在 | 低于 4.5 的 |\n|---|---|---|---|---|");
for (const v of ["current", "warm", "cool"]) {
  const all = textContrast(variants[v]), low = all.reduce((m, x) => x.ratio < m.ratio ? x : m);
  console.log(`| ${v} | ${all.length} | ${low.ratio.toFixed(2)} | ${low.mode} ${low.text} 在 ${low.surface} | ${all.filter(x => x.ratio < 4.5).length} |`);
  if (process.argv.includes("--lowest")) for (const x of all.filter(x => x.ratio < 4.5)) console.log(`|  | | ${x.ratio.toFixed(2)} | ${x.mode} ${x.text} 在 ${x.surface} | |`);
}
