# Codex × Claude 双运行时并存：抽象层与能力适配

> 状态：**研究提议，未实施**。2026-11-08 起草，是 [Claude Agent SDK 接入方案](claude-agent-sdk-integration-20261108.md) 的配套文档。前提已经确定：**Claude 与 Codex 长期并存，不替换 Codex**。本文回答三个问题：
> 1. evoLoop 依赖运行时提供哪些关键能力（逐项列出，请确认有无遗漏）；
> 2. 为了让两个 provider 同时存在，需要做哪些 provider 中立的抽象；
> 3. 两边能力不一样的地方，适配器分别怎么处理。
>
> 依据：evoLoop `main@d8f60eb` 源码（每项都标了调用点）和 `@anthropic-ai/claude-agent-sdk@0.3.319` 的 `sdk.d.ts`。**[已核]** 表示已从类型声明或官方文档确认；**[待 spike]** 表示还要用真实进程验证，编号沿用主文档 §8 P0 的 S1–S10；本文新增的 S11–S14 也已经补进主文档那张表。

---

## 0. 结论

1. **并存模式下，抽象层是必做项。** 主文档里的 P1（去 Codex 化）原来是"可选的前置重构"，现在改为**并存的前提条件**。理由是现在 core 和 coordinator 里有 12 处直接认 Codex 的地方（主文档 §1.2 C1–C12），只接一个 provider 时还能让 Claude 伪装成 Codex，两个 provider 同时在线就做不到了。
2. **抽象不取最大公约数。** 做法分三层：
   - **不变量层**（先落库、只发一次、只有 owner 能写、结果未知时不重试、原生完成不等于验收、知识外置、全权限加预算、原始会话正文不外泄）：两个 provider 都必须满足，**不允许降级**。哪个 provider 做不到，就不能启用。
   - **能力层**：用 `RuntimeCapabilities` 显式声明每项能力"有没有、语义是什么、保真度如何"，取代现在靠"可选方法存不存在"来推断的写法。
   - **适配层**：每个 provider 用原生、模拟、降级、不支持四种策略之一实现每项能力。
3. **关键能力共 28 项，分 6 类**（§2）。按 Claude 侧的实现方式统计：
   - 15 项可以直接映射到原生能力，其中 4 项 Claude 比 Codex 更强（预分配 Session ID 和 Turn ID、可持久化的首派证明、按美元计的成本）。
   - 8 项要由适配器用别的原语组合实现：归档、普通会话准入、未知结果对账、工作痕迹、工作区时间线、托管压缩、执行画像激活、Role 技能。
   - 3 项只能降级或部分不支持：派发前拒绝证明、版本钉，以及原生观测里的 plan/diff。
   - 2 项不进入合同：审批（DEC-033 下两边都不会触发）、鉴权（只是配置不同）。
4. **一个 Session 终身只属于一个 provider。** 想换 provider 就新建 Session，Role 和职责不变。路由键是 `runtime_session.runtime_provider`，coordinator 用 `RuntimeRegistry` 把请求分派到对应的适配器。
5. **能力不够时，默认在派发前拒绝，不静默降级。** 例如某个 Role 需要原生提问，而它被分到的 provider 不支持，那么在 Session 预留阶段就返回 `RUNTIME_CAPABILITY_UNAVAILABLE`，不会等到运行中途才失败。证据类能力（trace、时间线、观测）例外：允许降级，但必须标出保真度。
6. **共享合同测试套件**（§7）是并存方案的质量闸门。Codex 适配器在 P1 结束时要先通过这套测试，以证明重构没有改变它的行为。Claude 适配器要通过同一套测试才能启用。

---

## 1. 抽象原则

### 1.1 不能降级的不变量（两个 provider 都必须满足）

| # | 不变量 | 出处 | 对适配器的要求 |
| --- | --- | --- | --- |
| I1 | 先在 PG 持久化预留，再做外部调用；同一个预留只发一次 | 架构原则、`runtime/service.ts` | 必须能在派发前或派发后**确定性地**把原生 Turn 绑定到 evoLoop 的 operationId |
| I2 | 只有 owner connection 能写 | `RuntimePort` 注释、`registerBinding` | 写操作必须先校验 binding 归属；子进程或连接换了以后，旧句柄必须失效 |
| I3 | 结果未知时不自动重试 | `faultMessage.run_start` 等 | 确认没收到时抛 `RuntimeUnknownError`，绝不重发 |
| I4 | 原生 Turn 完成不等于任务验收 | 评审包机制 | 适配器只报告原生终止状态，不做验收判断 |
| I5 | 知识以外置 Wiki 和 PG 为准 | DEC-006/018/027 | 关闭 provider 自带的长期记忆（Claude 的 auto memory、Codex 的 memories 之类） |
| I6 | 全权限运行，用 grant 限预算 | DEC-033 | 用全权限模式运行，但必须保留守卫和预算上限 |
| I7 | 原始会话正文不进公开数据、不进日志 | `dispatchFailureDetail` 注释、native-observation 的 `clip` | 跨边界的只能是有界的事实（分类、计数、ID），不能是原文 |

**规则**：哪个 provider 满足不了 I1–I7 中的任何一条，配置校验阶段就直接拒绝启用它。没有"降级运行"这个选项。

### 1.2 中立化原则

1. **业务层只看中立类型。** 原生方法名、错误码、item 类型都降为 `native` 诊断字段（有界字符串），业务逻辑不能用它们做分支判断。
2. **能力要显式声明。** 现在的写法是 `if (runtime.compactThread)`，这只能看出"有没有这个方法"，看不出语义：Codex 用 RPC 压缩，Claude 用斜杠命令，"没东西可压"时的结果也不同。改为 `capabilities().compaction` 返回语义枚举。
3. **缺失要显式。** 沿用 `readWorkPage` 注释里的原则 "Absence means unsupported, never an empty complete trace"，推广到所有证据类能力：保真度分为 `native`、`reconstructed`、`approximate`、`unavailable` 四档，UI 和评审包都要标出来。
4. **词汇不复用。** 名字相同、语义不同的字段必须改名或分开。最典型的是 `maxTurns`，见 F24。
5. **暂不重命名 Thread。** 现有代码里 "Thread" 很多，P1 只加一张术语表（Thread = 原生会话；Claude 下 `nativeThreadId === nativeSessionId`），不做大规模重命名，以免没有收益的改动。

