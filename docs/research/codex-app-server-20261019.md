# Codex App Server 接入调查：把真实会话接到 evoLoop

> 2026-10-19。**调查与接口提议，未采纳为生产实现。** 范围为本机 `codex-cli 0.154.0`、当日官方 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)及一次只初始化的本机握手。本文不声称已创建业务 Thread、运行模型 Turn、连接飞书、部署 Wiki 或完成定时任务。

## 问题、方法与版本

evoLoop 需要让多个实际工作的 session 承接飞书任务，记录从需求、缺陷到交付、实际使用与认知修订的链路，并在约定时间推动待办。调查问题是：Codex App Server 能提供哪些会话原语，哪些责任必须由 evoLoop 自己承担？当前仓库只有正式文档与隔离 Wiki 实验；[领域合同](../architecture/contracts.md)中的 `SessionRuntime`、协调者、飞书适配器均未实现。

官方文档说明 App Server 用于深度集成的客户端，提供身份、会话历史、审批和流式事件；自动化作业或 CI 另建议使用 [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)。因此本文把 App Server 作为**交互式会话运行时候选**，把定时触发看成 evoLoop 的调度职责；是否改用 SDK 执行无交互批处理，应在真实切片比较。参考的是 2026-10-19 读取的[官方协议文档](https://learn.chatgpt.com/docs/app-server)；页面会更新，实施时应再次固定文档和 CLI 版本。

本机执行了 `codex --version`，返回 `codex-cli 0.154.0`；执行该版 `app-server generate-json-schema --out`，获得 v2 schema 包。`codex_app_server_protocol.v2.schemas.json` 的 SHA-256 为 `f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9`。该包保留在仓库忽略的本地实验目录，没有发布，也不代表桌面 App 内置运行时同版。只做了独立 `codex app-server --stdio` 进程的 `initialize`／`initialized` 握手：收到同 ID 的成功响应，包含 `userAgent`、`codexHome`、`platformFamily`、`platformOs` 四个键，随后进程正常退出。没有读取或记录键值、账号凭据、历史会话内容。

## 已确认的协议边界

默认传输为 **stdio 上逐行 JSON（JSONL）**；消息采用省略 `jsonrpc: "2.0"` 头的双向 JSON-RPC 2.0 形式。客户端每条连接先发一次 `initialize` 请求，参数包含 `clientInfo: {name,title,version}`，随后发 `initialized` 通知。请求以 `id` 匹配响应；通知没有 `id`。本机握手证实这个最小路径可通。Unix socket 与 WebSocket 也在文档中，但 WebSocket 被标为实验、未支持生产；本文的第一切片只采用 stdio 子进程。[协议与初始化](https://learn.chatgpt.com/docs/app-server#protocol)

`initialize.params.capabilities.experimentalApi` 决定实验方法与字段是否可用。第一切片省略它，仅使用本机 schema 和官方文档都确认的稳定方法；版本升级时重新生成 schema 并做能力探测。某些官方页面示例可早于或晚于本机 schema，不能把页面出现的字段直接当本机已支持。`clientInfo.name` 要标识真实集成方，不能冒充 `codex_vscode` 或桌面客户端。[初始化与实验 API](https://learn.chatgpt.com/docs/app-server#initialization)

| Codex 原语 | 0.154.0 schema 中的必需参数／回执 | evoLoop 的使用与限制 |
| --- | --- | --- |
| `thread/start` | 请求可给 `cwd`、`model`、`sandbox`、`approvalPolicy`、`serviceName` 等；响应有 `thread.id`，可有 `instructionSources` | 为一个有明确职责和任务的承载实例新建对话；启动成功不等于已开始工作。记录返回的 `thread.id`，不要从标题反推。 |
| `thread/resume` | 必需 `threadId`；建议 `excludeTurns: true`，再分页取历史 | 继续本适配器可访问的已存 Thread。恢复动作不等于创建新 Role；也不保证任何桌面窗口已打开。 |
| `thread/read`、`thread/turns/list`、`thread/items/list` | 按 `threadId` 读元数据、分页 Turn 和 Item；`thread/read` 不恢复 | 断线、重启和审计时回读；项目侧只保存最小关联与证据定位，原文继续服从原运行时权限。 |
| `turn/start` | 必需 `threadId`、`input`；响应初始 `turn.id` 与 `inProgress` | 发出一次任务指令或跟进。回执只表示运行请求已接受；继续读事件。`clientUserMessageId` 在本机 schema 可选，但未证明它构成跨重试幂等保证。 |
| `turn/steer` | 必需 `threadId`、`expectedTurnId`、`input`；响应 `turnId` | 仅在目标 Turn 正在进行、且版本和意图明确时追加修正。没有活动 Turn 会失败；不要用它给闲置 session 派新任务。 |
| `turn/interrupt` | 必需 `threadId`、`turnId`；成功响应 `{}` | 请求停止当前工作，随后等待 `turn/completed` 的 `interrupted` 或其他实际结果；接受停止请求不等于已停、也不取消外部副作用。 |
| `item/*`、`turn/completed` 通知 | `item/completed` 给 Item 终态；`turn/completed` 的状态可为 `completed`、`failed`、`interrupted` | 增量通知用于观察；断线后以可分页的持久历史和任务权威对账。`completed` 是模型轮次终结，不是飞书任务或用户效果验收。 |

官方对 Thread、Turn、Item 的定义分别是一次对话、一次用户请求及其 Agent 工作、一个消息／命令／文件变更等单元。[核心原语](https://learn.chatgpt.com/docs/app-server#core-primitives) App Server 的 `thread.sessionId` 是原生会话树根 ID：根线程等于自身 ID，fork 后仍可指向根。它不是 evoLoop `RoleId`，也不必等于 evoLoop 对某次任务承接定义的 `SessionId`；适配器应同时保存原生 `thread.id`、`thread.sessionId` 与项目侧稳定映射。[启动与恢复](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)

### 关键区分：另起服务，不是控制当前桌面聊天

本次握手启动的是自己的 CLI App Server 子进程。官方文档允许客户端对**该服务可访问的**持久 Thread 调用 `thread/resume`，也提供 `thread/list` 的 `sourceKinds` 过滤；这不等于已经验证另起进程能安全接管当前 Codex 桌面聊天、在桌面侧注册它创建的 Thread、保持桌面 UI 同步、复用桌面插件连接与审批状态。跨进程可见性、共享存储、同一账号与同一宿主的实际行为仍需单独试验。第一切片仅承诺管理自己创建并记录 ID 的 App Server Thread；若要接管已有桌面聊天，先在隔离测试账号／项目验证只读发现、授权、接续、双端并发和 UI 可见性。

### 审批与身份是客户端责任

命令和文件改动可能由服务器发起带 `threadId`、`turnId` 的审批请求，客户端须按服务端策略与既有授权处理；需要人判断的请求要展示准确内容并按决定回包；还会有 MCP 询问、权限请求及需要用户输入的请求。自动调度器不能通过固定 `approvalPolicy` 把真实授权边界绕开。需要人判断而通道不可用时保留待处理状态；若请求停止则另发中断并核验，不能把等待输入写成已暂停运行。[审批协议](https://learn.chatgpt.com/docs/app-server#approvals)

`account/read` 可检查登录形态，但本研究没有调用它，更没有导出凭据。本轮只研究本地进程；模型调用的认证和可用性仍需首个真实任务验证，不能从初始化成功推断模型权限。[认证端点](https://learn.chatgpt.com/docs/app-server#auth-endpoints) 传输若从本地 stdio 改为远程 WebSocket，还须另行验证连接认证、TLS、网络权限与远端执行边界。不要从本机握手推出远程部署安全。

## 接入提议：让任务与会话各守自己的权威

接口草案见[Codex 接入架构](../architecture/codex-integration.md)。evoLoop 的 `RoleId` 表示持续责任，`SessionId` 表示一次承载实例，飞书 `TaskId` 表示行动与状态；Codex `threadId`、`turnId` 是运行时定位符。保留 `taskId ↔ roleId ↔ sessionId ↔ threadId ↔ turnId` 的**有时间范围的关联**，同一任务跨会话接续要保留交接链。任务优先级、责任、验收与最终状态仅由飞书 TaskStore 决定；App Server 事件只能证明运行观察，外置 Wiki 保存认识和修订。运行记录应保存请求 ID、派发操作 ID、预期动作、读入任务和知识修订、响应或超时、事件检查点与对账结果；不把整个私有对话复制进公开仓库。

对需求和 dogfood 缺陷，业务 session 可以提出带证据的任务并在自己领域修复。协调者回读飞书后选择已授权责任和承载 Thread，用一次 `turn/start` 下发包含任务 ID、目标、输入修订、权限、验收和反馈入口的工作说明。专门认知 session 负责综合反馈与下一步选择，但不是所有局部修复的审批点。结果从 Codex Item／Turn 事件与真实产物归集，责任者检查交付和实际使用后才更新飞书任务；新的发现再成为有来源的需求／缺陷／知识候选。`turn/completed`、通知送达、飞书“完成”、用户使用效果必须分别记录。

人类日常使用的分工和认知聊天初期可以仍在 Codex Desktop。项目内的窄 CLI／MCP 工具提供明确的任务／知识读取和提议入口；其变更操作统一进入协调服务，由 core 核对身份、授权和基线，再调用 TaskStore／KnowledgeRepository；工具不能直接构造后端适配器写入，也不复制任务或 Wiki 正文。自动 worker 由 evoLoop 自己的 App Server 承载；两边以任务 ID、知识修订和交接说明显式接续。此路线无需让另起 App Server 接管现有桌面聊天，且同一 Role 换宿主时不隐式克隆聊天历史；自动回看必须另有已登记的可派发实例，只有 Desktop 实例时任务保持待承接。两类实例共享明确的任务归属、决定修订和并行边界；桌面自动控制需另行实测。

定时任务的时间表、触发去重、逾期补偿和停用条件应由 evoLoop 的调度器与飞书任务记录持有。拟议在同一飞书 Base 的独立计划表定义 schedule，每次到期创建独立 occurrence／任务；运行日志仅保存恢复所需状态。时间到了先回读权威任务与授权，再按关联调用 App Server；**没有发现可作为通用 cron 调度的 App Server RPC**。协调服务订阅完成事件并周期对账后推进知识和下一步，不能依赖 worker 临时记得通知。Codex 产品自身的计划任务是另一种产品能力，不能假设它自动与此协议、飞书或另起 App Server 进程共享身份及状态。对无人值守工作，先限定只读／可安全重试的步骤和审批升级路径；若目标主要是批处理，可比较官方推荐的 SDK。

## 恢复与失效模式

1. **创建或派发超时。** 先查本地操作记录，再按已保存的 `threadId`、`turnId` 回读运行时和飞书。`thread/start` 或 `turn/start` 超时但没有返回 ID 时，协议未给跨请求全局幂等承诺；不得盲目重发造成重复会话或重复外部动作。保留 `unknown`，在可辨认的试点范围内人工或更强证据对账。
2. **流断开或通知丢失。** 重连后用 `thread/read` 与分页 `thread/turns/list`／`thread/items/list` 补历史；按稳定 Item／Turn ID 去重。当前没有证明通知携带可重放的全局事件游标，检查点属于 evoLoop。`thread/list` 可帮助发现，但官方文档说明不传 `sourceKinds` 时默认只列 `cli`、`vscode`，要查 `appServer` 来源须显式过滤；大范围扫描还可能暴露不相关历史，第一版优先只读已登记 ID。[线程列表过滤](https://learn.chatgpt.com/docs/app-server#list-threads-with-pagination--filters)
3. **Turn 成功但任务失败。** 完整读最终 Item、变更与检查结果，按任务验收判断；需要用户亲用的阶段继续保留“效果未知／待验证”。失败、打断和审批拒绝也可能留已发生副作用，先核实再决定恢复动作。
4. **并发、权限和职责变化。** 对同一 Thread 的派发采用项目侧串行或明确允许的并行规则；`turn/steer` 用 `expectedTurnId` 防误加到另一轮。飞书无经验证 CAS 时协调者单活。Role 改变须经职责试行与回看，不能靠 Fork 或新聊天标题自动推断。

## 最小验收设计与当前证据

| 检查 | 当前结果 | 下一步需要实际跑出的证据 |
| --- | --- | --- |
| CLI 与 schema 固定 | **已运行**：`0.154.0`、v2 schema SHA-256 如上 | 升级时对比方法与字段差异；生成受控客户端类型。 |
| stdio 握手 | **已运行**：收到初始化成功响应并退出；未建 Thread | 在隔离项目验证进程重启、错误回包与事件消费。 |
| 一次真实任务承接 | **未运行** | 真实飞书测试任务 → 新 Thread／Turn → 产物 → 责任者验收与亲用结果分栏。 |
| 多 session 交接 | **未运行** | 同职责续做、并行增容量、一次临时专项各一例；核对 Role 不被窗口数污染。 |
| dogfood 需求／缺陷闭环 | **未运行** | session 提出带来源任务、负责修复、用户实际使用、失败反馈更新 Wiki／下一任务。 |
| 定时与恢复 | **未运行** | 计划触发、重复触发、断线丢响应、重启对账、审批等待、停止后副作用逐例记录。 |
| 桌面聊天互通 | **未运行** | 若有需求，在隔离环境验证进程与桌面之间的可见性和授权；未验证前不作产品承诺。 |

本调查改变的决策只是将 **Codex App Server 列为 SessionRuntime 的可实现候选，首片优先 stdio、稳定 API、自己创建的 Thread**。正式采用取决于上述端到端试点，以及与 SDK 的无人值守作业对照；研究提议不得替代[现行架构合同](../architecture/contracts.md)。
