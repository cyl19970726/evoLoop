import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { validateModel } from './viewer.js';

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
const sourceRefs = sources => sources.map(({ path, line, endLine }) => ({ path, line, ...(endLine ? { end_line: endLine } : {}) }));
const status = { proposed: '拟议', selected: '归属已定', existing: '现有', conditional: '有条件' };
const tree = {
  schema_version: 1, diagram_type: 'tree',
  meta: {
    title: 'evoLoop 全模块归属 · 目标设计', locale: 'zh-CN', quality_profile: 'showcase',
    output: 'docs/assets/evoloop-system-modules.html',
    repository: { url: model.repository.url + '.git', revision: model.repository.revision },
  },
  layout: { direction: 'right', nodeW: 150, nodeMaxW: 200, gapX: 30, gapY: 26 },
  nodes: [
    { id: 'evoloop', label: 'evoLoop 目标架构', sublabel: '展示分组 / 包 / 内部职责 / 外部权威', sources: [{ path: 'docs/architecture/packages.md', line: 3, end_line: 18 }] },
    ...model.nodes.map(node => ({
      id: node.id, label: node.label, parent: node.parent || 'evoloop',
      sublabel: `${status[node.status]} · ${node.summary}`,
      ...(model.nodes.some(child => child.parent === node.id) ? { collapsed: false } : {}),
      sources: sourceRefs(node.sources).slice(0, 3),
    })),
  ],
  cards: [
    { dot: 'cyan', title: '怎样读这棵树', items: ['边只表示展示归属，不表示调用、源码依赖或进程包含。', '各节点可展开；跨模块协作和数据归属在全局地图中切换查看。'] },
    { dot: 'amber', title: '实现状态', items: ['12 个业务包仍是拟议边界，尚未实现或部署。', 'PG 主数据归属已定；Wiki 底座、具体栈和版本仍待采纳。'] },
    { dot: 'emerald', title: '权威不合并', items: ['PG 主数据、外置 Wiki、Git 正式正文与大原件分别持有。', '四部分是产品能力，不是四个固定岗位、包或进程。'] },
  ],
};
await publish('evoloop-system.tree.json', JSON.stringify(tree, null, 2) + '\n');
const result = await build({ entryPoints: [path.join(root, 'scripts/architecture-map/viewer.js')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' });
const css = await fs.readFile(path.join(root, 'scripts/architecture-map/viewer.css'), 'utf8');
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const json = JSON.stringify(model).replaceAll('<', '\\u003c');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="evoLoop module explorer; Archify 3.2.0 native companion diagrams">
<title>${esc(model.title)}</title><style>${css}</style></head>
<body><div id="architecture-app"></div><noscript>此地图需启用 JavaScript；完整模块、关系和固定来源也保存在同目录的 evoloop-system.model.json。</noscript>
<script type="application/json" id="architecture-model">${json}</script><script>${script}</script></body></html>\n`;
await publish('evoloop-system.html', clean(html));
console.log(`${checkOnly ? 'Checked' : 'Built'} global map: ${model.nodes.length} nodes, ${model.edges.length} sourced relations; native Tree JSON ready.`);
