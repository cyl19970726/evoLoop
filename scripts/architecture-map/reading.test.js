import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { READING_MECHANISMS, READING_REGIONS, parseReadingState } from './reading.js';

const model = JSON.parse(fs.readFileSync(new URL('../../docs/assets/evoloop-system.model.json', import.meta.url), 'utf8'));
const nodes = new Map(model.nodes.map(node => [node.id, node]));

test('四个问题各有可读路径、门槛与真实模型定位', () => {
  assert.deepEqual(Object.keys(READING_MECHANISMS), ['loop', 'revision', 'recovery', 'authority']);
  for (const [id, mechanism] of Object.entries(READING_MECHANISMS)) {
    assert.ok(mechanism.steps.length >= 3, `${id} needs a causal explanation`);
    assert.ok(mechanism.route.every(region => READING_REGIONS[region]), `${id} route references an unknown region`);
    assert.ok(mechanism.steps.every(step => mechanism.route.includes(step.region) && step.gate && step.body), `${id} needs evidence gates and steps on its route`);
    for (const sourceId of mechanism.sources) assert.ok(nodes.has(sourceId), `${id} source node ${sourceId}`);
  }
  for (const [region, info] of Object.entries(READING_REGIONS)) {
    assert.ok(info.modules.length > 0, `${region} is not explorable`);
    for (const nodeId of info.modules) assert.ok(nodes.has(nodeId), `${region} links missing module ${nodeId}`);
  }
});

test('工作回路区分任务验收、运行终态和实际效果', () => {
  const loop = READING_MECHANISMS.loop;
  assert.deepEqual(loop.route, ['decision', 'task', 'run', 'use', 'review', 'wiki', 'decision']);
  assert.match(loop.steps.find(step => step.region === 'task').gate, /授权.*接受.*依据有效/);
  assert.match(loop.steps.find(step => step.region === 'run').gate, /不等于 Task 验收/);
  assert.match(loop.steps.find(step => step.region === 'use').gate, /若 Task 判据要求消费，.*不能验收/);
  assert.match(loop.steps.find(step => step.region === 'review').gate, /不自动批准/);
});

test('改版保留旧依据，未知派发需回读并禁止盲目重发', () => {
  const revision = READING_MECHANISMS.revision.steps;
  assert.match(revision.find(step => step.region === 'task').gate, /暂停新派发/);
  assert.match(revision.find(step => step.region === 'run').body, /旧 Run.*TaskBasis/);
  const recovery = READING_MECHANISMS.recovery.steps;
  assert.match(recovery[1].body, /Journal \/ outbox.*运行时.*connector/);
  assert.match(recovery.at(-1).body, /证实未启动才重发/);
  assert.match(recovery.at(-1).gate, /unknown.*禁止重复执行/);
});

test('权威分区保留 Wiki、Git、PG、飞书各自写入门', () => {
  const authority = READING_MECHANISMS.authority.steps;
  assert.deepEqual(authority.map(step => step.region), ['postgres', 'wiki', 'git', 'feishu']);
  assert.match(authority[0].gate, /不复制 Wiki 正文/);
  assert.match(authority[1].gate, /发布.*采用.*不同状态/);
  assert.match(authority[2].gate, /不创建过程 Document 行/);
  assert.match(authority[3].body, /身份与所见版本.*核验/);
});

test('机制 hash 仅认 read，旧模块深链留给完整模块图', () => {
  assert.equal(parseReadingState('#read=recovery'), 'recovery');
  assert.equal(parseReadingState('#read=authority'), 'authority');
  assert.equal(parseReadingState('#read=invalid'), null);
  assert.equal(parseReadingState(''), null);
  assert.equal(parseReadingState('#open=core&node=tasks&mode=runtime'), null);
});

test('机制引用的节点携带固定仓库来源', () => {
  assert.match(model.repository.url, /^https:\/\//);
  assert.match(model.repository.revision, /^[0-9a-f]{40}$/);
  for (const mechanism of Object.values(READING_MECHANISMS)) {
    for (const id of mechanism.sources) {
      const node = nodes.get(id);
      assert.ok(node.sources.some(source => source.path.startsWith('docs/') && source.line > 0), `${id} lacks a document source`);
    }
  }
});