---

## 2. 关键能力清单（请确认）

下表是从 coordinator 和 core 对 `RuntimePort` 及 `ManagedRuntime` 的**实际调用**里逐项整理出来的，不是从接口定义抄的。"MVP" 列表示 Claude 适配器第一版（主文档 P2）是否必须具备。

### A. 身份与生命周期

| ID | 能力 | evoLoop 里谁在用 | 现有接口 | MVP |
| --- | --- | --- | --- | --- |
| F01 | 创建 Session 并绑定原生会话 | `runtime/runner.ts` 创建流程、`verifyBinding` | `create`、`registerBinding` | 必须 |
| F02 | 首派证明（新建会话还没发过任何 Turn） | runner 首次派发、执行画像零 Turn 保护 | `hasFreshStartProof` | 必须 |
| F03 | 重启后恢复 | `core/session-recovery`、runner | `resume` | 必须 |
| F04 | 健康检查与断连通知 | `main.ts`、runner、pump、read-only-owner | `isReady`、`onDisconnect` | 必须 |
| F05 | 关闭与归档（带回读证明） | runner `session_close` | `archiveThread`、`isThreadArchived` | 必须 |
| F06 | 会话命名同步 | runner `session_name_sync` | `readThreadName`、`setThreadName` | P3 |

### B. 派发与对账

| ID | 能力 | evoLoop 里谁在用 | 现有接口 | MVP |
| --- | --- | --- | --- | --- |
| F07 | Task Run 派发（幂等） | runner `run_start`、`run_bind`；输入首行带 `[evoloop-run-operation:<id>]` | `startTurn` | 必须 |
| F08 | 普通会话消息（准入指纹 + 派发） | `session-messages/pump.ts` | `qualifyConversationThread`、`startConversationTurn` | P3 |
| F09 | 中断 / 手动停止 | pump、`manual-stop.ts`、runner | `interruptTurn` | 必须 |
| F10 | 结果未知时对账 | runner `run_reconcile`、`turn-lookup.ts` | `inspect`、`listTurns`、`listItems` | 必须 |
| F11 | 派发前被拒的证明（复核后可继续） | `core/runtime/service.ts` 的 `preTurnProof` | `-32600` 拒绝 + requestId | P3 |
| F12 | 提取最终答复（评审包材料） | runner `finalMessages()` | `listItems` 加 Codex 的 item 解析 | 必须 |

### C. 观测与回读

| ID | 能力 | evoLoop 里谁在用 | 现有接口 | MVP |
| --- | --- | --- | --- | --- |
| F13 | 原生观测投影（状态、item、计划、diff、token） | `runtime/native-observation.ts` → `core/native-observation` | `onEvent`（8 个 Codex 方法的白名单） | 必须（状态、item、用量） |
| F14 | 工作痕迹（trace） | runner、Workbench | `readWorkPage` | P3 |
| F15 | 工作区时间线（历史 + 实时） | `session-timeline/*` | `readWorkspaceHistory`、`onWorkspaceUpdate` | P3 |

### D. 运行期控制

