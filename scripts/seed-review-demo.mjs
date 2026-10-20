import { randomUUID } from "node:crypto";

const projectId = process.argv[process.argv.indexOf("--project") + 1];
if (!process.argv.includes("--project") || !projectId) throw new Error("Explicit opt-in required: node scripts/seed-review-demo.mjs --project <authorized UUID>");
const token = process.env.EVOLOOP_TOKEN;
if (!token) throw new Error("Set EVOLOOP_TOKEN. This script only creates explicitly labeled synthetic demo data.");
const base = new URL(process.env.EVOLOOP_API_URL ?? "http://127.0.0.1:4318");
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("Demo seeding is limited to a local API.");
async function command(payload) {
  const operationId = randomUUID();
  const result = await fetch(new URL("/api/commands", base), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...payload, projectId, operationId }),
  }).then(r => r.json()).catch(() => {
    throw new Error(`Result unknown for ${operationId}. Query the operation before running this script again.`);
  });
  if (result.status !== "applied") throw new Error(`Stopped at ${payload.type}: ${JSON.stringify(result)}`);
  return result;
}
await command({ type: "project.create", title: "evoLoop 首片体验 · 合成示例" });
const documentId = randomUUID();
const r1 = await command({ type: "document.create", documentId, title: "过程文档阅读需求", body: "# 过程文档阅读 · 第一版\n\n## 用户目标\n从任务进入过程文档，读到完整原件。\n\n## 验收\n- 过程文档以表格呈现。\n- 点击后能阅读完整正文。\n- 仓库正式文档不混入过程文档表。\n\n本材料为本机验证专门创建的合成示例。" });
await command({ type: "document.adopt", documentId, expectedVersion: 1, revisionId: r1.revisionId, reason: "采纳合成示例第一版，供首片使用。" });
const tasks = [];
for (const [title, goal] of [
  ["任务 A：实现历史依据阅读", "让使用者能说明任务当时采用哪一版需求。"],
  ["任务 B：回归完整原件阅读", "核对已实现的完整原件阅读行为。"],
]) {
  const taskId = randomUUID();
  await command({ type: "task.propose", taskId, title, goal, acceptance: "从任务打开完整过程文档，能说明其版本。", owner: "本机体验者", documentIds: [documentId] });
  await command({ type: "task.accept", taskId, expectedVersion: 1, basis: [{ documentId, revisionId: r1.revisionId }], reason: "合成示例任务，允许在本机复核，尚未运行。" });
  tasks.push(taskId);
}
const r2 = await command({ type: "document.revise", documentId, expectedVersion: 2, body: "# 过程文档阅读 · 第二版\n\n## 保留原有目标\n表格列表、完整正文，仓库正式文档保持独立。\n\n## 新增要求\n任务必须能读取当时采用的固定需求版本；后续需求改版时，由有权责任者逐项决定采用新版或有理由保留旧版。\n\n## 验收\n- 能比较旧版与已采纳新版。\n- 两项任务可以做不同选择并保留理由。\n- 复核后原始任务依据不变。\n\n本材料为本机验证专门创建的合成示例。", reason: "发现只读当前版不足以解释过去的任务依据。" });
await command({ type: "document.adopt", documentId, expectedVersion: 3, revisionId: r2.revisionId, reason: "采纳固定历史依据要求；产生两项待复核。" });
console.log(JSON.stringify({ projectId, documentId, r1: r1.revisionId, r2: r2.revisionId, tasks, url: `${base.origin}/#/p/${projectId}/overview` }, null, 2));
