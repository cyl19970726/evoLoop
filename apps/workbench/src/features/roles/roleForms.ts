// The Role commands the 职责 page can send: field lists and the command each form builds. The forms are the shared
// command forms (draft keeping, operation receipts); only their placement on the page is new.
import type { RoleHandoff, RoleProposal, RoleRecord } from "@evoloop/contracts/roles";
import type { HostLink } from "@evoloop/contracts/resident-hosts";
import { option, reasonField, type Field } from "../../shared/ActionForm";
import { codexThreadHref } from "../../shared/externalHostEntry";
import { splitLines as lines } from "./rolePresentation";

const evidenceKinds = [{ kind: "gap", label: "积压、遗漏或返工" }, { kind: "effect", label: "实际效果" }, { kind: "cost", label: "已付成本" }] as const;
const alternativeKinds = [
  { kind: "method", label: "改方法或工具" }, { kind: "knowledge", label: "补知识或输入" },
  { kind: "another-instance", label: "同职责增实例" }, { kind: "temporary-assignment", label: "临时专项" },
] as const;

export const proposalFields: Field[] = [
  { name: "title", label: "职责名称" }, { name: "goal", label: "独立目标", kind: "textarea" },
  { name: "independentResponsibility", label: "为什么需要持续独立判断", kind: "textarea" },
  { name: "ownerScope", label: "责任与授权范围", kind: "textarea" },
  { name: "inputs", label: "主要输入（每行一项）", kind: "textarea" },
  { name: "writableAssets", label: "可写资产（每行一项，可留空）", kind: "textarea", optional: true },
  { name: "deliverables", label: "交付（每行一项）", kind: "textarea" },
  { name: "triggers", label: "触发条件（每行一项）", kind: "textarea" },
  { name: "workflow", label: "检查、判断、修复与交付流程", kind: "textarea" },
  { name: "handoffBoundary", label: "与既有职责的交接边界", kind: "textarea" },
  { name: "gapKind", label: "主要责任缺口", kind: "select", options: [option("backlog", "持续积压"), option("omission", "反复遗漏"), option("rework", "反复返工")] },
  ...evidenceKinds.flatMap(item => [
    { name: `${item.kind}Observation`, label: `${item.label}：观察`, kind: "textarea" as const },
    { name: `${item.kind}SourceRef`, label: `${item.label}：固定来源引用` },
    { name: `${item.kind}ObservedAtUtc`, label: `${item.label}：实际观察时间（ISO 8601）`, hint: "填来源发生或核对的时间，不会自动写成提案时间。" },
  ]),
  ...alternativeKinds.flatMap(item => [
    { name: `${item.kind}Assessment`, label: `${item.label}能否解决及原因`, kind: "textarea" as const },
    { name: `${item.kind}Cost`, label: `${item.label}的估计成本` },
  ]),
  { name: "firstTaskId", label: "首项试行任务 ID", hint: "必须是本项目仍未结束的真实任务；创建职责不会自动接受任务。" },
  { name: "baseline", label: "当前基线", kind: "textarea" }, { name: "expectedEffect", label: "预期效果", kind: "textarea" },
  { name: "costLimit", label: "试行成本上限" }, { name: "trialDays", label: "最长试行天数（1–90）", value: "14" },
  { name: "reviewAtUtc", label: "回看时间（ISO 8601，含时区）", hint: "须在试行期限内；例如 2026-11-03T09:00:00+08:00。" },
  { name: "exitCriteria", label: "停止或撤回判据", kind: "textarea" },
];

export function buildProposal(values: Record<string, string>): RoleProposal {
  return {
    title: values.title!, goal: values.goal!, independentResponsibility: values.independentResponsibility!, ownerScope: values.ownerScope!,
    inputs: lines(values.inputs!), writableAssets: lines(values.writableAssets || ""), deliverables: lines(values.deliverables!), triggers: lines(values.triggers!),
    workflow: values.workflow!, handoffBoundary: values.handoffBoundary!,
    evidence: evidenceKinds.map(item => ({ kind: item.kind === "gap" ? values.gapKind as "backlog" | "omission" | "rework" : item.kind,
      observation: values[`${item.kind}Observation`]!, sourceRef: values[`${item.kind}SourceRef`]!, observedAtUtc: new Date(values[`${item.kind}ObservedAtUtc`]!).toISOString() })),
    alternatives: alternativeKinds.map(item => ({ kind: item.kind, assessment: values[`${item.kind}Assessment`]!, estimatedCost: values[`${item.kind}Cost`]! })),
    firstTaskId: values.firstTaskId!, baseline: values.baseline!, expectedEffect: values.expectedEffect!, costLimit: values.costLimit!, trialDays: Number(values.trialDays),
    reviewAtUtc: new Date(values.reviewAtUtc!).toISOString(), exitCriteria: values.exitCriteria!,
  };
}

export interface RoleForm { title: string; fields: Field[]; build(values: Record<string, string>): Record<string, unknown> }

const base = (role: RoleRecord) => ({ roleId: role.id, expectedVersion: role.version });

export const decideForm = (role: RoleRecord): RoleForm => ({
  title: "决定是否试行",
  fields: [{ name: "decision", label: "决定", kind: "select", options: [option("accept-trial", "接受有限试行"), option("reject", "不采纳"), option("defer", "暂缓重看")] }, reasonField],
  build: v => ({ ...base(role), type: "role.decide", ...v }),
});