| ID | 能力 | evoLoop 里谁在用 | 现有接口 | MVP |
| --- | --- | --- | --- | --- |
| F16 | 托管压缩 | `runtime/compaction.ts`、`session_compaction` 表 | `compactThread`、`observeCompaction` | P3，建议降为可选（两边都会自动压缩，见[审计 C3](codex-adapter-audit-20261108.md#c3中托管压缩基本是多余的真正缺的是上下文超限的失败识别)） |
| F17 | 执行画像激活（换模型或 effort） | runner `profile_activation` | `activateExecutionProfile`、`inspectExecutionProfileActivation` | P3 |
| F18 | 模型列表 | `main.ts` 的 `listRuntimeModels` | `listModels` | P3 |

### E. 交互与工具

| ID | 能力 | evoLoop 里谁在用 | 现有接口 | MVP |
| --- | --- | --- | --- | --- |
| F19 | 原生用户输入（模型向人提问） | `runtime/native-input.ts` | `onNativeInput`、`hasPendingInput`、`respondToInput`、`nativeInputConnectionId` | P3 |
| F20 | 审批 | runner `approval_receipt` | `onApprovalRequest` | 不涉及（DEC-033） |
| F21 | 动态工具（browser-read） | `runtime/browser-read.ts`、`main.ts:346` | Codex 选项 `dynamicTools`、`callDynamicTool` | P3 |
| F22 | Role 技能与上下文注入 | `lightweight-input.ts`、`roleSkills`、`materialCli` | 输入文本加 Codex skills 目录 | 必须（方案 A） |

### F. 治理

| ID | 能力 | evoLoop 里谁在用 | 现有接口 | MVP |
| --- | --- | --- | --- | --- |
| F23 | 失败分类 | runner 的 `faultCategory`、`RuntimeTurnFailure` | Codex 错误类 | 必须 |
| F24 | 预算与用量 | `execution-capability.ts`、`core/session-messages` 的 `maxTurns` | grant、token 事件 | 必须 |
| F25 | 隔离（配置、记忆、环境变量） | Codex 的 `childEnvironment`、`CHILD_ENV_KEYS` | 适配器内部 | 必须 |
| F26 | 鉴权 | 部署配置 | 适配器内部 | 必须 |
| F27 | 版本钉 | `configuration.ts` 的 `protocolVersion`、`PINNED_PROTOCOLS` | 适配器内部 | 必须 |
| F28 | 子进程诊断 | runner 的诊断落库 | `listChildDiagnostics`、`onChildDiagnostic`、`flushChildDiagnostics` | P3 |

> **请你确认**：(a) 这 28 项有没有漏掉的业务依赖，比如 Workbench 直接读了原生字段的地方；(b) 标为"必须"的那几项是不是就是 MVP 的底线。

---

## 3. 能力适配矩阵

策略标记：
- **原生**：两边都有对应的原生能力，只需要映射。
- **原生+**：Claude 的原生能力比 Codex 强。core 可以选择利用，但不依赖。
- **模拟**：Claude 没有对应能力，由适配器组合其他原语实现，而且必须能回读出证明。
- **降级**：只能提供更弱的保证，必须在 `capabilities` 和 UI 里写明。
- **不支持**：声明为缺失，依赖它的业务入口在派发前就拒绝。

### A. 身份与生命周期

| ID | Codex 现状 | Claude 能力 | 策略 | 适配做法 | 验证 |
| --- | --- | --- | --- | --- | --- |
| F01 | `thread/start` 应答后才拿到 threadId 和 sessionId | `Options.sessionId` 由调用方预先指定 UUID，`system/init` 回显 `session_id` [已核] | **原生+** | core 在预留时生成 `nativeSessionId` 并和 Session 一起落库。`create` 的做法是启动 host，等到 `init.session_id` 与预分配值相同才返回 binding。`nativeThreadId` 设为与 `nativeSessionId` 相同 | S1：流式输入下还没发首条消息时，`initializationResult()` 和 init 是否已经到达；转录文件什么时候落盘 |
| F02 | 内存里记录 `freshThreads`，只在同一连接内有效 | 转录不存在，或者转录里没有 user 消息，就能证明还没派发过，而且这个证明可以持久化 | **原生+** | `hasFreshStartProof` 的条件是：本 host 还没发过 Turn，并且 `getSessionInfo(id)` 查不到记录或者没有任何 user 消息。重启后仍然能证明，比 Codex 强 | S1 |
| F03 | `thread/resume` | `Options.resume` 加同一个 sessionId，拉起新进程 [已核] | **原生** | 每次 resume 都重新施加完整的 profile：model、effort、permissionMode、env、hooks、mcpServers。然后用 `init.model` 和 `init.permissionMode` 回读核对，不一致就当作 `RuntimeProtocolError` | — |
| F04 | 只有一个连接，断开会影响所有 Thread | 每个 Session 一个 CLI 子进程 | **原生**（粒度不同） | 合同改为 `onDisconnect(listener(reason, scope))`，其中 `scope` 是 `{kind:'adapter'}` 或 `{kind:'session', sessionId}`。adapter 级别的 `isReady` 条件是凭据可读且 CLI 版本在白名单内 | S8：并发子进程的资源占用 |
| F05 | `thread/archive`，并能在归档列表里回读到作为证明 | **没有原生归档**；有 `tagSession` 和 `getSessionInfo().tag` [已核] | **模拟** | `archiveThread` 先关闭 host，再执行 `tagSession(id, 'evoloop:closed:<operationId>')`。`isThreadArchived` 要求回读到的 tag 精确相等才返回 true。**绝不调用 `deleteSession`**，以保留证据。语义差异：原生会话列表里仍然能看到这个会话，只是带了标记 | S11：host 还活着时调用 `tagSession` 或 `renameSession`，与转录写入有没有冲突 |
| F06 | `thread/name/set` 并回读 | `renameSession`，回读用 `getSessionInfo().customTitle`；也可以用 `Options.title` [已核] | **原生** | 只改元数据，不启动模型 Turn，满足注释里的约束 | S11 |

### B. 派发与对账

| ID | Codex 现状 | Claude 能力 | 策略 | 适配做法 | 验证 |
| --- | --- | --- | --- | --- | --- |
| F07 | `turn/start` 应答后才有 turnId；靠输入首行的标记来对账 | `SDKUserMessage.uuid` 由调用方指定，assistant 和 result 消息会回显 `user_message_uuid(s)` [已核] | **原生+** | 适配器内部生成 uuid，并通过 `startTurn` 的返回值交出。core **先不改状态机**（决策 D7），两个 provider 走同一路径。输入首行仍然保留 `[evoloop-run-operation:…]` 标记，方便两边一致地人工核对。适配器强制**每个 Session 最多一个在途 Turn**；如果 result 里 `user_message_uuids` 的数量不是 1，或者不包含本次 uuid，就把这个 Turn 标为 unknown，用来防止 fold-in | S2：回显的时序；S14：fold-in |
| F08 | 准入时 `thread/read` 检查状态 idle、模型一致并算出指纹，然后 resume，再 `turn/start` 并带上 `clientUserMessageId` | host 的 `session_state_changed`、`init.model`、转录末尾的状态 | **模拟**（准入）+ **原生**（派发） | 指纹改为基于中立字段：`provider`、`nativeVersion`、`sessionId`、`cwd`、`scope`、`profile`、`observedModel`、`status`、`lastTerminalTurn`。**指纹里包含 provider**，防止跨 provider 复用。派发路径和 F07 共用 | — |
| F09 | `turn/interrupt(turnId)` | `Query.interrupt()`，不带 turnId 参数 [已核] | **原生** | 适配器先核对 `inflight.turnId === 参数`，不一致就拒绝。中断后根据 result 的 `subtype` 和 `terminal_reason` 把状态定为 interrupted。如果 host 已经退出，就没有可中断的东西，转入 F10 对账 | S4：interrupt 之后 result 的形态 |
| F10 | `thread/read` 加 `thread/turns/list` 分页，配合 `lookupKnownTurn` | **没有原生 Turn 列表**；`getSessionMessages` 可以读转录 [已核] | **模拟** | `listTurns` 从转录重建：按 user 消息的 uuid 分组。有终止证据（result 或等价记录）才判 completed 或 failed。只有 user 消息、而且 host 已不在，就判 **unknown，绝不推断为 completed**。转录里找不到这个 uuid 时返回 not_found，沿用 core 现在的语义，即 not_found 不等于可以重试。cursor 用转录的 offset | **S3（关键）**：result 是否写入转录 |
| F11 | `turn/start` 被 `-32600` 拒绝时，`preTurnProof` 记录 requestId 和 code，经人工复核后可以继续 | 没有对等的错误码。能找到的证据是 `result.startup_failure_reason`，以及"转录里确证没有该 uuid、并且 host 已经退出" | **降级** | `preTurnProofSchema` 中立化为 `{provider, refusalCode: string, requestRef: string}`。Claude 只在满足"转录确证没有该 uuid，并且有 startup_failure 或进程退出的诊断"时才产生证明，其他情况一律是 unknown | S3 |
| F12 | 取 `agentMessage` 中 `phase === final_answer` 的那条 | 本 Turn 的 `result.result`，或最后一条 assistant 文本 | **原生** | `finalMessages()` 下沉为端口方法 `readFinalMessages(binding, turnId)`，评审包不再解析原生 item | — |

### C. 观测与回读

| ID | Codex 现状 | Claude 能力 | 策略 | 适配做法 | 验证 |
| --- | --- | --- | --- | --- | --- |
| F13 | 白名单里有 8 个 Codex 通知方法 | `session_state_changed`、assistant 和 user 消息里的内容块、`result.usage` 与 `modelUsage`、`compact_boundary` [已核] | **原生**（状态、item、用量）+ **降级**（plan）+ **不支持**（turn diff） | 适配器输出中立的 `RuntimeEvent.kind`（§4.3）。plan 从 TodoWrite 的输入近似映射，标为 `approximate`。Claude 没有 turn diff，**声明为缺失**。如果确实需要，建议由 coordinator 根据 git 工作区统一计算，这样就和 provider 无关（决策 D6）。用量：Codex 报的是 Thread 累计，Claude 报的是每个 Turn，统一为"每 Turn 增量 + 可选的累计" | — |
| F14 | `readWorkPage`，基于原生 item 分类 | 转录里的 `tool_use` 和 `tool_result` 内容块 | **模拟** | Bash 映射为 command，exitCode 取 `tool_use_result` 的结构化字段，取不到就是 null。Edit、Write、MultiEdit、NotebookEdit 映射为 file_change。WebSearch、WebFetch 映射为 web_search。`mcp__*` 映射为 tool，名字还原为不带前缀的形式。Task 和 Agent（子代理）映射为 tool，但不展开，计入 `unsupportedCount`。thinking 内容不进 trace（I7） | S12：`tool_use_result` 的结构 |
| F15 | 实验 API，需要打开 `workspaceExperimental` 开关 | 历史用 `getSessionMessages`，实时用流式 SDKMessage | **模拟** | 历史和实时**共用同一个**"消息到 WorkspaceEntry"的映射函数。顺序锚点用转录的 uuid 和 parentUuid。`includePartialMessages` 只用于实时显示，不落库。`WorkspaceEntry` 合同本身已经是中立的，不需要改 | — |

### D. 运行期控制

| ID | Codex 现状 | Claude 能力 | 策略 | 适配做法 | 验证 |
| --- | --- | --- | --- | --- | --- |
| F16 | `thread/compact/start`，用数值型 requestId，再回读 contextCompaction item | 发一条 `/compact` 用户消息（uuid 预先分配），得到 `compact_boundary`，trigger 为 manual [已核]。没有可压缩的内容时返回 success，但不产生 boundary [已核] | **模拟** | `requestId` 改为字符串（迁移见 §6）。`RuntimeCompactionObservation` 新增 `outcome` 字段，取值 `compacted`、`noop`、`unknown`。自动压缩（trigger auto）只作为观测事件，**不进入** `session_compaction` 的托管流程 | S5：流式输入下 `/compact` 的时序 |
| F17 | 走 resume 再回读，分支很多（比如已加载的 Thread 可能保留旧模型、零 Turn 时不支持） | 每个 Session 一个进程：空闲时关闭 host，再带着新的 model 和 effort 用 resume 拉起；也可以用 `Query.setModel` 在运行时切换 [已核] | **模拟**（比 Codex 简单）+ effort **降级** | 推荐"重启式激活"，不用 `setModel`，以免同一进程内状态不一致。回读：`init.model` 和 assistant 消息的 `model` 字段都可以确认模型。**effort 没有回读来源**，只能记为"已配置、未观测"（决策 D3）。零 Turn 的 Session 也能激活：重启时直接用新 profile，不需要 Codex 那条 `EXECUTION_PROFILE_ZERO_TURN_UNSUPPORTED` 分支 | S13：effort 能否从任何地方回读 |
| F18 | `model/list`，不需要会话 | `Query.supportedModels()`，需要一个活着的进程 [已核] | **原生**（需要探针进程） | 用一个短生命周期的探针 host 获取，或者缓存最近一次的结果；失败时退回配置里的白名单。两个 provider 的模型词汇不同，grant 按 provider 分开配置 | — |

### E. 交互与工具

| ID | Codex 现状 | Claude 能力 | 策略 | 适配做法 | 验证 |
| --- | --- | --- | --- | --- | --- |
| F19 | 由 `request_user_input` 服务器请求触发，挂在连接上，断连就失效 | AskUserQuestion 工具调用会进入 `PreToolUse` hook（用 matcher 指定）。hook 挂起，等 evoLoop 的答复，然后返回 allow 加 `updatedInput.answers`。也可以返回 `defer`，让本 Turn 结束，并在 result 里带上 `deferred_tool_use` [已核类型] | **原生**（挂起式，和 Codex 等价）；跨重启存活是**可选增强** | 问题结构几乎同构（`questions`、`options{label,description}`、`multiSelect`），可以直接映射到 `NativeInputQuestion`。`connectionId` 用 host 的 startId；host 退出，输入就失效，这一点和 Codex 一致。defer 模式能让提问跨重启存活，**但 resume 之后怎么提交答复还没核实**（决策 D5） | S6：bypass 模式下 hook 的行为、`answers` 的格式、defer 之后再 resume 的答复路径 |
| F20 | `onApprovalRequest`；DEC-033 下策略是 never | `bypassPermissions` 模式下不会调用 `canUseTool` | **不涉及**（两边都不会触发） | Claude 适配器的 `onApprovalRequest` 永远不发事件，并声明 `approvals: 'never_requested'`。守卫用 PreToolUse 的 deny 实现，被拒的调用会出现在 `result.permission_denials` 里，只作为观测记录 | S6 |
| F21 | 实验性的 `dynamicTools`：按 Thread 注册，通过 `item/tool/call` 服务器请求调用 | `createSdkMcpServer` 加 `tool()`，是进程内的 MCP，属于稳定 API [已核] | **原生**（机制不同） | 定义中立的 `RuntimeToolSpec`（§4.4），每个适配器自己注册。Claude 侧的工具名会变成 `mcp__evoloop__<name>`，观测时还原。Claude 这一侧反而是稳定 API，Codex 那一侧是实验协议 | S9：取消信号能否传到 handler |
| F22 | `lightweight-input` 在输入里注入 Role 上下文和 CLI bootstrap，Codex 会读 `.agents/skills` | Claude 只读 `.claude/skills`、`~/.claude/skills`、`additionalDirectories` 和 plugins，**不读 `.agents/skills`** [已核] | **模拟** | 默认用方案 A：输入注入。coordinator 已经有这套逻辑，而且和 provider 无关。方案 B（生成本地插件）作为 Claude 专属的增强，P4 再评估 | — |

### F. 治理

| ID | Codex 现状 | Claude 能力 | 策略 | 适配做法 | 验证 |
| --- | --- | --- | --- | --- | --- |
| F23 | JSON-RPC 的 code 和 category，映射到 `RuntimeTurnFailure` | result 的 `subtype`、assistant 消息的 `error`、`terminal_reason`、`USAGE_LIMIT_ERROR_PREFIXES`、`startup_failure_reason` [已核] | **原生** | 新增类别 `budget_exhausted`，对应 `error_max_turns` 和 `error_max_budget_usd`。这两个上限是 evoLoop 自己设的，不能归入 `provider_rejected`。`providerCode` 统一为字符串 | — |
| F24 | `grant.maxTurns` 计的是 **evoLoop 的会话消息轮数**（`countSessionMessageTurns`）；有 token 事件 | `total_cost_usd`、`usage`、`modelUsage`；`Options.maxTurns` 计的是**单次 query 内模型往返的次数**；`maxBudgetUsd` [已核] | **原生+**（Codex 拿不到美元成本） | **两个 maxTurns 语义冲突，不能直接对接。** 现有的 `grant.maxTurns` 保持原义。另外新增 `grant.maxAgentSteps`（只对 Claude 生效，传给 `Options.maxTurns`）和 `grant.maxBudgetUsdPerTurn`。Codex 侧 `costUsd` 记为 null。Run 记录 usage 和 cost | — |
| F25 | `CHILD_ENV_KEYS` 白名单 | `CLAUDE_CONFIG_DIR`、`settingSources`、`strictMcpConfig`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY`、`plugins: []`、env 白名单 [已核] | **原生**（要多配几个开关） | 隔离配置不做抽象，由各 provider 自己配置。合同测试负责断言：子进程看不到白名单之外的 env，并且没有写入 auto memory | S7 |
| F26 | ChatGPT 登录 | API key、Bedrock 或 Vertex；**不得使用 claude.ai 订阅** [已核] | **不涉及**（只在配置层不同） | 各 provider 自己配置 credential，从文件读取，不进合同 | 计费方式待你决定（主文档 §11-1） |
| F27 | `PINNED_PROTOCOLS` 用 schema hash 钉住版本 | SDK 用 npm 精确版本，加上 `init.claude_code_version` 白名单 | **降级** | 没有协议级的 schema hash，改为录制样本回归测试加版本白名单。`nativeVersion` 进入准入指纹（F08） | — |
| F28 | 只诊断一个 app-server 子进程 | `spawnClaudeCodeProcess` 能拿到每个子进程 [已核] | **原生**（多实例） | `nativeChildDiagnosticSchema` 增加可空的 `sessionId` 字段；每个 host 有自己的 startId | — |

### 3.1 单边能力：暂不暴露给业务层

| 只有 Claude 有 | 只有 Codex 有 |
| --- | --- |
| 子代理（Task/Agent）、`forkSession`、`rewindFiles` 检查点、`outputFormat` 结构化输出、hooks、plugins、`getContextUsage`、美元成本 | 原生 Turn 列表、原生归档、turn diff、`turn/plan/updated`、实验性的工作区 API、不需要会话的 `model/list`、ChatGPT 登录 |

**规则**：单边能力可以在适配器**内部**使用，比如 Claude 用 hooks 做守卫、Codex 用原生 Turn 列表做对账。但在出现**两边都能满足**的中立用例之前，不进入 `RuntimePort`，不让业务层分支依赖它。有两个候选值得 P4 评估：`outputFormat` 可以用于评审包的结构化结论；`forkSession` 可以用于对照评估。

---

## 4. 抽象设计

### 4.1 Provider 身份

```ts
// packages/contracts/src/runtime-provider.ts（新）
export const runtimeProviders = ["codex", "claude"] as const;
export type RuntimeProvider = typeof runtimeProviders[number];
export type RuntimeOwner = "evoloop-codex-app-server" | "evoloop-claude-agent-sdk";
export const ownerOf: Record<RuntimeProvider, RuntimeOwner> = {
  codex: "evoloop-codex-app-server", claude: "evoloop-claude-agent-sdk" };

// RuntimeBinding：owner 字段由字面量改为 RuntimeOwner；新增 provider，便于路由与校验
// resumeProfile.sandbox / approvalPolicy 不改词汇（DEC-033 固定为 full + never），Claude 适配器把它们视为
// "必须为 danger-full-access + never" 的断言，并映射到 permissionMode:'bypassPermissions'。
```

### 4.2 能力声明

```ts
// packages/contracts/src/runtime-capabilities.ts（新）
export type Fidelity = "native" | "reconstructed" | "approximate" | "unavailable";

export interface RuntimeCapabilities {
  provider: RuntimeProvider;
  adapterVersion: string;                    // 适配器自身语义版本
  nativeVersion: string | null;              // Codex 协议版本 / claude_code_version
  identity: { session: "preassigned" | "acknowledged"; turn: "preassigned" | "acknowledged" }; // F01/F07
  process: "shared" | "per_session";                                       // F04
  freshStartProof: "connection_scoped" | "durable";                        // F02
  turnHistory: Fidelity;                                                   // F10
  finalAnswer: "native_phase" | "result_message";                         // F12
  preTurnRefusal: "native_code" | "startup_failure" | "none";              // F11
  observation: { status: Fidelity; items: Fidelity; plan: Fidelity; diff: Fidelity;
                 usage: "thread_cumulative" | "per_turn" };                // F13
  workTrace: Fidelity;                                                     // F14
  workspace: { history: Fidelity; live: boolean };                         // F15
  naming: "native" | "none";                                               // F06
  archive: "native" | "tag" | "none";                                      // F05
  compaction: { mode: "native_rpc" | "slash_command" | "none"; reportsNoop: boolean };      // F16
  profileActivation: { mode: "resume_readback" | "respawn" | "none";
                       readback: { model: boolean; effort: boolean }; zeroTurn: boolean }; // F17
  models: "native_list" | "live_host" | "configured";                      // F18
  nativeInput: { mode: "connection_held" | "hook_held" | "none"; survivesRestart: boolean }; // F19
  approvals: "interactive" | "never_requested";                            // F20
  tools: "dynamic_experimental" | "in_process_mcp" | "none";               // F21
  cost: { tokens: boolean; usd: boolean; budgetCap: boolean };             // F24
}
```

两个适配器预计的声明值：

| 字段 | Codex | Claude |
| --- | --- | --- |
| identity | acknowledged / acknowledged | **preassigned / preassigned** |
| process | shared | per_session |
| freshStartProof | connection_scoped | **durable** |
| turnHistory | native | reconstructed |
| finalAnswer | native_phase | result_message |
| preTurnRefusal | native_code | startup_failure |
| observation | 全部 native，usage 为 thread_cumulative | status、items 为 native；plan 为 approximate；**diff 为 unavailable**；usage 为 per_turn |
| workTrace / workspace.history | native / native（实验开关） | reconstructed / reconstructed |
| naming / archive | native / native | native / **tag** |
| compaction | native_rpc，reportsNoop: false | slash_command，**reportsNoop: true** |
| profileActivation | resume_readback，readback 为 model 与 effort 都可，zeroTurn: false | respawn，**readback 只有 model**，zeroTurn: true |
| models | native_list | live_host |
| nativeInput | connection_held，survivesRestart: false | hook_held，survivesRestart: false（做了 defer 后为 true） |
| approvals | never_requested（DEC-033） | never_requested |
| tools | dynamic_experimental | in_process_mcp |
| cost | tokens 可，usd 不可，budgetCap 不可 | tokens、usd、budgetCap 都可 |

### 4.3 中立事件与错误

```ts
// RuntimeEvent：业务只看 kind；method 降为诊断
export type RuntimeEventKind = "session.status" | "turn.started" | "turn.completed" |
  "item.started" | "item.completed" | "plan.updated" | "diff.updated" | "usage.updated" | "compaction.observed";
export interface RuntimeEvent { provider: RuntimeProvider; kind: RuntimeEventKind;
  sessionId: string; nativeSessionId: string; turnId: string | null; params: unknown;
  native: { method: string } }   // 有界诊断字段

// packages/contracts/src/runtime-errors.ts（新）：Codex 包改为 re-export
export type RuntimeOperation = "session.create" | "session.resume" | "session.read" | "turn.start" |
  "turn.interrupt" | "turn.list" | "session.archive" | "session.rename" | "session.compact" |
  "profile.activate" | "models.list" | "tool.call";
export class RuntimeUnknownError extends Error { operation: RuntimeOperation; nativeRef: string | null }
export class RuntimeServerError extends Error { operation: RuntimeOperation;
  category: "permission_denied" | "not_found" | "invalid_request" | "rate_limited" | "unavailable" | "rejected";
  providerCode: string | null; native: { method: string; code: string | number | null } }
export class RuntimeProtocolError extends Error { operation: RuntimeOperation | null }
```

需要同步修改的地方：
- `runner.ts` 的 `RuntimeFault.nativeMethod` 改为 `operation: RuntimeOperation`，另加 `nativeMethod?: string` 作为诊断字段。
- `dispatchFailureDetail` 里写死的 `"thread/resume" | "turn/start"` 改为按 operation 判断。
- `core/native-observation` 的白名单改为按 `kind` 判断。

### 4.4 端口拆分

做法是把端口拆成能力切面，但**不改调用点**：

```ts
// RuntimePort = 必备核心 + 生命周期 + 可选切面（Partial），可选方法名保持不变，coordinator 调用点几乎不动
export interface RuntimeCore {
  readonly provider: RuntimeProvider; capabilities(): RuntimeCapabilities;
  create(spec: RuntimeSessionSpec): Promise<RuntimeBinding>;          // spec 新增 nativeSessionId?（preassigned 时必填）
  resume(binding: RuntimeBinding, spec: RuntimeSessionSpec): Promise<RuntimeBinding>;
  inspect(binding: RuntimeBinding): Promise<unknown>;
  startTurn(binding, input, operationId, profile?): Promise<RuntimeTurn>;
  interruptTurn(binding, turnId): Promise<void>;
  listTurns(binding, cursor?): Promise<RuntimePage<RuntimeTurn>>;
  listItems(binding, turnId, cursor?): Promise<RuntimePage<unknown>>;
  readFinalMessages(binding, turnId): Promise<string[]>;              // 新：替代 runner.finalMessages(items)
  onEvent(listener): () => void; onApprovalRequest(listener): () => void; close(): Promise<void>;
}
export interface RuntimeHostLifecycle {   // 原 ManagedRuntime 的附加项，提升进合同
  open(): Promise<void>; isReady(): boolean;
  onDisconnect(listener: (reason: string, scope: { kind: "adapter" } | { kind: "session"; sessionId: string }) => void): () => void;
  registerBinding(binding: RuntimeBinding): Promise<void>; hasFreshStartProof(binding: RuntimeBinding): boolean;
}
export interface ConversationFacet { qualifyConversationThread(...); startConversationTurn(...) }        // F08
export interface CompactionFacet { compactThread(binding, baselineTurnId,
  beforeSend: (requestRef: string) => Promise<void>, afterAccepted?): Promise<string | null>;
  observeCompaction(binding, targetTurnId?): Promise<RuntimeCompactionObservation> }                  // F16，requestId→requestRef
export interface NamingFacet { readThreadName(...); setThreadName(...) }                                  // F06
export interface ArchiveFacet { archiveThread(...); isThreadArchived(...) }                               // F05
export interface TraceFacet { readWorkPage(...) }                                                         // F14
export interface WorkspaceFacet { readWorkspaceHistory(...); onWorkspaceUpdate(...) }                    // F15
export interface NativeInputFacet { nativeInputConnectionId(); onNativeInput(...); hasPendingInput(...); respondToInput(...) } // F19
export interface ProfileFacet { activateExecutionProfile(...); inspectExecutionProfileActivation(...) }   // F17
export interface ModelsFacet { listModels(): Promise<ModelListResult> }                                   // F18
export interface DiagnosticsFacet { listChildDiagnostics(); onChildDiagnostic(...); flushChildDiagnostics() } // F28
export type RuntimePort = RuntimeCore & RuntimeHostLifecycle & Partial<ConversationFacet & CompactionFacet &
  NamingFacet & ArchiveFacet & TraceFacet & WorkspaceFacet & NativeInputFacet & ProfileFacet & ModelsFacet & DiagnosticsFacet>;

// 工具：中立定义，coordinator 提供，适配器注册
export interface RuntimeToolSpec<I = unknown> { name: string; description: string; input: ZodType<I>;
  handler(ctx: { binding: RuntimeBinding; turnId: string | null }, args: I, signal: AbortSignal): Promise<RuntimeToolResult> }
```

**合同规则**：一个可选切面有没有实现，必须和 `capabilities()` 的声明一致，比如 `archive: 'none'` 就意味着没有 `ArchiveFacet`。这一条由合同测试断言。coordinator 里**影响语义**的判断，比如压缩是否会返回 noop、effort 能否回读，一律读 `capabilities()`；"方法在不在"只用来做类型收窄。

### 4.5 路由：`RuntimeRegistry`

```ts
// apps/coordinator/src/runtime/registry.ts（新）
export class RuntimeRegistry {
  constructor(private readonly runtimes: ReadonlyMap<RuntimeProvider, RuntimePort>) {}
  for(session: Pick<RuntimeSessionRecord, "runtimeProvider">): RuntimePort;      // 已有 Session：只按落库的 provider
  select(input: { roleId: string; grant: RuntimeGrant | null; requires: RequiredCapability[] }):
    { provider: RuntimeProvider } | { error: "RUNTIME_CAPABILITY_UNAVAILABLE"; missing: RequiredCapability[] };
  all(): Iterable<[RuntimeProvider, RuntimePort]>;                                // 供各 bridge 多路订阅
}
```

- **新 Session 选 provider 的优先级**：显式指定 → grant 或 Role 分配里的 `provider` → `runtime.defaultProvider`。选定后做能力门检查：Role 声明的 `requires`（例如 `nativeInput`、`tools`、`compaction`）都要满足，否则返回 `RUNTIME_CAPABILITY_UNAVAILABLE`，并给出缺了哪些。
- **已有 Session** 只按 `runtime_session.runtime_provider` 路由，**永不改变**。数据库用触发器禁止修改这一列。
- **各个 bridge**（`NativeInputBridge`、`NativeObservationBridge`、session-timeline、diagnostics）现在都是 `attach(runtime)` 只接一个，改为遍历 `registry.all()` 逐个订阅，事件自带 `provider`。
- **owner 连接与写权限**：两个 provider 共用 coordinator 现有的 owner 机制。readiness 按 provider 分别计算，Codex 断连不影响 Claude Session 的派发，反过来也一样。

### 4.6 配置

```jsonc
"runtime": {
  "enabled": true,
  "defaultProvider": "codex",              // 默认保持 codex，向后兼容
  "providers": {
    "codex":  { "enabled": true,  "executable": "...", "protocolVersion": "0.167.0-alpha.3.2", "nativeUserInput": true },
    "claude": { "enabled": false, "sdkVersion": "0.3.319", "expectedCliVersions": ["..."], "configDir": "...",
                "credential": { "kind": "apiKeyFile", "path": "..." }, "settingSources": ["project"],
                "maxHosts": 4, "idleTimeoutMs": 600000 }
  },
  "grants": [
    { "...": "...", "provider": "codex",  "model": "gpt-…",            "reasoningEffort": "high", "maxTurns": 20 },
    { "...": "...", "provider": "claude", "model": "claude-opus-5-5",  "effort": "high",          "maxTurns": 20,
      "maxAgentSteps": 200, "maxBudgetUsdPerTurn": 5 }
  ]
}
```

- grant 用 `provider` 做判别联合（zod `discriminatedUnion`）。effort 的词汇按 provider 各自校验：Claude 可选 low、medium、high、xhigh、max。
- 旧配置里没有 `provider` 的一律当作 codex，并给出迁移提示，**不报错**。
- 跨 provider 的 grant 不能共用 model 字段，避免把 Codex 的模型名发给 Claude。

---

## 5. 降级与拒绝规则

| 能力类别 | 包含 | 能力缺失时 | 记录方式 |
| --- | --- | --- | --- |
| 不变量类 | I1–I7 | **不允许降级**，provider 不能启用 | 配置校验阶段直接报错 |
| 派发控制类 | F07、F08、F09、F16、F17 | 可以用模拟实现，但模拟**必须能回读证明**；拿不到证明时状态停在 unknown | 现有的 fault phase 与 unknown 状态机 |
| 证据类 | F10 部分、F13、F14、F15 | **允许降级**，但必须标保真度；不允许把"无数据"当成"完整的空结果" | 记录 `fidelity` 字段，Workbench 显示标记 |
| 交互类 | F19、F21 | 缺失时，依赖它的 Role 不能分配到该 provider（能力门） | `RUNTIME_CAPABILITY_UNAVAILABLE` |
| 元数据类 | F05、F06、F18 | 可以模拟（tag 或配置），语义差异写进能力声明 | `capabilities()` |

---

## 6. 数据库与合同迁移

在主文档 §7.5 `059_runtime_provider` 的基础上补充：

- `runtime_session.runtime_provider` 设为 `NOT NULL DEFAULT 'codex'`，加 CHECK 约束，并用 **UPDATE 触发器禁止修改**。
- `runtime_session` 新增 `capability_snapshot jsonb NULL`：创建时记录当时的 `capabilities()` 摘要，事后审计"这个 Session 当时承诺了什么"。
- `runtime_run` 新增 `usage jsonb NULL`、`cost_usd numeric NULL`、`trace_fidelity text NULL`。
- `session_compaction.native_request_id` 由 integer 改为 text（或者新增 `native_request_ref text`，旧列保留只读），新增 `outcome text NULL`，取值为 compacted、noop 或 unknown。
- `preTurnProof` 的 JSON 做兼容解析：旧记录（`code: -32600`、数值型 `requestId`）读出来时视为 `{provider: 'codex', refusalCode: '-32600', requestRef: String(requestId)}`；新记录写中立格式。
- `native_child_diagnostic` 新增可空的 `session_id`。

---

## 7. 共享合同测试套件

位置建议是 `packages/contracts/testkit/runtime-contract.ts`，导出 `describeRuntimeContract(name, makeRuntime, fixture)`：

- Codex 用现有的 `adapter-codex-app-server/test/fixture.mjs`（伪造的 app-server）运行。
- Claude 用伪造 CLI 运行，通过 `spawnClaudeCodeProcess` 注入，回放录制的 stream-json 样本。

| 组 | 用例（每条都和某个不变量或能力对应） |
| --- | --- |
| 不变量 | 同一 operationId 第二次 `startTurn` 被拒，并且**没有第二次原生发送**（I1）；确认丢失时抛 `RuntimeUnknownError`，并且不重发（I3）；不是本 owner 的 binding 发起写操作会被拒（I2）；子进程环境里只有白名单 env（I7、F25）；Claude 侧没有 auto memory 写入（I5） |
| 身份 | `capabilities().identity` 是 preassigned 时，`create` 返回的 `nativeSessionId` 必须等于预分配值；是 acknowledged 时，必须等于原生应答的值 |
| 对账 | 转录或列表不完整时，返回 `partial`，**不返回** `not_found`；没有终止证据就**不能**判 completed；中断时 turnId 不匹配会被拒 |
| 证据保真 | 声明为 `unavailable` 的切面，其方法不存在；声明为 `approximate` 或 `reconstructed` 的，返回值带有对应的保真度标记 |
| 能力一致 | 每个可选切面的方法是否存在，与 `capabilities()` 一致 |
| 条件用例 | `compaction.reportsNoop` 为真时，无内容可压缩要返回 `outcome: noop`；`nativeInput.mode` 不为 none 时，宿主进程或连接换了以后，旧句柄会失效；`profileActivation.zeroTurn` 为假时，零 Turn 激活会被拒 |
| 归档 | 只有确认（ack）、没有回读证明时，`isThreadArchived` 返回 false |

**闸门**：P1 结束时 Codex 先通过这套测试，同时现有的 `npm test` 和 `test:integration` 全部通过。Claude 适配器在 P2 和 P3 期间按能力逐步通过，没通过的切面就不声明。

---

## 8. P1 拆分（每一步都不改变 Codex 的行为）

| 步 | 内容 | 主要文件 |
| --- | --- | --- |
| 1 | 中立错误类移到 contracts，Codex 包改为 re-export；coordinator 的 import 改为从 contracts 引入 | `contracts/runtime-errors.ts`，`compaction.ts`、`pump.ts`、`read-only-owner.ts`、`runner.ts` |
| 2 | 引入 `RuntimeOperation`，修改 `RuntimeFault` 和 `dispatchFailureDetail` | `runner.ts:25-56` |
| 3 | 加入 `RuntimeProvider`、`RuntimeOwner`、`ownerOf`；改造 `bindingOf()` 和 core 里三处 owner 校验 | `runtime.ts`、`runner.ts:83`、`core/runtime/service.ts:53,171,207` |
| 4 | 迁移 059（provider 列、触发器、兼容列） | `adapter-postgres/schema`、`migrations` |
| 5 | 中立事件 `kind`，改造 native-observation 的白名单 | `core/native-observation/index.ts:5`，Codex 适配器 |
| 6 | 加入 `capabilities()` 和切面类型；Codex 实现声明；语义判断改为读能力声明 | `runtime.ts`、Codex 适配器、runner、compaction |
| 7 | `readFinalMessages` 下沉到适配器 | `runner.ts:78` |
| 8 | `RuntimeRegistry`、bridge 多路订阅、`runtime/factory.ts`，main.ts 不再 import 具体适配器 | `main.ts:326`、`native-input.ts`、`native-observation.ts`、session-timeline |
| 9 | 配置判别联合（`providers`、`grant.provider`），向后兼容 | `configuration.ts:94-134` |
| 10 | `preTurnProof`、`compaction requestRef` 中立化，兼容解析旧数据 | `runtime.ts:21`、`compaction.ts` |
| 11 | 合同测试套件，Codex 通过 | `contracts/testkit` |

步骤 1–3 互相独立，可以并行，其余基本按顺序进行。每一步完成后都要跑全量测试。

---

## 9. 需要你确认的事项

| # | 事项 | 推荐 | 影响 |
| --- | --- | --- | --- |
| D1 | §2 的 28 项能力清单是否完整，MVP 底线是否就是标为"必须"的那些 | — | P2 范围 |
| D2 | 能力不足时：派发前拒绝，还是静默降级 | **拒绝**（证据类能力除外） | §5 |
| D3 | Claude 侧 effort 无法回读，能否接受"已配置、未观测" | 接受，并在 Workbench 标出 | F17 |
| D4 | 归档用 tag 模拟（原生会话列表里仍可见）是否可以接受 | 接受；绝不删除转录 | F05 |
| D5 | 原生提问是否需要跨重启存活 | 先不需要，与 Codex 等价；P3 用 S6 验证 defer 后再决定 | F19 |
| D6 | Claude 会话缺少 turn diff、plan 是近似值，是否可以接受；还是由 coordinator 基于 git 统一计算 diff | 由 coordinator 统一计算（与 provider 无关，Codex 也受益） | F13 |
| D7 | core 是否利用"预分配 Turn ID"简化状态机 | **先不简化**，两个 provider 走同一路径；P4 稳定后再评估 | F07 |
| D8 | provider 选择的粒度：按 grant 或 Role 分配；是否允许同一 Role 同时有两个 provider 的 Session（用于对照评估） | 按 grant 分配；对照评估只在 evaluation 场景开放 | §4.5 |

另外，主文档 §11 里还有三项没决定：计费方式、技能用方案 A 还是 B、settingSources 怎么设。
