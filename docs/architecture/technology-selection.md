# 技术选型：核心栈、Wiki 基座与改造边界

状态：**S1a 工程基线已采用（DEC-028）；完整目标架构仍分阶段实施。** 用户已选 PostgreSQL 主数据、飞书 connector，以及先用 OpenViking、以后可自研替换（DEC-027）。下文区分首片已安装实现与后续候选；本机可运行不表示已部署生产服务。代码责任见[包架构](packages.md)，产品目标仍以[产品定义](../product/definition.md)为准。

先读[包与进程边界](packages.md)，再看本页的取舍。需要决定的是谁来维护协调规则、知识服务和外部接缝；不会因为选一个库就自动获得业务保证。

**已选：**PostgreSQL 为项目主数据与运行存储，飞书为 connector；OpenViking 是首个知识接入后端，前端参考 nashsu 图谱与阅读体验。过程 Document、Git 正式正文、外置 Wiki 各自持有权威。**本机已采用：**TS/Node 核心、React/Vite、PG 驱动与迁移、Agent CLI 与业务技能，OpenViking 0.5.1 已做受限写读和回读。**待验证：**真实飞书租户、OpenViking 语义索引/多写者/生产恢复、后续前端库与可选 MCP。以下先比较理由与门槛，再列完整技术清单和部署约束。

## 1. 为什么主语言选 TypeScript

| 候选 | 对本项目有利的部分 | 代价与取舍 |
| --- | --- | --- |
| **TypeScript / Node** | 状态分支和多包接口容易统一检查；可沿用现有仓库工具；飞书、MCP、进程/HTTP 接入有直接入口 | 要重写经过验证的薄协议客户端，且仍需真实故障测试；OpenViking 是另一个服务运行环境。推荐为核心语言。 |
| **Python** | 已有可运行的标准库协议夹具；OpenViking 服务与研究生态接近，做实验和故障注入方便 | 同样可以实现正确协调器，但需另建核心类型/运行校验和服务工程约定；HTTP 服务边界并不要求主应用与 Wiki 同语言。保留研究脚本与上游修改用途。 |
| **Go** | 单二进制、明确并发和部署方式，适合以运行控制为主要负担的服务 | 当前没有 CPU/部署瓶颈或成熟 Go 业务代码可复用；还要建立协议、schema 和工具链。暂不为未来规模引入第三套自研语言。 |

这不是语言能力排名。决定因素是我们要长期维护哪一层：evoLoop 核心主要维护跨角色、跨平台的合同与行动规则；解析、嵌入和索引交给独立知识服务。**选 TS 不是因为文档站碰巧使用 Node，也不是因为未来可能做网页。** 如果第一轮真实切片显示 Python 端复用的不是薄客户端而是大量必要业务能力，应拿迁移成本与接口一致性回看此选择。