export const reviewForm = (role: RoleRecord): RoleForm => ({
  title: "记录职责回看",
  fields: [
    { name: "decision", label: "回看决定", kind: "select", options: [option("continue-trial", "延长试行并设下次回看"), option("activate", "确认持续职责"), option("merge", "并入已有职责并准备交接"), option("retire", "撤回并准备交接")] },
    { name: "effectEvidence", label: "实际效果与反例", kind: "textarea" }, { name: "effectEvidenceRefs", label: "效果固定来源（每行一项）", kind: "textarea" },
    { name: "costEvidence", label: "实际成本", kind: "textarea" }, { name: "costEvidenceRefs", label: "成本固定来源（每行一项）", kind: "textarea" },
    { name: "baselineComparison", label: "与试行前基线对比", kind: "textarea" },
    { name: "nextReviewAtUtc", label: "若延长：下次回看（ISO 8601）", optional: true },
    { name: "mergeTargetRoleId", label: "若合并：现有持续职责 ID", optional: true }, reasonField,
  ],
  build: v => ({ ...base(role), type: "role.review", decision: v.decision, effectEvidence: v.effectEvidence, effectEvidenceRefs: lines(v.effectEvidenceRefs!),
    costEvidence: v.costEvidence, costEvidenceRefs: lines(v.costEvidenceRefs!), baselineComparison: v.baselineComparison, reason: v.reason,
    ...(v.nextReviewAtUtc ? { nextReviewAtUtc: new Date(v.nextReviewAtUtc).toISOString() } : {}), ...(v.mergeTargetRoleId ? { mergeTargetRoleId: v.mergeTargetRoleId } : {}) }),
});

export const handoffForm = (role: RoleRecord): RoleForm => ({
  title: "登记待交接事项",
  fields: [
    { name: "kind", label: "事项类型", kind: "select", options: [option("task", "未完成任务"), option("knowledge", "知识与材料"), option("session", "智能体现场")] },
    { name: "sourceRef", label: "原对象引用；任务请填任务 ID" }, { name: "targetRoleId", label: "接收职责 ID" },
    { name: "observedTaskVersion", label: "若为任务：当前任务版本", optional: true }, { name: "note", label: "交接范围与待确认内容", kind: "textarea" },
  ],
  build: v => ({ ...base(role), type: "role.handoff", handoffId: crypto.randomUUID(), kind: v.kind, sourceRef: v.sourceRef, targetRoleId: v.targetRoleId,
    ...(v.kind === "task" ? { observedTaskVersion: Number(v.observedTaskVersion) } : {}), note: v.note }),
});

export const ackHandoffForm = (role: RoleRecord, handoff: RoleHandoff): RoleForm => ({
  title: "确认交接已完成",
  fields: [{ name: "note", label: "接收与核对证据", kind: "textarea" }],
  build: v => ({ ...base(role), type: "role.ackHandoff", handoffId: handoff.id, ...v }),
});

export const bindForm = (role: RoleRecord): RoleForm => ({
  title: "绑定承载智能体",
  fields: [{ name: "sessionId", label: "本项目已预留且就绪的受管智能体 ID", hint: "不能绑定任意桌面聊天。" }, { name: "note", label: "绑定说明" }],
  build: v => ({ ...base(role), type: "role.bindSession", ...v }),
});

export const retireForm = (role: RoleRecord): RoleForm => ({
  title: "核对并撤回职责",
  fields: [reasonField, { name: "knowledgeDisposition", label: "知识与未读材料的处理", kind: "textarea" },
    { name: "runtimeDisposition", label: "在途及结果未知的智能体核对结果", kind: "textarea" }],
  build: v => ({ ...base(role), type: "role.retire", ...v }),
});

export const registerHostForm = (role: RoleRecord): RoleForm => ({
  title: "登记外部聊天",
  fields: [{ name: "ref", label: "原聊天完整引用", hint: "填写 codex://threads/<聊天 UUID>；历史裸 UUID 也会规范化。先在原应用核对。" }, reasonField],
  build: v => {
    const ref = codexThreadHref(v.ref);
    if (!ref) throw new Error("请填写完整的 Codex 聊天引用或 UUID");
    return { type: "host.register", linkId: crypto.randomUUID(), roleId: role.id, expectedRoleVersion: role.version,
      host: { kind: "external", provider: "codex-desktop", ref }, claimedCapabilities: ["open", "read", "manual-claim"], reason: v.reason };
  },
});

export const verifyHostForm = (role: RoleRecord, link: HostLink): RoleForm => ({
  title: "核实人工连接能力",
  fields: [{ name: "verifiedCapabilities", label: "亲自核实的能力", kind: "multi", options: [option("open", "打开原聊天"), option("read", "读取原聊天"), option("manual-claim", "人工领取")] },
    { name: "evidence", label: "核实证据", kind: "textarea" }, reasonField],
  build: v => ({ type: "host.verify", linkId: link.id, expectedVersion: link.version, expectedRoleVersion: role.version,
    verifiedCapabilities: JSON.parse(v.verifiedCapabilities || "[]"), evidence: v.evidence, observedAtUtc: new Date().toISOString(), reason: v.reason }),
});
