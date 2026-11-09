# 团队：每项职责由谁承担

团队页说明每项持续职责的目标、承载它的 Session、运行时与 skill，以及分工讨论与组织复盘。具体实例的对话与活动在 [Sessions](sessions.md)。

## 这一页回答什么

- 项目有哪些持续职责，哪些已建立、在试行或未建立？
- 这项职责用哪个运行时和哪些 skill，由哪些 Session 承载？
- 最近有哪些分工讨论和组织复盘，结论落到了哪里？

## 布局

| 栏 | 放什么（目标） |
| --- | --- |
| 内层栏（对象列表） | 职责目录，分业务 / System；分工讨论下是讨论列表（当前分工 / 下一阶段 / 全部） |
| 中间 | 所选职责：目标、范围、交接、试行状态；承载它的 Session（链到 Sessions）；相关讨论与决定。所选讨论：准备 → 交接 → 决定 |
| 右栏（可收起） | 职责：运行时与 skill、试行指标与回看时间。讨论：讨论依据、关联的任务 / 职责 / 文档、来源与完整标识 |

外壳与左栏见[布局](../layout.md)。

现状（#229 PR9、PR9h）：视图由外壳“团队”导航切换（分工与运行、职责、分工讨论、组织复盘、协作回执）。职责视图在内层栏列出职责目录，点选定位到职责卡片。分工讨论已按上表重写：`?discussion=` 选中一条，`?new=1` 打开准备表单，四种写入（准备、登记承接、登记或纠正决定、链接后续对象）都在中间。协作回执是单栏页，右栏放飞书连接与待处理。组织复盘列表已换新样式；职责卡片、分工与运行仍是旧组件。

## 内容与状态

通用的空、加载、失败、未知规则见[设计原则](../principles.md)。

- 具体实例只从 Sessions 进入。Role 存在 ≠ 已有可运行的实例。
- 职责卡片写明运行时是否已绑定（绑定后不可更换），每个 skill 是否加载及原因，清单来自运行时还是按文件推断。有 review 权限的人可修改，下一个 Turn 生效；规则见 [Agent CLI](../../development/agent-cli.md#准备或复用受管-session)。
- 同 Role ≠ 已接手：接手只认同一 Task 修订的接受记录（[可信关系](../../architecture/contracts.md#9-分工讨论的可信关系反查)）。
- 分工讨论分开显示未落到任务、未接受、已转交、被取代。讨论正文另被修订时并列两版，由人明确确认后再接续（[项目数据](../../architecture/project-data.md#3-关系与认知读取)）。交接包原文和文档当前版都核对通过才能登记，读取失败时写“无法判断”。填写中讨论、文档当前版或所选对象的修订变了，或服务端答复所见已过期，都保留输入但拒绝提交，要重新核对；恢复确认要重新勾选。结果未知的写入按原操作核对为已应用后，草稿自动清除。
- 协作回执：结果未知的投影只按稳定键对账，不重发；只有身份已核实、只改标题的远端修改能采纳，采纳和拒绝都先确认。写入结果丢失时只留项目、对象与操作 ID，按原 ID 读回。
- 新聊天或绑定 Role ≠ 试行有效（[分工试行](../../product/daily-loop.md#分工提议怎样试行)）。
- 组织复盘是 `organization_review` 类型的 Document，列表点开即进入同一份原件阅读器（[项目数据](../../architecture/project-data.md#4-文档表怎样设计)）。报告已保存 ≠ 建议已采纳。

## 截图

暂无当前截图。

## 代码与测试

| 范围 | 源码（`apps/workbench/src/`） | 测试（`apps/workbench/test/`） |
| --- | --- | --- |
| 团队 | `features/team/TeamWorkspace.tsx`、`features/team/OrganizationReviewList.tsx`、`features/roles/RolesPanel.tsx`、`features/roles/RoleRuntimeCard.tsx`、`features/roles/roleRuntimePresentation.ts`、`shared/RoleTemplateSummary.tsx`、`features/runtime/RuntimePanel.tsx` | `role-runtime-card.test.ts`、`role-template-summary.test.ts`、`runtime-session-role-browser.test.ts`、`team-browser.test.ts` |
| 分工讨论 | `features/discussions/DiscussionPanel.tsx`、`features/discussions/DiscussionDetail.tsx`、`features/discussions/DiscussionForms.tsx`、`features/discussions/CommandForm.tsx`、`features/discussions/discussionClient.ts`、`features/discussions/discussionBaseline.ts`、`features/discussions/discussionPresentation.ts`、`features/discussions/commands.ts`、`features/discussions/AllocationRelationsPanel.tsx`、`features/discussions/AllocationBacklinks.tsx`、`features/discussions/useAllocationTraces.ts` | `team-discussions-browser.test.ts`（`EVOLOOP_DISCUSSIONS_SCREENSHOT_DIR`）、`discussion-presentation.test.ts`、`discussion-panel.test.ts`、`allocation-backlink-groups.test.ts`、`allocation-names.test.ts` |
| 协作回执 | `features/collaboration/CollaborationPanel.tsx`、`features/collaboration/collaborationPresentation.ts`、`features/collaboration/client.ts` | `team-collaboration-browser.test.ts`（`EVOLOOP_COLLABORATION_SCREENSHOT_DIR`）、`collaboration-presentation.test.ts` |

## 相关

- 产品：[对象关系与能力职责](../../product/workbench.md#对象关系与能力职责)、[分工专题](../../product/functional-scenarios.md#分工专题从实际负担选择方法容量或职责)
- 合同：[RoleRegistry 与 SessionRuntime](../../architecture/contracts.md#4-roleregistry-与-sessionruntime)、[具体承接与职责分开](../../architecture/contracts.md#具体承接与职责分开)
