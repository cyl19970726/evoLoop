// The pages the screenshot script renders. Each scene opens one address of the fixture project and waits for content
// that only appears once its reads are answered. `widths` (default 1440 and 390) are shot as the page opens; `drawer`
// (true = 1024) opens the right column as a drawer first. `before` runs before the page loads (e.g. a failing read),
// `prepare` after it is ready. Names are the file names under docs/assets/frontend-pages/ and stay fixed.
import { agentKey, projectId, roles } from "./fixture/common.mjs";
import { docs, tasks } from "./fixture/work.mjs";
import { evaluations, knowledge } from "./fixture/spaces.mjs";

const p = path => `/p/${projectId}/${path}`;
const heading = (name, level) => page => page.getByRole("heading", { name, exact: true, ...(level ? { level } : {}) }).filter({ visible: true }).first().waitFor();
const text = value => page => page.getByText(value, { exact: false }).filter({ visible: true }).first().waitFor();
const both = (...waits) => async (page, shot) => { for (const wait of waits) await wait(page, shot); };
/** Every scrolled area back to its start. */
const toTop = page => page.evaluate(() => {
  for (const element of document.querySelectorAll("*")) if (element.scrollTop) element.scrollTop = 0;
  window.scrollTo(0, 0);
});
const taskReady = both(heading(tasks.t1.title, 1), heading("完成条件"));
/** The report renders inside an isolated frame; wait for its last section. */
const reportReady = page => page.frameLocator("iframe").first().getByText("下一步").waitFor();
const taskTabs = [["basis", "依据与影响"], ["delivery", "交付与使用"], ["runtime", "运行与关联"], ["history", "历史"], ["actions", "任务操作"]];

export const scenes = [
  // Entry: login, the project list, settings.
  { name: "login", path: "/", login: false, ready: heading("进入项目工作台") },
  { name: "projects", path: "/", ready: both(heading("你的项目"), text("对外说明整理")) },
  { name: "settings", path: p("settings"), ready: both(heading("项目设置"), text("zhang-reviewer")) },
  { name: "overview", path: p("overview"), drawer: true, ready: both(heading("项目总览"), text(tasks.t2.title)) },

  // Tasks: the table view, one task and its five other tabs, a new task.
  { name: "tasks", path: p("work"), drawer: true, ready: both(heading("任务", 1), text(tasks.t2.title)) },
  { name: "task", path: p(`tasks/${tasks.t1.id}`), drawer: true, ready: taskReady },
  // At 390 the task's facts open as a sheet from the bottom.
  { name: "task-facts", path: p(`tasks/${tasks.t1.id}`), widths: [], drawer: [390], ready: taskReady },
  // A basis document opened beside the task, as a tab of the right column.
  { name: "task-document", path: p(`tasks/${tasks.t1.id}`), widths: [1440], ready: taskReady, prepare: async page => {
    const panel = page.getByRole("complementary", { name: "右栏" });
    await panel.getByRole("button", { name: new RegExp(docs.map.title) }).first().click();
    await panel.getByRole("tab", { name: docs.map.title }).waitFor();
    await panel.getByText("本轮切片").first().waitFor();
  } },
  // Opening a tab scrolls to it, by an amount that depends on when the content arrived; the picture starts at the top.
  ...taskTabs.map(([tab, label]) => ({
    name: `task-${tab}`, path: p(`tasks/${tasks.t1.id}?tab=${tab}`), widths: [1440], prepare: toTop,
    ready: both(heading(tasks.t1.title, 1), page => page.getByRole("tab", { name: new RegExp(`^${label}`), selected: true }).waitFor()),
  })),
  { name: "task-new", path: p("tasks/new"), ready: both(heading("新建任务"), text("要做什么")) },
  { name: "journey", path: p("journey"), drawer: true, ready: both(heading("目标与阶段"), text("新版任务与文档页")) },
  { name: "evaluations", path: p("evaluations"), ready: both(heading("评价与后果"), text("只给需求总图")) },
  { name: "evaluation", path: p(`evaluations/${evaluations.id}`), drawer: true, ready: heading("加入固定知识页后，右栏核对是否一次通过？", 1) },

  // Documents and knowledge.
  { name: "documents", path: p("documents"), ready: both(heading("过程文档"), text(docs.map.title)) },
  { name: "document", path: p(`documents/${docs.map.id}`), drawer: true, ready: both(heading(docs.map.title, 1), text("完成条件")) },
  // An HTML report fills the space below the header; the right column starts closed.
  { name: "document-html", path: p(`documents/${docs.html.id}`), ready: both(heading(docs.html.title, 1), reportReady) },
  // The original of the HTML report cannot be read: the page says so and keeps 修订与发布.
  { name: "document-html-failed", path: p(`documents/${docs.html.id}`), widths: [1440], ready: both(heading(docs.html.title, 1), text("修订与发布")),
    before: page => page.route(/\/original$/, route => route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ message: "原件存储暂时不可达" }) })) },
  { name: "knowledge", path: p(`knowledge?knowledgeId=${knowledge.firstPage}`), drawer: true, ready: heading("右栏只在要时打开", 1) },

  { name: "schedules", path: p("schedules"), drawer: true, ready: both(heading("日程"), text("每日验收巡检")) },

  // Agents: the directory with 统筹安排, one agent's conversation.
  { name: "arrangement", path: p("sessions"), drawer: true, ready: both(heading("统筹安排"), text("前端实现")) },
  { name: "agent", path: p(`sessions?session=${encodeURIComponent(agentKey("dev"))}`), drawer: true, ready: text("已核对：1024 下右栏默认收起") },

  // Team.
  { name: "team-roles", path: p(`roles?role=${roles.dev.id}`), drawer: true, ready: both(heading("功能开发", 1), text("提出依据")) },
  { name: "team-runtime", path: p("runtime"), drawer: true, ready: both(heading("分工与运行"), text("受管智能体")) },
  { name: "team-discussions", path: p("discussions"), drawer: true, ready: heading("分工讨论") },
  { name: "team-reviews", path: p("reviews"), ready: both(heading("组织复盘"), text(docs.review.title)) },
  { name: "team-collaboration", path: p("collaboration"), ready: heading("协作回执") },

  // The first route's recent deliveries are read on request; open them so the picture shows how they were handled.
  { name: "connectors", path: p("connectors"), ready: both(heading("微信连接"), text("工作台改版群")), prepare: async page => {
    await page.getByRole("button", { name: "读取最近的投递" }).first().click();
    await page.getByText(/投递 21/).first().waitFor();
  } },

  // The component samples (no project, no reads).
  { name: "ui-samples", path: "/ui", login: false, ready: heading("按钮与输入") },
];
