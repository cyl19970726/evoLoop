// Sample text for the body links (Task a910ee96), switched on by FIXTURE_REF_SAMPLE=1: every kind of candidate in one text, put into
// the five places (task body and completion condition, delivery and observation text, a document, a conversation message). The ids are
// the fixture's own (common.mjs `id(n)`), so this file reads nothing from the other fixture files. FIXTURE_REF_MANY=1 adds 80 distinct
// 8-hex words to the task body, for the 50-candidate limit.
import { id } from "./common.mjs";

export const refIds = { task: id(202), document: id(100), agent: id(21), stage: id(700), schedule: id(1400), delivery: id(5000), clash: "88888888", missing: "deadbeef", date: "20261123" };
const on = () => process.env.FIXTURE_REF_SAMPLE === "1";
export const manyWords = Array.from({ length: 80 }, (_, i) => `a1b2c3${String(i).padStart(2, "0")}`);

const plainLines = () => [
  `任务 ${refIds.task.slice(0, 8)}，文档 ${refIds.document}，智能体 ${refIds.agent.slice(0, 8)}，阶段 ${refIds.stage}，日程 ${refIds.schedule.slice(0, 8)}，交付 ${refIds.delivery.slice(0, 8)}。`,
  `PR 号 #12 和 PR #12；不存在的 ${refIds.missing}，日期 ${refIds.date}，撞号 ${refIds.clash}；网址 https://example.test/ref/1 。`,
];
/** Plain text (delivery and observation evidence). */
export const refPlain = () => on() ? plainLines().join("\n") : null;
/** Markdown (task, document, message): adds inline code and a fenced block. */
export const refMarkdown = () => on() ? [...plainLines(), "", `行内代码 \`${refIds.task.slice(0, 8)}\`。`, "", "```", refIds.task.slice(0, 8), "```", ...(process.env.FIXTURE_REF_MANY === "1" ? ["", manyWords.join(" ")] : [])].join("\n") : null;
