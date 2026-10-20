// A hand-composed reading layer over the sourced architecture model. It describes
// the target design; the module explorer remains the exhaustive model browser.
import { sourceUrl } from './viewer.js';
const READ_IDS = ['loop', 'revision', 'recovery', 'authority'];

export const READING_REGIONS = Object.freeze({
  decision: { label: '判断与责任', modules: ['owner', 'domain-session', 'cognition-role', 'division-role', 'cognition', 'roles'] },
  task: { label: '受控 Task', modules: ['tasks', 'documents', 'relations', 'pg-basis', 'coordination'] },
  run: { label: 'Session / Run', modules: ['sessions', 'runtime-port', 'codex-adapter', 'pg-runtime', 'reconcile'] },
  use: { label: '真实使用与评价', modules: ['evaluation', 'evaluation-ui', 'pg-evaluation', 'reviews'] },
  wiki: { label: '认识与修订', modules: ['knowledge', 'sourcebridge', 'publication', 'wiki-service', 'wiki-content'] },
  review: { label: '审阅与下一步', modules: ['reviews', 'cognition', 'tasks', 'roles'] },
  postgres: { label: 'PostgreSQL 主数据', modules: ['postgres', 'pg-work', 'pg-basis', 'pg-runtime', 'pg-evaluation'] },
  git: { label: '受管 Git 正文', modules: ['git-repos', 'git-content', 'git-adapter'] },
  feishu: { label: '飞书协作投影', modules: ['feishu', 'feishu-content', 'feishu-adapter', 'connectors'] },
});

