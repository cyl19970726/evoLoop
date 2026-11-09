# Sessions：谁在做，做到哪里，Leader 怎样安排

Session 页说明一个具体实例此刻在做什么、做出了什么；“Leader 安排”说明这些 Session 和任务是怎样被组织起来的。

## 这一页回答什么

- 某项任务实际由哪个 Session 承接，现在做到哪、卡在哪？
- 这个 Session 的输入、Agent 活动、工具调用和回复按什么顺序发生，清单做到第几步？
- 它交付了什么，有没有问题在等我回答？
- Leader 怎样安排各个 Session 与任务，目标是什么，哪里有冲突？

## 布局

| 栏 | Session | Leader 安排 |
| --- | --- | --- |
| 内层栏（对象列表） | 顶部固定“Leader 安排”，下面是 Session 目录：搜索，分业务 / System / 待归类，历史可展开 | 同左 |
| 中间 | 对话与 Agent 活动流（见下方“目标体验”），输入框固定在底部 | 上半部分是当前的编排总览文档，下半部分是安排看板：每个 Session 一行，写职责、当前任务、排队任务和状态；没有承接者的任务单独一组 |
| 右栏（可收起） | 角色、运行时（读 Session 自己的绑定与执行配置）、所在机器（#219 之前显示“未知”）、当前任务、队列、成果 | 数据能证明的冲突与风险：同一 Session 有多项进行中任务、依赖未完成就已开始、截止已过或临近、待验收却没有可用的验收者 |

