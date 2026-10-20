const EDGE_KINDS = ['runtime', 'dependency', 'ownership'];
const NODE_KINDS = ['group', 'module', 'detail', 'external', 'actor'];
const STATUSES = ['proposed', 'selected', 'existing', 'conditional'];
const KIND_LABELS = { group: '分组', module: '模块', detail: '职责 / 端口', external: '外部权威', actor: '参与者' };
const STATUS_LABELS = { proposed: '拟议', selected: '方向已定', existing: '现有', conditional: '有条件' };
const EDGE_LABELS = { runtime: '运行关系', dependency: '依赖关系', ownership: '权威归属' };
const LANE_LABELS = ['入口 · 人与现有工具', '协调 · 核心与合同', '适配 · 外部权威'];

function validSource(source) {
  return source && typeof source.path === 'string' && source.path.trim() &&
    Number.isInteger(source.line) && source.line > 0 &&
    (source.endLine === undefined || (Number.isInteger(source.endLine) && source.endLine >= source.line));
}

export function validateModel(model) {
  if (!model || model.schemaVersion !== 1 || typeof model.title !== 'string' ||
      typeof model.description !== 'string' || !model.repository ||
      typeof model.repository.url !== 'string' || typeof model.repository.revision !== 'string' ||
      typeof model.nativeTreeUrl !== 'string' || typeof model.nativeOverviewUrl !== 'string' ||
      !Array.isArray(model.nodes) || !Array.isArray(model.edges)) throw new Error('无效的架构模型头部');
  const ids = new Set();
  for (const node of model.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) ||
        !(node.parent === null || typeof node.parent === 'string') ||
        ![0, 1, 2].includes(node.lane) || typeof node.label !== 'string' || !node.label ||
        typeof node.summary !== 'string' || !NODE_KINDS.includes(node.kind) ||
        !STATUSES.includes(node.status) || (node.path !== undefined && typeof node.path !== 'string') ||
        !Array.isArray(node.sources) || !node.sources.every(validSource) ||
        (node.details !== undefined && (!Array.isArray(node.details) || !node.details.every(
          item => item && typeof item.label === 'string' && typeof item.value === 'string'
        )))) throw new Error(`无效的节点：${node?.id ?? '未知'}`);
    ids.add(node.id);
  }
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  if (model.defaultExpanded !== undefined && (!Array.isArray(model.defaultExpanded) ||
      !model.defaultExpanded.every(id => typeof id === 'string' && byId.has(id))))
    throw new Error('无效的默认展开节点');
  if (model.journeys !== undefined && (!Array.isArray(model.journeys) ||
      !model.journeys.every(journey => journey && typeof journey.id === 'string' && journey.id &&
        typeof journey.label === 'string' && journey.label && typeof journey.note === 'string' &&
        Array.isArray(journey.focus) && journey.focus.every(id => byId.has(id)) &&
        (journey.checks === undefined || (Array.isArray(journey.checks) &&
          journey.checks.every(check => typeof check === 'string' && check.trim())))) ||
      new Set(model.journeys.map(journey => journey.id)).size !== model.journeys.length))
    throw new Error('无效的场景定位');
  for (const node of model.nodes) {
    if (node.parent !== null && !byId.has(node.parent)) throw new Error(`节点 ${node.id} 的父节点不存在`);
    const seen = new Set([node.id]);
    let parent = node.parent;
    while (parent !== null) {
      if (seen.has(parent)) throw new Error(`节点 ${node.id} 形成循环层级`);
      seen.add(parent);
      parent = byId.get(parent).parent;
    }
  }
  const edgeIds = new Set();
  for (const edge of model.edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id) ||
        !byId.has(edge.from) || !byId.has(edge.to) || typeof edge.label !== 'string' || !edge.label ||
        !EDGE_KINDS.includes(edge.kind) || !Array.isArray(edge.sources) || !edge.sources.every(validSource))
      throw new Error(`无效的关系：${edge?.id ?? '未知'}`);
    edgeIds.add(edge.id);
  }
  return model;
}

