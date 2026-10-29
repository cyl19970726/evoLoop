# 文档导航

本目录维护 evoLoop 的产品定义、目标架构、开发方法及可公开研究。第一次了解产品，沿下方理解路径阅读；已有具体工作，再用任务入口定位章节。产品页描述期望体验，当前实现程度另见[阶段路线](roadmap.md#当前基线)，不要把设计中的完整旅程当成已上线服务。

## 先建立一条完整认识

evoLoop 面向一个人与多个 Agent 持续推进的软件项目。[两张产品卫星图](product/definition.md#两张产品卫星图经营交付与组织改进)给出共同模型：经营与交付循环把需求变成 Task、业务结果和独立使用；Evocation 与 User Session 的改进循环用内部事实和亲用结果试行方法与组织变化。两者共用任务、交付与反馈，Leader 负责跨任务组织，每个 Agent 保留本职责内的判断。希望减少的是反复补背景、传话、遗漏和返工；记录齐全或运行完成本身不能证明价值。

## 第一次完整理解产品

先沿下面三步建立问题、完整经历和界面认识；已有具体工作可直接使用下一节的任务入口。每页都保留目标行为与实际证据的边界，当前能做什么另查[阶段路线](roadmap.md#当前基线)。

1. **[产品定义](product/definition.md)**：先看经营交付与组织改进两张卫星图，再读价值理由和 J1—J6 短地图。应能讲清谁受益、两个循环怎样共用 Task、哪一步才产生价值；P01—P12 保留验收索引。
2. **[功能场景与协作闭环](product/functional-scenarios.md)**：完整跨 Session 场景的唯一正文；沿需求到 Leader 安排、业务执行到独立使用、Evocation 与 User Session 联合改进读完整接力。它区分目标责任、局部实跑和未验的长期效果。
3. **[项目工作台](product/workbench.md)**：从人的当前问题推导信息主次、详情与动作，再看页面细则。应能设计一次“交付已产生、使用仍失败”的回看和接续；不同布局可以成立，不要求把每个实体做成顶级入口。

机制和操作在需要时下钻，不必再顺读一遍全部页面。改变角色、交接或两循环关系时，先核[卫星图与场景](product/functional-scenarios.md#两条循环怎样组成完整场景)；节点内部能力则进入相应专题。每个事实先改其所属正文：产品定义管整体价值和判据，功能场景管完整接力，Agent loop 管支撑机制，日常工作管眼前动作，工作台管人的信息与路径；架构总览管系统责任，专题管对象、端口和失败语义；开发入口管怎么实施、验证和交付。其余页链接并标明范围：

| 此刻还需要弄清什么 | 所属正文 |
| --- | --- |
| 两条循环各由谁接力、四部分怎样支撑 | [双循环场景](product/functional-scenarios.md#两条循环怎样组成完整场景) → [Agent loop](product/agent-loop.md) |
| 眼前工作怎样开始、纠正与接续，Agent 具体怎样操作 | [日常工作](product/daily-loop.md) → [业务 skill＋CLI](development/agent-cli.md) |
| Task 正文、验收、过程 Document 与固定修订的关系 | [任务与过程文档](product/tasks-and-documents.md) |
| 何时需要 Wiki，采用的认识是否改变了行动 | [Wiki 与评价](product/wiki-evaluation.md) |
| 哪些是已定方向、实现、有限运行或未验效果 | [决定记录](decisions.md)与[阶段路线](roadmap.md)；实现合入和使用中的服务版本分别核对 |

读者可用自己的项目解释一轮工作，画出当前最需要处理的问题及下一入口，再说明什么观察会改变选择。若必须靠猜测补上责任、授权或接续方式，应标出具体缺口；配色、列宽或组件不同通常是设计空间。首次理解无需先读数据库或运行时细节。

## 按眼前任务进入

| 我现在要做什么 | 先读哪里 | 何时继续查 |
| --- | --- | --- |
| 判断产品是否适合、现在能体验什么 | [为什么做](product/definition.md#为什么要做) → [当前基线](roadmap.md#当前基线) | 想理解整体行为再读 [Agent loop](product/agent-loop.md#一轮循环应留下什么)；不必先读接口。 |
| 阶段检查全绿，但使用者仍不会用；需要选下一步 | [当前阶段的一个小任务](roadmap.md#当前阶段的一个小任务) → [阶段回看](product/daily-loop.md#阶段交付后怎样选择下一步) | 具体界面失败查[工作台使用路径](product/workbench.md#六条端到端使用路径)；先区分这一任务、阶段与整套工作台的完成。 |
| Agent 接手实际项目工作，读取固定依据并受控执行 | [日常接力](product/daily-loop.md#人和-agent-怎样在两类入口间接力) → [业务技能与 CLI](development/agent-cli.md) | 使用项目内 `evoloop-workflow`，按当前状态与服务权限工作；无需通过 GUI。能力/命令以 CLI 帮助和实际回读为准。 |
| 发现缺陷或提出小功能，准备接受与执行 | [提议怎样成为任务](product/daily-loop.md#一条提议怎样变成可做的任务) → [当前贡献流程](../CONTRIBUTING.md#提出与完成变更) | 跨目标、争议或超出授权再找适当判断者；常规领域修复可直接负责完成。 |
| 收到需求纠正，或把技术讨论结论纳入正式文档 | [纠正处理步骤](product/daily-loop.md#需求纠正怎样处理) → [P11 的结果与验收](product/definition.md#p11--工作文档驱动任务并把成立结论沉淀为正式文档) | 需要精确版本/旧任务影响查[项目数据 §4](architecture/project-data.md#4-文档表怎样设计)；整理到 Git 查[§6](architecture/project-data.md#6-工作文档怎样沉淀为仓库正式文档)。 |
| 因返工或积压考虑增加长期审核职责 | [分工诊断与试行](product/agent-loop.md#②-动态多-session先诊断再改变分工) | 先比较方法、容量、临时专项和独立职责；具体事实和试行指标来自当次任务，不由目录预设岗位。 |
| 设计页面，或验证 Wiki 是否影响行动 | [工作台](product/workbench.md#工作台要帮助人完成什么) / [Wiki 评价](product/wiki-evaluation.md#evaluator-要回答的问题) | 实现时再查下方架构合同与固定研究；页面模拟、独立 Agent 消费和真人效果分别记录。 |

本机业务服务已能承接部分真实工作，实际范围见[当前基线](roadmap.md#当前基线)。对尚未接入服务的仓库开发或隔离工作，在当前任务或 PR 保留目标、依据、范围、责任和验收，沿[贡献指南](../CONTRIBUTING.md#提出与完成变更)交付；不必为一次修复先建任务平台或外置 Wiki，也不另建需长期同步的任务状态表。

## 第一次理解整个架构

从[架构总览](architecture/overview.md)连续读完“问题 → 系统组成 → 一轮工作 → 对象/权威 → 变化/失败 → 实现/状态”，先建立整体模型。总览第 2 节的[结构图](architecture/overview.md#2-四部分如何组成系统)先回答人、session、协调软件与外部权威怎样配合；第 3 节的工作回路再解释一次行动如何走到真实使用和下一步。需要查全部拟议模块、端口与关系时，从[包架构的模块索引](architecture/packages.md#完整模块索引)下钻。

随后按需要深入：[项目数据](architecture/project-data.md)解释对象为何分开，[知识流](architecture/knowledge-flow.md)解释认识如何进入并改变任务，[包架构](architecture/packages.md)把逻辑责任落到拟议运行与源码。查字段、表或具体服务时再进入合同、存储、选型和专题页。不要把所有技术参考当作首读前置条件。

需要先了解用户目标时读[产品定义](product/definition.md)；需要判断当前能做什么时读[阶段路线](roadmap.md)。理解系统后，贡献者仍按具体任务查所属正文。

## 当前正式文档

以下是完整目录，供查找所属正文；不是每次工作的必读清单。

### 产品、工作与阶段

| 文档 | 负责回答的问题 | 谁在变更时维护 |
| --- | --- | --- |
| [产品定义](product/definition.md) | 用户要去哪里，哪些场景值得做，什么体验算成功 | 负责该产品变化的 session |
| [功能场景规划](product/functional-scenarios.md) | 跨模块怎样接续、谁接下一棒、如何回到实际效果及原始问题 | 产品责任者与受影响模块责任者 |
| [Agent loop](product/agent-loop.md) | 认知怎样推动下一步，分工怎样演进，任务怎样可靠接续 | 负责行为及协作变化的 session |
| [Dogfood 与日常工作](product/daily-loop.md) | 发现如何进入任务、需求谁判断、日常讨论和定时工作怎样接续 | 对应领域与整体协调责任者 |
| [项目工作台](product/workbench.md) | 旅程如何成为功能、页面布局、交互与反馈 | 产品与前端责任者 |
| [界面设计约定（试行）](../DESIGN.md) | 页面视觉、信息层级、状态语言和双左栏怎样保持一致 | 产品与前端责任者；实际页面验证后修订候选值 |
| [Wiki 建设与评价](product/wiki-evaluation.md) | 怎样积累、修订和使用认识，怎样判断它是否有效 | 认知维护与相应验证的责任者 |
| [阶段路线](roadmap.md) | 当前在哪，下一阶段交付什么、需要学到什么 | 当前阶段的整体验收负责人 |
| [决定记录](decisions.md) | 哪些是已确定方向，哪些是设计提议与待验证选择 | 作出或接收决定的责任者 |

### 架构与实现依据

| 文档 | 负责回答的问题 | 谁在变更时维护 |
| --- | --- | --- |
| [架构总览](architecture/overview.md) | 组件和层级怎样支撑场景，数据和责任归谁 | 负责架构或接口变化的 session |
| [项目数据与 Connector](architecture/project-data.md) | 任务、需求文档与 Wiki 如何关联，飞书如何接入 | 产品、架构与集成责任者 |
| [知识关联](architecture/knowledge-flow.md) | Task、需求、Git 规范如何进入 Wiki，纠正怎样影响后续工作 | 认知与集成责任者 |
| [包架构](architecture/packages.md) | 四部分如何落到语言、包、接口、依赖与运行边界 | 架构及实现责任者 |
| [技术选型](architecture/technology-selection.md) | 推荐语言与核心技术、Wiki 基座/版本和有限改造边界 | 架构及选型责任者 |
| [接口与协作合同](architecture/contracts.md) | 任务、知识、会话如何交换，失败后怎样恢复 | 接口双方与整体验收负责人 |
| [存储逻辑](architecture/storage.md) | 表、固定版本、外键、事务、外置原件和恢复怎么设计 | 数据与架构责任者 |
| [Codex 接入](architecture/codex-integration.md) | 线程/轮次如何承接任务、回收和恢复，与桌面入口如何衔接 | 运行时适配责任者 |
| [前端架构](architecture/frontend.md) | 工作台技术、路由、查询/命令、会话衔接与部署边界 | 前端与核心接口责任者 |
| [Wiki 维护机制](architecture/wiki-maintenance.md) | 参考哪些编纂机制，如何形成候选、审阅发布和纠正旧认识 | 认知与知识集成责任者 |
| [Wiki 工作区架构](architecture/wiki-workspace.md) | 参考 nashsu 怎样做知识点、专题、双链、来源、图谱与 Review 前端 | Wiki 产品与前端责任者 |
| [Wiki 具体集成](architecture/wiki-integration.md) | 组件接缝、共同 API、OpenViking 能力映射、Task/Document/Git 读写怎样实现 | 前端、知识与核心接口责任者 |

### 开发与维护

| 文档 | 负责回答的问题 | 谁在变更时维护 |
| --- | --- | --- |
| [开发规范](development/standards.md) | 实际工作如何执行、验证、交接并改善 | 承担相应开发与方法维护工作的 session |
| [Agent skill 与 CLI](development/agent-cli.md) | Agent 根据人类沟通读取固定依据、执行业务变更、恢复并核对共同状态 | 使用 evoLoop 推进实际工作的 Agent；人类从工作台观察结果 |
| [文档维护](development/documentation.md) | 文档如何保持一致、生成 HTML 并发布 | 修改正文或构建工具的贡献者 |

这里的维护责任是工作分配，不要求项目第一天就建立同名常设角色。专门产品、架构或开发规范 session 是否出现，由实际任务与职责演进决定。

## 依据与状态

- [研究与探索](research/README.md)：统一收录候选调查、实验协议、两个 Wiki 的完整计划/结果/机制分析及基座改造建议。原验证目录已合并到这里，后续探索也使用此入口。
- [来源与演进](references/lineage.md)：觉察、工作台协作经历与本轮方向之间的关系，以及哪些旧方案被替换。
- [知识底座验证摘要](references/validation-summary.md)：OpenViking 与 nashsu/llm_wiki 的有限实测、缺口和下一步判据。
- [Wiki 功能与流程对比](references/wiki-feature-comparison.md)：两个固定版本的功能清单、分色流程图与接入 evoLoop 的边界。
- [Wiki 机制与有效性验证](references/wiki-effectiveness.md)：从两条原验证会话解释机制、反例和成立条件，提出统一对照、接力与真实使用测试。

**方向已定**表示用户已明确边界；**设计提议**表示当前有理由采用但尚未实现或验收的方案；**已验证**必须同时写出版本、样本与范围。具体能力阶段在阶段路线中汇总，其他文档引用它，避免多个当前状态相互矛盾。

## 怎样使用这套文档

首次了解产品按上面的完整理解路径；第一次建立架构理解按总览路径；已有上下文按任务选章节。使用产品推进工作时，Agent 从业务 skill＋CLI 接手，人从工作台观察和反馈；开发 evoLoop 本身时，Agent 先读根目录 [AGENTS](../AGENTS.md)，再按任务选择产品、架构或规范章节；需要依据时下钻引用，不必每轮加载全部历史。

Markdown 正文在 Git 中维护，`docs/site.json` 选择公开页面，`npm run docs:build` 生成同一份内容的 HTML。修改一个事实时先修改它的所属文档，再检查依赖它的内容。具体方法见[文档维护](development/documentation.md)。

认知 Wiki、原始 session 历史和运行数据位于独立知识空间或本地资料区。公开摘要标明证据边界；读者无需拥有本机私有文件才能理解当前产品与架构。
