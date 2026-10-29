# evoLoop 领域合同

> 状态：目标语义合同与受限本机实现并存。C5 将 Task 正文统一归入固定 DocumentRevision、当前任务收敛为四态；11 个工作区、迁移 012 的实际字段以 `packages/contracts` 和[本机运行](../development/local-run.md)为准，逐项已验范围与限制见[阶段路线](../roadmap.md#当前基线)。PostgreSQL 保存主数据，工作台与项目业务 skill＋CLI 经同一 API 使用；飞书真实租户、完整目标合同、真人效果与生产保证仍待验证。整体位置见[架构总览](overview.md)，数据权威见[项目数据](project-data.md)，用户行为见[产品定义](../product/definition.md)，实现规范见[开发规范](../development/standards.md)。

## 对象如何配合

一项工作先有观察或要求，再明确有界动作和验收。未决定的问题可保存在 issue/spec 或讨论；TaskStore 管理 Task 的责任、验收、固定主正文和四态进度。历史 TaskProposal/判断保留，不作为新任务的强制流程；创建记录也不扩大实际授权。`ScheduleStore` 可按约定时点提出或创建可追溯的工作，触发本身不授权开始 Task。飞书可以展示和接收受控编辑，任务本体仍由 PostgreSQL 维护。

任务的详细要求与讨论可在过程 `Document` 中修订；仓库正式 `docs/` 由 Git 独立维护；Wiki 在仓库外维护可修订的认识及其来源。Task 与 Document 的普通链接只帮助导航，不能说明任务已经接受哪版内容。主正文从创建时就固定 DocumentRevision；开始执行时同事务形成 TaskRevision 与完整、封存的 BasisSet，固定目标、判据及实际使用的 DocumentRevision、GitSourceRef 或 Knowledge 修订；封存后不改成员，变更依据产生新任务修订与集合。派发只能使用已封存集合；后续来源更新只触发影响复核，不重写旧 Run 的依据。

`Coordinator` 依据已开始且获授权的任务和 `RoleRegistry` 选择责任者，再由 `SessionRuntime` 承接。`Delivery` 记录产物和检查，约定的验收者判断任务是否满足判据；`StageReview` 另外观察成果是否被目标消费者实际使用、效果与偏差，并决定继续、补证或提出新工作。发送通知、Run 结束、任务交付、正式文档合入、Wiki 发布及实际使用各有自己的证据，不能互相代替。

后文先给这些对象的权威和状态边界，再细化来源、权限、版本、结果、端口与恢复。所有跨系统读取都须保留固定引用和当前可达性观察：原件与提取文本、投影视图分开；不可变载荷与可变权限/有效性分开。

## 1. 通用身份与结果

跨系统引用使用稳定的项目、任务、日程、文档、文档修订、关系、来源、知识、逻辑 Role、Session、操作和成果标识。飞书等外部平台 ID 保留在 `ExternalBinding`，不能把可变化的标题、Wiki 路径或会话窗口名当唯一身份。

每条可追溯变更至少记录行为者/承载 session、发生时间、所读基线、写入意图、操作 ID 与结果依据；可见范围跟随来源权限，不因被摘要引用而自动公开。

结果统一区分：`applied`（已回读证实目标效果生效）、`rejected`（已证实目标效果未发生并拒绝该动作）、`pending`（已接收，仍有异步处理或恢复待完成）、`unknown`（是否生效未明）。

结果须绑定操作和效果范围：PG 主数据提交为 applied 时，飞书投影或 Wiki 发布仍可分别是 pending/unknown。一次多步操作保留各副作用的结果与证据；部分文件写成、索引失败或发布指针未核实，不能汇总为“全部成功”，也不能用一个 rejected 声称外部完全没有变化。

已知待恢复记 pending，是否发生仍未明记 unknown。`unknown` 是持久待对账状态，不能映射为失败后盲重试。后端没有强制条件写能力时必须报告“不支持”，不能用“先读后写”冒充原子操作。

### 状态分别回答什么

| 状态域 | 判断依据与边界 |
| --- | --- |
| Task 业务状态 | 按所接受目标和验收推进；采用[产品状态图](../product/agent-loop.md)的 todo/in_progress/done/cancelled；等待、检查及受阻在原任务中说明原因和下一步，旧八态只作历史。 |
| Document 采纳与 Review 决定 | 候选修订、决定和已采纳指针分别记录；草稿保存不等于采纳，审阅结案不等于正文已发布。 |
| Run | 运行时实际承接、等待、停止和终态；Turn 结束不代替任务验收。 |
| 操作结果 | 对应动作及效果范围的 applied/rejected/pending/unknown；不与 Run 终态或 Task 状态合用一列。 |
| Sync | 外部投影与本体分别核对到哪版；同步失败不抹掉已提交主数据。 |
| Knowledge 发布与有效性 | 发布修订、索引水位、待复核/撤回和后续采用分别观察；已发布不等于认识已证实。 |
| 效果 Review | 目标消费者实际使用与预期差距；未观察保持未知，不能由 Task 或 Turn 完成自动填为通过。 |

## 2. TaskStore：行动状态的唯一权威

`TaskStore` 的主数据在 PostgreSQL；飞书多维表格是可读写的协作投影和入口，不拥有任务本体。人可在飞书受支持字段编辑，入站变更须由 core 核对身份、权限、基线和状态转换后成为内部 command，不能直接覆盖主数据。每个受管项目维持独立任务命名空间，evoLoop 不接管业务项目的代码与 Git 正式文档。所有入口经同一合同，飞书同步滞后不使 PostgreSQL 的已提交任务失效。[数据权威](project-data.md)

### 正文、执行与验收责任

`task.create` 接收 title/content/acceptance/owner 和按需元数据，一次创建 Task 与主 DocumentRevision。Task/TaskRevision 的 content 是固定主正文的读取投影，不另存正文。Task.kind 可为空或 implementation/research/validation；所有类型共用 todo/in_progress/done/cancelled。项目 Goal 与 Role.goal 不改变含义，Schedule 的新 TaskTemplate 使用 content，旧模板仅在读取时兼容。

开始时校验当前版本、实际授权和固定原件，原子发布主正文、封存 BasisSet 并进入 in_progress；外部材料可显式加入，主正文会自动加入，无需独立创建/采纳其他 Document。`task.start` 保留明确的 review 权限核验；状态简化不把旧提议自动变成已获准运行。Runtime 只从已开始的 in_progress Task 派发。

TaskRevision 从创建时就固定主正文 revision。执行中改变正文或验收须先核清在途运行，再显式 reopen→update→start；旧 Run、封存集合与操作回执保持原义。任务主文档不能通过通用 document.revise/publish 旁路修改。历史 TaskRevision 可以保留旧八态，当前 Task 仅四态；新写命令不继续保留旧八态流程。

`Delivery` 指向交付登记产生的固定任务修订、产物、技术检查与证据，登记后仍是 in_progress。`delivery.record.runId` 可显式关联同项目、同 Task 的确定终态 Run；登记前核对当前完整业务输入与该 Run 的固定执行修订一致。执行修订沿 Run 读取，不能把登记修订当成执行修订。旧无归因交付保留 `runId: null`；有署名的 Run 归因也不等于系统证明模型生成了产物字节。`task.close` 要求当前有效的最新技术通过交付、验收达标及必要证据；只有明确 useRequired 的任务才检查指定消费者实际使用，不默认增加验收状态、独立验证任务或真人审批。未通过继续处理；取消和重开保留旧结果，旧交付不能自动满足新一轮验收。

旧 TaskProposal/TaskJudgement 等记录可读取历史，不是新任务的必经工作流。未决定的问题可保存在 issue/spec 或讨论中，普通工作不必先制造额外材料。写作和业务含义见[任务与过程文档](../product/tasks-and-documents.md)。

## 2a. DocumentStore 与 RelationStore

Document 增加可空用途 kind 与 draft/published/archived；发布指针沿用 adoptedRevisionId，允许已发布版与新草稿共存。task 类型主正文由 Task 命令原子维护，通用文档修改不得旁路；正文与附件的固定修订、完整性和当前授权仍需核对。

`DocumentStore` 只管理可关联任务的过程文档及正文修订，包括需求、任务详述、技术讨论、方案和评审记录；文档完成或归档后仍保留固定历史。仓库 `docs/` 下的产品、架构、接口与开发规范不进入 DocumentStore，而由 Git 独立维护。

`DocumentRevision` 是 PostgreSQL 中不可变的过程文档正文修订，含作者、创建时间、内容校验、格式、创建时的权限范围与所读基线；新增修订须按预期基线提交，旧基线冲突须显式返回。Task 与 Document 可多对多建立普通导航链接，只指向稳定 documentId；任务开始或执行时，再由 TaskBasis 固定实际采用的其他 DocumentRevision。任务引用某需求不意味着其他关联任务自动采用它。

Git 文档不创建 Document 行；独立 `GitSourceRef`（或等价来源元数据）保存稳定仓库身份、repo/path/commit、原始字节 hash、读取校验和可达状态。Git 正文及 commit 仍由对应仓库维护，发布 HTML 是只读派生视图。

Document 目录列表返回 ID、标题、类型、状态、当前修订和内容格式等摘要；点行后按授权读取所选不可变 DocumentRevision 的完整载荷，不依赖 Task 描述字段或外链再取内容。修订可采用 Markdown、HTML 等格式；详情层解析 Markdown，HTML 报告可保留原件并预览。固定修订的 hash 必须在读取时核验，缺失资源或无权读取时明确显示不完整/不可达，不用旧摘要伪装完整正文。

不可变的是原始载荷、资源清单和形成修订时的事实；当前权限、可达性、完整性核验结果和采纳状态另记带时间的观察或决定，不回写旧正文。

历史修订不能沿用过去权限绕过当前授权。补齐缺失资源或修复原件要创建新修订；原件未变而只是恢复访问，则追加核验记录。GitSourceRef 和 KnowledgeRef 固定身份/版本与当前可达、撤回、待复核观察也须分开。

HTML 原件保存为数据，不直接执行。默认阅读策略是静态预览：在隔离 sandbox/独立来源中禁用脚本和同源权限；不得用 `dangerouslySetInnerHTML` 或等价方式把不可信正文注入应用 DOM。交互式预览只有在独立隔离渲染环境中另行通过安全检查后才启用，且不与 evoLoop 应用共享来源或权限。HTML/CSS/图片等本地资源必须由随修订保存并校验的 assets manifest 追溯；自包含 HTML 可单独保存，但依赖资源缺失时不能声称报告完整。外链按外部引用显示，不自动复制未知网站内容、用户私人目录或未授权资源。

原始修订与文本提取结果分开：从 HTML 提取的纯文本只供检索索引或 Wiki 来源，不替代原件，也不能执行报告 JS。提取记录输入源 hash、extractor 版本、状态及缺失资源/内容清单；源 hash 改变时旧提取失效，提取失败或不完整时如实返回缺项。

`RelationStore` 保存有方向、有类型的跨对象关系，例如 Task 与 Document 之间只按稳定 ID 导航的 `links_to`，以及 `justified_by`、`specifies`、`implements`、`validates`、`contradicts`、`supersedes`、`incorporated_into`。关系端点可为 Task、Schedule、过程 Document/DocumentRevision、GitSourceRef、KnowledgeRef、EvidenceRef、Delivery 或 Review；导航关系只固定对象身份，作为依据或有来源主张时才附固定修订/来源绑定。关系至少记录项目、关系作者、依据来源、观察时间、状态、ACL 和撤回／取代链。关系只表达一项**有来源的主张**，标签本身不证明任务已实现、验收已通过、知识为真或权限可继承。创建或撤回关系须校验两端身份与权限；端点、方向或类型需改变时，失效旧关系并以新 relation ID 创建新关系，不原位改掉旧版本绑定的含义。来源撤回、文档改版和 Wiki 修订触发相关关系与任务的影响复核。PG 可为跨 Task／过程文档／GitSourceRef／Wiki 导航保存 KnowledgeRef，但 Wiki 正文、来源与内部知识依赖仍由外置 KnowledgeRepository 持有。

`DocumentIncorporation` 关联多份过程 DocumentRevision/片段与多个 Git 正式文档目标位置；记录整理理由、Task/Delivery/Review 引用、目标 repo/path/章节、base commit、候选差异与 PR、核实的 merge commit，构建/部署结果另列。目标是 GitSourceRef/source metadata，不是 Document 行，目标表无须 FK 到 Document。

候选期只表示拟纳入，核实合入后才记录 `incorporated_into` 的实际 GitSourceRef/提交；拒绝、无需更新或部分采纳保留理由和范围。

来源过程文档与 Git 目标的 ID、正文和生命周期分别保留，不把纳入当 `supersedes`。原仓库写入由授权任务完成，`DocumentSource` 不因此获得写权限；本库记录不能与远端 PR/merge/build 组成单个事务，未知结果先查既有请求和提交，不能盲建重复变更。详见[工作文档整理流程](project-data.md#6-工作文档怎样沉淀为仓库正式文档)。

## 3. EvidenceStore 与 KnowledgeRepository

`EvidenceStore` 登记和定位原始材料：`sourceId`、项目、原件位置、片段定位、内容校验、来源类型、观察时间/记录时间、可见范围和撤回状态。原件可以仍在原始归档或受控材料存储；正文页里的引文和搜索索引都不是原件。取不到原件时返回“依据不可访问/已撤回”，不能从旧摘要补造证据。

`KnowledgeRepository` 面向开发仓库外的 Wiki/知识空间，至少表达：提交材料或候选知识变更；按项目/主题查找；读取当前页及指定修订；标明主张是观察、推断、假设、已采纳决定、争议还是已失效；列出来源与被其支持的知识页／主张及内部依赖；提出修订与发布；导出固定修订的只读视图。跨 Wiki 与 Task／Document 的关系在 PostgreSQL `RelationStore`，不由 Wiki 维护第二份任务关系权威。每个受管项目有独立知识命名空间。底座若只能搜索并生成答案，应如实标记未支持这些维护语义。[方向出处](../references/lineage.md)

贡献与发布分开：业务 session 提交“旧判断、观察与片段、解释/反例、建议范围”，Wiki 维护者负责与现行页综合、保留相反解释、处理过时链接和影响任务。新来源时间更晚不自动成为更正确的结论。来源撤回触发依赖查找及复核；受影响页先标待审，不能仅删除源记录就假定综合正文同步正确。决定的权威来自人类或授权范围内的责任者，不来自模型语气。

Wiki 综合维护由有权维护者承担，领域判断由相应责任者承担；Leader 组织受影响任务，Evocation 结合独立体验研究跨任务方法和组织问题。现有“认知”模板仅是历史配置事实，不自动授予发布或统一审批职责。下一步选择通过任务与阶段约定落实，KnowledgeRepository 不因存储了一个建议而自动批准或执行该建议。Wiki evaluator 的产品验收范围见[建设与有效性评价](../product/wiki-evaluation.md)。

页发布须声明读入基线与操作 ID。当前选型未能承诺可靠的页级条件写；在受限试点中采用单维护者串行发布、发布前回读与快照，旁路写入视为必须对账的风险。只有固定版本证明服务器确实拒绝旧基线写入，才可宣称多维护者安全发布。两候选的已观察结果见[验证摘要](../references/validation-summary.md)；按 DEC-027，首个集成后端选择 OpenViking，具体版本及生产能力尚未验收。

`BlobStore` 管理仓库外受控原件的准备、按 hash 核验、发布读取与撤回；PG 只登记 blob 引用。发布顺序和恢复边界见[存储设计](storage.md)，PG 事务不覆盖文件系统或对象存储。知识查询还须提供带权限和固定 revision 的类型/专题分页、正文、来源、出链/反链和有界邻域，详见[Wiki 前端模型](wiki-workspace.md)；这些是适配器需支持或明确报告缺失的合同，不假定 OpenViking 已有对应实体/API。

Blob 身份使用稳定 ID，附内容 hash、大小、媒体类型和资源 manifest；本机路径、bucket/key 与短期访问 URL 是适配层定位，不是业务身份。迁移存储实现保留原 ID/hash 与 DocumentRevision，只切换经核验的物理绑定。端口的 prepare/verify/publish 表达完整性及业务可读状态，不要求底层提供多对象原子改名；实现必须验证未完成上传不可读、缺资源拒绝发布、PG 登记失败后对账及旧修订回读。对象存储推荐与上游存储核查见[存储选择](storage.md#evoloop-何时接入对象存储)。

较大 Markdown/HTML 报告和资源 bundle 沿用同一 BlobStore；原始小型 Markdown 或小型自包含 HTML 可内联存 PG。blob 先 prepare、校验 hash 与完整 assets manifest，再由 PG 事务登记不可变 DocumentRevision 及唯一 canonical payloadRef；只有 PG 提交成功后修订才可读。未准备完成的 blob 不可见，资源不全的修订最多标记 incomplete，不能标为完整可读。`body` 与 `payloadRef` 必须互斥且恰有一个；payloadRef 指向该 revision 唯一的不可变载荷，不是另一份可编辑正文。读写都再次核权限、有效性与 hash；撤回或权限收紧时停止新读取，保留历史状态及缺项记录。

发布批准绑定不可变候选修订/hash 与所读知识基线；outbox 实际执行或重新写入前再核批准、权限、来源有效性与独占资格。已发出但结果未知的操作先对账，批准后来撤销不代表先前写入未发生。审阅结案可以是拒绝、归并或无需修改；只有接受并确需改正文的项才要求另有发布回执，结案和发布保持分离。具体时序见[Wiki 集成](wiki-integration.md#4-命令发布和纠正)。

### 知识后端可替换合同

`KnowledgeRepository` 是业务需要的端口，不能直接照抄 OpenViking HTTP 方法。下面按使用者分组，仍属于同一知识边界，不增加服务或要求所有能力第一天实现。浏览器只取得共同 API 的公开 DTO，发布和迁移端口不从浏览器出口暴露。

| 能力分组 | 最小合同与不支持时的行为 |
| --- | --- |
| 读取与检索 | 按项目列页、读固定修订、来源、出/反链及有界邻域；搜索只返回候选，正文与关系再核固定身份和当前授权。缺少关系或历史读取时返回明确缺项，不能从相似度或最新版补造。 |
| 候选、发布与回读 | 沿用候选/批准/预期基线/操作 ID；输出本次操作结果、发布修订及索引状态。端口不批准任务、不决定结论为真。 |
| 能力与健康 | 逐项声明固定修订读取、条件发布、有界关系、迁移导出/导入及恢复范围；区分后端原生能力与适配补齐、受限单发布者或不支持，并附所验证版本与限制。未实测不标 verified；能力不等于当前用户权限。 |
| 迁移与校验 | 管理端导出带 `formatVersion` 的固定清单，目标端支持保留 ID 的导入和校验报告。普通只读页面导出不等于完整迁移包；缺失历史、附件或来源须明确列出。 |

业务身份使用 `projectId + knowledgeId + revision`，每个修订带 `contentHash`；知识 ID 和历史 revision 不包含供应商名、URI、文件名或向量索引 ID。来源保留稳定身份、原修订/hash 与片段；内部关系保留稳定 `edgeId`、端点和所据修订、方向/类型、主张来源及撤回/取代记录。改名不换 ID，同名不合并，迁移不重编号；找不到历史版返回缺项，不能重定向到当前版。物理 URI/外部 ID 只在适配器绑定中解析；绑定和外置 manifest 必须可恢复。

知识内部关系由外置知识空间维护；跨 Task/过程 Document/Git/Knowledge 的关系仍由 `RelationStore` 维护。查询装配层返回统一图视图，但不把两类关系复制成第二份可编辑图数据库。检索相关性和布局聚类只作为导航提示，不能生成“支持”“证明”边。

图查询须声明焦点、关系范围、页长与深度上限；响应区分完整/截断/部分/不可用，附节点及边的来源修订、分源水位、继续读取依据。无结果和后端不支持是不同状态。权限先于关系拼装和计数；隐藏节点的名称、边和数量不得泄漏。历史页关系和当前反链分开，跨 PG/Wiki 的视图不声称全局历史快照。[图谱交互与读取](wiki-workspace.md)维护具体界面和查询形状。

迁移包必须覆盖当前发布指针、保留范围内的不可变正文/候选/来源、附件清单与字节校验、内部关系和失效历史、权限映射、发布操作引用；外部原件可只保留固定定位与 hash，但必须标记依赖是否可达。PG 的 Task/Review 等记录保持原权威，通过原 ID 校验连接。向量、全文索引、图布局坐标是可重建派生物，不要求原样搬迁；重建后的检索质量另测。切换前后使用同一端口合同测试，运行步骤见[迁移设计](wiki-integration.md#9-以后替换知识后端怎样保留前端与历史)。

## 3a. DocumentSource、SourceBridge 与 ContextQuery

`DocumentSource` 是 Git 来源读取端口：按仓库稳定身份、白名单路径及固定 commit 读取原始字节，返回独立 `GitSourceRef`、内容校验、权限/可达性与来源状态；观察指定分支变化只产生新的候选来源引用，不自动采纳。Git 路径移动保留旧 GitSourceRef 并登记新 repo/path/commit/hash；无需也不得强制映射到 Document ID。正式 HTML 视图不另作独立来源。Git 端口不代替原仓库的修改与审阅流程。

`SourceBridge` 用例组合 Task/过程 Document 固定修订、GitSourceRef、DocumentSource 和 EvidenceStore 读取，将选定材料交给外置知识空间。最少关联项目、来源类型、原对象/修订或 repo/path/commit/hash、片段、内容 hash、过程文档的采纳/撤回状态或 Git 来源的可达/撤回状态、权限策略版本、转换器版本和目标空间；据此去重并保留外部 sourceRef/处理回执。权限检查覆盖原件、摘要与目标可见范围。PG 保存传递映射，Wiki 保存来源内容及内部依赖；资料已送达、索引可用、知识已维护分别观察。来源变化触发影响复核，不能因入库成功就改 Task 或需求的接受状态。

`ContextQuery` 为人或 session 装配有限上下文：Task 的过程文档导航链接、TaskBasis 固定的过程 DocumentRevision/GitSourceRef（repo/path/commit/hash）/Knowledge 修订、当前变化/反例、真实使用结果及缺项。返回每项权限、读取时间、修订与校验，区分普通导航和历史依据；不得把未固定的 Document 最新版冒充执行基线，也不得补造无法读取的来源。跨系统没有共同快照事务，精确引用组合不等于全局同时一致。上下文送达只证明传递，使用/采用由后续产物证据判断。

Task 接受和 Run 派发固定到不可变 TaskRevision 及依据集合；更新当前任务不改旧 Run 的依据。派发前复核权限、业务接受状态和重要来源/知识有效性，已撤回或待复核依据不得因后台扫描尚未完成而继续无条件使用。无法核对外置修订时报告缺项；跨系统检查后仍可能变化，不能宣称跨系统线性一致。具体表与约束见[存储设计](storage.md)，传递、反向影响和例子见[知识关联](knowledge-flow.md)。

## 3b. 工作台 Query / Command 合同

工作台、CLI、Agent 工具和 connector 共用领域命令。QueryService 只装配已授权的对象和关系，返回固定修订、当前版本、分源状态与缺项，不把搜索摘要当权威正文。Command 包含 operationId、行为者、项目、预期版本和变更意图；权限、状态和基线由服务端 core 在提交时核验。Journal 保存这些字段的规范化命令摘要；同一 operationId 的摘要不一致则拒绝，一致时重新核当前授权后回读原结果，不以当前较新对象版本重新执行旧命令。

浏览器保存新草稿不自动采纳它；已采纳的版本指针由显式决定和条件更新改变。发生冲突保留输入并返回可复核的当前版本；结果未知按 operationId 查询，而不是换 ID 重发。UI 分别呈现业务、运行、同步、知识和效果状态。刷新提示只要求回读，不能直接推进状态。前端结构与范围见[前端架构](../frontend/architecture.md)。

### Session 工作观察：有界读取同一份事实

会话目录统一读取 owned RuntimeSession 和已登记的 external HostLink。同一真实会话去重，同一 Role 的不同实例保留；可选绑定表不能代替完整目录。项目内展示名、用途和当前／历史归类由 `SessionProfileRecord` 版本化维护，不改原生聊天标题或运行权限。没有明确归类的旧 ready 会话保持 unclassified；外部实时状态未同步时为未知。

`session-work` 提供目录、单会话快照、变化和分页活动。共同 DTO 在 `contracts/session-work` 与 `contracts/session-observation`：分别返回生成时间、来源观察时间、部分结果及缺项，区分项目记录、Session 自述与独立使用。当前工作依据具体分派、claim 或 Run；Role 拥有某任务只表示职责，不能推定同 Role 每个 Session 都已接手。成果归属按真实 Run 或人工接手的有效时间范围核对，不把转交后新承接者的交付算给旧会话。

受控恢复通过单 Session 恢复读取返回配置档案、当前 gate、最多20条正式决定、关联队列的版本与累计预算，以及可解释的下一动作。attempts 未读到或额度字段缺失时为未知，不得显示成零。gate 决定与普通 activity 不混为一类；分别保留 cause、操作者、理由、原 Run/inputHash、指定 retry Run 或 pin 消息及记录时间，只有同项目有权限的读取才可见。

PG 在源写入的同一事务追加只含引用、状态与短预览的观察变化；每项目事务计数器锁持有到提交，避免普通 identity sequence 的晚提交越过游标。读取在一个 repeatable-read 事务中取得事实和边界。变化返回有稳定身份的 invalidate，客户端合并去重后重读相关范围；不重发写入或启动模型。游标绑定项目、调用者与用途／筛选；分页期间继续保留首个观察位置，目录失效后从第一页重建，避免漏掉并发新增项。

活动保留正式事件的真实 `actorId` 与源讨论入口；讨论事件属于项目记录，关联到 Session 的任务上下文不能证明由该 Session 本人发言或执行。分工、方向讨论与任务沟通分别标明，讨论链接其他目标仍是关联背景，不扩展本会话的接受或执行归属。Discussion 聚合头保留变化失效记录，但不作为第二条活动重复显示同一动作；历史和首屏快照都带出这个范围说明。范围说明本身不表示数据缺失，实际截断或不可读仍以 `partial` 和具体限制标注。

普通消息的阻塞原因表示最近一次确认的阻塞，不随每次轮询先清空再写回。调度检查通过不代表原生资格、权限和执行槽全部通过；消息真正进入 processing 时，由 `beginDispatch` 与处理记录在同一事务清理原因。相同原因保持版本、更新时间和观察水位不变；真实阻塞变化仍正常更新。排队、原生处理与显式已读分开，观察刷新不制造接收或运行事实。 `session.message.receipt` 由持久处理记录中的实际接收 actor 自署；同项目、原消息及原 Session 一致且已绑定原生 Turn 后，可在 message=processing／processing=running 时登记，不必等 Turn 结束。原有终态消息仍可补记；排队、未绑定、unknown 或其他身份不能据此登记。read 仅证明该身份声明已读，不证明物理调用进程、处理完成或 Delivery；它不改消息／处理的状态与版本，不释放占用或预算，重复操作沿原 operation journal 恢复。

目录／活动默认每页 50，变化最多 100；服务端限制 UTF-8 响应字节，超限显式分页或标注遗漏及详情入口。项目 attention 聚合独立于当前目录页。原生深度历史不进入页面轮询；token、费用和进程内存没有可靠采集时返回 null 与原因，不填 0。当前源码和隔离检查不代表新工作区、性能目标或真实消息已通过使用验收。

### UnitOfWork：同库原子命令

`UnitOfWork.transaction` 和 `read` 是中立事务端口，由 PostgreSQL 适配器提供一组绑定同一连接的 Task/Document/Relation/Schedule Store、操作去重记录与 outbox 访问入口；read 使用一致的只读快照。core 先核 operation ID/摘要，再在写事务内重验对象版本、当前权限和采纳状态，一并提交相应对象、关系和待发意图；不暴露 SQL 或 `pg.Client` 给 core，也不允许各 Store 单独提交。身份或命令结构校验失败可直接拒绝而不建 Journal。合法命令因旧基线或领域规则被拒时，可用事务内 savepoint 回滚业务写，再由外层事务只提交 `rejected` 与摘要，不生成 outbox；PG 提交结果不明须按 operation ID 回读，不能伪造已拒绝。事务内只处理本库状态，网络读写、模型调用和外部发布放在提交前准备或提交后执行。

操作 ID 与命令摘要一起去重，同一 ID 带不同命令必须拒绝；提交结果未知时按该 ID 查询同库事务结果。首片已自动检查最后一步失败时全部回滚、提交成功但回包丢失后恢复不重复创建，以及旧基线更新被拒绝；CLI 当前也按原 ID 查询回执。这个本机子集不证明外部副作用恰好一次或生产恢复，数据库选型本身也不是测试通过证据。

## 4. RoleRegistry 与 SessionRuntime

`RoleRegistry` 记录逻辑责任的稳定 ID、目标、范围、主要输入、可写资产、交付、触发条件、与其他 Role 的交接、试行状态和修订。Role 可处于候选、试行、活跃、调整中、撤回；这描述职责约定，不是 session 运行状态。一个 Role 可有先后多个 Session 或经批准的并行实例。会话换窗、上下文压缩、模型替换都不自动变成新 Role。

正式 Role 的可选 `roleClass` 区分 system/business，旧未分类 Role 仍可读取；Lead、认知、分工、产品、架构、开发流程、功能开发是分类模板，不自动生成七个 Role。分类沿 Role 的不可变修订与 reviewer CAS 决定更新，模板键须与分类一致；持续新责任仍走原 `role.propose` 与试行审阅。BusinessDomain 有稳定 ID、标题、修订、Role 映射、路由选择理由和授权证据；Task 的可选 `domainId` 与 `kind` 独立并固定于 TaskRevision。只读领域路由仅对当前 trial/active Role 给出承载状态，不能凭显示名、领域或模板取得执行权。

HostLink 独立记录 Role、owned Session 或外部 Codex Desktop 引用及历史。owned 登记要求同项目、同 Role、ready、真实原生 Thread 与正式绑定；external 只可声称并经 reviewer 核实 open/read/manual-claim，核实能力、证据、观察者和时间分开保存，未核实显示未知。撤销、Role 退出或承载失效时不能沿旧验证继续派发。Desktop link 不是 RuntimeSession，也不提供 start/send/interrupt 自动控制；路由查询本身永不启动模型。本机已按该合同核回 owned/external 承载与领域登记；已建立范围与本轮证据统一见[当前基线](../roadmap.md#当前基线)。登记、已核能力、队列执行及页面展示分别取证，不能由一个链接推定 Desktop 自动控制。

`SessionRuntime` 的能力按实际宿主逐项声明：创建/继续、查询状态、发送已授权任务、读取回复/产物、请求停止、恢复关联；某能力不存在就返回 unsupported。发送消息或唤醒并不等于接收、执行、完成。不能凭“创建请求已发出”就登记为已运行。运行时身份映射保留 `roleId ↔ sessionId ↔ taskId` 的时间范围和来源；同一任务因续做换 session 时保留交接链。

Codex App Server 协议版本由本机运行配置显式固定；省略时维持兼容旧配置。升级到受支持的新候选前，配置保管人先核选中的二进制版本与标准／实验 schema 指纹，服务按该版本做精确匹配，不自动升级或放宽协议锁。新增的 `currentTime/read` 仅为精确绑定 owned Thread 提供只读时间，不授予执行权或模型能力；即使 `model/list` 返回某模型，也不能证明新 Turn 会被服务商接受或其实际运行模型。

受管 Session 的启动失败或结果未知会在项目事务内阻断该 Session 后续 Run 与普通消息启动，保留失败来源、原 Task claim 和最早已排队消息；结果未知先沿原 Run／消息 ID 只读对账，不自动重发，也不清除失败事实。Lead 的 `queue.retryFailed` 只针对原 claim 最新、已确认 `failed` 或 `interrupted` 的 Run；retry 不改写来源 Run 的终态，也不把 `interrupted` 重新命名为 `failed`，并仍禁止 `unknown`／`completed`。只要业务 Task 输入未变，新 Run 的输入仍包含原 Run 固定输入，但会创建新的沟通通道和执行封套，因此保存并区分来源 Run/inputHash 与新 Run 实际 inputHash，不能把字节不同的两个输入称为同一 hash。每次 retry 都要求控制者复核影响、固定输入与原 claim，消耗同队列累计预算，且不自动重试。retry 成功后只允许恢复原来 pin 的那条 queued 消息一次；消息完成后保持 `awaiting_acceptance`，直到原 claim 的交付、消费者使用、Task 验收与 accepted release 满足既有条件，才开放下一个启动。任何后续失败或未知都会重新阻断。

已完成 retry 且原 claim 仍等待验收时，独立复核可要求同 Task 返工。若依据是业务输入变更，控制者先修订并重新封存 Task 业务输入、amend 并 readopt 队列；若依据是合法问答，则固定前一 Task 通道的真实问答。随后以 `queue.continue.rework` 固定 gate 版本、最近 completed Run 的 ID/version/inputHash、active 执行配置及依据。项目事务只为此原 claim 的一个新 Run 进入 `reworking`，PG 启动栅栏和 attempt 追加只认该 Run；旧失败来源、retry 决定、消息 pin 和累计预算不变。完成后回 `awaiting_acceptance`，失败或未知重回 `blocked`；其他 Task、claim、Run 或普通消息均不因返工许可开放。若业务输入未改且无合法问答，或来源、身份、权限、预算、配置、采纳版本不符，事务拒绝且不留下许可。

`runtime.session.executionProfile.revise` 只登记新的不可变执行配置修订，本次可改已授权的 model；它不是运行时观测到的实际模型，也不直接调用原生宿主或解除恢复门槛。每个 Run 固定其启动时的配置修订快照，旧 Run 不随 Session 后续换模改写。重试还必须明确匹配受审的 `expectedExecutionProfileRevisionId`，不能在读入后悄悄换用另一配置。新配置需要在同一原生 Thread 以显式配置恢复并取得肯定回读后才可启动；激活回执未知时只对原 Thread 只读对账，不重复调用激活。即使只读对账确认配置已 active，有权者仍须显式作 `runtime.session.recovery.resume`，不会因回读成功自动启动后续工作。显示配置、激活状态与逐 Turn 实际模型时必须区分；没有可靠原生实际模型遥测时仍为未知。

Evocation 在授权范围内对照任务负荷、结果、User Session 亲用和 Wiki 缺口，提出替代动作：改方法/工具、同职责增实例、临时专项、新 Role、合并或撤回；Leader 组织试行承接。提案进入 TaskStore，不在 RoleRegistry 中直接悄悄改正式约定；试行含目标、成本、效果观察和退出条件。所有 Session 可提出，Evocation 不控制全部业务任务。[产品职责](../product/functional-scenarios.md#共同前提谁负责信息在哪里)

要在后台 runner 已运行时给首次认知固定 trace，`loop.enroll` 可选以 paused 状态登记，再由原有声明命令以 Loop CAS 固定材料，最后通过原有 `loop.state active` 开始。旧 enroll 省略初态仍为 active，历史操作摘要与预算不变；暂停中的 runner 不建立新的 Task/Dispatch/Run。

受管认知研究的 trace 材料由非 worker reviewer 显式声明在当前 active Loop：单个来源 Task 的固定修订、最多十个当前正式 Run decision。服务端解析终态 Run 的固定输入、Task 修订与 slot，核当前来源 grant；Loop 只持有当前声明指针，事件和操作记录保持不可变。controller 创建真实认知 Task 后，以软件创建回执和确定 ID 证明目标来源，在同一 PostgreSQL 引用事务内经窄权限 resolver 把逐项 Run 复制成正式引用，并随 Task 修订递进；完整快照、当前声明及原声明者的实时项目 read/write/review 凭据在派发时重验，复制与 worker 新 trace GET 同样重验；同项目其他 owner 不代替原声明者。worker 的新 trace GET 再核其自身 Run 的固定 Task 修订、声明当前性、来源 slot、Session/grant；直接由 reviewer 正式采纳而无自动继承 provenance 的既有 Run 引用维持原权限语义。撤销仅去掉未来读取/派发权，不删历史引用或恢复预算。`025_trace_study_provenance` 为正式 reference decision 增可空结构化出处；旧行保持 NULL，无回填，因为原固定列及不可变触发器不能安全承载后来软件继承的授权依据。

受限分工先持久化意图、执行绑定和不可变 Loop 策略修订。认知在自己的活跃 Run、最终决定之前签署意图，固定来源、诊断 Document 修订与首项 Task 的已观察版本；worker 对诊断原件的读取权必须在签意图前独立存在，不能靠新 binding 反过来授权该原件。同一父派发的意图与普通 child 请求互斥。外置模板必须精确授权本 Loop 的认知 Role 或指定决定者、既有 Role 或一个有界的新 Role 名额，以及 actor、目录、模型、沙箱、网络、审批和期限；原单 Role 执行 grant 不隐含委托权。认知 worker 可在自己 Loop 的窄入口读取当前未过期模板及所列既有 Role 的状态，随后读取自己父派发的 binding 和固定诊断原件；这些读取权限不能扩成全项目 Role/模板浏览。`waiting` 必须显式引用此前唯一意图，其他最终决定不执行它。

父 Run 确认完成且派发结算为 `waiting` 后，controller 在同 project 锁下仅消费该绑定一次：先核当前策略、模板、正式 Role、预算/并发、父子因果与首项 Task 原版本，持久预留 child 并累计预算；再按普通 `task.update` CAS 转移 todo Task，固定操作与 Task 修订桥接由 `division.confirmTransfer` 核实。首项 Task 若已 `in_progress`，返回 `TASK_HANDOFF_REQUIRES_REOPEN`，不能直写、默默 reopen 或复制 Task。未确认转移的 child 在 claim、恢复与启动入口都被拒绝。转移后若撤权/过期，可凭原操作确认已发生的交接并保留历史收束权，但新 Session/Run/Turn 仍须当前 policy 与模板；动态绑定失效不可回退到同 Role 的静态 grant。接收 worker 在自己的 Run 已建立后读取固定交接包、核 Document hash，并以真实 broker 身份签 `division.ackHandoff`；controller 不能代签。签收前不得提交或签最终决定，签收也不证明交付、独立使用或试行收益。旧派发以派发时政策证明历史，撤回不改旧记录、不返预算。隔离代码的自动执行路径覆盖已合法接受的 trial/active Role；自动新 Role 提案/接受已有隔离工程验证，真实 native 试行及其成效仍未验收。

显式新职责试行许可在 `newRoleAllocation.creation`，缺省无创建权。只有精确模板授权 `allowProposeAndAcceptTrial: true`、限定最多 90 天的 `maxTrialDays` 时，研究者才能随 `division.decide` 提交完整 Role 提案及首 Task 当前 owner；首 Task 须为同 Goal／Stage 下观察版本一致的 todo、无在途或未知执行，固定诊断 Document 原文须由研究者实际有权读回。原 Role 提案与接受规则在同一项目锁和 PostgreSQL 事务内运行，两次正式 Role 操作及 role effect 与一次 binding 名额、策略、分工事件和操作一起提交；失败整体回滚，成功后撤回不返名额。同一操作重试回读，异正文拒绝。研究者的提案署名、控制者按模板接受的署名分别保留；创建许可不代表永久激活、延长期限、增额或扩大运行目录。真正接收、执行、独立使用和成本回看仍分别取证，未知成本保持未知。

每个新 Session 引用当前职责说明或临时任务约定，补充实例目标、输入修订、首项任务、操作范围和交接/退出条件。新 Role 另附缺口证据、替代办法、独立责任与工作流程、试行基线和回看条件；换窗口仅更新实例关联。撤回 Role 时交接未完任务与知识、停止相应触发并核对在途实例，不能仅更改登记状态。流程见[动态多 session](../product/agent-loop.md)。

### 具体承接与职责分开

`TaskSessionAssignment` 固定 Task 修订、具体 owned Session／external HostLink、指定接手 actor 和版本；reviewer 通过 `task.assignment.set/release` 安排与交接，不自动创建 Run。接手由指定 actor 用 `acknowledge` 亲签；Lead 只有人工通信观察时使用 `observeAcceptance`，记录 observer、来源及 `lead-observed`，实际接手 actor 留空，不能冒称执行者签名或原生送达。人工承接窗口只用于筛选关联任务记录；其中的交付仍保留原登记者和产物来源，不据时间窗口推定该会话独立制作了成果。

建议先完成 `task.start` 固定依据再分派。开始、范围变化或其他修订使旧分派过时后，旧 ack 保持原修订，不自动沿用。新队列和直接 Run 必须匹配当前具体 owned 分派；external 人工任务不能被任意同 Role ready 会话抢走。没有显式分派的旧工作维持原授权规则；已建立的合法 queue claim 按其独立封存的业务输入接续，真实 claim／Run 与旧人工 ack 分别显示。

## 5. Coordinator：派发、交接与恢复

首期仍用单活协调者串行派发，租约、并发条件和失去独占后的停写行为在 PostgreSQL 上验证；不再把飞书记录字段当独占锁。数据库条件更新能约束内部抢占，却不提供跨 Codex、飞书和 Wiki 的恰好一次副作用。

协调者消费 PostgreSQL 中 TaskStore 当前状态和 RoleRegistry 约定，按已授权规则选责任者，再调用 SessionRuntime；它不作知识真值或产品价值的最终裁决。最小运行记录保留：任务/Role/Session、派发操作 ID、预期动作、请求时间、运行时回执、最近已知状态、检查水位与下一次核对时间。业务 Task、外部同步 Sync、运行 Run 和效果 Review 各有状态，不合并成一个“完成”；各对象显示当前读回的状态、观察时间与下一责任；Run 的终态不能代替任务验收或消费者使用。普通受管执行者的 `ordinary.submit` 先绑定当前 Run、Task 修订和固定结果意图；原 Run 未知或仍在途时不伪造 Delivery，终态封存核对后才生成本轮唯一固定交付。声明消费者对当前交付的 Observation 与有权者的 Task close 各自独立；返工后的旧交付或旧 `used` 不验收新修订。业务操作方法见[Agent CLI](../development/agent-cli.md#普通-run-本人提交与终态封存)，完整用户接力见[功能场景](../product/functional-scenarios.md#场景-2业务-session-怎样接任务提交结果并带回问题)。

`GET /api/projects/:projectId/orchestration/work-status` 为已分页 Task 列表补充最多50项的工作事实，只依赖项目读取权限和已迁移数据库，不依赖自动 Loop、controller 或原生运行时启用。普通启动和受管模式各只注册一次同一读取入口；读取不启动泵、派发或模型。无派发的普通 Task 保持普通工作标签，存储读取失败明确报错，不伪装为没有工作；受管 worker 的读取范围仍由原鉴权限制。

`GET /api/projects/:projectId/work-management/index` 提供 Leader 的当前 Task 或 Document 读取，`GET .../work-management/tasks/:taskId` 以同一投影精确读取已列出的单个 Task；两者都不启动模型、创建 Task、预约 Run 或改变 assignment/queue。Task 投影保留四态，并从 assignment、当前 Run、当前修订的 Delivery/使用观察、pending impact、跨 Task dependency 与 queue hold 派生“未分派、待接手、可开始、运行中、待交付、待验收、返工、受阻、未知、已关闭或取消”；同时给出当前 Task version/revision 与该 Task 自己的 `workChangeSequence`。创建与当前业务变化分别取首个和当前 TaskRevision 时间，实际开始取首个 `run.bound` 事件，完成只取当前 TaskRevision 的 closure 时间。闭包或正常交付推进 TaskRevision 时，当前有效 Delivery 的 `runId` 仍保留其来源 Run；重新打开后的旧 closure、Delivery 和 Run 不会挂到新轮次。可选计划开始、截止、优先级和依赖来自独立元数据，不改变 Task 四态，优先级也不冒充模型排期。依赖只有在前置 Task 的当前 revision 已 closure，或同一 revision 的队列 claim 已 accepted release 时满足。

`leader_work_change` 为 Task、Document、assignment、Run、Delivery、observation、closure、impact、queue、plan、dependency 和 Leader review 的实际变化记录持久递增序号；UUID 只保留对象身份，不作为顺序或时间水位。相关写入在同一项目事务锁下分配并提交序号，后来的序号不能越过更早的未提交写入先行提交。Leader plan/dependency/review 事务按“Workflow 已有的原始 projectId 锁 → operation 锁 → `leader-work:<projectId>` → Task 行”取得资源，与 Workflow 插入 TaskRevision 时先锁项目、再取父 Task 外键锁、最后由触发器取 Leader 锁的顺序相容，避免外键隐式锁形成 `40P01`。Task 与 Document 的派生阶段/状态排序和 `LIMIT/OFFSET` 在 PostgreSQL 内完成，只返回当前页；总数和分类计数在同快照内单独聚合。分页位置绑定当前变化序号与数字偏移，期间出现新变化即 `WORK_INDEX_CHANGED`，必须从首页重读。`GET /api/projects/:projectId/work-management/changes` 以该序号继续读取变化。读取无业务副作用；后续安排仍走既有命令与稳定 operation ID。Document 列表投影分别保留 current、adopted、draft/published/archived 和来源 Task 关系，旧记录没有可核历史时间时显示未知。

`PUT /api/projects/:projectId/work-management/tasks/:taskId/plan`、`/dependencies` 和 `/review` 由同时具有项目写与 review 权限者更新可选组织元数据或 Leader 处理决定，分别 CAS 当前 Task version、独立 plan/dependency version 或当前 TaskRevision。依赖替换在同项目事务内拒绝不存在对象、自依赖和 cycle；计划拒绝截止早于计划开始。处理决定还携带调用者从 Leader index 实际读到的该 Task 变化序号，并在同一项目事务锁内与最新同 Task 序号比较；不匹配返回 `WORK_INDEX_CHANGED`，不能用写入时的最新值替调用者补确认。决定只记 `acknowledged` 或 `deferred`、理由、actor、operation、固定版本和该确认位置，不把暂缓写成 Task 取消；之后出现的 plan、dependency、assignment、Run、Delivery、观察、impact、queue 或 Task 修订变化会使旧决定退出当前摘要，需要重新核对。三项都写 operation journal 与单调变化记录，同 operation/actor/正文重放返回已提交结果，改变正文则冲突。该元数据不改 Task 四态、依据、Run 或验收事实，也不产生外部 outbox 投影；Task 创建和详情中的字段编辑仍须随共享 Task 合同接线。

本机受限 ResidentQueue 让 Lead 明示条目顺序、依赖、理由、固定 Task 输入、owned Session、消费者、释放规则与累计 Run 预算，并采纳一个可执行版本。未领取的重排、Task 改版后的队列修订和重新采纳使用 CAS；不能只改正文便沿旧条目启动。领取在同项目事务内核当前 Task、正式绑定、精确 grant、Session ready 与原生 Thread、Task/Session 无在途或未知 Run，并原子记录 claim、Run 预留意图、Journal/outbox；同一 Session 的后项等前项释放，另一个领取不能抢占。所有后续尝试计入同一预算；终态只结束一次 Run，不释放 Task claim。默认核当前通过的 Delivery、Task 关闭及要求的消费者 `used` 后释放；条目预先允许有界释放时，有权 Lead 可对无依赖后项给出释放决定，保留未完任务下一责任。已释放的有界条目不会自动开放 Session gate；有权者仍须另作 `runtime.session.recovery.resume`，且记录保留该有界释放来源。依赖该条目的后项仍须真实验收并取得 `accepted` release；有界释放不能满足依赖，也不能改写原 claim 的 accepted 规则。未知原生启动或封存按原操作与 Run 对账，不能重试造成第二次外部执行。[PR #91](https://github.com/cyl19970726/evoLoop/pull/91) 的本机原 Session 已按采纳队列完成 A→B 两项真实任务的领取、接续和验收后放行；[PR #99](https://github.com/cyl19970726/evoLoop/pull/99) 的有界故障回归不能替代其他场景的原生验收，也不能从已领取或 Run 结束推定 Task 被消费者使用。

队列额度通常在创建时固定；受控恢复中的 `queue.extendBudget` 是有边界的显式追加：当前登记控制者以队列版本和旧上限做 CAS，记录新上限、理由与依据，保留累计 attempts、claim 及历史决定，不自动解除 held 条目或派发 Run。变更后的队列版本须重新采纳。`queue.retryFailed` 使用同一队列累计预算，并固定原失败 Run、Run 版本/inputHash、Task 修订、Session gate 和原 claim；不能用继续运行、重排或新建队列擦除失败或重置用量。只有精确授权且剩余额度足够时才可形成唯一 successor；失败/未知保留原记录并再次阻断。`queue.unhold` 只处理仍可解除的普通 hold，不越过预算耗尽或 Session recovery gate。

Task 协作通道把 question/answer/progress/blocker/handoff/result 固定到同项目 TaskRevision、Run、Session 与 DocumentRevision；事件与 `received`、`read`、`adopted`、`resolved` 回执分开，发出不等于读到或采用。答复若改变范围，应先按 Task 版本规则修订；原 Turn 的输入不静默 steering。原 Run 已知终态后，控制者经显式 `queue.continue` 引用此前同一通道的问答，固定答复正文/hash 进入同一 Session 的新 Run 输入。实际收件者可在新 Run 已绑定原生 Turn、正在运行或已完成时签采用回执；仍须同 Task/Session、完整业务输入一致且包含精确答复，不能以采用代替交付或验收。受限工程动作另有 request、review 决定和实际 executor 执行回执：请求固定原 Run 输入 hash、精确 repo/worktree/路径/commit/PR 范围、授权证据和到期；批准不等于外部动作已发生，执行时再核真实 actor 与现行精确 grant，unknown 沿原外部操作 ID 对账。缺配置或权限即阻断，不借 controller 身份代业务执行。原 Session 的真实问答、固定答复采用、消费者使用及受限动作回执已按[当前基线](../roadmap.md#当前基线)分别取证；答复、采用、请求、批准和实际执行各有独立记录。当前没有独立通知消费者，重复 Task 消息和 pump 的回归不表示外部通知传输重投或 Desktop 自动唤醒已验。

一次派发超时的恢复顺序是：按操作 ID 回读 PostgreSQL 中的任务、Journal 与 outbox → 查运行时是否有对应 Session/动作 → 需要外部协作投影时另查 connector 绑定和同步结果 → 能证实已派发则继续跟踪，能证实未派发才重发，仍不明则保留 `unknown` 并暂停重复执行。飞书投影同步成功不是默认派发前置条件；只有任务目标明确要求远端可见或远端协作时才按判据等待。重复创建、通知和外部副作用各自需要可查询的去重依据；TaskStore 的幂等键不能替代运行时幂等。重启先对账未结束动作、未复核交付和未决外部同步，之后才派发新任务。

受管自动循环候选把已确认终态、却没有 worker 署名提交或决定的运行记为 `dispatch.gap`。它是新的调查来源：在原 Loop 的范围、预算、暂停和来源去重条件内生成一轮新的认知工作；若恢复认知自己又缺提交，则保留新缺口，停止连续自动恢复，待核因后显式处理。旧 Run、失败与缺少交付的事实保留，不由控制者补签。未知 Run、未知封存副作用仍按原身份对账，不能走新运行重试分支。独立消费者观察可证明使用效果，但不是每个认知行动的全局审批门槛。

`loop.resumeWaiting` 将解除阻塞作为有权控制者的新意图，以当前 Loop 版本 CAS 追加 `waiting.resumed`；原 waiting Decision、终态 Run 与失败历史不改写。固定 Issue、bootstrap 同 Task 研究与普通业务结果返工是互斥的来源模式。业务模式携 `businessRecovery.expectedTaskVersion` 和 `basisSetId`，只接受同 Loop 中已正式结算且原生结果确定的业务 `worker.outcome`，其原认知父派发和随后 waiting 认知的来源链须可核；操作签名摘要、Dispatch、Run 和来源投影相互匹配，不能仅凭事件文字构造新来源。

业务恢复固定同 Goal/active Stage 下原责任者的当前 todo Task 和 sealed basis，且无后续派发或在途/未知 Run；现行动态 binding/policy/template 或既有精确静态授权仍须有效，不借历史 binding 回退到静态授权。来源接纳、派发请求和开始前重验这些条件；后来改版不会悄悄替换已登记的修订。原 Task 需补输入时先经普通依据重选保存新修订，执行者仍按新 Run 的固定原件权限亲自读取，恢复事件不携正文来绕过读取围栏。恢复本身不增加原件权限；新认知沿既有规则读取同 Goal/Stage 内获准 Task 的当前固定主正文、依据及获准规划候选，每次须指向明确修订并通过当前授权检查。这不等于材料已成为认知 Run 自身的执行依据，也不证明实际读取或采用。同 Task 研究或业务恢复可在 paused 状态登记但不派发，stopped 拒绝；每个 Decision 最多解除一次。恢复命令不扩预算，后续各新 Dispatch 独立计数，实际返工、独立使用与结束仍另行验收。

预算的例外增加通过 `loop.extendBudget` 显式留痕：原登记控制者须有项目 write＋review，按当前 Loop 版本及旧上限 CAS、只增加一个 Run，并提供依据与理由。仅 paused、无未结派发和在途/未知 Run 时允许；同项目事务保持原累计 `dispatchCount`、策略与历史，追加 `loop.budgetExtended`，不产生来源派发或自动恢复。原操作去重，异载荷冲突；这项有限命令不授予 worker 自行增额或跨 Loop 转移预算的权限，实际成本决定仍须在相应授权范围内。

请求派发时的 TaskVersion 与实际 Run 的固定 TaskRevision 分别保存：自动准备、正文固定和开始会推进版本，不能假定两者相等。恢复读取须核对原请求范围与实际 Run 输入；新认知只因自身已接收的有效缺口获得原 Run、实际固定 Task 修订及其必要原件的读取权限，不借此获得原任务后来的正文或所有历史运行。旧格式缺口从不可变操作结果及原 Dispatch/Run 绑定还原，证据缺失时不猜测。实际验证进度另见[路线图](../roadmap.md#当前自动接续切片2026-10-23)。

通知最少区分“已请求发送、平台已接受、接收者已读/可处理、处理完成”；运行时只提供到哪一层就记录哪一层。没有投递或消费回执时保持未知，不能把请求 200 解释为受托人已醒来。对方完成后，责任者核对成果修订、检查结果和是否满足验收，再更新任务。阶段亲用另行记录，不能被技术检查通过自动替代。

## 6. StageReview：从交付到下一阶段

每个阶段记录目标、交付判据、预期使用效果、必须弄清的未知、责任者和读入的知识/正式文档修订。阶段结束关联实际交付、真实使用过程、用户反馈、失败/反例、成本、改变或保留的认识、下一阶段任务与 Role 试行建议。若只有产物没有亲用或效果证据，结果是“交付已完成、效果未知”；不填零或成功。

下一阶段工作应能追到上一阶段的判断及其来源；相关知识修订若被推翻，未执行任务标待复核。读取端只取与当前任务相关的页和关键反例，再下钻原料，不把整套 Wiki 当作无条件提示词。是否改善要与直接读取原材料等可比基线对照，记录编译、维护、读取和纠错的总成本。

回看结果应形成继续、补证、修订、暂缓、结束或请求具体取舍的选择，关联目标、依据修订、预期观察、责任和资源范围。已授权且有明确正文、责任和验收的行动进入 TaskStore；没有新证据或有价值动作时允许等待/结束。阶段回看可由交付、使用反馈、来源变化或约定周期触发，触发成功不等于认知已完成，任务创建也不等于已执行。

## 6a. EvaluationRecord：评价证据与条件

首片以 `EvaluationRevision`、`EvaluationAttempt`、`EvaluationAssessment`、`EvaluationConclusion` 四种追加事实实现固定条件评价，沿用现有 Task、Session、Run、Delivery、ConsumerObservation；不新增评价执行器或状态机。定义修订固定一个进行中 Task 的来源修订及业务签名（正文、验收、封存依据与保留决定、外部来源），协议、共同材料、共同指令、判据和两种条件：直接读固定材料、额外读指定 Wiki 修订。两组声明相同模型与环境；若 Task 已强制采用 Wiki，则不能建立声称“直接”的对照。定义改变时追加新修订，旧尝试及判断仍归旧修订。

每次首次或重试都要以新的受管 Session 预留真实 Run，并在同一事务追加 `EvaluationAttempt`。它分别保存来源 `sourceTaskRevisionId` 与本次派生、实际执行的 `actualTaskRevisionId`；两者不可混写。派生时重新核 Task 签名及外部来源快照，变更则拒绝派发。启动前协调器应从固定协议、共同材料、必需 Task 依据/外部来源及该组 Wiki 修订生成受控 Blob 输入包，记录内容 hash、清单 hash、构建版本和固定来源；Run 绑定包后才可派发，原生执行须读取相同字节。不存在包或来源不可核时不能用摘要代替运行。

评审为每个尝试追加固定 Delivery/Observation、来源忠实、知识采用、交付质量、真人效果、逐项成本与证据；Delivery 必须显式关联该 Attempt 的 Run，Observation 必须属于所选 Delivery，旧无归因交付不能自动匹配。`null` 成本是未知而非零，Agent 使用不等于真人效果。纠正以 `supersedesId` 指向旧判定，不覆盖历史。结论须引用包括失败与重试在内的全部尝试的当前判定，说明可比性、局限、下一步选择及受影响固定引用。首片没有全阶段成本覆盖及技术隔离证明，只能记 `with_limits` 或 `unknown`，即使两组有尝试及局部成本也不能记完全可比。后续行动可固定引用同项目现有 Task 的指定 TaskRevision；核实身份后仍不自动创建、开始或关闭它。PG 保存四种事实及固定身份，原件与输入包由受控 Blob 保存，活 Wiki 正文仍外置。评价结论不自动关闭 Task、发布 Wiki 或代替阶段回看；后续行动仍走既有授权与任务规则。目标方法见[产品评价约定](../product/wiki-evaluation.md)。

## 7. ScheduleStore 与触发实例

`ScheduleStore` 的日程定义及触发实例以 PostgreSQL 为权威，飞书日程视图若提供则只是 connector 投影。到期计算、实例去重和普通 todo 创建已有本机实现；可选受管接续使用下述固定目标合同，实际验证范围见[路线图](../roadmap.md#当前自动接续切片2026-10-23)。日程回答“何时、为何检查或做事”，具体工作仍进入同一 TaskStore，不由定时器另建一套执行权威。

| 对象 | 身份与语义 |
| --- | --- |
| Schedule | 稳定 `scheduleId`、项目、责任 Role、目标/任务模板、一次性时点或重复规则、IANA 时区、有效期、启停状态、修订、授权/资源范围、错过策略、重叠策略与再看/结束条件。 |
| Occurrence | 一次计划时点的触发实例，关联 `scheduleId`、定义修订、计划 UTC 时点、实际观察时间及任务 ID。相同 `scheduleId + plannedAt` 对应同一稳定触发键，修订号作为被观察基线，避免仅改描述就重复执行相同时点。 |
| 运行记录 | 到期水位、创建任务意图及回执、是否跳过/汇总、关联 Run、unknown 与对账结果；保存在 PostgreSQL Journal，仅用于恢复，不替代 Task／Schedule 主数据。 |

触发流程为：读现行有效日程 → 按时区计算到期 → 核定义修订、授权、积压和在途实例 → 记录稳定触发意图 → 创建/关联独立任务 → 按同一接受和派发规则推进。已授权的重复常规工作可沿用模板判据；运行中发现的新功能需求仍走提议判断。周期完成不能反复覆盖同一任务行，历史每次产物/成本可查。定时器响起不会直接等价于 `SessionRuntime.run`。

### 可选的受管目标

新日程修订的 `template.managedTarget` 可显式指定 `{loopId, stageId}`。不设置时仍只产生普通 todo；已有日程和修订不被自动绑定或回填。目标必须是同项目的既有 Loop 和 active Stage；Stage 须属于 Loop 的 Goal，且 Loop 已明确限定同一个 Stage；当前受管 runner 不执行未限定 Stage 的 Goal 级 Loop，本切片不扩展其范围。模板责任者须匹配已授权的业务职责。显式 Loop 避免同一 Goal/Stage 的多个循环重复消费。目标引用不授予新的运行权限。

物化事务重新核对目标，将该修订的 Stage 写入所创建 Task 的提议记录，保留原 UTC 实例键、Task、操作和事件身份。失效不能退化为无 Stage 待办或换一个 Loop；原因须可查。`schedule.task.todo` 只有在 created occurrence、不可变日程修订、applied occurrence 操作、固定 Task 修订及目标范围一致时才成为该 Loop 的认知来源。裸 outbox 标签或同范围另一 Loop 不能获得派发权。

认知先核当前状态，需要执行时复用该业务 todo，沿现有同源 next_action、child 请求、预算、版本和 runtime grant 推进。周期来源不属于独立消费者观察，无须伪造另一作者；来源可信来自实例与操作证明，实际使用仍单独观察。

| 变化 | 既有工作与后续触发 |
| --- | --- |
| Schedule pause/stop | 不再物化新实例；已创建 Task、在途 Run 和原操作保留，不自动取消。 |
| Loop paused | Schedule 可继续产生 todo，持久来源待恢复后处理；不启动新的 child。 |
| Loop stopped、Stage 不再 active 或授权失效 | 不自动换目标或放宽职责；保留任务及可核原因，修订配置后按原身份核对。 |
| 同修订排队、随后修订日程 | 同修订在前次结束后按原 UTC 键处理；旧 queued 不自动套用新目标，仍保留待复核限制。 |
| 重复 tick、重启或结果未知 | 复用原 occurrence/操作并去重；unknown 先按原 Run/Dispatch 对账，下一次到期不是重跑许可。 |

错过规则明确选择跳过、只补最近一次、汇总或有上限地补跑；禁止停机很久后无限补发。重叠规则明确选择等待、合并或已验证可并行，默认同一逻辑任务串行。没有新事实时，轻量检查只记录检查水位和“无需动作”；真正派发了检查工作就保留相应任务与运行记录，不能删掉无发现或失败运行来美化成本。

日程变更先核对旧修订尚未派发的实例；暂停默认只禁止后续触发，已运行任务按各自合同处理。要停止在途工作需显式产生停止操作并核实际结果。恢复或改时间后重算下一时点；重复事件、时钟回拨和重启不得仅凭触发次数新建工作。创建任务结果未知时先按稳定操作键查 PostgreSQL 事务记录；外部投影不明时再查 connector 绑定并对账，无法排除已有外部副作用就保留 unknown；没有跨系统恰好一次保证。

计划触发和 Codex 桌面产品自动化分别有宿主。首期只有一个自动调度权威，不同时为同一日程注册两套定时器。[定时产品行为](../product/daily-loop.md) · [Codex 映射](codex-integration.md)

## 7a. Connector 与 ExternalBinding

`Connector` 把内部对象投影到外部协作系统，并把外部允许的编辑转为内部 command；它不改变本体的权威。`ExternalBinding` 至少保存内部对象 ID／修订、外部平台和远端 ID、字段与身份映射、同步方向、最近已确认的双方基线、操作 ID、同步状态、冲突与解除状态。一次外部删除、失联或重建不删除 PostgreSQL 本体；按配置修复投影、暂停或解除绑定，保留历史与人工可核依据。

飞书第一切片仅承诺 Bitable 的**任务投影**。出站：主数据变更与 outbox 意图可在同一 PostgreSQL 事务提交；worker 发出前重验当前对象授权、目标可见范围及绑定状态，失效意图停发并留痕；写远端后回读确认并推进同步状态。首次创建投影前要验证可在远端保存并查询稳定内部对象/操作标记；创建成功却丢回包且尚无 ExternalBinding 时，须用该标记定位已有记录，不能因 binding 为空就重建。若远端无法可靠定位，保留 `unknown` 并暂停自动重试。PG 提交不等于飞书已更新，外部请求超时仍可能已经生效，按绑定与操作证据对账。入站：事件只作提示，回读真实远端记录，将受支持字段的变更连同外部身份、远端基线送入 core；core 校验权限、当前内部修订和合法状态转换，冲突保留待决，不使用“最近写入者赢”。来源标记、操作 ID 与双方基线用于防回环；分页、乱序和漏事件由水位与周期对账补齐。飞书 Docs 正文若要接入，是另一种文档 connector 和 API 验证，不可从 Bitable 任务投影推断已有正文双向同步。

`Sync` 状态与 Task、Run、Review 状态独立；投影失败不回滚已提交的任务本体，也不默认阻断已授权运行。外部协作本身属于验收判据时，任务需明确要求相应远端可见性与回读证据。同步冲突、解除绑定、远端撤回和权限变化都写 Journal 供对账；不得把飞书当第二个可直接修改的任务权威。

## 8. 合同验收与尚未承诺的保证

第一条端到端试点至少贯穿：来源入库 → 两个 session 的相反解释 → Wiki 维护修订 → PostgreSQL 任务引用固定修订并执行 → 飞书投影与入站协作对账 → 交付后的实际亲用 → 依据效果形成下一任务/职责试行。随后演练文档旧基线写、同基线 Wiki 写、任务出站成功但丢响应、飞书入站冲突与投影删除、来源撤回、协调者重启、知识恢复及新 session 独立消费。每项报告要分开记录“原生能力、官方 Skill/模型行为、项目适配、人工操作、尚未观察”。

当前没有证据可承诺飞书事件完整投递、跨平台恰好一次执行、外部投影立即一致、OpenViking 0.5.0 安全多写者发布、源撤回自动修正全部页、可靠通知送达或 Wiki 比直接材料更高效。S1a 已验证 PG 内部事务、同基线竞争与固定依据；范围见[实测报告](../research/design-review-20261020.md)，不能将其外推到未接入的合同。任何实现只能在验证后的边界内向上暴露能力；升级后重新跑相应案例。更细的测试和代码约定见[开发规范](../development/standards.md)。

## 9. 分工讨论的可信关系反查

角色探索复用 allocation Discussion、固定 Document、Role 与 Task 的正式记录。`GET /api/projects/:projectId/allocation-relations` 恰选 `roleId`、`sessionKey`、`discussionId` 一个过滤器；`GET .../discussions?kind=allocation` 可发现未决或尚无正式关联的讨论。它们都是读取，不创建角色、分派、Run 或权限。写入继续通过既有讨论决定与 `discussion.action.link`、Role 决定/回看和具体任务分派命令。

可信路径是决议的不可变 action event → Role/Task 的固定修订；具体接手者另须匹配同项目、同 Task ID、同 Task 修订的 `accepted` 分派历史。同 Role 的其他会话、仅 assigned、文本 sourceRef 或另一 Task 修订不能补足这条路径。Role 反查只展示该正式关联 Role 及其固定 Task owner 匹配的路径；Session 反查只取精确身份与真实别名，不扩展整个职责。

返回按关系路径分页：默认20、最大50、单响应不超过256KiB。每页含来源、当前决定/目标修订/分派关系的独立状态；讨论当前正文与决议当时的固定 Document 修订分别提供。直接接收者亲签与 Lead 人工观察保留各自身份，转交、释放和被新决定取代的路径仍可追溯。关联、接受、Run、交付与独立使用是不同证据；不由一条边推定试行成功。试行期限、条件和回看继续读原 Role 权威。

Task 目标的 `taskAcceptanceGap` 说明精确修订的接受缺口：`null` 表示已有相符接受历史（其路径可能在后页），`no-assignment` 表示未登记分派，`not-accepted` 表示该修订尚无接受，`different-task-revision` 表示仅登记了其他修订，`unavailable` 表示固定对象不可读。其他目标不带该字段；这不是新增 Task 状态。只有 Role 链接而没有 Task 链接时保留 Role 来源，讨论未读全前不推断不存在后续任务。

游标签名并绑定项目、调用身份/权限、过滤范围、规范会话及关系代次。复用既有 observation journal，使独立 Document、Stage 和 Discussion 头变化也推进关系代次；关系页通过项目级变化入口失效。代次改变时返回 `resetRequired` 并要求重读，不能伪装跨页固定快照；无变化时按不可变路径键继续，不能在一万项处截断。签名仅在当前协调进程内有效，重启或无效签名要求重新从首屏读取。缺少正式路径是空页，不存在/越权、服务未安装与读取失败仍为错误；前端不能把错误显示成“没有讨论”。更完整的对象正文和版本从原入口读取。Document 来源指向固定原件；Stage 保留固定版本，入口为当前阶段页，核历史仍用既有修订读取。
