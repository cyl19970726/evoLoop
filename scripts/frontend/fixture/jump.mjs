// “跳到” of the screenshot fixture: answers GET /jump?q= from the fixture's own objects the way the real lookup does
// (packages/adapter-postgres/src/object-jump.ts): one id prefix or PR number, at most 10 matches, kind order task, document,
// session, stage, schedule, delivery. Two objects named only here (a task and a document that share their first 8 digits)
// and one delivery whose artifact is a PR let the browser tests walk the choice list and the PR number.
import { jumpBatchLimit, jumpPrefixRange, jumpResultLimit, parseJumpInput } from "@evoloop/contracts/object-jump";
import { agents, id, projectId } from "./common.mjs";
import * as work from "./work.mjs";
import * as spaces from "./spaces.mjs";

export const prDelivery = { id: id(5000), taskId: work.tasks.t1.id, artifactRef: "https://github.com/cyl19970726/evoLoop/pull/12" };
export const clash = { task: "88888888-0000-4000-8000-000000000001", document: "88888888-0000-4000-8000-000000000002" };
const base = `/p/${projectId}`;
const objects = () => [
  ...Object.values(work.tasks).map(t => ({ kind: "task", id: t.id, title: t.title, href: `${base}/tasks/${t.id}` })),
  { kind: "task", id: clash.task, title: "撞号的任务（夹具）", href: `${base}/tasks/${clash.task}` },
  ...work.documentList({}).map(d => ({ kind: "document", id: d.id, title: d.title, href: `${base}/documents/${d.id}` })),
  { kind: "document", id: clash.document, title: "撞号的文档（夹具）", href: `${base}/documents/${clash.document}` },
  ...Object.values(agents).map(a => ({ kind: "session", id: a.sessionId, title: a.title, href: `${base}/sessions?session=${encodeURIComponent(`owned:${a.sessionId}`)}` })),
  ...Object.values(work.stages).map(s => ({ kind: "stage", id: s.id, title: s.deliverable, href: `${base}/journey?stage=${s.id}` })),
  ...spaces.schedules.list().map(s => ({ kind: "schedule", id: s.id, title: s.revision.template.title, href: `${base}/schedules?schedule=${s.id}` })),
  { kind: "delivery", id: prDelivery.id, title: Object.values(work.tasks).find(t => t.id === prDelivery.taskId).title, taskId: prDelivery.taskId, href: `${base}/tasks/${prDelivery.taskId}?tab=delivery` },
];
const order = ["task", "document", "session", "stage", "schedule", "delivery"];

export function jump(query) {
  const parsed = parseJumpInput(query);
  let found = [];
  if (parsed.kind === "pr") {
    const hit = new RegExp(`/pull/${parsed.number}(?:[/?#].*)?$`).test(prDelivery.artifactRef);
    if (hit) found = [{ kind: "task", id: prDelivery.taskId, title: objects().find(o => o.id === prDelivery.taskId).title, href: `${base}/tasks/${prDelivery.taskId}?tab=delivery` }];
  } else if (parsed.kind === "id") {
    const { low, high } = jumpPrefixRange(parsed.prefix);
    found = objects().filter(o => o.id >= low && o.id <= high).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.id < b.id ? -1 : 1));
  }
  return { query: query.trim(), matches: found.slice(0, jumpResultLimit), truncated: found.length > jumpResultLimit };
}

/** GET /jump/refs?q=a,b,c: one answer per candidate (two matches at most), the way the real batch read answers; more than 50 is refused. */
export function jumpRefs(q) {
  const candidates = [...new Set(q.split(",").map(t => t.trim()).filter(Boolean))];
  if (candidates.length === 0 || candidates.length > jumpBatchLimit) return { results: {}, refused: "1 to 50 candidates" };
  const results = {};
  for (const candidate of candidates) { const r = jump(candidate); results[candidate] = { matches: r.matches.slice(0, 2), truncated: r.matches.length > 2 }; }
  return { results };
}
