import { mountArchitectureViewer, validateModel } from './viewer.js';
import { mountSystemReading } from './reading.js';

// Existing links into the complete map remain valid. A fresh visit starts with meaning.
export function pageView(hash = '') {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.has('read')) return 'reading';
  return ['open', 'node', 'mode', 'journey', 'zoom'].some(key => params.has(key)) ||
    params.get('view') === 'modules' ? 'modules' : 'reading';
}

export function mountSystemApp(root, model) {
  validateModel(model);
  root.className = 'system-app';
  const create = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text) element.textContent = text;
    return element;
  };
  const header = create('header', 'system-header');
  const identity = create('div', 'system-identity');
  identity.append(create('span', 'system-name', 'evoLoop'),
    create('span', 'system-status', '目标设计 · 业务系统尚未实现'));
  const title = create('h1', '', '系统架构');
  const controls = create('nav', 'system-views');
  controls.setAttribute('aria-label', '架构阅读层次');
  const readingButton = create('button', '', '理解系统');
  const moduleButton = create('button', '', '完整模块 · 12 个拟议包');
  readingButton.type = moduleButton.type = 'button';
  controls.append(readingButton, moduleButton);
  const refs = create('details', 'system-sources');
  refs.append(create('summary', '', '图源与版本'));
  const sourceList = create('div', 'system-source-list');
  for (const [label, href] of [
    ['Archify 工作与反馈机制图', 'evoloop-system-loop.html'],
    ['Archify 四部分责任图', model.nativeOverviewUrl],
    ['Archify 完整模块树', model.nativeTreeUrl],
    ['固定文档来源 · ' + model.repository.revision.slice(0, 12), model.repository.url + '/tree/' + model.repository.revision],
  ]) {
    const anchor = create('a', '', label);
    anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    sourceList.append(anchor);
  }
  refs.append(sourceList);
  const bar = create('div', 'system-bar'); bar.append(controls, refs);
  header.append(identity, title, bar);
  const readingPanel = create('main', 'system-reading-panel');
  const readingRoot = create('div', ''); readingPanel.append(readingRoot);
  const modulePanel = create('main', 'system-module-panel');
  const atlasRoot = create('div', ''); modulePanel.append(atlasRoot);
  root.replaceChildren(header, readingPanel, modulePanel);
  let atlas = null;
  let atlasHash = '#view=modules&open=authority';
  let readingHash = '#read=loop';
  const selectHash = hash => {
    if (location.hash !== hash) location.hash = hash;
    else show();
  };
  readingButton.addEventListener('click', () => {
    if (pageView(location.hash) === 'modules') atlasHash = location.hash;
    selectHash(readingHash);
  });
  moduleButton.addEventListener('click', () => {
    if (new URLSearchParams(location.hash.slice(1)).has('read')) readingHash = location.hash;
    selectHash(atlasHash);
  });
  mountSystemReading(readingRoot, model, { onExplore: id => {
    const params = new URLSearchParams({ view: 'modules' });
    if (id) params.set('node', id);
    else params.append('open', 'authority');
    selectHash('#' + params);
  } });
  function show() {
    const modules = pageView(location.hash) === 'modules';
    readingPanel.hidden = modules; modulePanel.hidden = !modules;
    readingButton.setAttribute('aria-pressed', String(!modules));
    moduleButton.setAttribute('aria-pressed', String(modules));
    if (modules) {
      atlasHash = location.hash;
      if (!atlas) atlas = mountArchitectureViewer(atlasRoot, model);
      requestAnimationFrame(() => {
        if (!modulePanel.hidden && atlas.state.focus) atlas.focusNode(atlas.state.focus, true);
      });
    } else if (new URLSearchParams(location.hash.slice(1)).has('read')) readingHash = location.hash;
  }
  window.addEventListener('hashchange', show);
  show();
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('architecture-app');
  const data = document.getElementById('architecture-model');
  if (root && data) {
    try { mountSystemApp(root, JSON.parse(data.textContent)); }
    catch (error) { root.textContent = `架构图无法载入：${error.message}`; }
  }
}