export function ancestorPath(model, id) {
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  if (!byId.has(id)) return [];
  const path = [];
  let node = byId.get(id);
  while (node) {
    path.unshift(node.id);
    node = node.parent === null ? null : byId.get(node.parent);
  }
  return path;
}

export function expandEdgeAncestors(model, expandedSet, kind) {
  const next = new Set(expandedSet);
  for (const edge of model.edges) if (edge.kind === kind) {
    for (const id of [edge.from, edge.to])
      for (const ancestor of ancestorPath(model, id).slice(0, -1)) next.add(ancestor);
  }
  return next;
}

export function projectGraph(model, expandedSet = new Set(), mode = 'runtime') {
  if (!EDGE_KINDS.includes(mode)) throw new Error(`未知的关系类型：${mode}`);
  const expanded = expandedSet instanceof Set ? expandedSet : new Set(expandedSet);
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const visibleNodes = model.nodes.filter(node => {
    let parent = node.parent;
    while (parent !== null) {
      if (!expanded.has(parent)) return false;
      parent = byId.get(parent).parent;
    }
    return true;
  });
  const visible = new Set(visibleNodes.map(node => node.id));
  const representative = id => {
    let node = byId.get(id);
    while (!visible.has(node.id)) node = byId.get(node.parent);
    return node.id;
  };
  const groups = new Map();
  const internalEdges = [];
  for (const edge of model.edges) {
    if (edge.kind !== mode) continue;
    const from = representative(edge.from);
    const to = representative(edge.to);
    if (from === to) {
      internalEdges.push({ representative: from, edge });
      continue;
    }
    const key = `${from}\u0000${to}`;
    if (!groups.has(key)) groups.set(key, { id: `projected:${mode}:${encodeURIComponent(from)}:${encodeURIComponent(to)}`, from, to, kind: mode, edges: [] });
    groups.get(key).edges.push(edge);
  }
  return { visibleNodes, edges: [...groups.values()], internalEdges };
}

