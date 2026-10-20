import { READING_MECHANISMS } from './reading.js';

const VIEWS = Object.freeze({
  loop: {
    width: 1060, height: 470,
    nodes: [
      { id: 'decision', x: 40, y: 85, w: 285, h: 115, label: '判断下一步', lines: ['对照目标、来源与反例', '人类负责人保留关键取舍'] },
      { id: 'task', x: 390, y: 85, w: 285, h: 115, label: '接受 Task / 固定依据', lines: ['写明交付与验收判据', '授权、接受、依据有效才派发'] },
      { id: 'run', x: 740, y: 85, w: 280, h: 115, label: 'Run 执行与交付', lines: ['保留输入、状态与回执', 'Run 结束 ≠ Task 验收'] },
      { id: 'wiki', x: 40, y: 290, w: 285, h: 115, label: '审阅后修订 Wiki', lines: ['保留原判断、反例与版本', '供下一次判断读取'] },
      { id: 'review', x: 390, y: 290, w: 285, h: 115, label: '责任者审阅', lines: ['比较交付、采用、效果与成本', '反馈不自动采纳'] },
      { id: 'use', x: 740, y: 290, w: 280, h: 115, label: '验收 / 真实使用', lines: ['按约定判据核对 Task', '效果未知不代替任务状态'] },
    ],
    edges: [
      { id: 'accept', from: 'decision', to: 'task', points: [[325, 142], [390, 142]], label: '接受', at: [357, 128] },
      { id: 'dispatch', from: 'task', to: 'run', points: [[675, 142], [740, 142]], label: '派发', at: [707, 128] },
      { id: 'deliver', from: 'run', to: 'use', points: [[880, 200], [880, 290]], label: '交付后分别核对', at: [900, 251] },
      { id: 'evaluate', from: 'use', to: 'review', points: [[740, 347], [675, 347]], label: '使用证据', at: [707, 332], kind: 'feedback' },
      { id: 'revise', from: 'review', to: 'wiki', points: [[390, 347], [325, 347]], label: '审阅修订', at: [357, 332], kind: 'feedback' },
      { id: 'learn', from: 'wiki', to: 'decision', points: [[182, 290], [182, 200]], label: '下一轮', at: [204, 250], kind: 'feedback' },
    ],
  },
  revision: {
    width: 1060, height: 470,
    nodes: [
      { id: 'r2', x: 40, y: 82, w: 200, h: 110, label: '原基线 r2', lines: ['原修订继续可查', '旧 Run 固定引用它'] },
      { id: 'r3', x: 295, y: 82, w: 200, h: 110, label: '新增修订 r3', lines: ['过程 Document / Wiki', '各在所属权威处修订'] },
      { id: 'scan', x: 550, y: 82, w: 200, h: 110, label: '扫描影响', lines: ['引用旧版的 Task', '列为待复核'] },
      { id: 'review', x: 805, y: 82, w: 215, h: 110, label: '责任者复核', lines: ['未执行 Task 逐项决定', '待复核时暂停新派发'] },
      { id: 'history', x: 40, y: 318, w: 200, h: 100, label: '旧 Run', lines: ['仍按 r2 与原验收解释'] },
      { id: 'replace', x: 295, y: 318, w: 200, h: 100, label: '换基线', lines: ['未来执行采用 r3'] },
      { id: 'retain', x: 550, y: 318, w: 200, h: 100, label: '保留旧版', lines: ['说明继续采用 r2 的理由'] },
      { id: 'remedy', x: 805, y: 318, w: 215, h: 100, label: '补救 Task', lines: ['需要时另建任务处理'] },
    ],
    edges: [
      { id: 'new-revision', from: 'r2', to: 'r3', points: [[240, 137], [295, 137]], label: '新修订', at: [267, 122] },
      { id: 'impact', from: 'r3', to: 'scan', points: [[495, 137], [550, 137]], label: '影响', at: [522, 122] },
      { id: 'assign-review', from: 'scan', to: 'review', points: [[750, 137], [805, 137]], label: '待复核', at: [777, 122] },
      { id: 'historical-basis', from: 'r2', to: 'history', points: [[140, 192], [140, 318]], label: '原依据不回写', at: [159, 261], kind: 'reference' },
      { id: 'choose-replace', from: 'review', to: 'replace', points: [[858, 192], [858, 264], [395, 264], [395, 318]], kind: 'feedback' },
      { id: 'choose-retain', from: 'review', to: 'retain', points: [[912, 192], [912, 282], [650, 282], [650, 318]], kind: 'feedback' },
      { id: 'choose-remedy', from: 'review', to: 'remedy', points: [[966, 192], [966, 318]], kind: 'feedback' },
    ],
  },
  recovery: {
    width: 1060, height: 455,
    nodes: [
      { id: 'operation', x: 40, y: 75, w: 260, h: 120, label: '原操作 ID', lines: ['保留派发意图与已知 Run', '超时不等于未启动'] },
      { id: 'unknown', x: 400, y: 75, w: 260, h: 120, label: 'Run 回执未知', lines: ['可能已启动而回执丢失', 'Task 终态不代表 Run'] },
      { id: 'readback', x: 760, y: 75, w: 260, h: 120, label: '按同一操作回读', lines: ['PG Journal / outbox', '运行时 Session / 动作'] },
      { id: 'started', x: 40, y: 310, w: 300, h: 105, label: '证实已启动', lines: ['跟踪原 Run'] },
      { id: 'not-started', x: 380, y: 310, w: 300, h: 105, label: '证实未启动', lines: ['才可受控重发'] },
      { id: 'still-unknown', x: 720, y: 310, w: 300, h: 105, label: '仍 unknown', lines: ['禁止重复执行', '交责任者处理'] },
    ],
    edges: [
      { id: 'dispatch-unknown', from: 'operation', to: 'unknown', points: [[300, 135], [400, 135]], label: '派发', at: [350, 120] },
      { id: 'reconcile', from: 'unknown', to: 'readback', points: [[660, 135], [760, 135]], label: '先对账', at: [710, 120] },
      { id: 'found-started', from: 'readback', to: 'started', points: [[830, 195], [830, 250], [190, 250], [190, 310]], kind: 'feedback' },
      { id: 'found-absent', from: 'readback', to: 'not-started', points: [[890, 195], [890, 270], [530, 270], [530, 310]], kind: 'feedback' },
      { id: 'unresolved', from: 'readback', to: 'still-unknown', points: [[950, 195], [950, 310]], kind: 'feedback' },
    ],
  },
  authority: {
    width: 1060, height: 455,
    nodes: [
      { id: 'wiki', x: 40, y: 75, w: 270, h: 125, label: '外置 Wiki', lines: ['知识正文与修订', '来源、反例、内部依赖'] },
      { id: 'postgres', x: 395, y: 75, w: 270, h: 125, label: 'PostgreSQL / evoLoop', lines: ['Task、过程 Document 修订', 'Schedule、关系与运行记录'] },
      { id: 'git', x: 750, y: 75, w: 270, h: 125, label: '受管 Git', lines: ['产品 / 架构 / 开发 docs/', '按原仓库审阅修订'] },
      { id: 'core', x: 395, y: 310, w: 270, h: 105, label: 'connector / core', lines: ['核验身份与所见版本', '受控写入 PG'] },
      { id: 'feishu', x: 750, y: 310, w: 270, h: 105, label: '飞书协作投影', lines: ['读取 PG Task 视图', '入站编辑成为受控命令'] },
    ],
    edges: [
      { id: 'wiki-reference', from: 'wiki', to: 'postgres', points: [[310, 137], [395, 137]], label: '版本引用', at: [352, 122], kind: 'reference' },
      { id: 'git-reference', from: 'git', to: 'postgres', points: [[750, 137], [665, 137]], label: 'commit 引用', at: [707, 122], kind: 'reference' },
      { id: 'projection', from: 'postgres', to: 'feishu', points: [[615, 200], [615, 255], [885, 255], [885, 310]], label: 'Task 投影', at: [742, 240], kind: 'reference' },
      { id: 'inbound', from: 'feishu', to: 'core', points: [[750, 362], [665, 362]], label: '入站命令', at: [707, 347] },
      { id: 'verified-write', from: 'core', to: 'postgres', points: [[445, 310], [445, 200]], label: '核验后写入', at: [465, 260] },
    ],
  },
});

export function mechanismDiagram(model, view) {
  const mechanism = READING_MECHANISMS[view];
  const layout = VIEWS[view];
  if (!mechanism || !layout) throw new RangeError(`Unknown mechanism view: ${view}`);
  const modelIds = new Set(model.nodes.map(node => node.id));
  const sourceNodes = [...mechanism.sources];
  for (const id of sourceNodes) {
    if (!modelIds.has(id)) throw new Error(`Missing model source node: ${id}`);
  }
  return {
    title: mechanism.label,
    description: mechanism.lead,
    ...layout,
    sourceNodes,
  };
}
