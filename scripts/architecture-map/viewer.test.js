import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModel, projectGraph, routeProjectedEdges, ancestorPath, expandEdgeAncestors, parseViewState, serializeViewState } from './viewer.js';

function fixture() {
  const node = (id, parent, lane, kind = 'module') => ({ id, parent, lane, label: id, summary: `${id} summary`, kind, status: 'proposed', sources: [{ path: 'docs/architecture.md', line: 1 }] });
  const edge = (id, from, to, kind = 'runtime') => ({ id, from, to, label: id, kind, sources: [{ path: 'docs/architecture.md', line: 2 }] });
  return {
    schemaVersion: 1, title: '地图', description: '目标设计',
    repository: { url: 'https://github.com/example/evoLoop', revision: 'abc123' },
    nativeTreeUrl: './tree.svg', nativeOverviewUrl: './overview.svg',
    defaultExpanded: ['authority'],
    journeys: [{ id: 'recovery', label: '执行恢复', note: '恢复路径', focus: ['worker', 'postgres'], checks: ['核对固定基线', '核对责任决定'] }],
    nodes: [node('entry', null, 0, 'group'), node('request', 'entry', 0),
      node('core', null, 1, 'group'), node('worker', 'core', 1), node('planner', 'core', 1),
      node('authority', null, 2, 'group'), node('postgres', 'authority', 2, 'external')],
    edges: [edge('run-1', 'request', 'worker'), edge('run-2', 'request', 'planner'),
      edge('run-3', 'worker', 'planner'), edge('run-4', 'worker', 'postgres'),
      edge('own-1', 'worker', 'postgres', 'ownership')],
  };
}

test('折叠关系投到最近可见祖先并保留每条原始 ID', () => {
  const model = validateModel(fixture());
  const graph = projectGraph(model, new Set(), 'runtime');
  assert.deepEqual(graph.visibleNodes.map(node => node.id), ['entry', 'core', 'authority']);
  assert.deepEqual(graph.edges.map(group => [group.from, group.to, group.edges.map(edge => edge.id)]),
    [['entry', 'core', ['run-1', 'run-2']], ['core', 'authority', ['run-4']]]);
  assert.deepEqual(graph.internalEdges.map(item => item.edge.id), ['run-3']);
});

test('展开后重投影，内部边显现，自环始终可核对', () => {
  const model = fixture();
  const graph = projectGraph(model, new Set(['entry', 'core', 'authority']), 'runtime');
  assert.deepEqual(graph.edges.map(group => group.edges.map(edge => edge.id)),
    [['run-1'], ['run-2'], ['run-3'], ['run-4']]);
  assert.equal(graph.internalEdges.length, 0);
  model.edges.push({ id: 'self', from: 'worker', to: 'worker', label: '自环', kind: 'runtime', sources: [] });
  assert.deepEqual(projectGraph(model, new Set(['core']), 'runtime').internalEdges.map(item => item.edge.id), ['self']);
  assert.deepEqual(projectGraph(model, new Set(), 'runtime').internalEdges.map(item => item.edge.id), ['run-3', 'self']);
});

test('关系模式切换保持语义隔离', () => {
  const model = fixture();
  const ownership = projectGraph(model, new Set(), 'ownership');
  assert.equal(ownership.edges.length, 1);
  assert.deepEqual(ownership.edges[0].edges.map(edge => edge.id), ['own-1']);
  assert.equal(projectGraph(model, new Set(), 'dependency').edges.length, 0);
  assert.throws(() => projectGraph(model, new Set(), 'contains'), /未知的关系类型/);
  const ownershipExpanded = expandEdgeAncestors(model, new Set(model.defaultExpanded), 'ownership');
  assert.deepEqual([...ownershipExpanded], ['authority', 'core']);
  assert.deepEqual(projectGraph(model, ownershipExpanded, 'ownership').edges[0].edges.map(edge => edge.id), ['own-1']);
  assert.deepEqual(model.defaultExpanded, ['authority']);
});

test('搜索定位可取得稳定祖先路径，深链恢复焦点及展开状态', () => {
  const model = fixture();
  assert.deepEqual(ancestorPath(model, 'postgres'), ['authority', 'postgres']);
  assert.deepEqual(ancestorPath(model, 'missing'), []);
  const expanded = new Set(model.defaultExpanded);
  for (const ancestor of ancestorPath(model, 'worker').slice(0, -1)) expanded.add(ancestor);
  assert.deepEqual(projectGraph(model, expanded).visibleNodes.map(node => node.id),
    ['entry', 'core', 'worker', 'planner', 'authority', 'postgres']);
  assert.deepEqual(model.defaultExpanded, ['authority']);
  const state = parseViewState(model, '');
  assert.deepEqual([...state.expanded], ['authority']);
  state.expanded = expanded; state.focus = 'worker'; state.mode = 'ownership'; state.journey = 'recovery';
  const restored = parseViewState(model, serializeViewState(state));
  assert.deepEqual([...restored.expanded], ['authority', 'core']);
  assert.equal(restored.focus, 'worker');
  assert.equal(restored.mode, 'ownership');
  assert.equal(restored.journey, 'recovery');
  assert.deepEqual([...parseViewState(model, '#open=').expanded], []);
});

