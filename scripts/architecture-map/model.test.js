import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateModel, projectGraph } from './viewer.js';
const model = validateModel(JSON.parse(await fs.readFile(new URL('../../docs/assets/evoloop-system.model.json', import.meta.url), 'utf8')));

test('published target map covers all target packages and distinguishes the one unbuilt workspace', async () => {
  const packages = await fs.readFile(new URL('../../docs/architecture/packages.md', import.meta.url), 'utf8');
  const rows = [...packages.matchAll(/^\| `(packages\/[^`]+|apps\/[^`]+)`(（未建）)? \|/gm)]
    .map(match => ({ path: match[1], unbuilt: Boolean(match[2]) }));
  assert.equal(rows.length, 12);
  assert.equal(new Set(rows.map(row => row.path)).size, rows.length);
  assert.deepEqual(rows.filter(row => row.unbuilt).map(row => row.path), ['packages/agent-tools']);
  for (const { path, unbuilt } of rows) {
    const nodes = model.nodes.filter(node => node.path === path);
    assert.equal(nodes.length, 1, `${path} needs exactly one map location`);
    assert.equal(nodes[0].status, 'proposed', `${path} is a target-map location`);
    const manifest = new URL(`../../${path}/package.json`, import.meta.url);
    const exists = await fs.access(manifest).then(() => true, () => false);
    assert.equal(exists, !unbuilt, `${path} documentation and workspace state disagree`);
  }
  const cache = new Map();
  for (const item of [...model.nodes, ...model.edges]) {
    assert.ok(item.sources.length, `${item.id} needs evidence`);
    for (const source of item.sources) {
      assert.match(source.path, /^docs\/architecture\/[a-z-]+\.md$/);
      if (!cache.has(source.path)) cache.set(source.path, execFileSync('git', ['show', `${model.repository.revision}:${source.path}`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' }).split('\n'));
      assert.ok(source.line <= (source.endLine || source.line));
      assert.ok((source.endLine || source.line) <= cache.get(source.path).length, `${item.id}: source span exceeds file`);
    }
  }
});

test('root fold combinations preserve every declared relation without inventing endpoints', () => {
  const roots = model.nodes.filter(node => node.parent === null);
  for (let bits = 0; bits < 2 ** roots.length; bits++) {
    const expanded = new Set(roots.filter((_, i) => bits & (1 << i)).map(node => node.id));
    for (const mode of ['runtime', 'dependency', 'ownership']) {
      const graph = projectGraph(model, expanded, mode);
      const actual = [...graph.edges.flatMap(edge => edge.edges.map(item => item.id)), ...graph.internalEdges.map(item => item.edge.id)].sort();
      const expected = model.edges.filter(edge => edge.kind === mode).map(edge => edge.id).sort();
      assert.deepEqual(actual, expected);
      const visible = new Set(graph.visibleNodes.map(node => node.id));
      for (const edge of graph.edges) {
        assert.ok(visible.has(edge.from) && visible.has(edge.to));
        assert.notEqual(edge.from, edge.to);
      }
    }
  }
});


test('committed reading page and inline diagrams match their source models and reader implementation', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url)), '--check'], { stdio: 'pipe' });
});
