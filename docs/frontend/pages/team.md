# 团队：每项职责由谁承担

团队页说明每项持续职责的目标、承载它的智能体、运行时与 skill，以及分工讨论与组织复盘。具体实例的对话与活动在 [Sessions](sessions.md)。

## 这一页回答什么

- 项目有哪些持续职责，哪些已建立、在试行或未建立？
- 这项职责用哪个运行时和哪些 skill，由哪些智能体承载？
- 受管智能体能不能关闭，挡住它的是什么？
- 最近有哪些分工讨论和组织复盘，结论落到了哪里？

## 布局

| 栏 | 职责（`/roles?role=`） | 分工与运行（`/runtime?session=`） |
| --- | --- | --- |
| 内层栏 | 职责目录：业务、系统、提议与已关闭 | 受管智能体：就绪、准备中、需要核对、已关闭 |
| 中间 | 所选职责：目标与范围、提出依据、承载与业务领域、按状态给出的下一步、修订与交接历史、相关讨论；未选时为基础职责、全部职责和提出试行 | 所选智能体：身份与权限、队列、它的运行、关闭条件、线程历史；未选时为执行服务、全部智能体、新建、编排与队列、运行记录 |
| 右栏 | 试行与回看、运行时与 skill | 所选智能体的事实、执行服务 |

外壳与左栏见[布局](../layout.md)。视图由外壳“团队”导航切换，App 把所属分区传给页面，懒加载的页面不再从地址推断。旧地址 `/runtime?view=roles` 跳到 `/roles`，`/runtime?session=owned:…` 跳到智能体空间；`/runtime?session={ID}` 就是分工与运行里选中该智能体。分工讨论仍是旧组件，组织复盘列表点开即进入原件阅读器。

## 内容与状态

通用的空、加载、失败、未知规则见[设计原则](../principles.md)。

- 职责存在 ≠ 已有可运行的实例。链接里的职责逐页查找，读完仍没有就明说，不定位到别的职责。
- 运行时写明是否已绑定（绑定后不可更换）、每个 skill 是否加载及原因、清单来自运行时还是按文件推断。保存后所选职责不变，下一轮生效；规则见 [Agent CLI](../../development/agent-cli.md#准备或复用受管-session)。
- 承载列表只有在最近一次读取成功时才给出打开、复制后的入口和路由核对；重读失败时保留旧内容并标明。
- 关闭只在没有阻断时提供。阻断逐条写明：状态不是就绪、原生线程未绑定、在途或结果未知的运行、队列占用，以及运行或队列没读回。消息与分派的完整核对在智能体空间的关闭面板。
- 同职责 ≠ 已接手：接手只认同一任务修订的接受记录（[可信关系](../../architecture/contracts.md#9-分工讨论的可信关系反查)）。新聊天或绑定职责 ≠ 试行有效（[分工试行](../../product/daily-loop.md#分工提议怎样试行)）。
- 组织复盘是 `organization_review` 类型的文档；报告已保存 ≠ 建议已采纳。

## 截图

由 `team-roles-browser.test.ts` 生成（`EVOLOOP_TEAM_ROLES_SCREENSHOT_DIR`），宽度 1440、1024（右栏为抽屉）、390，不入库。

## 代码与测试

| 范围 | 源码（`apps/workbench/src/`） | 测试（`apps/workbench/test/`） |
| --- | --- | --- |
| 外壳与组织复盘 | `features/team/TeamWorkspace.tsx`、`features/team/OrganizationReviewList.tsx`、`shared/routes.ts` | `team-browser.test.ts`、`team-presentation.test.ts` |
| 职责 | `features/roles/RolesView.tsx`、`features/roles/RoleDetail.tsx`、`features/roles/RolePresence.tsx`、`features/roles/RoleRuntime.tsx`、`features/roles/RoleTemplates.tsx`、`features/roles/rolePresentation.ts` | `role-presentation.test.ts`、`role-runtime-card.test.ts`、`role-template-summary-browser.test.ts`、`role-card-keep-open-browser.test.ts`、`resident-observation-browser.test.ts`、`team-roles-browser.test.ts` |
| 分工与运行 | `features/runtime/ExecutionView.tsx`、`features/runtime/ManagedSessionDetail.tsx`、`features/runtime/ManagedSessionCreate.tsx`、`features/runtime/RunList.tsx`、`features/runtime/executionPresentation.ts` | `execution-presentation.test.ts`、`runtime-session-role-browser.test.ts`、`runtime-model-selection-browser.test.ts`、`runtime-reconcile-browser.test.ts` |
| 分工讨论、飞书协作 | `features/discussions/DiscussionPanel.tsx`、`features/collaboration/CollaborationPanel.tsx` | `discussion-panel.test.ts` |

## 相关

- 产品：[对象关系与能力职责](../../product/workbench.md#对象关系与能力职责)、[分工专题](../../product/functional-scenarios.md#分工专题从实际负担选择方法容量或职责)
- 合同：[RoleRegistry 与 SessionRuntime](../../architecture/contracts.md#4-roleregistry-与-sessionruntime)、[具体承接与职责分开](../../architecture/contracts.md#具体承接与职责分开)
