// What the overview's version and milestone blocks say. Missing data is said as missing ("未登记", "版本未读到"); nothing is guessed or kept
// from an earlier read. Links point at public pages only.
import type { MilestonePhase, MilestonesView, VersionInfo } from "@evoloop/contracts/milestones";

export const repoBase = "https://github.com/cyl19970726/evoLoop";
export const NOT_REGISTERED = "未登记";
export const VERSION_UNREAD = "版本未读到";
export const NO_REVIEW = "暂无回看";

const day = (value: string) => new Date(value).toISOString().slice(0, 10);
const minute = (value: string) => `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export interface VersionView {
  readable: boolean;
  commit: string; builtAt: string; startedAt: string;
  links: Array<{ label: string; href: string }>;
}
/** The version block. No commit means the version was not read: both the commit and the build time say so, never an old value. */
export function versionView(info: VersionInfo | null): VersionView {
  const roadmap = { label: "路线图“当前基线”", href: `${repoBase}/blob/main/docs/roadmap.md#当前基线` };
  const deploy = { label: "部署文档", href: `${repoBase}/blob/main/docs/development/local-run.md` };
  if (!info || !info.commit) return { readable: false, commit: VERSION_UNREAD, builtAt: VERSION_UNREAD, startedAt: info ? minute(info.startedAt) : VERSION_UNREAD, links: [roadmap, deploy] };
  return { readable: true, commit: info.commit.slice(0, 7), builtAt: info.builtAt ? minute(info.builtAt) : NOT_REGISTERED, startedAt: minute(info.startedAt),
    links: [{ label: "这个提交（公开仓库）", href: `${repoBase}/commit/${info.commit}` }, roadmap, deploy] };
}

export interface MilestoneRowView { id: string; title: string; deliver: string; exit: string; status: string; tone: "done" | "progress" | "partial" | "idle" | "none"; date: string; current: boolean; linked: boolean }
const tones: Record<string, MilestoneRowView["tone"]> = { exited: "done", in_progress: "progress", partial: "partial", reviewed: "partial", not_started: "idle" };
export function milestoneRows(view: MilestonesView | null): MilestoneRowView[] {
  return (view?.phases ?? []).map((phase: MilestonePhase) => ({
    id: phase.id, title: phase.title, deliver: phase.deliver, exit: phase.exit,
    status: phase.statusLabel ?? (phase.linkedStages > 1 ? `${NOT_REGISTERED}（关联了 ${phase.linkedStages} 个阶段）` : NOT_REGISTERED),
    tone: phase.status ? tones[phase.status] ?? "idle" : "none",
    // 未登记 only when no stage is linked; a linked stage that was never reviewed says so.
    date: !phase.stage ? NOT_REGISTERED : phase.reviewedAt ? `回看于 ${day(phase.reviewedAt)}` : NO_REVIEW,
    current: view?.currentPhaseId === phase.id, linked: !!phase.stage,
  }));
}
