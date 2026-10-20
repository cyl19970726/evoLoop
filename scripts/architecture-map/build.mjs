import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { validateModel } from './viewer.js';
import { renderPlainSvg } from './plain-svg.js';
import { structureDiagram } from './structure.js';
import { mechanismDiagram } from './mechanism-svg.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = path.join(root, 'docs/assets');
const checkOnly = process.argv.includes('--check');
async function publish(filename, content) {
  const destination = path.join(assets, filename);
  if (checkOnly) {
    if (await fs.readFile(destination, 'utf8') !== content) throw new Error(`${filename} is stale; run npm run architecture:build`);
  } else await fs.writeFile(destination, content);
}
const model = validateModel(JSON.parse(await fs.readFile(path.join(assets, 'evoloop-system.model.json'), 'utf8')));
const esc = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const clean = value => value.split('\n').map(line => line.replace(/[\t ]+$/, '')).join('\n');
const architecture = JSON.parse(await fs.readFile(path.join(assets, 'evoloop-system-structure.architecture.json'), 'utf8'));
await publish('evoloop-system-structure.svg', renderPlainSvg(structureDiagram(architecture)));
for (const view of ['loop', 'revision', 'recovery', 'authority'])
  await publish(`evoloop-system-${view}.svg`, renderPlainSvg(mechanismDiagram(model, view)));
const result = await build({ entryPoints: [path.join(root, 'scripts/architecture-map/app.js')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' });
const css = (await Promise.all(['viewer.css', 'app.css', 'reading.css', 'structure.css'].map(file => fs.readFile(path.join(root, 'scripts/architecture-map', file), 'utf8')))).join('\n');
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const json = JSON.stringify(model).replaceAll('<', '\\u003c');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="evoLoop architecture reader; source-backed structure and mechanism views">
<title>${esc(model.title)}</title><style>${css}</style></head>
<body><div id="architecture-app"></div><noscript>此地图需启用 JavaScript；完整模块、关系和固定来源也保存在同目录的 evoloop-system.model.json。</noscript>
<script type="application/json" id="architecture-model">${json}</script><script type="application/json" id="architecture-structure">${JSON.stringify(architecture).replaceAll('<', '\\u003c')}</script><script>${script}</script></body></html>\n`;
await publish('evoloop-system.html', clean(html));
console.log(`${checkOnly ? 'Checked' : 'Built'} global map: ${model.nodes.length} nodes, ${model.edges.length} sourced relations; five inline SVG previews ready.`);
