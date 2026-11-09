// Checks docs/frontend/pages/*.md against the page template and lists pages whose source changed without the page.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGES_DIR = 'docs/frontend/pages';
export const REQUIRED_SECTIONS = ['这一页回答什么', '布局', '内容与状态', '截图', '代码与测试', '相关'];
export const MAX_BODY_CHARS = 1600;

function sections(markdown) {
  const result = new Map();
  let current = null;
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = !fenced && /^## (.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      result.set(current, []);
    } else if (current) result.get(current).push(line);
  }
  return result;
}

/** Counts prose characters, leaving out headings, tables, images, code blocks, link targets, markup and whitespace. */
export function bodyChars(markdown) {
  let fenced = false;
  let count = 0;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || /^\s*(#|\||!\[)/.test(line)) continue;
    count += line.replace(/\]\([^)]*\)/g, ']').replace(/[`*_>\[\]-]/g, '').replace(/\s/g, '').length;
  }
  return count;
}

/** Repository paths written in backticks under the code section, e.g. `apps/workbench/src/sessions/`. */
export function codePaths(markdown) {
  const lines = sections(markdown).get('代码与测试') ?? [];
  const paths = new Set();
  for (const match of lines.join('\n').matchAll(/`((?:apps|packages)\/[^`\s]+)`/g)) {
    paths.add(match[1].replace(/:\d+(?:-\d+)?$/, ''));
  }
  return [...paths];
}

/** Workbench-relative source names such as `sessions/SessionWorkspace.tsx`, resolved later against src/ or test/. */
export function relativeSourcePaths(markdown) {
  const lines = sections(markdown).get('代码与测试') ?? [];
  const names = new Set();
  for (const match of lines.join('\n').matchAll(/`([\w.-]+\/[\w./-]+\.(?:tsx?|css|js|mjs))`/g)) {
    if (!/^(apps|packages)\//.test(match[1])) names.add(match[1]);
  }
  return [...names];
}

async function exists(root, relative) {
  return fs.stat(path.join(root, relative)).then(() => true, () => false);
}

async function pageFiles(root) {
  const entries = await fs.readdir(path.join(root, PAGES_DIR)).catch(() => []);
  return entries.filter(name => name.endsWith('.md')).sort().map(name => `${PAGES_DIR}/${name}`);
}

export async function checkFrontendPages(root) {
  const problems = [];
  const pages = [];
  for (const page of await pageFiles(root)) {
    const markdown = await fs.readFile(path.join(root, page), 'utf8');
    const present = sections(markdown);
    for (const name of REQUIRED_SECTIONS) {
      if (!present.has(name)) problems.push(`${page}: missing section "## ${name}"`);
    }
    const chars = bodyChars(markdown);
    if (chars > MAX_BODY_CHARS) problems.push(`${page}: body has ${chars} characters, limit is ${MAX_BODY_CHARS}`);
    const paths = codePaths(markdown);
    for (const name of relativeSourcePaths(markdown)) {
      const resolved = [`apps/workbench/src/${name}`, `apps/workbench/test/${name}`];
      const found = [];
      for (const candidate of resolved) if (await exists(root, candidate)) found.push(candidate);
      if (found.length) paths.push(...found.filter(p => !paths.includes(p)));
      else problems.push(`${page}: listed file not found under apps/workbench/src or test: ${name}`);
    }
    if (present.has('代码与测试') && !paths.some(p => p.startsWith('apps/workbench/src/') && p.replace(/\/$/, '') !== 'apps/workbench/src')) {
      problems.push(`${page}: "代码与测试" must list at least one specific apps/workbench/src/ path`);
    }
    for (const relative of paths) {
      if (!await exists(root, relative)) problems.push(`${page}: listed path does not exist: ${relative}`);
    }
    pages.push({ page, chars, paths });
  }
  if (pages.length === 0) problems.push(`${PAGES_DIR}: no page documents found`);
  return { pages, problems };
}

/** Pages whose listed workbench source changed while the page document itself did not. */
export function stalePages(pages, changedFiles) {
  const changed = new Set(changedFiles);
  const stale = [];
  for (const { page, paths } of pages) {
    if (changed.has(page)) continue;
    const sources = paths.filter(p => p.startsWith('apps/workbench/src/') && p.replace(/\/$/, '') !== 'apps/workbench/src');
    const touched = changedFiles.filter(file => sources.some(source => file === source || file.startsWith(source.endsWith('/') ? source : `${source}/`)));
    if (touched.length) stale.push({ page, touched });
  }
  return stale;
}

async function main() {
  const root = process.cwd();
  const baseIndex = process.argv.indexOf('--base');
  const { pages, problems } = await checkFrontendPages(root);
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`Checked ${pages.length} frontend page documents.`);
  if (baseIndex > 0) {
    const base = process.argv[baseIndex + 1];
    if (!base) throw new Error('Use --base <git ref>.');
    const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const stale = stalePages(pages, changed);
    for (const { page, touched } of stale) {
      console.log(`Source changed but ${page} did not: ${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ' …' : ''}`);
    }
    if (!stale.length) console.log('Every page whose source changed was updated.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
