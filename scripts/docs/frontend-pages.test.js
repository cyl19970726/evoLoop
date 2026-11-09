import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bodyChars, checkFrontendPages, codePaths, relativeSourcePaths, stalePages } from './frontend-pages.js';

const complete = `# 示例页：说明

一句话。

## 这一页回答什么
- 问题

## 布局
| 左栏 | 中间 | 右栏 |
| --- | --- | --- |
| a | b | c |

## 内容与状态
- 要点

## 截图
暂无当前截图。

## 代码与测试
- \`apps/workbench/src/sample/\`
- \`apps/workbench/test/sample.test.ts:12\`

## 相关
- 链接
`;

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evoloop-frontend-pages-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return root;
}

test('accepts a page that follows the template and lists existing paths', async t => {
  const root = await fixture(t, {
    'docs/frontend/pages/sample.md': complete,
    'apps/workbench/src/sample/index.ts': '',
    'apps/workbench/test/sample.test.ts': '',
  });
  const { problems, pages } = await checkFrontendPages(root);
  assert.deepEqual(problems, []);
  assert.deepEqual(pages[0].paths, ['apps/workbench/src/sample/', 'apps/workbench/test/sample.test.ts']);
});

test('reports missing sections, missing paths and long bodies', async t => {
  const long = complete.replace('## 截图\n暂无当前截图。\n', '') + `\n${'长'.repeat(1700)}\n`;
  const root = await fixture(t, { 'docs/frontend/pages/sample.md': long });
  const { problems } = await checkFrontendPages(root);
  assert.ok(problems.some(p => p.includes('missing section "## 截图"')));
  assert.ok(problems.some(p => p.includes('listed path does not exist: apps/workbench/src/sample/')));
  assert.ok(problems.some(p => p.includes('limit is 1600')));
});

test('counts prose only and reads code paths from the code section', () => {
  assert.equal(bodyChars('# 标题\n\n| a | b |\n![图](x.png)\n```\ncode\n```\n两字'), 2);
  assert.equal(bodyChars('- [链接](../../very/long/path.md#anchor) 和 `代码`'), 5);
  assert.deepEqual(codePaths('## 布局\n`apps/x`\n## 代码与测试\n`packages/ui/src/a.ts:3-9`\n'), ['packages/ui/src/a.ts']);
});

test('resolves workbench-relative file names and reports missing ones', async t => {
  const page = complete.replace('- \`apps/workbench/src/sample/\`', '| 源码（\`apps/workbench/src/\`） | \`roles/Team.tsx\`、\`roles/Gone.tsx\` |');
  assert.deepEqual(relativeSourcePaths(page), ['roles/Team.tsx', 'roles/Gone.tsx']);
  const root = await fixture(t, {
    'docs/frontend/pages/sample.md': page,
    'apps/workbench/src/roles/Team.tsx': '',
    'apps/workbench/test/sample.test.ts': '',
  });
  const { problems, pages } = await checkFrontendPages(root);
  assert.ok(pages[0].paths.includes('apps/workbench/src/roles/Team.tsx'));
  assert.deepEqual(problems, ['docs/frontend/pages/sample.md: listed file not found under apps/workbench/src or test: roles/Gone.tsx']);
});

test('lists pages whose workbench source changed without the page', () => {
  const pages = [
    { page: 'docs/frontend/pages/a.md', paths: ['apps/workbench/src/sessions/', 'apps/workbench/test/a.test.ts'] },
    { page: 'docs/frontend/pages/b.md', paths: ['apps/workbench/src/documents'] },
  ];
  pages.push({ page: 'docs/frontend/pages/c.md', paths: ['apps/workbench/src/'] });
  const stale = stalePages(pages, ['apps/workbench/src/sessions/SessionTimeline.tsx', 'apps/workbench/src/documents/x.ts', 'docs/frontend/pages/b.md']);
  assert.deepEqual(stale, [{ page: 'docs/frontend/pages/a.md', touched: ['apps/workbench/src/sessions/SessionTimeline.tsx'] }]);
});
