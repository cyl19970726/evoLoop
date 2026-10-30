import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptancePoints } from '../src/workflow/acceptancePresentation.ts';
test('numbered acceptance keeps each original condition and punctuation',()=>{
 assert.deepEqual(acceptancePoints('1. 保留旧 Run。2. 核对当前版本。3. 返回原任务。'),['保留旧 Run。','核对当前版本。','返回原任务。']);
});
test('versions and measurements are not inferred as acceptance bullets',()=>{
 assert.equal(acceptancePoints('支持 1.5 与 2.0，保持已有合同。'),null);
 assert.deepEqual(acceptancePoints('1. 第一项含 2.0 版本。2. 第二项。'),['第一项含 2.0 版本。','第二项。']);
 assert.equal(acceptancePoints('先核对。1. 第一项。2. 第二项。'),null);
});
test('incomplete numbering and prose retain their authored presentation',()=>{
 assert.equal(acceptancePoints('1. 第一项。3. 第三项。'),null);
 assert.equal(acceptancePoints('按固定版本检查，再记录独立使用。'),null);
 assert.deepEqual(acceptancePoints('1、第一项\n2、第二项'),['第一项','第二项']);
});