test('无效层级、端点、来源、重复 ID 和场景节点均拒绝', () => {
  const mutations = [
    model => { model.nodes[1].parent = 'missing'; },
    model => { model.nodes[0].parent = 'request'; },
    model => { model.edges[0].to = 'missing'; },
    model => { model.nodes[1].sources[0].line = 0; },
    model => { model.nodes[1].id = 'entry'; },
    model => { model.journeys[0].focus = ['missing']; },
    model => { model.journeys[0].checks = ['']; },
    model => { model.journeys[0].checks = '不是列表'; },
    model => { model.defaultExpanded = ['missing']; },
  ];
  for (const mutate of mutations) {
    const model = fixture(); mutate(model);
    assert.throws(() => validateModel(model));
  }
});

test('同列与邻列关系走留白正交通道，端口分离且不穿其他卡片', () => {
  const boxes = new Map([
    ['a', { lane: 0, left: 68, right: 338, top: 60, bottom: 140, height: 80 }],
    ['b', { lane: 1, left: 448, right: 718, top: 60, bottom: 140, height: 80 }],
    ['c', { lane: 1, left: 448, right: 718, top: 170, bottom: 250, height: 80 }],
    ['d', { lane: 2, left: 828, right: 1098, top: 60, bottom: 140, height: 80 }],
    ['e', { lane: 2, left: 828, right: 1098, top: 170, bottom: 250, height: 80 }],
    ['f', { lane: 2, left: 828, right: 1098, top: 280, bottom: 360, height: 80 }],
  ]);
  const lanes = [{ left: 68, right: 338 }, { left: 448, right: 718 }, { left: 828, right: 1098 }];
  const edges = [
    { id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' },
    { id: 'bd', from: 'b', to: 'd' }, { id: 'de', from: 'd', to: 'e' },
    { id: 'df', from: 'd', to: 'f' }, { id: 'ed', from: 'e', to: 'd' },
  ];
  const routes = routeProjectedEdges(edges, boxes, lanes, 1210);
  assert.equal(routes.length, edges.length);
  assert.deepEqual(routes.map(route => route.edge.id), edges.map(edge => edge.id));
  for (const route of routes) {
    for (let i = 1; i < route.points.length; i++) {
      const [x1, y1] = route.points[i - 1], [x2, y2] = route.points[i];
      assert.ok(x1 === x2 || y1 === y2, `${route.edge.id} contains a diagonal`);
      for (const [id, box] of boxes) {
        if (id === route.edge.from || id === route.edge.to) continue;
        const crosses = x1 === x2 ? x1 > box.left && x1 < box.right && Math.max(y1, y2) > box.top && Math.min(y1, y2) < box.bottom :
          y1 > box.top && y1 < box.bottom && Math.max(x1, x2) > box.left && Math.min(x1, x2) < box.right;
        assert.equal(crosses, false, `${route.edge.id} crosses ${id}`);
      }
    }
  }
  const ports = routes.filter(route => route.edge.from === 'd').map(route => route.points[0][1]);
  assert.equal(new Set(ports).size, ports.length);
  assert.ok(routes.find(route => route.edge.id === 'de').label.x > lanes[2].right);
});

test('相邻汇总数量在共享走廊内保持至少 22px 间距', () => {
  const boxes = new Map([
    ['b', { lane: 1, left: 448, right: 718, top: 60, bottom: 140, height: 80 }],
    ['c', { lane: 1, left: 448, right: 718, top: 170, bottom: 250, height: 80 }],
    ['d', { lane: 2, left: 828, right: 1098, top: 60, bottom: 140, height: 80 }],
    ['e', { lane: 2, left: 828, right: 1098, top: 170, bottom: 250, height: 80 }],
  ]);
  const lanes = [{ left: 68, right: 338 }, { left: 448, right: 718 }, { left: 828, right: 1098 }];
  const edges = [
    { id: 'ten', from: 'b', to: 'c', edges: Array(10).fill({}) },
    { id: 'fourteen', from: 'c', to: 'b', edges: Array(14).fill({}) },
    { id: 'bd', from: 'b', to: 'd', edges: [{}] },
    { id: 'ce', from: 'c', to: 'e', edges: [{}] },
  ];
  const routes = routeProjectedEdges(edges, boxes, lanes, 1210);
  const a = routes[0].label, b = routes[1].label;
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 22);
  assert.ok(routes.every(route => route.points.length === 4));
});
