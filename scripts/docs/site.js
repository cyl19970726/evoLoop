import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { build as bundle } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const marker = '.evoloop-docs-build';
const privateLocation = /(?:\/Users\/|file:\/\/|codex:\/\/)/i;
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
const defaultFence = markdown.renderer.rules.fence;
const defaultHeadingOpen = markdown.renderer.rules.heading_open;
markdown.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const aliases = (tokens[index].meta?.headingAliases || []).map(id =>
    `<span id="${escapeHtml(id)}" aria-hidden="true"></span>`).join('');
  return aliases + (defaultHeadingOpen ? defaultHeadingOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options));
};
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (!/^mermaid(?:\s|$)/i.test(token.info.trim())) return defaultFence(tokens, index, options, env, self);
  const source = escapeHtml(token.content);
  return `<figure class="diagram"><div class="diagram-bar"><span>流程图 · 可横向滚动</span><button type="button" class="diagram-zoom" aria-pressed="false" hidden>放大</button></div><div class="diagram-view" tabindex="0" aria-label="流程图，可横向滚动"><p class="diagram-status">图表加载中…</p><pre class="mermaid">${source}</pre></div><details class="diagram-source"><summary>查看 Mermaid 源码</summary><pre><code>${source}</code></pre></details></figure>\n`;
};

function fail(message) { throw new Error(message); }
function escapeHtml(value) { return markdown.utils.escapeHtml(String(value)); }
function repoPath(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
      value.startsWith('/') || /^[a-zA-Z]:/.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(`${label}: invalid repository-relative path: ${JSON.stringify(value)}`);
  }
  return value;
}
async function regularFile(root, relative, label) {
  repoPath(relative, label);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => fail(`${label}: missing ${relative}`));
    if (stat.isSymbolicLink()) fail(`${label}: symlinks are not allowed: ${relative}`);
  }
  const stat = await fs.stat(current);
  if (!stat.isFile()) fail(`${label}: not a regular file: ${relative}`);
  return current;
}
function outputPath(source) {
  if (source === 'README.md') return 'index.html';
  if (source.endsWith('/README.md')) return `${source.slice(0, -'README.md'.length)}index.html`;
  return `${source.slice(0, -3)}.html`;
}
function slug(text) {
  return text.toLowerCase().trim().replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '')
    .replace(/\s/g, '-');
}
function headings(tokens, aliases = {}) {
  const ids = new Map();
  const anchors = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const title = (inline.children || []).map(t => t.type === 'image' ? t.content : (t.content || '')).join('');
    const base = slug(title);
    const count = ids.get(base) || 0;
    ids.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    tokens[i].attrSet('id', id);
    anchors.add(id);
  }
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) fail('headingAliases must be an object');
  for (const [alias, target] of Object.entries(aliases)) {
    if (!alias || alias !== slug(alias) || typeof target !== 'string' || !anchors.has(target)) {
      fail(`headingAliases: invalid alias or missing target: ${alias}`);
    }
    if (anchors.has(alias)) fail(`headingAliases: alias conflicts with a heading: ${alias}`);
    const heading = tokens.find(token => token.type === 'heading_open' && token.attrGet('id') === target);
    heading.meta = { ...heading.meta, headingAliases: [...(heading.meta?.headingAliases || []), alias] };
  }
  for (const alias of Object.keys(aliases)) anchors.add(alias);
  return anchors;
}
function localUrl(raw, source) {
  if (privateLocation.test(raw)) fail(`${source}: private local address is forbidden: ${raw}`);
  if (raw.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
  if (raw.startsWith('/')) fail(`${source}: absolute local link is forbidden: ${raw}`);
  const hashIndex = raw.indexOf('#');
  const beforeHash = hashIndex < 0 ? raw : raw.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  const pathPart = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : beforeHash.slice(queryIndex);
  let relative;
  try { relative = decodeURIComponent(pathPart); }
  catch { fail(`${source}: malformed URL escape: ${raw}`); }
  if (relative.startsWith('/') || relative.includes('\\') || relative.includes('\0')) fail(`${source}: invalid local link: ${raw}`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), relative));
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    fail(`${source}: link escapes repository: ${raw}`);
  }
  let fragment;
  try { fragment = hashIndex < 0 ? '' : decodeURIComponent(raw.slice(hashIndex + 1)); }
  catch { fail(`${source}: malformed anchor: ${raw}`); }
  return { target: relative ? resolved : source, fragment, query };
}
function walkTokens(tokens, callback) {
  for (const token of tokens) {
    if (token.type === 'link_open' && token.attrGet('href')) callback(token, 'href');
    if (token.type === 'image' && token.attrGet('src')) callback(token, 'src');
    if (token.children) walkTokens(token.children, callback);
  }
}
function relUrl(from, to, fragment = '', query = '') {
  let relative = path.posix.relative(path.posix.dirname(from), to);
  if (!relative) relative = path.posix.basename(to);
  return `${relative.split('/').map(encodeURIComponent).join('/')}${query}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`;
}
export async function check(root) {
  const manifestFile = await regularFile(root, 'docs/site.json', 'manifest');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); }
  catch (error) { fail(`docs/site.json: ${error.message}`); }
  if (!manifest || typeof manifest.title !== 'string' || !manifest.title.trim() ||
      typeof manifest.description !== 'string' || !Array.isArray(manifest.pages) || !manifest.pages.length) {
    fail('docs/site.json: expected title, description, and nonempty pages array');
  }
  const pagePaths = new Set();
  const outputPaths = new Set();
  const pages = [];
  for (const entry of manifest.pages) {
    if (!entry || typeof entry.title !== 'string' || !entry.title.trim() ||
        typeof entry.group !== 'string' || !entry.group.trim()) fail('docs/site.json: each page needs title and group');
    const source = repoPath(entry.path, 'manifest');
    if (!source.endsWith('.md')) fail(`manifest: expected Markdown file: ${source}`);
    if (pagePaths.has(source)) fail(`manifest: duplicate page: ${source}`);
    pagePaths.add(source);
    const output = outputPath(source);
    if (outputPaths.has(output)) fail(`manifest: duplicate output: ${output}`);
    outputPaths.add(output);
    const filename = await regularFile(root, source, 'manifest');
    const content = await fs.readFile(filename, 'utf8');
    if (privateLocation.test(content)) fail(`${source}: contains a private local address`);
    const tokens = markdown.parse(content, {});
    pages.push({ ...entry, source, output, tokens, anchors: headings(tokens, entry.headingAliases), hasMermaid: tokens.some(token => token.type === 'fence' && /^mermaid(?:\s|$)/i.test(token.info.trim())) });
  }
  const byPath = new Map(pages.map(page => [page.source, page]));
  const assets = new Set();
  for (const page of pages) {
    const links = [];
    walkTokens(page.tokens, (token, attr) => links.push({ token, attr, raw: token.attrGet(attr) }));
    for (const { token, attr, raw } of links) {
      const local = localUrl(raw, page.source);
      if (!local) continue;
      const { target, fragment, query } = local;
      if (target.endsWith('.md')) {
        const destination = byPath.get(target);
        if (!destination) fail(`${page.source}: Markdown link is not published: ${raw}`);
        if (fragment && !destination.anchors.has(fragment)) fail(`${page.source}: missing heading #${fragment} in ${target}`);
        token.attrSet(attr, relUrl(page.output, destination.output, fragment, query));
      } else {
        if (!target.startsWith('docs/assets/')) fail(`${page.source}: local asset must be under docs/assets/: ${raw}`);
        await regularFile(root, target, page.source);
        assets.add(target);
        token.attrSet(attr, relUrl(page.output, target, fragment, query));
      }
    }
  }
  return { manifest, pages, assets: [...assets].sort() };
}