外壳与左栏见[布局](../layout.md)，场景见[场景 3](../scenarios.md#十个场景)与[场景 11](../scenarios.md#场景-11看清-leader-怎样安排-session)。

现状（#229 PR6a）：
- **内层栏目录**：已改为新的智能体目录。顶部是搜索和“统筹安排”，下面按业务智能体、系统智能体分组，历史与待归类可展开。每项有按职责取底色的头像、当前任务或职责、状态。状态用平白的话写记录能说明的事（有在途工作、无在途工作、占用待核对），不写内部来源词。
- **还没做的**：
  - “统筹安排”暂时打开旧的目录页，PR6b 换成安排视图。
  - 详情页仍是旧版：页首状态卡，下面是“活动与对话 / 任务与队列 / 成果”三个页签和底部输入；连续工具调用合并为“工具与活动 · N 项”，没有子 Agent 层级；“所在机器”没有数据来源。PR6c 改成中间对话流、右栏信息。
  - 编排总览还只是一份普通过程文档。

## 内容与状态

通用的空、加载、失败、未知规则见[设计原则](../principles.md)。

- 目录按正式 RoleClass 分组；没有正式 Role、跨类或读取失败的进“待归类”并写原因。外部状态未知 ≠ 空闲。
- 首屏先认清实例：名称、真实状态、职责、受管还是外部接入。
- Session 就绪 ≠ Run 运行中；已发送 ≠ 已读 ≠ 已采用；Run 结束 ≠ 已交付；closing ≠ closed。
- 活动流按真实顺序和发送者显示，唯一有据的 Task 关系才给任务入口（[历史与实时读取](../../architecture/codex-integration.md#session-工作区的历史与实时读取)）。失败、待答和阻断不折叠。
- 加载更早内容时保持阅读位置，新进展不抢走阅读位置。
- 待答卡片区分待答、已保存、已发入原生连接、已清理（[原生提问](../../architecture/codex-integration.md#原生提问与业务问答)）。实时状态断线后标过期，Token 与费用无证据写未知（[原生观察](../../architecture/codex-integration.md#有界原生观察)）。
- 结果未知的输入保留原文（[即时输入](../../development/session-direct-input-integration.md)）。模型的配置、生效回执和实际运行分开写；外部 Desktop 会话只显示已核实的能力。
- 关闭入口列出阻断原因：未完 Task、队列、Run、消息、待答问题、Session 忙碌；来源没读全时不按旧内容关闭。
- 从 Task 进来再返回，恢复页签和阅读位置；切换项目、身份或 Session 时清掉旧数据。
- Leader 安排：总览文档写的冲突以文档为准，界面只补充数据能证明的部分；调整安排回到与 Leader 的对话，由 Leader 经 CLI 修改。

**目标体验：像用 Claude Code 一样用 Session**

随时知道 Agent 在做什么、做到哪一步，发消息也一样顺手。参考是用户提供的两段录屏：Claude Code 桌面版（工作流、待办清单、输入框、右栏环境与产出）和一个 Bot 应用（提问卡、右栏实体卡、单行实时状态）。

| 交互 | 怎样做 | 数据来源与现状 |
| --- | --- | --- |
| 连续的工作流 | Agent 正文不包卡片；工具调用折叠成一行灰字（“已执行 5 个指令，已建立 1 个文件，1 个失败 ›”），展开后每步一行，失败标红，改动的文件带增删行数 | 时间线 tool 条目，Codex 已有；文件增删行数需要工具详情 |
| 需要你决定 | Agent 停下来等人时，流末出现提问卡：一句问题、几个可点的选项（A、B、C…），最后一项“其他”可以直接写；选好后点“提交”，等于发出这条回复，卡片随后折叠成一行“已回答：…” | 原生提问与业务问答已有，但不在时间线里（见下表） |
| 输入框信息 | 输入框下方一行：当前模型、权限或执行配置、上下文用量 | Session 执行配置与用量部分已有 |
| 实时状态行 | 流末一行，前面是 Session 的身份标记：“正在运行测试 · 1 分 04 秒 ›”，点开看当前工具 | 进行中的条目与开始时间，Codex 已有 |
| 待办清单 | 固定在输入框上方，每步显示已完成、进行中、待做，随 Agent 更新；全部完成后折叠成一行 | Codex 的 `turn/plan/updated` 已有分步状态，但被压成一段文字；需要在合同里保留结构化步骤。Claude 的 TodoWrite 尚未接入 |
| 发消息 | Enter 发送；运行中按 Enter 补充到当前这一轮（运行时支持时），Cmd/Ctrl+Enter 排到下一轮；已排队的消息显示在输入框上方，可取消；停止按钮中断当前这一轮 | 发送、排队、取消、中断已有命令；补充到当前轮目前只有 Codex |
| `/` 与 `@` | 输入 `/` 弹出当前职责可用的技能和命令（停止这一轮、撤回排队消息、关联任务或文档）；输入 `@` 选择其他智能体，这条消息另发一份给对方，两边时间线各留一条记录（见[组件清单](../components.md#对话流组件)） | 技能清单来自职责配置；`@` 用现有的给指定智能体发消息命令；选中技能后运行时是否按技能执行待确认；关联文档需要扩展消息的上下文字段（现在只能带任务） |
| 头像与称呼 | 界面上 Session 叫“智能体”、Leader 叫“统筹”（[界面用语](../principles.md#界面用语)）；每个智能体有按职责取底色的卡通头像，出现在目录、标题、状态行和 `@` 菜单里 | 头像由职责和实例推出，不需要新数据 |
| 每轮小结 | 一轮结束时，最后一条回复后跟一行本轮产出：改了什么、交付了什么、下一步等谁 | 最终回复与交付记录已有 |
| 右栏 | 顶部是实体卡：身份标记、名称、职责、所在机器与状态（在线 / 空闲 / 休眠）；下面两个页签，“动态”看当前任务、队列和最近活动，“资料库”看本 Session 的产出、交付和关联文档；再往下是环境（工作目录、执行配置）和上下文用量 | 工作目录与用量部分已有；机器等 #219 |

**两种运行时的现状差异**

界面按 Session 自己的运行时判断能做什么，服务端时间线能力也按它计算（Claude 不报历史与实时）。做不到的功能写明限制，不留空白。

| 能力 | Codex | Claude |
| --- | --- | --- |
| 时间线历史与实时 | 需开启实验性工作区读取且服务端支持 | 没有；中间栏目前只有 evoLoop 自己保存的输入消息 |
| 子 Agent | 主线程只有一条“Agent collaboration”工具条目和一条空的 notice；子线程未读取，读取它要按接收线程 ID 并单独设计授权范围 | 子消息与主流在同一个流里，但现在被丢弃；父级是发起它的工具调用 ID，可直接映射到计划中的 `parentEntryId` |
| 待答问题 | 开启原生提问时经单独通道读写，不在时间线里 | 不支持 |
| 运行中补充输入 | 经组合运行时的转向能力 | 不支持，只能排队到下一轮 |

## 截图

[![Sessions 目录：两条左栏，项目栏和主区各有一份 Session 目录](../../assets/frontend-journey-20261108/sessions-1440x900.png)](../../assets/frontend-journey-20261108/sessions-1440x900.png)

2026-11-08，发布后维护服务 36cb620。看点：项目栏和主区各显示一份 Session 目录，内容重复；目标是只在内层栏保留一份目录，中间直接打开所选 Session。

[![Session 详情公开脱敏版：没有右栏，状态卡在上，三个页签和底部输入在下](../../assets/frontend-journey-20261108/session-detail-1440x900.png)](../../assets/frontend-journey-20261108/session-detail-1440x900.png)

2026-11-08，同一版本，消息与工具正文已换成占位。看点：没有右栏，状态卡和关联任务占去首屏上部，下面是三个页签和底部输入。逐步说明见[实景旅程](../journeys/current-work.md#3-从任务核对具体承接者)。

## 代码与测试

| 范围 | 源码（`apps/workbench/src/`） | 测试（`apps/workbench/test/`） |
| --- | --- | --- |
| 外壳 | `app/shell/AppShell.tsx` | `shell.test.ts`、`session-directory-groups-browser.test.ts` |
| 智能体目录（内层栏） | `features/sessions/SessionNavigation.tsx`（新目录）、`features/sessions/SessionsDirectoryPage.tsx`、`features/sessions/sessionDirectoryPresentation.ts`、`features/sessions/useSessionDirectoryGroup.ts` | `session-directory-presentation.test.ts`、`session-directory-groups.test.ts`、`session-directory-groups-browser.test.ts` |
| Session 详情 | `features/sessions/SessionWorkspace.tsx`、`features/sessions/SessionTimeline.tsx`、`features/sessions/workspaceTimelineModel.ts`、`features/sessions/DirectInputEntry.tsx`、`features/sessions/NativeSessionPanel.tsx`、`features/sessions/SessionModelControl.tsx`、`features/sessions/SessionClosePanel.tsx` | `session-workspace-redesign-browser.test.ts`、`session-timeline-browser.test.ts`、`session-workspace-timeline-model.test.ts`、`session-direct-input-layout-browser.test.ts`、`session-native-input-browser.test.ts`、`session-native-progress-browser.test.ts`、`session-close-entry-browser.test.ts`、`task-session-return-browser.test.ts` |
| Leader 安排的数据 | `features/queues/ResidentQueuePanel.tsx`、`shared/leaderWorkLoad.ts`、`features/sessions/TaskAssignmentPanel.tsx` | `leader-work-load.test.ts`、`leader-work-overview-browser.test.ts` |
| 数据来源 | `packages/contracts/src/session-timeline.ts`、`packages/adapter-claude-agent-sdk/src/index.ts`、`packages/adapter-codex-app-server/src/workspace-map.ts`、`apps/coordinator/src/runtime/routed.ts` | — |

## 相关

- 产品：[对象关系与能力职责](../../product/workbench.md#对象关系与能力职责)、[职责与 Session](../../product/functional-scenarios.md#职责session-与项目初始安排)、[从需求到 Leader 安排](../../product/functional-scenarios.md#场景-1从需求到-leader-安排)
- 合同：[Session 工作观察](../../architecture/contracts.md#session-工作观察有界读取同一份事实)、[RoleRegistry 与 SessionRuntime](../../architecture/contracts.md#4-roleregistry-与-sessionruntime)、[具体承接与职责分开](../../architecture/contracts.md#具体承接与职责分开)
- 运行时：[普通消息与业务执行](../../architecture/codex-integration.md#普通消息与业务执行共用原会话)、[执行配置](../../architecture/codex-integration.md#受控-session-恢复与执行配置)、[Session 关闭](../../architecture/codex-integration.md#端口合同拟议)、[消息额度](../../development/agent-cli.md#普通消息累计用量与旧试用-grant-转换)
- 团队与职责见[团队](team.md)。