export const READING_MECHANISMS = Object.freeze({
  loop: {
    label: '一轮工作怎样闭合', kicker: '工作闭环',
    lead: '判断、执行与反馈相连；交付、验收和实际效果分别核对。',
    route: ['decision', 'task', 'run', 'use', 'review', 'wiki', 'decision'],
    steps: [
      { region: 'decision', title: '提出有依据的判断', body: '领域 session 对照目标、来源和反例；跨领域时由认知责任综合。人类负责人保留目标、授权与关键取舍。', gate: '判断可以选择继续、补证、修订、停止或等待。' },
      { region: 'task', title: '接受并固定任务依据', body: 'Task 写明承接者、交付和验收；TaskBasis 固定本次实际采用的过程 Document、知识或 Git 来源修订。', gate: '已授权、已接受且关键依据有效，才允许派发。' },
      { region: 'run', title: '运行与交付', body: '一次 Task 可有多次 Run；每次 Run 保留自己的输入、状态、回执和历史。', gate: 'Run 终态、通知送达和产物存在均不等于 Task 验收。' },
      { region: 'use', title: '观察真实使用与效果', body: 'Task 按自身约定判据验收；接续方沿真实路径使用成果，另记录采用、失败、效果和成本。', gate: '未实际使用时效果为未知；若 Task 判据要求消费，缺少消费证据不能验收。' },
      { region: 'review', title: '责任者复核评价', body: '对照采用、交付合格、实际效果和成本，决定继续、补证、修订或停止。', gate: '自动评分不自动批准知识、验收任务或关闭目标。' },
      { region: 'wiki', title: '审阅后维护认识', body: 'Wiki 保留原判断、反例、适用条件与修订；改版影响未执行 Task 的依据选择。', gate: '修订不改写已完成 Run 的原依据和验收。' },
    ],
    sources: ['cognition', 'tasks', 'evaluation', 'knowledge'],
  },
  revision: {
    label: '需求或认识改版', kicker: '版本与影响',
    lead: '新修订改变未来的可用依据，但不改写旧 Run 当时采用的版本。',
    route: ['wiki', 'review', 'task', 'run'],
    steps: [
      { region: 'wiki', title: '两个权威产生新修订', body: '过程 Document 新版归 PG；知识新版归外置 Wiki。两者都保留来源、旧判断和变化理由。', gate: '发布、索引可查与消费者采用分别记录。' },
      { region: 'review', title: '扫描影响并交给责任者', body: '找出引用旧版的 Task，形成待复核项；通知送达不证明已处理。', gate: '影响扫描只补齐待办，不能替代派发前有效性检查。' },
      { region: 'task', title: '逐项决定基线', body: '未执行任务可换基线、保留旧版并说明，或开补救任务；执行中由责任者判断是否停止。', gate: '关键依据缺失、撤回或待复核时暂停新派发。' },
      { region: 'run', title: '历史仍按原版解释', body: '旧 Run 仍指向当时的 TaskBasis；已完成任务保留原验收，需要时另建补救。', gate: '普通导航链接不能冒充固定执行依据。' },
    ],
    sources: ['documents', 'pg-basis', 'knowledge', 'relations'],
  },
  recovery: {
    label: '派发结果未知', kicker: '对账与恢复',
    lead: '超时不等于未启动；先查同一操作的真实结果，再决定是否继续。',
    route: ['task', 'run', 'task'],
    steps: [
      { region: 'task', title: '保留原操作 ID', body: '记录派发意图与已知 Run 关联，不用新的请求掩盖未知。', gate: 'Task 状态不能代表 Run 或外部同步状态。' },
      { region: 'run', title: '按层回读', body: '回读 PG Journal / outbox、运行时 Session / 动作；仅在验收要求远端可见时核对 connector 投影。', gate: '本库幂等键不能替代运行时或外部副作用去重。' },
      { region: 'task', title: '按证据分流', body: '证实已启动则跟踪原 Run；证实未启动才重发；仍不能排除执行则保持 unknown。', gate: 'unknown 时禁止重复执行，交给责任者处理。' },
    ],
    sources: ['coordination', 'reconcile', 'pg-runtime', 'operation-journal'],
  },
  authority: {
    label: '数据由谁持有', kicker: '权威边界',
    lead: '正文、主数据与协作投影各有所有者；跨边界只有带版本的引用或受控命令。',
    route: ['postgres', 'wiki', 'git', 'feishu'],
    steps: [
      { region: 'postgres', title: 'PG 持项目主记录', body: 'Task、Schedule、过程 Document 修订、关系、固定依据、Run / Sync / Review 等记录归 evoLoop。', gate: '只保存 Wiki 身份与修订引用，不复制 Wiki 正文和内部依赖。' },
      { region: 'wiki', title: '外置 Wiki 持认识', body: '知识正文、来源、反例、适用条件、修订及内部依赖由 Wiki 维护。', gate: '受控发布与消费者采用是不同状态。' },
      { region: 'git', title: 'Git 持正式规范', body: '产品、架构、开发正文依原仓库 PR 和审阅流程改变，Task 以固定 commit 引用。', gate: '正式 docs/ 不创建过程 Document 行。' },
      { region: 'feishu', title: '飞书提供协作投影', body: '首期 Task 视图是 PG 主记录的投影；入站编辑带身份与所见版本，经 connector / core 核验。', gate: '远端删除、旧版编辑或同步成功都不直接改写主记录与验收。' },
    ],
    sources: ['postgres', 'wiki-service', 'git-repos', 'feishu'],
  },
});

export function parseReadingState(hash = '') {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  const read = params.get('read');
  return READ_IDS.includes(read) ? read : null;
}

