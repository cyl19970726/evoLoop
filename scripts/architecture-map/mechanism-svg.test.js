import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mechanismDiagram } from './mechanism-svg.js';
import { READING_MECHANISMS } from './reading.js';

const model = JSON.parse(fs.readFileSync(new URL('../../docs/assets/evoloop-system.model.json', import.meta.url), 'utf8'));
const modelIds = new Set(model.nodes.map(node => node.id));
const views = ['loop', 'revision', 'recovery', 'authority'];

function diagramText(spec) {
  return spec.nodes.flatMap(node => [node.label, ...node.lines]).join(' ');
}

test('四张正文图有模型来源，边连接真实节点且坐标落在画布内', () => {
  for (const view of views) {
    const spec = mechanismDiagram(model, view);
    assert.equal(spec.title, READING_MECHANISMS[view].label);
    assert.equal(spec.description, READING_MECHANISMS[view].lead);
    assert.ok(spec.width <= 1080 && spec.height <= 480, view);
    assert.ok(spec.sourceNodes.length >= 4 && spec.sourceNodes.every(id => modelIds.has(id)), `${view} fixed sources`);
    const byId = new Map(spec.nodes.map(node => [node.id, node]));
    assert.equal(byId.size, spec.nodes.length, `${view} unique nodes`);
    for (const node of spec.nodes) {
      assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.w <= spec.width && node.y + node.h <= spec.height, `${view}:${node.id} bounds`);
      assert.ok(node.label && node.lines.length, `${view}:${node.id} readable label`);
      assert.ok(node.lines.every(line => line.length <= 20), `${view}:${node.id} short lines`);
    }
    for (const edge of spec.edges) {
      assert.ok(byId.has(edge.from) && byId.has(edge.to), `${view}:${edge.id} endpoints`);
      assert.ok(edge.points.length >= 2 && edge.points.every(([x, y]) => x >= 0 && y >= 0 && x <= spec.width && y <= spec.height), `${view}:${edge.id} path`);
    }
  }
  assert.throws(() => mechanismDiagram(model, 'missing'), RangeError);
});

test('工作回路按判断、接受、运行、使用、审阅、知识修订闭合，并区分三种结果', () => {
  const spec = mechanismDiagram(model, 'loop');
  assert.deepEqual(spec.edges.map(edge => [edge.from, edge.to]), [
    ['decision', 'task'], ['task', 'run'], ['run', 'use'],
    ['use', 'review'], ['review', 'wiki'], ['wiki', 'decision'],
  ]);
  const text = diagramText(spec);
  assert.match(text, /授权、接受、依据有效才派发/);
  assert.match(text, /Run 结束 ≠ Task 验收/);
  assert.match(text, /效果未知不代替任务状态/);
  assert.match(text, /反馈不自动采纳/);
  assert.match(READING_MECHANISMS.loop.steps[3].gate, /效果为未知/);
});

test('修订保留 r2 的历史引用，r3 只触发 Task 复核与明确选择', () => {
  const spec = mechanismDiagram(model, 'revision');
  const text = diagramText(spec);
  for (const phrase of ['原基线 r2', '新增修订 r3', '旧 Run 固定引用它', '待复核时暂停新派发', '换基线', '保留旧版', '补救 Task']) assert.ok(text.includes(phrase), phrase);
  assert.ok(spec.edges.some(edge => edge.from === 'r2' && edge.to === 'history' && edge.kind === 'reference'));
  assert.ok(!spec.edges.some(edge => edge.from === 'r3' && edge.to === 'history'));
  assert.match(READING_MECHANISMS.revision.steps[2].body, /换基线、保留旧版并说明，或开补救任务/);
});

test('未知派发按同一操作回读后才分流，unknown 不重发', () => {
  const spec = mechanismDiagram(model, 'recovery');
  const text = diagramText(spec);
  assert.match(text, /原操作 ID.*Run 回执未知.*按同一操作回读/);
  assert.match(text, /Journal \/ outbox.*Session \/ 动作/);
  assert.match(text, /Task 终态不代表 Run/);
  assert.match(text, /证实未启动.*才可受控重发/);
  assert.match(text, /仍 unknown.*禁止重复执行/);
  assert.deepEqual(spec.edges.filter(edge => edge.from === 'readback').map(edge => edge.to), ['started', 'not-started', 'still-unknown']);
  assert.match(READING_MECHANISMS.recovery.steps[2].gate, /unknown.*禁止重复执行/);
});

test('四个权威边界与飞书受控写入方向明确', () => {
  const spec = mechanismDiagram(model, 'authority');
  const text = diagramText(spec);
  for (const phrase of ['PostgreSQL', 'Task、过程 Document 修订', '知识正文与修订', '内部依赖', '受管 Git', 'docs/', '飞书协作投影', '核验身份与所见版本']) assert.ok(text.includes(phrase), phrase);
  assert.deepEqual(spec.edges.map(edge => [edge.from, edge.to]), [
    ['wiki', 'postgres'], ['git', 'postgres'], ['postgres', 'feishu'],
    ['feishu', 'core'], ['core', 'postgres'],
  ]);
  assert.ok(spec.edges.filter(edge => edge.from === 'wiki' || edge.from === 'git').every(edge => edge.kind === 'reference'));
  assert.match(READING_MECHANISMS.authority.steps[0].gate, /不复制 Wiki 正文/);
});