function pageHtml(manifest, page, pages) {
  const groups = new Map();
  for (const item of pages) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  const nav = [...groups].map(([group, items]) => `<section class="nav-group"><h2>${escapeHtml(group)}</h2>${items.map(item =>
    `<a href="${escapeHtml(relUrl(page.output, item.output))}"${item.source === page.source ? ' aria-current="page"' : ''}>${escapeHtml(item.title)}</a>`).join('')}</section>`).join('');
  const stylesheet = relUrl(page.output, 'assets/style.css');
  const script = page.hasMermaid ? `<script defer src="${escapeHtml(relUrl(page.output, 'assets/mermaid.js'))}"></script>` : '';
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${escapeHtml(manifest.description)}"><title>${escapeHtml(page.title)} · ${escapeHtml(manifest.title)}</title><link rel="stylesheet" href="${escapeHtml(stylesheet)}">${script}</head><body><div class="layout"><aside class="sidebar"><a class="brand" href="${escapeHtml(relUrl(page.output, 'index.html'))}">${escapeHtml(manifest.title)}</a><details class="mobile-nav"><summary>目录</summary><nav>${nav}</nav></details><nav class="desktop-nav">${nav}</nav></aside><main class="content"><p class="eyebrow">${escapeHtml(page.group)}</p><article class="markdown">${markdown.renderer.render(page.tokens, markdown.options, {})}</article><footer>${escapeHtml(manifest.title)}</footer></main></div></body></html>\n`;
}

export async function build(root) {
  const result = await check(root);
  const destination = path.join(root, 'site');
  const existing = await fs.lstat(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail('site/: output must be a regular directory');
    const oldMarker = await fs.readFile(path.join(destination, marker), 'utf8').catch(() => null);
    if (oldMarker !== 'evoloop-docs-v1\n') fail('site/: refusing to replace a directory not made by this builder');
  }
  const staging = await fs.mkdtemp(path.join(root, '.site-build-'));
  try {
    await fs.writeFile(path.join(staging, marker), 'evoloop-docs-v1\n');
    await fs.mkdir(path.join(staging, 'assets'), { recursive: true });
    await fs.copyFile(path.join(here, 'style.css'), path.join(staging, 'assets/style.css'));
    if (result.pages.some(page => page.hasMermaid)) {
      await bundle({
        entryPoints: [path.join(here, 'mermaid-client.js')],
        outfile: path.join(staging, 'assets/mermaid.js'),
        bundle: true,
        minify: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        logLevel: 'silent',
      });
    }
    for (const page of result.pages) {
      const output = path.join(staging, page.output);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, pageHtml(result.manifest, page, result.pages));
    }
    for (const asset of result.assets) {
      const output = path.join(staging, asset);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(path.join(root, asset), output);
    }
    if (existing) await fs.rm(destination, { recursive: true });
    await fs.rename(staging, destination);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return result;
}
