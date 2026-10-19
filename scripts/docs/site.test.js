import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build, check } from './site.js';

async function fixture(t, pages = [{ path: 'README.md', title: 'Home', group: 'Start' }]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evoloop-docs-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/site.json'), JSON.stringify({ title: 'Test', description: 'Test docs', pages }));
  await fs.writeFile(path.join(root, 'README.md'), '# Home\n');
  return root;
}

test('rewrites published relative Markdown links and heading anchors', async t => {
  const root = await fixture(t, [
    { path: 'README.md', title: 'Home', group: 'Start' },
    { path: 'docs/topic.md', title: 'Topic', group: 'Guide' },
  ]);
  await fs.writeFile(path.join(root, 'README.md'), '# Home\n\n[topic](docs/topic.md#second-heading)\n');
  await fs.writeFile(path.join(root, 'docs/topic.md'), '# Topic\n\n## Second heading\n\n[home](../README.md#home)\n');
  await build(root);
  const home = await fs.readFile(path.join(root, 'site/index.html'), 'utf8');
  const topic = await fs.readFile(path.join(root, 'site/docs/topic.html'), 'utf8');
  assert.match(home, /href="docs\/topic.html#second-heading"/);
  assert.match(topic, /href="..\/index.html#home"/);
  assert.match(topic, /id="second-heading"/);
});

test('rejects manifest traversal and symlinked sources', async t => {
  const root = await fixture(t, [{ path: '../outside.md', title: 'Bad', group: 'Start' }]);
  await assert.rejects(check(root), /invalid repository-relative path/);
  await fs.writeFile(path.join(root, 'docs/site.json'), JSON.stringify({ title: 'Test', description: '', pages: [{ path: 'docs/link.md', title: 'Link', group: 'Start' }] }));
  await fs.symlink(path.join(root, 'README.md'), path.join(root, 'docs/link.md'));
  await assert.rejects(check(root), /symlinks are not allowed/);
});

test('rejects links to unpublished pages and missing anchors', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'README.md'), '# Home\n\n[secret](docs/private.md)\n');
  await assert.rejects(check(root), /not published/);
  await fs.writeFile(path.join(root, 'README.md'), '# Home\n\n[broken](#missing)\n');
  await assert.rejects(check(root), /missing heading/);
});

test('refuses an existing user directory or symlink as output', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'site'));
  await fs.writeFile(path.join(root, 'site/keep.txt'), 'user data');
  await assert.rejects(build(root), /refusing to replace/);
  assert.equal(await fs.readFile(path.join(root, 'site/keep.txt'), 'utf8'), 'user data');
  await fs.rm(path.join(root, 'site'), { recursive: true });
  await fs.symlink(os.tmpdir(), path.join(root, 'site'));
  await assert.rejects(build(root), /regular directory/);
});

test('escapes raw HTML and blocks private local addresses', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'README.md'), '# Home\n\n<script>alert(1)</script>\n');
  await build(root);
  assert.doesNotMatch(await fs.readFile(path.join(root, 'site/index.html'), 'utf8'), /<script>/);
  await fs.writeFile(path.join(root, 'README.md'), '# Home\n\nfile://local/private\n');
  await assert.rejects(check(root), /private local address/);
});

test('copies only referenced assets from docs/assets and builds repeatably', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'docs/assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/assets/picture.svg'), '<svg/>');
  await fs.writeFile(path.join(root, 'docs/assets/unused.svg'), '<svg id="unused"/>');
  await fs.writeFile(path.join(root, 'README.md'), '# Home\n\n![picture](docs/assets/picture.svg)\n');
  await build(root);
  const first = await fs.readFile(path.join(root, 'site/index.html'), 'utf8');
  await build(root);
  assert.equal(await fs.readFile(path.join(root, 'site/index.html'), 'utf8'), first);
  await assert.rejects(fs.stat(path.join(root, 'site/docs/assets/unused.svg')), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, 'README.md'), '# Home\n\n![bad](docs/research/private.svg)\n');
  await assert.rejects(check(root), /local asset must be under docs\/assets/);
});
