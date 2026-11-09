import type { AllocationTrace } from "./allocationClient";

export type AllocationBacklinkGroup = {
  discussion: AllocationTrace["discussion"];
  traces: AllocationTrace[];
};

/** Group only the relations returned in the loaded pages; no Role membership is inferred. */
export function groupAllocationBacklinks(items: AllocationTrace[]): AllocationBacklinkGroup[] {
  const groups = new Map<string, { discussion: AllocationTrace["discussion"]; traces: Map<string, AllocationTrace> }>();
  for (const trace of items) {
    let group = groups.get(trace.discussion.id);
    if (!group) {
      group = { discussion: trace.discussion, traces: new Map() };
      groups.set(trace.discussion.id, group);
    }
    if (trace.discussion.version > group.discussion.version) group.discussion = trace.discussion;
    group.traces.set(trace.id, trace);
  }
  return [...groups.values()].map(group => ({ discussion: group.discussion, traces: [...group.traces.values()] }));
}

export function loadedBacklinkSummary(group: AllocationBacklinkGroup, incomplete: boolean): string {
  const targets = group.traces.filter(trace => trace.relation.kind === "decision-target").length;
  const accepted = group.traces.length - targets;
  return `已读 ${group.traces.length} 条关系：${targets} 条正式目标、${accepted} 条同修订接受${incomplete ? "；后续页或来源未读全，非总数" : ""}`;
}
