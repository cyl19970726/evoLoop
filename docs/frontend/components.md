# 组件清单：用哪个、何时用

工作台只用一套组件。新页面先在这里找，找不到再新增，并把新组件补进本表。

**目标与现状。** 目标是基础组件放在 `packages/ui`（`@evoloop/ui`），基于 shadcn/ui 和 Radix，样式只引用[设计基础](foundations.md)的 token（[DEC-036](../decisions.md#用户已确定的方向)）。这个包不依赖业务合同、不发请求，文案由调用方传入。现状是只有 `apps/workbench/src/components/ui` 里的 `Button` 和 `Sheet` 来自 shadcn，`Button` 全仓只用了 2 次；真正共用的只有 `ui/shared.tsx` 的 `Alert`（`.notice`）和 `.empty` 样式类，其他控件由各页自己写。迁移由[前端改版 issue #229](https://github.com/cyl19970726/evoLoop/issues/229) 跟踪。上游组件的来源与许可登记在 `apps/workbench/THIRD_PARTY.md`。

## 基础组件

| 组件 | 用途 | 规则 |
| --- | --- | --- |
| Button | 触发操作 | 变体：`primary`（每屏最多一个）、`secondary`（默认）、`ghost`（列表与工具栏）、`danger`（不可逆操作）。文字以动词开头，2–6 个字 |
| IconButton | 只有图标的操作 | 必须有可读名称（`aria-label`），悬停显示提示 |
| Field、Input、Textarea、Select | 表单输入 | 标签在上，说明和错误在下；错误写原因和改法 |
| StatusTag | 显示状态 | 只按[状态表](foundations.md#状态的视觉表达)渲染，颜色加图标加文字 |
| Badge | 计数、类型、短标记 | 中性色为主，不表达状态 |
| Notice | 页内提示 | 信息、等待、失败三种；不代替空状态 |
| Dialog | 确认危险或低频操作 | 写清影响对象和确认后的结果；不放长表单 |
| Sheet | 窄屏导航、窄屏右栏 | 从边缘滑出，Escape 关闭并回到触发位置 |
| DropdownMenu、Tooltip | 次要操作、补充说明 | 不把主要操作藏进菜单 |
| Tabs | 同一对象的平级视图 | 少用；优先一条连续的内容流 |
| Table | 表格视图、版本差异 | 原生表格语义，表格内部横向滚动，行点击不吞掉单元格里的链接 |
| ListRow | 左栏和列表里的一行 | 用细线分隔，不做成一张张卡片 |
| Collapsible | 一行摘要，点开看详情 | 收起时一行灰字，展开后缩进显示 |

## 状态组件

| 组件 | 什么时候出现 | 必须包含 |
| --- | --- | --- |
| EmptyState | 确认没有对象 | 为什么空、可以做什么；不用“暂无数据”一句带过 |
| LoadingState | 首次读取 | 骨架占位；再次读取时保留旧内容，只显示“正在核对” |
| ErrorState | 读取或操作失败 | 发生了什么、旧内容是否仍在、下一步；技术细节可展开 |
| UnknownState | 结果未知、权限不足、机器离线 | 已知的最后事实、原因、谁能处理、怎样查回 |

## 对话流组件

Session 页中间栏用这一组组件，任务和文档的进展时间线也复用它们。

| 组件 | 用途 |
| --- | --- |
| MessageBubble | 人的输入，浅色气泡，靠右 |
| AgentMessage | Agent 的回复，无气泡正文，支持 Markdown |
| ToolSummaryRow | 工具调用折叠成一行灰字，例如“已执行 3 个指令 ›”，失败标红 |
| NestedActivity | 子 Agent 或子任务的内容，缩进显示在摘要下面 |
| LiveStatusLine | 正在进行的事，一行，带耗时 |
| QuestionCard | 需要人回答的问题，嵌在流里，写明谁能回答、何时有效 |
| Composer | 底部输入框，固定在中间栏底部 |

## 布局组件

AppShell、Sidebar、ThreeColumn、RightPanel、PageHeader 组成页面骨架，规则见[布局](layout.md)。

## 业务共享组件

这些组件理解业务对象，放在工作台的共享层，不放进 `packages/ui`：

- **ObjectLink**：链接到任务、文档、Session 等对象，显示名称，不显示原始 ID。
- **RevisionTag**：显示所看修订与当前修订的关系，例如“当前版”“旧版 · 有新版”。
- **ShortId**：需要时显示缩短的标识，悬停看完整值，可复制。
- **业务状态映射**：把 Task、Run、Delivery 等的状态转换成 StatusTag 的输入。

## 组件样例页

目标是在工作台里提供一个组件样例页，用假数据渲染上面所有组件的各种状态。它和代码同步更新，是查看组件外观的唯一参照，文档里不放组件截图。