// Route only through the gutters around lane boxes. Points are in unscaled stage coordinates.
export function routeProjectedEdges(edges, nodeBoxes, laneBoxes, stageWidth) {
  const boxes = nodeBoxes instanceof Map ? nodeBoxes : new Map(Object.entries(nodeBoxes));
  const items = edges.filter(edge => boxes.has(edge.from) && boxes.has(edge.to)).map(edge => {
    const a = boxes.get(edge.from), b = boxes.get(edge.to);
    const same = a.lane === b.lane;
    const sideA = same ? (a.lane === 0 ? 'left' : 'right') : (a.lane < b.lane ? 'right' : 'left');
    const sideB = same ? sideA : (a.lane < b.lane ? 'left' : 'right');
    const bucket = same ? (a.lane === 0 ? 'outer-left' : a.lane === 2 ? 'outer-right' : 'gap-1') :
      `gap-${Math.abs(a.lane - b.lane) > 1 ? (a.lane === 0 ? 0 : 1) : Math.min(a.lane, b.lane)}`;
    return { edge, a, b, sideA, sideB, bucket };
  });
  const bucketGroups = new Map();
  const portGroups = new Map();
  for (const item of items) {
    if (!bucketGroups.has(item.bucket)) bucketGroups.set(item.bucket, []);
    bucketGroups.get(item.bucket).push(item);
    for (const [id, side] of [[item.edge.from, item.sideA], [item.edge.to, item.sideB]]) {
      const key = `${id}\u0000${side}`;
      if (!portGroups.has(key)) portGroups.set(key, []);
      portGroups.get(key).push(item);
    }
  }
  const portY = (item, id, side) => {
    const group = portGroups.get(`${id}\u0000${side}`);
    const box = boxes.get(id);
    const y = box.top + box.height * (group.indexOf(item) + 1) / (group.length + 1);
    return Math.min(box.bottom - 7, Math.max(box.top + 7, y));
  };
  const channelX = item => {
    const group = bucketGroups.get(item.bucket);
    const slot = group.indexOf(item) + 1;
    if (item.bucket === 'outer-left') return Math.max(12, laneBoxes[0].left - 14 - slot * 8);
    if (item.bucket === 'outer-right') return Math.min(stageWidth - 12, laneBoxes[2].right + 14 + slot * 8);
    const gap = Number(item.bucket.slice(-1));
    const left = laneBoxes[gap].right, right = laneBoxes[gap + 1].left;
    return left + 12 + (right - left - 24) * slot / (group.length + 1);
  };
  const routes = items.map(item => {
    const x1 = item.sideA === 'left' ? item.a.left : item.a.right;
    const x2 = item.sideB === 'left' ? item.b.left : item.b.right;
    const y1 = portY(item, item.edge.from, item.sideA);
    const y2 = portY(item, item.edge.to, item.sideB);
    const channel = channelX(item);
    let points;
    if (Math.abs(item.a.lane - item.b.lane) > 1) {
      const secondGap = item.a.lane === 0 ? 1 : 0;
      const next = (laneBoxes[secondGap].right + laneBoxes[secondGap + 1].left) / 2;
      const top = 9 + bucketGroups.get(item.bucket).indexOf(item) * 5;
      points = [[x1, y1], [channel, y1], [channel, top], [next, top], [next, y2], [x2, y2]];
    } else points = [[x1, y1], [channel, y1], [channel, y2], [x2, y2]];
    const label = { x: channel + (item.bucket === 'outer-left' ? -10 : 10), y: (y1 + y2) / 2 - 7 };
    return { edge: item.edge, points, label, labelRun: [Math.min(y1, y2), Math.max(y1, y2)] };
  });
  const placed = [];
  for (const route of routes) {
    if ((route.edge.edges?.length || 0) < 2) continue;
    const [low, high] = route.labelRun;
    const base = route.label;
    const yOptions = [0, 24, -24, 48, -48, 72, -72].map(offset => base.y + offset)
      .filter(y => high - low < 20 || (y >= low + 8 && y <= high - 8));
    if (!yOptions.length) yOptions.push(base.y);
    const xOptions = [0, 24, -24, 48, -48].map(offset => base.x + offset)
      .filter(x => x >= 14 && x <= stageWidth - 14);
    const clear = (x, y) => placed.every(label => Math.hypot(x - label.x, y - label.y) >= 22);
    let chosen = null;
    for (const x of xOptions) {
      for (const y of yOptions) {
        if (clear(x, y)) { chosen = { x, y }; break; }
      }
      if (chosen) break;
    }
    route.label = chosen || base;
    placed.push(route.label);
  }
  return routes;
}

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}
function button(label, className, callback) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}
function safeLink(url) {
  try {
    const parsed = new URL(url, document.baseURI);
    return ['https:', 'http:', 'file:'].includes(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}
function link(label, url, className) {
  const href = safeLink(url);
  if (!href) return el('span', className, label);
  const anchor = el('a', className, label);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}
function sourceLink(model, source) {
  const range = source.endLine ? `L${source.line}–${source.endLine}` : `L${source.line}`;
  const base = model.repository.url.replace(/\/$/, '');
  const path = source.path.split('/').map(encodeURIComponent).join('/');
  return link(`${source.path}:${range}`, `${base}/blob/${encodeURIComponent(model.repository.revision)}/${path}#L${source.line}`, 'source-link');
}
function modelLink(model, path) {
  const base = model.repository.url.replace(/\/$/, '');
  const target = path.endsWith('/') ? 'tree' : 'blob';
  return `${base}/${target}/${encodeURIComponent(model.repository.revision)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
export function parseViewState(model, hash = '') {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const ids = new Set(model.nodes.map(node => node.id));
  const expanded = new Set(params.has('open') ? params.getAll('open').filter(id => ids.has(id)) : model.defaultExpanded || []);
  const focus = ids.has(params.get('node')) ? params.get('node') : null;
  const mode = EDGE_KINDS.includes(params.get('mode')) ? params.get('mode') : 'runtime';
  const journey = (model.journeys || []).some(item => item.id === params.get('journey')) ? params.get('journey') : null;
  const zoom = Math.min(2, Math.max(.55, Number(params.get('zoom')) || 1));
  if (focus) for (const id of ancestorPath(model, focus).slice(0, -1)) expanded.add(id);
  return { expanded, focus, mode, zoom, journey };
}
export function serializeViewState(state) {
  const params = new URLSearchParams();
  if (state.focus) params.set('node', state.focus);
  if (state.expanded.size) for (const id of state.expanded) params.append('open', id);
  else params.append('open', '');
  if (state.mode !== 'runtime') params.set('mode', state.mode);
  if (state.journey) params.set('journey', state.journey);
  if (state.zoom !== 1) params.set('zoom', String(Math.round(state.zoom * 100) / 100));
  return `#${params}`;
}
function readState(model) { return parseViewState(model, location.hash); }
function writeState(state) {
  const hash = serializeViewState(state);
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

export function mountArchitectureViewer(root, model) {
  validateModel(model);
  if (!root) throw new Error('架构地图容器不存在');
  const children = new Map(model.nodes.map(node => [node.id, []]));
  for (const node of model.nodes) if (node.parent !== null) children.get(node.parent).push(node);
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const state = readState(model);
  let selectedEdge = null;
  let searchResult = [];
  let searchIndex = 0;
  let renderQueued = false;
  let drag = null;

  root.className = 'architecture-viewer';
  root.replaceChildren();
  const header = el('header', 'map-header');
  const titleRow = el('div', 'title-row');
  const heading = el('div');
  heading.append(el('p', 'eyebrow', 'evoLoop · 全局目标架构'), el('h1', '', model.title));
  const badge = el('div', 'revision-badge');
  badge.title = model.repository.revision;
  badge.append(el('span', '', '来源版本'), el('strong', '', model.repository.revision.slice(0, 12)));
  titleRow.append(heading, badge);
  const refs = el('nav', 'map-references');
  refs.setAttribute('aria-label', '架构图来源');
  refs.append(link('完整模块索引 ↗', model.nativeTreeUrl), link('系统结构 ↗', model.nativeOverviewUrl), link('仓库源版本 ↗', `${model.repository.url.replace(/\/$/, '')}/tree/${encodeURIComponent(model.repository.revision)}`));
  header.append(titleRow, refs, el('p', 'boundary-hint', '包=代码边界；协调进程=运行装配；Role=职责、Session=承载、Run=一次运行。'));

  const toolbar = el('div', 'map-toolbar');
  const search = el('input', 'map-search');
  search.type = 'search';
  search.placeholder = '搜索模块、职责或路径';
  search.setAttribute('aria-label', '搜索架构节点');
  const searchCount = el('span', 'search-count');
  const modes = el('div', 'mode-switch');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', '关系类型');
  const modeButtons = EDGE_KINDS.map(kind => button(EDGE_LABELS[kind], '', () => {
    state.mode = kind; selectedEdge = null;
    if (kind === 'ownership') state.expanded = expandEdgeAncestors(model, state.expanded, kind);
    render();
  }));
  modes.append(...modeButtons);
  const actions = el('div', 'map-actions');
  actions.append(button('展开全部', '', () => { state.expanded = new Set(children.keys()); render(); }),
    button('收起全部', '', () => { state.expanded.clear(); state.focus = null; render(); }),
    button('复位', '', () => { state.expanded = new Set(model.defaultExpanded || []); state.focus = null; state.mode = 'runtime'; state.zoom = 1; state.journey = null; selectedEdge = null; search.value = ''; searchResult = []; searchCount.textContent = ''; render(); resetPan(); }));
  toolbar.append(search, searchCount, modes, actions);

  const journeyBar = el('div', 'journey-bar');
  const journeyNote = el('p', 'journey-note');
  journeyBar.append(el('strong', '', '场景定位'));
  const journeyButtons = (model.journeys || []).map(journey => button(journey.label, '', () => {
    state.journey = journey.id; state.mode = 'runtime'; state.focus = null; selectedEdge = null;
    for (const id of journey.focus) for (const ancestor of ancestorPath(model, id).slice(0, -1)) state.expanded.add(ancestor);
    render();
  }));
  journeyBar.append(...journeyButtons, button('清除场景', '', () => { state.journey = null; render(); }), journeyNote);

  const workspace = el('div', 'map-workspace');
  const canvas = el('div', 'map-canvas');
  const stage = el('div', 'map-stage');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('edge-layer');
  svg.setAttribute('aria-label', '当前关系类型的有向连线');
  const lanes = el('div', 'map-lanes');
  stage.append(lanes, svg);
  canvas.append(stage);
  const zoomControls = el('div', 'zoom-controls');
  zoomControls.append(button('−', '', () => zoomTo(state.zoom - .15)), button('100%', '', () => zoomTo(1)), button('+', '', () => zoomTo(state.zoom + .15)));
  canvas.append(zoomControls);
  const detail = el('aside', 'map-detail');
  detail.setAttribute('aria-label', '节点与关系详情');
  workspace.append(canvas, detail);
  root.append(header, toolbar, ...(model.journeys?.length ? [journeyBar] : []), workspace);

  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => queueEdges());
  if (ro) ro.observe(stage);
  window.addEventListener('resize', queueEdges);
  window.addEventListener('hashchange', () => {
    // The system reading page shares this asset, but has its own deep links.
    if (new URLSearchParams(location.hash.slice(1)).has('read') || new URLSearchParams(location.hash.slice(1)).get('view') === 'structure' || !location.hash) return;
    const next = readState(model);
    Object.assign(state, next);
    selectedEdge = null;
    render();
  });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLocaleLowerCase();
    searchResult = q ? model.nodes.filter(node => `${node.label} ${node.summary} ${node.path || ''}`.toLocaleLowerCase().includes(q)) : [];
    searchIndex = 0;
    searchCount.textContent = q ? `${searchResult.length} 个结果 · Enter 定位` : '';
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter' && searchResult.length) {
      event.preventDefault();
      const node = searchResult[searchIndex++ % searchResult.length];
      focusNode(node.id, true);
      searchCount.textContent = `${(searchIndex - 1) % searchResult.length + 1} / ${searchResult.length}`;
    }
  });
  canvas.addEventListener('pointerdown', event => {
    if (event.target.closest('button, a, input, .map-node, [role="button"], .edge-hit, .edge-count')) return;
    drag = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    canvas.classList.add('is-dragging');
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    canvas.scrollLeft = drag.left - (event.clientX - drag.x);
    canvas.scrollTop = drag.top - (event.clientY - drag.y);
  });
  canvas.addEventListener('pointerup', () => { drag = null; canvas.classList.remove('is-dragging'); });
  canvas.addEventListener('pointercancel', () => { drag = null; canvas.classList.remove('is-dragging'); });

  function zoomTo(value) { state.zoom = Math.min(2, Math.max(.55, Math.round(value * 100) / 100)); renderScale(); writeState(state); }
  function renderScale() {
    stage.style.transform = `scale(${state.zoom})`;
    stage.style.marginRight = `${Math.max(0, (state.zoom - 1) * stage.offsetWidth)}px`;
    stage.style.marginBottom = `${Math.max(0, (state.zoom - 1) * stage.offsetHeight)}px`;
    zoomControls.children[1].textContent = `${Math.round(state.zoom * 100)}%`;
  }
  function resetPan() { canvas.scrollTo({ left: 0, top: 0 }); }
  function queueEdges() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; drawEdges(); renderScale(); });
  }
  function focusNode(id, scroll) {
    const restoreFocus = !scroll && document.activeElement?.dataset.nodeId === id;
    for (const ancestor of ancestorPath(model, id).slice(0, -1)) state.expanded.add(ancestor);
    state.focus = id; selectedEdge = null; render();
    if (restoreFocus) focusRenderedNode(id);
    if (scroll) requestAnimationFrame(() => {
      const target = renderedNode(id);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      target?.focus({ preventScroll: true });
    });
  }
  function renderedNode(id) {
    return [...lanes.querySelectorAll('[data-node-id]')].find(element => element.dataset.nodeId === id);
  }
  function focusRenderedNode(id, part = 'card') {
    const card = renderedNode(id);
    const target = part === 'toggle' ? card?.querySelector('.node-toggle') : card;
    target?.focus({ preventScroll: true });
  }
  function toggleNode(id, focusPart = 'card') {
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
      if (state.focus && ancestorPath(model, state.focus).includes(id) && state.focus !== id) state.focus = id;
    } else state.expanded.add(id);
    render();
    focusRenderedNode(id, focusPart);
  }
  function renderNode(node, depth) {
    const hasChildren = children.get(node.id).length > 0;
    const journey = (model.journeys || []).find(item => item.id === state.journey);
    const card = el('div', `map-node kind-${node.kind} status-${node.status}${state.focus === node.id ? ' is-focused' : ''}${journey?.focus.includes(node.id) ? ' is-journey' : ''}`);
    card.dataset.nodeId = node.id;
    card.id = `map-node-${encodeURIComponent(node.id).replace(/%/g, '_')}`;
    card.style.setProperty('--depth', Math.min(depth, 5));
    card.tabIndex = 0;
    const top = el('div', 'node-top');
    const kind = el('span', 'node-kind', KIND_LABELS[node.kind]);
    const status = el('span', 'node-status', STATUS_LABELS[node.status]);
    top.append(kind, status);
    const label = el('div', 'node-label', node.label);
    const summary = el('div', 'node-summary', node.summary);
    card.append(top, label, summary);
    if (hasChildren) {
      const toggle = button(state.expanded.has(node.id) ? '− 收起' : `＋ 展开 ${children.get(node.id).length}`, 'node-toggle', event => { event.stopPropagation(); toggleNode(node.id, 'toggle'); });
      toggle.setAttribute('aria-expanded', String(state.expanded.has(node.id)));
      toggle.setAttribute('aria-controls', `children-${encodeURIComponent(node.id).replace(/%/g, '_')}`);
      toggle.addEventListener('keydown', event => {
        event.stopPropagation();
        if ((event.key === 'ArrowRight' && !state.expanded.has(node.id)) ||
            (event.key === 'ArrowLeft' && state.expanded.has(node.id))) {
          event.preventDefault();
          toggleNode(node.id, 'toggle');
        }
      });
      card.append(toggle);
    }
    card.addEventListener('click', () => focusNode(node.id, false));
    card.addEventListener('keydown', event => {
      if (event.target !== card) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        if (hasChildren) { state.focus = node.id; selectedEdge = null; toggleNode(node.id); }
        else focusNode(node.id, false);
      }
      if (event.key === ' ' && hasChildren) { event.preventDefault(); toggleNode(node.id); }
      if (event.key === 'ArrowRight' && hasChildren && !state.expanded.has(node.id)) { event.preventDefault(); toggleNode(node.id); }
      if (event.key === 'ArrowLeft' && hasChildren && state.expanded.has(node.id)) { event.preventDefault(); toggleNode(node.id); }
    });
    const wrap = el('div', 'node-wrap');
    wrap.append(card);
    if (hasChildren && state.expanded.has(node.id)) {
      const nested = el('div', 'node-children');
      nested.id = `children-${encodeURIComponent(node.id).replace(/%/g, '_')}`;
      for (const child of children.get(node.id)) nested.append(renderNode(child, depth + 1));
      wrap.append(nested);
    }
    return wrap;
  }
  function render() {
    const projected = projectGraph(model, state.expanded, state.mode);
    lanes.replaceChildren();
    for (let lane = 0; lane < 3; lane++) {
      const column = el('section', 'map-lane');
      column.append(el('h2', '', LANE_LABELS[lane]));
      const roots = model.nodes.filter(node => node.parent === null && node.lane === lane);
      for (const node of roots) column.append(renderNode(node, 0));
      lanes.append(column);
    }
    modeButtons.forEach((control, index) => {
      const active = EDGE_KINDS[index] === state.mode;
      control.classList.toggle('active', active);
      control.setAttribute('aria-pressed', String(active));
    });
    const journey = (model.journeys || []).find(item => item.id === state.journey);
    journeyButtons.forEach((control, index) => control.classList.toggle('active', model.journeys[index].id === state.journey));
    journeyNote.textContent = journey ? journey.note : '选择场景以定位涉及的节点；高亮仅依据模型中已有的关系。';
    renderDetail(projected);
    writeState(state);
    queueEdges();
  }
  function renderSources(container, sources) {
    if (!sources.length) { container.append(el('span', 'muted', '模型未列出直接来源')); return; }
    const list = el('ul', 'source-list');
    for (const source of sources) { const item = el('li'); item.append(sourceLink(model, source)); list.append(item); }
    container.append(list);
  }
  function renderRelationList(container, edges, title) {
    if (!edges.length) return;
    container.append(el('h3', '', title));
    const list = el('div', 'relation-list');
    for (const edge of edges) {
      const item = el('article', 'relation-item');
      item.append(el('strong', '', edge.label), el('p', '', `${byId.get(edge.from).label} → ${byId.get(edge.to).label}`));
      renderSources(item, edge.sources);
      list.append(item);
    }
    container.append(list);
  }
  function renderDetail(projected) {
    detail.replaceChildren();
    const journey = (model.journeys || []).find(item => item.id === state.journey);
    if (journey && !selectedEdge && !state.focus) {
      detail.append(el('p', 'eyebrow', '场景定位 · 目标设计'), el('h2', '', journey.label),
        el('p', '', journey.note),
        el('p', 'muted', '这里只定位设计中已声明关系涉及的模块，不判断具体对象的完整影响范围。'));
      detail.append(el('h3', '', '已定位模块'));
      const targets = el('div', 'journey-targets');
      for (const id of journey.focus) targets.append(button(byId.get(id).label, 'journey-focus', () => focusNode(id, true)));
      detail.append(targets);
      detail.append(el('h3', '', '仍需核对'));
      const checks = el('ul', 'journey-checks');
      for (const check of journey.checks || ['具体对象、固定基线和责任决定须依来源逐项核对。']) checks.append(el('li', '', check));
      detail.append(checks);
      return;
    }
    if (journey) {
      const context = el('div', 'journey-context');
      context.append(el('strong', '', `场景：${journey.label}`), el('p', '', journey.note),
        button('返回场景定位', '', () => { state.focus = null; selectedEdge = null; render(); }));
      detail.append(context);
    }
    if (selectedEdge) {
      const group = projected.edges.find(edge => edge.id === selectedEdge);
      if (group) {
        detail.append(el('p', 'eyebrow', EDGE_LABELS[group.kind]), el('h2', '', `${byId.get(group.from).label} → ${byId.get(group.to).label}`),
          el('p', 'muted', `折叠投影 · ${group.edges.length} 条原始关系`));
        renderRelationList(detail, group.edges, '逐条核对');
        return;
      }
    }
    const node = state.focus ? byId.get(state.focus) : null;
    if (!node) {
      detail.append(el('p', 'eyebrow', '阅读说明'), el('h2', '', '选取节点或连线'),
        el('p', '', model.description),
        el('p', '', '默认显示顶层分组。展开可查看模块与职责；箭头仅代表当前选中的关系类型。折叠后的箭头显示汇总数量，点击可核对原始关系与来源。'),
        el('p', 'muted', '本图是系统地图：用于理解整体装配、跨模块协作和数据权威。层级只表示包含关系；箭头分别表示运行、依赖或权威归属。方向/归属已定不代表生产接入已实现。'));
      return;
    }
    detail.append(el('p', 'eyebrow', `${KIND_LABELS[node.kind]} · ${STATUS_LABELS[node.status]}`), el('h2', '', node.label), el('p', '', node.summary),
      el('p', 'muted', '方向/归属已定不代表生产接入已实现。'));
    if (node.path) {
      const path = el('div', 'detail-field');
      const proposed = node.status === 'proposed' || node.status === 'conditional';
      path.append(el('h3', '', proposed ? '拟议路径' : '代码位置'),
        proposed ? el('code', 'path-link', node.path) : link(node.path, modelLink(model, node.path), 'path-link'));
      detail.append(path);
    }
    if (node.details?.length) {
      const fields = el('dl', 'detail-fields');
      for (const item of node.details) fields.append(el('dt', '', item.label), el('dd', '', item.value));
      detail.append(fields);
    }
    detail.append(el('h3', '', '节点来源'));
    renderSources(detail, node.sources);
    const related = model.edges.filter(edge => edge.kind === state.mode && (edge.from === node.id || edge.to === node.id));
    renderRelationList(detail, related.filter(edge => edge.to === node.id), `${EDGE_LABELS[state.mode]} · 输入`);
    renderRelationList(detail, related.filter(edge => edge.from === node.id), `${EDGE_LABELS[state.mode]} · 输出`);
    const internal = projected.internalEdges.filter(item => item.representative === node.id).map(item => item.edge);
    renderRelationList(detail, internal, `折叠在此节点内 · ${internal.length} 条`);
  }
  function drawEdges() {
    const projected = projectGraph(model, state.expanded, state.mode);
    svg.replaceChildren();
    const box = stage.getBoundingClientRect();
    const scale = state.zoom;
    const width = stage.offsetWidth;
    const height = stage.offsetHeight;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    const defs = document.createElementNS(svg.namespaceURI, 'defs');
    const marker = document.createElementNS(svg.namespaceURI, 'marker');
    marker.setAttribute('id', 'map-arrow'); marker.setAttribute('markerWidth', '8'); marker.setAttribute('markerHeight', '8');
    marker.setAttribute('refX', '7'); marker.setAttribute('refY', '4'); marker.setAttribute('orient', 'auto'); marker.setAttribute('markerUnits', 'strokeWidth');
    const tip = document.createElementNS(svg.namespaceURI, 'path');
    tip.setAttribute('d', 'M0,0 L8,4 L0,8 Z'); tip.setAttribute('fill', 'context-stroke');
    marker.append(tip); defs.append(marker); svg.append(defs);
    function boxFor(element) {
      const rect = element.getBoundingClientRect();
      const left = (rect.left - box.left) / scale, right = (rect.right - box.left) / scale;
      const top = (rect.top - box.top) / scale, bottom = (rect.bottom - box.top) / scale;
      return { left, right, top, bottom, height: bottom - top };
    }
    const nodeBoxes = new Map([...lanes.querySelectorAll('[data-node-id]')].map(element => {
      const node = byId.get(element.dataset.nodeId);
      return [node.id, { ...boxFor(element), lane: node.lane }];
    }));
    const laneBoxes = [...lanes.children].map(boxFor);
    for (const route of routeProjectedEdges(projected.edges, nodeBoxes, laneBoxes, width)) {
      const edge = route.edge;
      const d = route.points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', d);
      const journey = (model.journeys || []).find(item => item.id === state.journey);
      const journeyNodes = new Set(journey?.focus || []);
      const inJourney = edge.edges.some(original => journeyNodes.has(original.from) && journeyNodes.has(original.to));
      path.setAttribute('class', `map-edge${edge.id === selectedEdge ? ' selected' : ''}${inJourney ? ' is-journey' : ''}`);
      path.setAttribute('marker-end', 'url(#map-arrow)');
      const hit = document.createElementNS(svg.namespaceURI, 'path');
      hit.setAttribute('d', path.getAttribute('d')); hit.setAttribute('class', 'edge-hit');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('role', 'button');
      hit.setAttribute('aria-label', `${byId.get(edge.from).label} 到 ${byId.get(edge.to).label}，${edge.edges.length} 条${EDGE_LABELS[edge.kind]}，查看原始关系`);
      const select = () => { selectedEdge = edge.id; state.focus = null; renderDetail(projected); drawEdges(); };
      hit.addEventListener('click', select);
      hit.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
      svg.append(path, hit);
      if (edge.edges.length > 1) {
        const count = document.createElementNS(svg.namespaceURI, 'text');
        count.setAttribute('x', String(route.label.x));
        count.setAttribute('y', String(route.label.y));
        count.setAttribute('class', 'edge-count');
        count.setAttribute('role', 'button');
        count.setAttribute('tabindex', '0');
        count.setAttribute('aria-label', hit.getAttribute('aria-label'));
        count.textContent = String(edge.edges.length);
        count.addEventListener('click', select);
        count.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
        svg.append(count);
      }
    }
  }
  render();
  return { focusNode, render, state };
}
