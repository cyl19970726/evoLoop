// Shared constants of the screenshot fixture: one synthetic project, fixed ids and fixed times.
// Every name, id and time here is invented; nothing is read from or sent to a real coordinator.

/** The browser clock during screenshots: 2026-11-10 11:00 in Asia/Shanghai. */
export const NOW = Date.parse("2026-11-10T03:00:00.000Z");
/** An ISO time `minutes` before NOW (negative = after). */
export const ago = minutes => new Date(NOW - minutes * 60000).toISOString();
export const later = days => new Date(NOW + days * 86400000).toISOString();

/** A stable UUID in the fixture's own range, `7{n}-0000-4000-8000-{n}`, so short (8-character) forms differ too. */
export const id = n => `7${String(n).padStart(7, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const hash = c => c.repeat(64);

export const projectId = id(1);
export const project = { id: projectId, title: "工作台改版", createdAt: ago(60 * 24 * 20) };
export const otherProject = { id: id(2), title: "对外说明整理", createdAt: ago(60 * 24 * 40) };
export const actorId = "zhang-reviewer";
export const token = "fixture-token";
export const root = `/api/projects/${projectId}`;
export const metadata = { generatedAt: ago(1), sourceObservedAt: ago(1), partial: false, limitations: [] };
export const page = (items, extra = {}) => ({ items, nextCursor: null, ...extra });

/** Business roles (持续职责) and the agents that hold them. */
export const roles = {
  lead: { id: id(10), title: "统筹", templateKey: "lead", roleClass: "system", responsibility: "安排工作、核对承接与验收" },
  dev: { id: id(11), title: "功能开发", templateKey: null, roleClass: "business", responsibility: "实现工作台页面并交付可用版本" },
  verify: { id: id(12), title: "独立验收", templateKey: null, roleClass: "business", responsibility: "按完成条件核对交付并记录实际使用" },
  design: { id: id(13), title: "体验设计", templateKey: null, roleClass: "business", responsibility: "给出页面结构、文案与走查意见" },
  docs: { id: id(14), title: "文档整理", templateKey: null, roleClass: "business", responsibility: "维护页面说明与过程文档" },
};

/** Agents (owned sessions): key, display title, roles, busy, look. */
export const agents = {
  lead: { sessionId: id(20), title: "统筹", role: "lead", busy: false, color: "copper", mark: "dot" },
  dev: { sessionId: id(21), title: "前端实现", role: "dev", busy: true, color: "violet", mark: "diamond" },
  verify: { sessionId: id(22), title: "验收", role: "verify", busy: true, color: "blue", mark: "layers" },
  design: { sessionId: id(23), title: "设计走查", role: "design", busy: false, color: "teal", mark: "brackets" },
  docs: { sessionId: id(24), title: "文档整理", role: "docs", busy: false, color: "magenta", mark: "spark" },
};
export const agentKey = name => `owned:${agents[name].sessionId}`;