Codex 隔离研究曾使用 Python 跑通受限闭环，[PR #2](https://github.com/cyl19970726/evoLoop/pull/2)保存脚本与实测报告；它当时没有证明 TS 客户端。后来的 TS 适配器已有本机 owned Turn、重启读回及终态纠错证据，范围见[本机运行](../development/local-run.md)；隔离 Python 结果仍不能替代 TS 或生产验收。

## 2. Wiki 到底选哪个，复用什么

### 首个接入后端：OpenViking

**用户已确定先用 OpenViking（DEC-027）。实现建议保持“独立服务 + evoLoop 知识适配器 + 认知维护流程”，以后可在同一合同后接自研知识服务。** 前端的知识图谱体验独立于后端选择；系统仅有一个活动知识写入权威。

依据有两类：一是 OpenViking 已有面向多客户端的内容/检索服务边界和真正的 Wiki compile；二是已有固定版实验观察到纠正合并、保留未决解释和外置恢复的有限可行性。nashsu 也有 HTTP/MCP 写页，但完整摄入依赖桌面前端状态、队列、文件调用和模型客户端；把它变成无人值守服务需要实质拆分。我们的核心目标是多 session 持续维护与消费项目认知，因而更适合前者。具体证据和相反条件见[已有基座比较](../research/wiki-base-selection-20261019.md)。

**不选择 nashsu 作为底座，并不否认它的阅读与整理价值。** Wiki 前端明确参考它的知识树、类型/来源筛选、知识页、来源卡片、双向链接、图谱和 Review，按[Wiki 工作区架构](wiki-workspace.md)适配为服务数据驱动的组件；purpose/schema、合并与维护流程按[Wiki 维护机制](wiki-maintenance.md)借鉴。首期先借鉴机制；复制模块前单独核依赖、许可证和与目标知识模型的兼容性。不能假设把 nashsu UI 指向 OpenViking URL 就能获得兼容产品。具体文件/符号与锁定技术栈见[复用研究](../research/nashsu-llm-wiki/frontend-reuse.md)，组件、API、OpenViking 能力映射和 PG/Git 数据装配见[集成设计](wiki-integration.md)。

### 候选版本与证据不能混用

- **已实测基线：OpenViking 0.5.0，`20f9c113`。** 同基线双写可丢更新、来源删除不自动修订 Wiki、原生恢复仍有未测项。这些结论仅属于该版本。[实测结果](../research/openviking/results.md)
- **当时的下一集成候选、现已受限本机运行：v0.5.1，`e855796c83f9eb575d9b0f3082926660730f6a63`。** 上游在 2026-10-19 发布，包含内容版本冲突检查、批量写和存储等变化；发布说明同时明确升级存在 API/存储兼容变化，正文写入后的后台入队失败不会回滚。本机已实测写读、重启回读与候选审阅发布，不把这些受限结果或发布说明当生产验收。[固定版本发布说明][ov-release] · [本机运行](../development/local-run.md)
- **nashsu 对照：v0.6.12，`48fd970e`。** 本轮未新增模型实验，也不把新版 OpenViking 的说明拿来与旧版 nashsu 的实测分数直接排名。

因此不建议从 0.5.0 打一个长期大 fork。0.5.1 的受限写入/回读补验已完成，能使用上游修复就减少自维护补丁；语义索引、并发与长期恢复仍须按下面门槛核，不能登记为已验收的生产知识服务。

这次只读源码进一步确认：0.5.1 的 `batch_write` 每文件 operation 可带 `expected_sha256`，服务在目标路径锁内比较后才写入；普通 `WriteContentRequest` 没有同样字段，compile 的提交幂等键也不等于最终页发布具备条件写。`skip_conflicts` 可跳过冲突条目，不是整批原子提交。尤其是新版 `write(mode="create")` 已改为覆盖别名，**不能拿它当 create-only 的不可变版本写入保护**。[批量请求结构][ov-batch] · [锁内校验][ov-write] · [编译提交][ov-compile] 上述是源码观察，尚无本项目对该版本的并发/故障实测。服务要求 Python ≥3.10，具体部署解释器和依赖须在该固定版环境验证。[运行要求][ov-python]

### 认知维护默认沿用我们的 session

默认链路是：领域责任者提交材料与候选认识 → 有权维护者读取现行页及原始依据 → 形成差异、反例和影响任务 → 受控发布 → 新 Session 按固定修订消费并反馈。领域判断保留在各 Agent 的职责内；Leader 组织受影响 Task，Evocation 结合 User Session 亲用研究跨任务方法问题。运行这类工作的 Agent 仍由 evoLoop 的 SessionRuntime 承载。

OpenViking 的普通内容 API 负责存取；它不会因为写了一页而自动完成综合判断。原生 `/compile` 是另一种可用维护执行方式，涉及其 Agent Runtime；首期不同时启用两个能更新当前知识的编译者。只有比较证明原生编译在质量、成本或维护上更合适，才在同一知识合同后替换该执行方式。上游解析/摘要/嵌入的模型配置与 Codex 账号是独立边界，不能假设选定 Codex 就自动配置了 Wiki 模型服务。

### “魔改”应落在哪一层

| 要解决的问题 | evoLoop 应负责 | 何时修改 OpenViking 服务端 |
| --- | --- | --- |
| 认识从哪里来、如何变成下一任务 | 贡献结构、来源固定修订、争议/假设、认知与分工任务、消费者回评 | 不把业务 Role、飞书状态和产品优先级塞进上游 |
| 纠正传播与来源撤回 | 在外置知识空间保存来源—知识依赖；来源变化先标待复核，重新维护并通知受影响任务 | 若必须阻止所有入口读取/发布已撤回结论，且现成能力不足，补查询/发布约束与可观察状态 |
| 读入基线和并发覆盖 | 调用后端能力、保留读入修订；首期限制唯一发布者并禁止旁路写入 | 必要的条件写必须在实际写入锁/事务内检查，覆盖相关入口；外层先读后比不能替代它 |
| 固定修订及可回退发布 | 定义知识修订、证据关联和发布包；在外置空间保存不可变修订及发布清单 | 后端无法可靠存旧版/创建版本/切换当前指针时，补写入边界；不能用快照名称假装多文件原子发布 |
| 查询、解析和内容服务 | 适配 API、权限和结果语义，暴露能力缺口 | 只有实际用例证明索引/解析缺陷阻断才补对应模块，不先重写存储引擎 |

“不可变修订 + 发布清单”是**拟议的项目知识格式**，不是声称上游已有完整的版本服务。正文、来源修订、内部依赖与 manifest 同属一个外置知识空间；PostgreSQL 只保存知识引用、任务/文档到知识的跨对象关系与操作回执。先准备修订，核验来源和页面，再发布清单；读者只读取已发布且可核对的组合。后端没有安全创建/条件更新能力时，串行单写只能形成受限约束，不能宣称原子发布或允许外部编辑者绕行。该格式必须通过断点恢复测试后才能成为正式保证。

必要补丁应保留在独立 OpenViking fork，逐个关联上游提交、失败用例和本地修复；优先向上游提交通用修复。evoLoop 仓库只保存适配器、固定版本/镜像引用、迁移说明和合同测试，不复制整套上游进来。不修改包管理器安装缓存，也不让业务知识正文进入 fork 仓库。

## 3. 正式采用与 fork 的门槛

| 门槛 | 要观察到什么 | 不通过时怎么办 |
| --- | --- | --- |
| 写入边界 | 用 0.5.1 重跑同基线冲突、API/维护入口旁路和写入后失败；准确区分正文提交与索引状态 | 保持受限单发布者；无法限制旁路则不开放共享写。确定缺口后才小范围 fork |
| 来源与修订 | 用户纠正修改受影响旧结论；撤回后不再以有效依据给出结论；旧修订可读 | 修改维护协议和服务边界；不能以新建一页代替传播 |
| 恢复 | 实际内容/来源/索引恢复；中途发布失败不暴露错误的当前组合 | 明确恢复方案和停写范围；降级能力并保留失败证据 |
| 真正的认知使用 | 两个新 session 独立使用真实项目材料，采用纠正与争议；产物经过实际使用 | 与直接读来源比较，若无收益则缩小维护范围，不以检索命中率宣称成功 |
| 工程与许可 | 固定源码、依赖和数据迁移路径，补丁可维护，许可安排明确 | 不复制/发布未知许可组合；先保留协议边界与独立实验 |

固定基线中 OpenViking 使用 AGPL-3.0，nashsu 使用 GPL-3.0；上游修改和代码复制需要保留并核对相应义务，独立进程并非自动免除许可证责任。[OpenViking 许可][ov-license] · [nashsu 许可][n-license] evoLoop 自有代码目前没有选定许可证：**基座方向已确定；开源及补丁发布安排仍须在实际复制或分发前确认，本轮不直接添加许可证或创建 fork。** 这会影响之后怎样复制和提供修改版，但不妨碍先审阅架构。

## 4. 推荐决定

**已选数据方向：evoLoop 的 PostgreSQL 持有 Task、Schedule、原生 Document/DocumentRevision、跨对象 Relation、ExternalBinding/同步状态与运行 Journal/outbox；飞书是受控协作投影和编辑入口。** 推荐以 TypeScript + Node.js 24 LTS 的模块化单体实现协调服务，首个知识后端 OpenViking 通过 HTTP 适配；Wiki 综合维护由实际获权的维护者负责，业务判断不集中给一个认知会话。默认由 Codex App Server 承载受管执行。TS/Node 已在 S1a 落地；部署与自动执行范围、知识后端具体版本仍按阶段证据核验。

这套选择对应当前负担：很多工作发生在跨 session 的判断、文档版本、对象关联、状态变化、平台 I/O 和失败恢复上。统一主数据让任务、原生需求文档及关系保留稳定 ID、审核和版本，并可在同库提交变更及出站 outbox；没有证据说明需要多节点调度或另一个聊天产品。

| 领域 | 推荐技术与范围 | 为什么这样选／代价 |
| --- | --- | --- |
| 主应用语言 | **TypeScript strict、ES modules** | 多包共享任务/运行/知识引用的类型与状态分支；运行时仍校验外部输入。代价是需要编译及类型维护，不能用类型替代业务验证。 |
| 运行环境 | **Node.js 24 LTS** | 适合进程、事件和 HTTP 协调，采用受支持 LTS。S1a 已将应用与文档构建/CI 统一至 Node 24.x。 |
| 仓库组织 | **npm workspaces + TypeScript 编译** | 沿用现有 npm 锁文件和工具习惯；先明确包边界，不引入额外 monorepo 调度平台。 |
| 核心设计 | **模块化单体、显式状态转换、注入端口** | core 不导入平台 SDK；业务状态、运行结果、消费验收分别建模。第一版无需通用 Agent 编排框架。 |
| 入口服务 | **Fastify 5，本机协调 API** | 统一工作台、现有 CLI 与按需 MCP 的身份、授权、输入和状态检查；初期只监听本机，服务启动/关闭和健康检查由 daemon 负责。 |
| 边界合同 | **Zod 4 → JSON Schema，版本化 JSON 消息** | 同一可表达 schema 生成 TS 类型和外部契约；业务状态守卫仍在 core，禁止另外手写一套漂移的协议。 |
| 主数据与协作入口 | **PostgreSQL 主数据 + 飞书 Bitable 任务投影** | evoLoop 持 Task、Schedule、原生 Document/Revision、Relation 和同步记录；飞书 connector 提供可见与受控编辑。入站身份/基线、字段权限、分页、限流仍须实测；飞书云文档是另一套待验证 API。 |
| 会话运行时 | **Codex App Server，stdio JSONL** | 已有隔离创建/续接/历史恢复证据；生成协议类型留在 Codex 适配器，桌面宿主桥接另外声明能力。 |
| 主数据与运行持久化 | **PostgreSQL 已选定；推荐 18.x + node-postgres（pg）** | 从第一版统一数据库引擎，保存业务主数据、修订、映射、Journal/outbox 与水位；承担数据库服务、迁移、连接和备份成本。Wiki 正文和 Git 正式文档仍在各自权威位置。 |
| 日程与状态推进 | **core 状态转换 + cron-parser 到期计算 + 周期对账** | 一次性 UTC 时点；重复日程带 IANA 时区，计划实例持久化。解析器只算时间，不提供持久投递或恰好一次。 |
| Wiki 基座 | **独立 OpenViking 服务，HTTP 接入** | 0.5.1 已受限本机写读与回读；普通写页与 Wiki 综合编译的语义分开。语义索引、多写者与生产恢复须通过[正式采用与 fork 的门槛](#3-正式采用与-fork-的门槛)。 |
| 上游语言 | **沿用 OpenViking 的 Python/Rust 等实现** | 上游独立构建，不把 Python 嵌入 Node core；HTTP 是语言和升级边界。Python 协议研究工具继续作为实验资产。 |
| Agent 工具 | **CLI 优先，按需要加官方 MCP TypeScript SDK** | 两者都调用协调 API；MCP 是工具传输，不是第二个协调者或另一套业务权限。 |
| 项目工作台 | **React + TypeScript / Vite SPA；Router + Query 为后续候选** | 工作台通过同一 API 组合任务、文档、认识与分工，支持依据追溯和复核；首期本机同源部署。飞书、Codex、公开静态站保留各自入口；S1a 已实现读取/复核，使用小型 hash 路由与显式读取状态；复杂页面增长后再评估 Router/Query。 |
| 检查与观测 | **node:test、合同用例、真实切片、结构化 JSON 日志** | 沿用当前检查工具；按 task/run/operation/knowledge revision 关联，日志脱敏并记录模型和维护成本。 |

Node 官方当前将 24 标为 LTS；Fastify 支持 TS，npm 原生支持 workspaces，Zod 提供 JSON Schema 转换。这里的项目选择是基于职责和代价的判断，并非这些官方文档证明了 evoLoop 的效果。[Node 生命周期][node] · [TS strict][ts] · [Fastify][fastify] · [npm workspaces][npm] · [Zod][zod]

表中飞书真实租户、可选 MCP 与完整图谱仍是后续工作；日程、Codex 运行时和 OpenViking 已有受限本机路径。S1a 固定版本：TypeScript 7.0.2、Fastify 5.12.7、Zod 4.6.7、pg 8.23.1、node-pg-migrate 9.0.0、React 19.3.1、Vite 8.3.4；真实验证使用 PostgreSQL 18.6。版本由各包 manifest 和根锁文件控制。JSON Schema 合同采用字符串时间、普通 JSON 数据，不使用不能等价导出的 transform/date 等结构；导出失败应报错，不能降成任意类型。飞书 SDK 的事件接入、cron-parser 的时区计算和 MCP 工具传输只提供各自原语，仍须遵守项目合同。[飞书 SDK][feishu] · [时间计算][cron] · [MCP SDK][mcp]

前端补充按[工作台产品设计](../product/workbench.md)与[前端架构](../frontend/architecture.md)的提案：同源工作台、共同 Query/Command API、可追溯版本和分源状态。存储表设计见[存储逻辑](storage.md)，PG/Git/Wiki 的资料桥接和纠正传播见[知识关联](knowledge-flow.md)。这修订此前暂不设计 Web 前端的建议；S1a 的读取与复核页面已接通本机 API，其余完整页面和部署未实现。

## 5. 数据与部署边界

目标部署单位是**一个 evoLoop daemon、它管理的 Codex 子进程、PostgreSQL 数据库服务，以及独立的 OpenViking 服务**。本机试用已运行协调 API、PostgreSQL、同源静态工作台，以及经明确配置启用的 Codex 与 OpenViking 受限接缝；这不是生产部署。每个业务 session 不是独立后端服务，每个 npm 包也不是进程。源码依赖和进程图见[包架构](packages.md)。

| 数据 | 唯一可改写权威 | 其他系统保存什么 |
| --- | --- | --- |
| Task 的价值、优先级、责任、接受、交付；Schedule 定义 | evoLoop PostgreSQL | 飞书 Bitable 首期只持 Task 协作投影；ExternalBinding 留在 PostgreSQL，入站编辑作为待检查 command，不直接决定主状态 |
| evoLoop 原生需求等 Document、DocumentRevision、审核状态 | evoLoop PostgreSQL | 飞书云文档 connector 若将来接入，需单独定义投影和审核映射；首期不混同 Bitable API |
| 跨 Task/Document/KnowledgeRef 等对象的 Relation、同步状态；派发/通知/触发恢复记录 | evoLoop PostgreSQL | 外部平台可持其自身 ID/回执；同库 outbox 与主数据变更可事务提交，外部副作用不能 |
| 当前知识、来源、知识历史与内部依赖 | 外置 KnowledgeRepository／OpenViking 候选及受控材料存储 | PostgreSQL 只持知识引用和任务/文档的跨对象关系，不复制 Wiki 正文或内部依赖权威 |
| 已有正式产品/架构/开发规范正文与配置约定 | 对应项目 Git 仓库 `docs/` | 不进入 Document Table；需要关联时登记独立 Git 来源 ref+commit，正文和正式修订由 Git 维护 |

**为什么直接使用 PostgreSQL 主数据。** 用户先选择 PostgreSQL 以避免 SQLite 过渡迁移，随后明确选择 evoLoop 保存主数据、飞书作为 connector 和协作入口。Task、Schedule、原生 Document/Revision、Relation 与运行记录因此共用一个可版本化、可事务提交的数据库。代价是要维护数据库服务、迁移、连接、备份、文档正文权限，以及与飞书投影的冲突和对账；不能把“已有飞书视图”当作原生文档审核或 PG 状态的证明。

推荐采用当前受支持的 **18.x**，首片锁定当时的小版本和驱动；官方当前将 18 列为受支持版本。开发、CI 与正式部署使用同一引擎/主版本，不用 SQLite 替身证明数据库行为。[版本政策][pg-version] 本机已有 PostgreSQL 18 试用数据库，远端托管实例的位置在部署时确定。

主数据与运行记录约定如下；S1a 首片只验证当时的任务/过程文档事务、修订、操作日志与出站记录。后来本机运行时和隔离备份恢复另有受限证据，生产恢复仍待验：

- `adapter-postgres` 持有 SQL、参数化查询、连接池和版本化迁移，`core` 只调用端口。首期用 `pg` 和显式 SQL，推荐 `node-pg-migrate` 作为版本化迁移 runner；具体字段、原件与检索取舍见[存储设计](storage.md)。不同时引入 ORM；新增 ORM 必须能解释其对迁移与合同维护的实际收益。
- 用稳定的对象/operation/occurrence 键、版本列和数据库唯一约束避免重复登记；PostgreSQL 适配器通过中立 `UnitOfWork` 绑定同一连接，Task/Document/Relation 更新、操作去重和 outbox 在一个事务提交；core 不直接使用驱动 client。Task、文档审核、运行、同步和实际效果分开建状态，避免一个“完成”替代所有判断。外部请求不放进长事务里，未知结果仍需对账。一次事务须使用同一个借出的 client，完成/失败后归还，不能用独立 `pool.query` 拼接事务。[驱动事务][pg-transactions] · [连接池][pg-pool]
- 为 evoLoop 使用独立数据库或受限 schema，数据和备份在开发仓库外；表按项目范围隔离。记录 schema 版本，迁移由单一部署步骤执行；空库建立、旧版升级、失败恢复及备份恢复要用真实 PostgreSQL 验证。迁移文件进 Git，运行数据和连接凭据不进 Git。

**首期仍只有一个活动协调者。** 启动时必须核验相同运行域的独占资格，数据库不可用或资格丢失时立即禁止所有新增外部变更和重试，包括 CLI/MCP 写入、知识发布、派发及 outbox 重试；已发出的请求保留未知结果，恢复独占资格并完成对账后才恢复写入。可用数据库会话级 advisory lock 做重复启动检查，但它须占用独立长连接，不能在归还连接池的连接上保留锁；断连会丢锁，旧进程已发出的外部请求却可能仍在执行。[锁语义][pg-locks] 因而不据此启用自动双机接管：首期切换须确认旧写者停止、在途操作已核对。未来多协调者仍需独立验证 fencing 和副作用恢复，不能把“使用 PostgreSQL”当作已经支持安全并行派发。

PostgreSQL 事务不能覆盖飞书、Codex 或 Wiki 的网络副作用。丢失写入回执时仍可能 `unknown`，必须对账而非盲重发。飞书出站由 outbox 投影，入站观察须映射成含可核验行为者、对象 ID 与读入基线的 command，经 core 身份、授权、状态和冲突检查再提交 PG；证据不足则暂停处理。禁止最后写入覆盖。飞书 SDK 的 Bitable 权限、事件、分页和版本能力尚未实测，首片可先由核心 CLI 写 PG 并单向投影，再按实测能力开放受控字段回写。

初期在开发机验证闭环，通过后才将唯一常驻协调者迁到确定的常在线主机；迁移时停止旧写者、保持同一主数据库或验证数据库迁移、核对在途操作。任务多端协作视图由飞书投影提供，不要求每台电脑各跑一个可派发 daemon。数据库连接、备份和监控是新增运维责任；跨主机执行和独立桌面唤醒仍未由本机协议实测证明。

本机 API 也需要身份和可操作项目范围，凭据由运行配置提供，不能信任模型自报的 Role。CLI/MCP 与飞书入站 command 的所有主数据变更进入同一协调入口；飞书原生人工编辑只改变投影，经回读、身份/基线与冲突检查后才可能进入主数据。网络鉴权、密钥和私有日志不进入公开仓库。

## 6. 什么时候升级技术，而不是一开始堆齐

| 真实触发条件 | 再考虑的技术变化 |
| --- | --- |
| 多台机器需要并行调度、无法由一个写者管理，且已有单机瓶颈证据 | 在既有 PostgreSQL 上评估多协调者的租约/队列；重新验证 fencing、抢占和副作用幂等，飞书继续作为投影和受控编辑入口 |
| 很多跨天流程、补偿/人工等待难以在现有状态表可靠维护 | 评估 Temporal 等持久工作流；它不能替代外部 API 的幂等和项目价值判断 |
| 工作台使用记录显示复杂协同编辑、大规模表格或公网渲染确有需要 | 在已有页面合同上评估富文本协作、虚拟化或全栈渲染；本轮已提出首期工作台，仍按实际使用推进 |
| 部署和运行成本成为主要负担 | 比较打包/容器/常驻服务或 Go 的收益；先测量再迁移 |
| OpenViking 固定版及可维护的小补丁仍不满足来源/修订/恢复，或桌面阅读成为主要目标 | 重开 Wiki 选型；保留可导出的来源、正文和修订，不把后端 URI 当永久业务主键 |

## 7. 确认后怎样进入实现

**PostgreSQL 主数据与飞书 connector 方向已确定**，各数据的权威范围按上表执行。S1a 已采用 TS/Node 主应用、React/Vite 和 PostgreSQL 18；OpenViking 0.5.1 的受限本机路径已运行，接下来验证其未覆盖的能力、有限补丁策略和真实部署位置。MCP 按需再加，不能把具体库选择误当产品约束。

按[包架构集中维护的 S1—S4 顺序](packages.md#切片与验证)，PG 主数据/API 首片、Codex 受控派发、OpenViking 0.5.1 写读与后续 Agent 的有限知识消费已有本机证据；研究代码、业务能力和效果证据仍分别记录。真实飞书测试表的 Bitable 出站投影、回读、入站字段权限和租户能力待验证，飞书云文档 connector 留作独立后续。生产部署、长期知识收益与真人亲用也未由本机样本证明。S1a 当时的详细证据及 10,000 条影响/关联任务上限见[实测报告](../research/design-review-20261020.md)；后续范围见[本机运行](../development/local-run.md)。

[node]: https://nodejs.org/en/about/previous-releases
[ts]: https://www.typescriptlang.org/tsconfig/strict.html
[fastify]: https://fastify.dev/docs/latest/Reference/TypeScript/
[npm]: https://docs.npmjs.com/cli/v11/using-npm/workspaces/
[zod]: https://zod.dev/json-schema
[pg-version]: https://www.postgresql.org/support/versioning/
[pg-transactions]: https://node-postgres.com/features/transactions
[pg-pool]: https://node-postgres.com/features/pooling
[pg-locks]: https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS
[feishu]: https://github.com/larksuite/node-sdk
[cron]: https://github.com/harrisiirak/cron-parser
[mcp]: https://modelcontextprotocol.io/docs/2026-07-28/sdk
[ov-release]: https://github.com/volcengine/OpenViking/releases/tag/v0.5.1
[ov-batch]: https://github.com/volcengine/OpenViking/blob/e855796c83f9eb575d9b0f3082926660730f6a63/openviking/server/routers/content.py
[ov-write]: https://github.com/volcengine/OpenViking/blob/e855796c83f9eb575d9b0f3082926660730f6a63/openviking/storage/content_write.py
[ov-compile]: https://github.com/volcengine/OpenViking/blob/e855796c83f9eb575d9b0f3082926660730f6a63/openviking/service/compile_service.py
[ov-python]: https://github.com/volcengine/OpenViking/blob/e855796c83f9eb575d9b0f3082926660730f6a63/pyproject.toml
[ov-license]: https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/LICENSE
[n-license]: https://github.com/nashsu/llm_wiki/blob/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b/LICENSE