function element(tag, className, content) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content !== undefined) result.textContent = content;
  return result;
}
function makeButton(label, className, action) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function addSources(container, model, ids) {
  const seen = new Set();
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) continue;
    for (const source of node.sources.slice(0, 2)) {
      const key = `${source.revision ?? model.repository.revision}:${source.path}:${source.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = element('a', 'sys-source', `${source.path}:${source.line}`);
      a.href = sourceUrl(model, source);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      container.append(a);
    }
  }
}
function addExploreButtons(container, model, ids, onExplore) {
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) continue;
    const status = node.status === 'proposed' ? ' · 拟议' : node.status === 'selected' ? ' · 方向已定' : '';
    container.append(makeButton(`${node.label}${status} ↗`, 'sys-module-link', () => onExplore?.(id)));
  }
}
function makeRegion(key, model, onExplore) {
  const spec = READING_REGIONS[key];
  const region = element('section', `sys-region sys-region-${key}`);
  region.dataset.region = key;
  const text = {
    decision: ['01 / 人与领域认知', '判断下一步', '目标、来源与反例收束成选择。'],
    task: ['02 / 协调软件', '已接受的 Task', '派发前核验接受、授权与依据有效性。'],
    run: ['03 / 承接与执行', 'Session → Run', 'Role 持续；Session 承载；Run 记录一次实际运行。'],
    use: ['04 / 使用与效果', '实际使用', 'Task 按约定验收；效果另看真实使用。'],
    wiki: ['06 / 外置知识权威', '认识 r2 → r3', '经审阅修订，保留来源、反例和适用条件。'],
    review: ['05 / 责任者复核', '审阅评价', '比较采用、结果和成本；可继续、补证、修订或停止。'],
  }[key];
  region.append(element('span', 'sys-region-kicker', text[0]), element('h3', '', text[1]), element('p', '', text[2]));
  if (key === 'task') region.append(element('div', 'sys-evidence sys-evidence-task', 'Task 交付 + 验收判据 · 例：DOC r2 锁定'));
  if (key === 'run') region.append(element('div', 'sys-evidence sys-evidence-run', 'Run 结束 ≠ Task 验收 · 沿用固定依据'));
  if (key === 'use') region.append(element('div', 'sys-evidence sys-evidence-use', '消费 / 失败 / 效果 / 成本证据'));
  const toggle = makeButton('＋ 细节', 'sys-region-toggle', () => {
    const next = region.getAttribute('aria-expanded') !== 'true';
    region.closest('.sys-reading')?.querySelectorAll('.sys-region[aria-expanded="true"]').forEach(item => {
      if (item === region) return;
      item.setAttribute('aria-expanded', 'false');
      const control = item.querySelector('.sys-region-toggle');
      control.setAttribute('aria-expanded', 'false');
      control.setAttribute('aria-label', `展开${READING_REGIONS[item.dataset.region].label}对应模块`);
      control.textContent = '＋ 细节';
    });
    region.setAttribute('aria-expanded', String(next));
    toggle.setAttribute('aria-expanded', String(next));
    toggle.textContent = next ? '− 收起' : '＋ 细节';
    toggle.setAttribute('aria-label', `${next ? '收起' : '展开'}${spec.label}对应模块`);
  });
  toggle.setAttribute('aria-label', `展开${spec.label}对应模块`);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', `sys-modules-${key}`);
  region.setAttribute('aria-expanded', 'false');
  region.append(toggle);
  const drawer = element('div', 'sys-region-drawer');
  drawer.id = `sys-modules-${key}`;
  drawer.append(element('strong', '', `${spec.label} · 模型定位`));
  if (key === 'decision') drawer.append(element('p', '', '目标变化、新证据与用户纠正也可直接触发复核，不必等到一轮工作结束。'));
  if (key === 'task') drawer.append(element('p', '', 'TaskBasis 固定实际采用的来源修订，普通导航不代表接受。任务创建不等于接受执行。'));
  if (key === 'use') drawer.append(element('p', '', '通知送达但接续方未核对时，效果仍未知。纯实现任务可按约定完成，阶段效果另行核验。'));
  addExploreButtons(drawer, model, spec.modules, onExplore);
  region.append(drawer);
  return region;
}
function makeLoopStage(model, onExplore) {
  const scroll = element('div', 'sys-stage-scroll');
  scroll.setAttribute('aria-label', '工作与反馈闭环空间图；窄屏可横向滚动，图后有完整文字步骤');
  const stage = element('div', 'sys-stage sys-stage-loop');
  stage.append(element('div', 'sys-human-band', '人类目标 / 成功条件 / 授权与关键取舍　↓　领域判断与受控执行'));
  const paths = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  paths.setAttribute('class', 'sys-paths');
  paths.setAttribute('viewBox', '0 0 1200 570');
  paths.setAttribute('aria-hidden', 'true');
  paths.innerHTML = `<defs><marker id="sys-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1 L8 4.5 L1 8"/></marker><marker id="sys-arrow-feedback" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1 L8 4.5 L1 8"/></marker></defs>
    <path class="sys-path sys-path-main" d="M330 180 H440" marker-end="url(#sys-arrow)"/>
    <path class="sys-path sys-path-main" d="M740 180 H850" marker-end="url(#sys-arrow)"/>
    <path class="sys-path sys-path-main" d="M1000 260 V385" marker-end="url(#sys-arrow)"/>
    <path class="sys-path sys-path-feedback" d="M850 465 H740" marker-end="url(#sys-arrow-feedback)"/>
    <path class="sys-path sys-path-feedback" d="M440 465 H330" marker-end="url(#sys-arrow-feedback)"/>
    <path class="sys-path sys-path-feedback" d="M190 385 V260" marker-end="url(#sys-arrow-feedback)"/>
    <text class="sys-edge-label" x="385" y="166" text-anchor="middle">接受</text>
    <text class="sys-edge-label" x="795" y="166" text-anchor="middle">派发</text>
    <text class="sys-edge-label" x="1016" y="326">交付与验收</text>
    <text class="sys-edge-label sys-edge-label-feedback" x="795" y="448" text-anchor="middle">使用反馈</text>
    <text class="sys-edge-label sys-edge-label-feedback" x="385" y="448" text-anchor="middle">审阅后修订</text>
    <text class="sys-edge-label sys-edge-label-feedback" x="206" y="326">按任务读取</text>`;
  stage.append(paths);
  for (const key of ['decision', 'task', 'run', 'use', 'review', 'wiki']) stage.append(makeRegion(key, model, onExplore));
  scroll.append(stage);
  return scroll;
}
function makeFocusCard(className, kicker, title, body, gate, moduleIds, model, onExplore) {
  const card = element('section', `sys-focus-card ${className}`);
  card.append(element('span', 'sys-region-kicker', kicker), element('h3', '', title), element('p', '', body));
  if (gate) card.append(element('div', 'sys-focus-gate', gate));
  const details = element('details', 'sys-focus-modules');
  details.append(element('summary', '', '对应模块与端口'));
  const links = element('div', 'sys-authority-links');
  addExploreButtons(links, model, moduleIds, onExplore);
  details.append(links);
  card.append(details);
  return card;
}
function makeFocusedStage(read, model, onExplore) {
  const scroll = element('div', 'sys-stage-scroll');
  scroll.setAttribute('aria-label', `${READING_MECHANISMS[read].label}空间路径；窄屏可横向滚动，图后有完整文字步骤`);
  const stage = element('div', `sys-stage sys-stage-${read}`);
  stage.append(element('div', 'sys-human-band', read === 'revision'
    ? '版本变化 · 新的可用依据影响下一次行动，不追溯改写已发生的 Run'
    : '运行结果未知 · 同一操作先回读证据，未确认前不制造第二次副作用'));
  const paths = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  paths.setAttribute('class', 'sys-paths');
  paths.setAttribute('viewBox', '0 0 1200 570');
  paths.setAttribute('aria-hidden', 'true');
  if (read === 'revision') {
    paths.innerHTML = `<defs><marker id="sys-focus-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1 L8 4.5 L1 8"/></marker><marker id="sys-focus-feedback" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1 L8 4.5 L1 8"/></marker></defs>
      <path class="sys-path sys-path-main" d="M355 169 H435" marker-end="url(#sys-focus-arrow)"/>
      <path class="sys-path sys-path-main" d="M740 169 H820" marker-end="url(#sys-focus-arrow)"/>
      <path class="sys-path sys-path-feedback" d="M980 267 V319" marker-end="url(#sys-focus-feedback)"/>
      <path class="sys-path sys-path-history" d="M205 247 V340" marker-end="url(#sys-focus-arrow)"/>
      <text class="sys-edge-label" x="395" y="150" text-anchor="middle">影响</text>
      <text class="sys-edge-label" x="780" y="150" text-anchor="middle">复核</text>
      <text class="sys-edge-label sys-edge-label-feedback" x="996" y="302">选择</text>
      <text class="sys-edge-label sys-edge-label-history" x="217" y="301">保留 r2 引用</text>`;
    stage.append(paths);
    stage.append(makeFocusCard('sys-focus-a', '01 / 来源保留各版', '同一来源：r2 → r3', '过程 Document 修订归 PG；知识修订归外置 Wiki。新添 r3，r2 原件继续可查。', '发布 ≠ 消费者采用', ['documents', 'pg-work', 'knowledge', 'wiki-service'], model, onExplore));
    stage.append(makeFocusCard('sys-focus-b', '02 / 影响关系', '找到受影响 Task', '扫描引用旧依据的任务，把尚未执行者列为待复核。通知只是提醒。', '扫描不代替派发前校验', READING_REGIONS.review.modules, model, onExplore));
    stage.append(makeFocusCard('sys-focus-c', '03 / 责任者决定', '复核任务基线', '核对授权、接受与关键依据的有效性；待复核或撤回时暂停新派发。', '未执行 Task 逐项选择', READING_REGIONS.task.modules, model, onExplore));
    stage.append(makeFocusCard('sys-focus-history', '历史不回写', '旧 Run 仍按 r2 解释', '旧 Run 保留当时 TaskBasis 和原验收；必要时另建补救任务。', '普通导航 ≠ 固定执行依据', READING_REGIONS.run.modules, model, onExplore));
    const choices = element('div', 'sys-focus-choices');
    choices.append(element('strong', '', '未执行任务的复核结果'));
    for (const choice of ['换到 r3 基线', '保留 r2 并说明', '另建补救 Task']) choices.append(element('span', '', choice));
    stage.append(choices);
  } else {
    paths.innerHTML = `<defs><marker id="sys-focus-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1 L8 4.5 L1 8"/></marker><marker id="sys-focus-feedback" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1 L8 4.5 L1 8"/></marker></defs>
      <path class="sys-path sys-path-main" d="M345 173 H425" marker-end="url(#sys-focus-arrow)"/>
      <path class="sys-path sys-path-main" d="M730 173 H815" marker-end="url(#sys-focus-arrow)"/>
      <path class="sys-path sys-path-feedback" d="M985 260 V306 H210 V344" marker-end="url(#sys-focus-feedback)"/>
      <path class="sys-path sys-path-feedback" d="M985 260 V319 H580 V344" marker-end="url(#sys-focus-feedback)"/>
      <path class="sys-path sys-path-feedback" d="M985 260 V344" marker-end="url(#sys-focus-feedback)"/>
      <text class="sys-edge-label" x="385" y="153" text-anchor="middle">派发</text>
      <text class="sys-edge-label" x="773" y="153" text-anchor="middle">回读</text>
      <text class="sys-edge-label sys-edge-label-feedback" x="733" y="297">凭证据分流 ↓</text>`;
    stage.append(paths);
    stage.append(makeFocusCard('sys-focus-a', '01 / 原操作', '已接受 Task / 原操作 ID', '保留固定依据、派发意图和已知 Run 身份，避免把超时当成未启动。', '发送请求 ≠ 接收或执行', READING_REGIONS.task.modules, model, onExplore));
    stage.append(makeFocusCard('sys-focus-b', '02 / 不确定性', 'Run 回执未知', '可能未启动，也可能已启动而回执丢失；Task 完成态不能代替 Run 结果。', '不盲目重发', READING_REGIONS.run.modules, model, onExplore));
    stage.append(makeFocusCard('sys-focus-c', '03 / 对账门', '按原操作回读', '查 PG Journal / outbox，再查运行时 Session / 动作；远端可见只在验收要求时核对。', '本库幂等键不能代替外部去重', ['operation-journal', 'reconcile', 'pg-runtime', 'runtime-port'], model, onExplore));
    stage.append(makeFocusCard('sys-focus-outcome sys-focus-outcome-a', '结果 A', '已启动 → 跟踪原 Run', '按已知身份继续观察，保留同一次执行的回执和成果。', '', READING_REGIONS.run.modules.slice(0, 2), model, onExplore));
    stage.append(makeFocusCard('sys-focus-outcome sys-focus-outcome-b', '结果 B', '未启动 → 才可重发', '只有证据排除已执行，才发起受控重试。', '', READING_REGIONS.task.modules.slice(0, 2), model, onExplore));
    stage.append(makeFocusCard('sys-focus-outcome sys-focus-outcome-c', '结果 C', '仍未知 → 暂停', '保持 unknown，禁止重复执行，交给责任者处理。', '', ['coordination', 'reconcile'], model, onExplore));
  }
  scroll.append(stage);
  return scroll;
}
function makeAuthorityStage(model, onExplore) {
  const stage = element('div', 'sys-authority-stage');
  stage.append(element('div', 'sys-authority-intro', '三处正文 / 主记录各守自己的权威。跨域引用带身份与版本；修改走各自的审阅门。'));
  const grid = element('div', 'sys-authority-grid');
  const cards = [
    ['postgres', '项目主记录', 'PostgreSQL / evoLoop', 'Task · Schedule · 过程 Document 修订 · Run / Review / Sync', '只保存 Wiki 引用与跨对象关系；固定 TaskBasis'],
    ['wiki', '知识正文', '外置 Wiki', '来源 · 反例 · 适用条件 · 知识修订与内部依赖', '发布需审阅；读取或送达不证明采用'],
    ['git', '正式规范', '受管 Git', '产品 / 架构 / 开发 docs/ 正文和固定 commit', '只经原仓库 PR / 审阅改写；不建 Document 行'],
  ];
  for (const [key, eyebrow, heading, body, gate] of cards) {
    const card = element('section', `sys-authority-card sys-authority-${key}`);
    card.dataset.region = key;
    card.append(element('span', 'sys-region-kicker', eyebrow), element('h3', '', heading), element('p', '', body), element('div', 'sys-authority-gate', gate));
    const links = element('div', 'sys-authority-links');
    addExploreButtons(links, model, READING_REGIONS[key].modules, onExplore);
    card.append(links);
    grid.append(card);
  }
  stage.append(grid);
  const feishu = element('section', 'sys-feishu-projection');
  feishu.dataset.region = 'feishu';
  feishu.append(element('span', 'sys-region-kicker', '协作入口 / 投影'), element('h3', '', '飞书 Bitable'));
  feishu.append(element('p', '', 'PG 任务视图 → 飞书投影。入站编辑须带身份和所见版本，经过 connector / core 核验；远端删除不默认删除主记录。'));
  const links = element('div', 'sys-authority-links');
  addExploreButtons(links, model, READING_REGIONS.feishu.modules, onExplore);
  feishu.append(links);
  stage.append(feishu);
  stage.append(element('div', 'sys-authority-legend', '读取 / 固定引用 →　受控命令 ⇥ 校验后写 PG　　修订正文 ↗ 各自权威流程'));
  return stage;
}
function showDetails(container, model, mechanism, onExplore) {
  const section = element('details', 'sys-explanation');
  section.append(element('summary', '', '阅读说明与固定来源'), element('p', 'sys-explanation-lead', mechanism.lead));
  const steps = element('ol', 'sys-steps');
  for (const [index, item] of mechanism.steps.entries()) {
    const li = element('li', 'sys-step');
    li.dataset.region = item.region;
    li.append(element('span', 'sys-step-index', String(index + 1).padStart(2, '0')), element('h3', '', item.title), element('p', '', item.body), element('div', 'sys-step-gate', `门槛 · ${item.gate}`));
    const modules = element('div', 'sys-step-modules');
    addExploreButtons(modules, model, READING_REGIONS[item.region].modules.slice(0, 3), onExplore);
    li.append(modules);
    steps.append(li);
  }
  section.append(steps);
  const sources = element('div', 'sys-explanation-sources');
  sources.append(element('strong', '', '固定来源 · '));
  addSources(sources, model, mechanism.sources);
  section.append(sources);
  container.append(section);
}

export function mountSystemReading(root, model, { onExplore } = {}) {
  if (!root || !model?.nodes || !model.repository) throw new Error('阅读层需要挂载节点与架构模型');
  let read = parseReadingState(location.hash) || 'loop';
  const render = (focusNav = false) => {
    root.replaceChildren();
    const app = element('section', `sys-reading sys-read-${read}`);
    const nav = element('nav', 'sys-mechanisms');
    nav.setAttribute('aria-label', '选择要理解的机制');
    for (const id of READ_IDS) {
      const item = READING_MECHANISMS[id];
      const button = makeButton(item.label, id === read ? 'sys-active' : '', () => {
        if (read === id) return;
        location.hash = `read=${id}`;
        read = id;
        render(true);
      });
      button.setAttribute('aria-current', id === read ? 'page' : 'false');
      button.setAttribute('aria-pressed', String(id === read));
      nav.append(button);
    }
    app.append(nav);
    const mechanism = READING_MECHANISMS[read];
    const stageTitle = element('div', 'sys-stage-title');
    stageTitle.append(element('span', 'sys-stage-index', `${READ_IDS.indexOf(read) + 1} / 4`), element('h2', '', mechanism.kicker), element('p', '', mechanism.lead));
    app.append(stageTitle);
    app.append(read === 'authority' ? makeAuthorityStage(model, onExplore) : read === 'loop' ? makeLoopStage(model, onExplore) : makeFocusedStage(read, model, onExplore));
    if (read !== 'authority') {
      const legend = element('div', 'sys-legend');
      const labels = read === 'loop'
        ? ['— 行动与派发', '— 使用反馈与审阅修订', '虚线外框：外置 Wiki']
        : read === 'revision'
          ? ['━━ 新版触发影响复核', '━━ 责任者选择后续', '┄ 保留历史 r2 引用']
          : ['━━ 派发与回读', '━━ 凭证据分流', 'unknown：暂停重复执行'];
      labels.forEach((label, index) => legend.append(element('span', ['sys-legend-action', 'sys-legend-feedback', 'sys-legend-basis'][index], label)));
      app.append(legend);
    }
    showDetails(app, model, mechanism, onExplore);
    const footer = element('div', 'sys-footer');
    footer.append(element('span', '', `完整模块：${model.nodes.length} 个可折叠节点，保留原模型与固定来源。`));
    footer.append(makeButton('查看完整模块 ↗', 'sys-all-modules', () => onExplore?.(null)));
    app.append(footer);
    root.append(app);
    if (focusNav) nav.querySelector('.sys-active')?.focus();
  };
  const onHashChange = () => {
    if (location.hash && !new URLSearchParams(location.hash.slice(1)).has('read')) return;
    const next = parseReadingState(location.hash) || 'loop';
    if (next !== read) { read = next; render(true); }
  };
  window.addEventListener('hashchange', onHashChange);
  render();
  return { destroy() { window.removeEventListener('hashchange', onHashChange); root.replaceChildren(); } };
}
