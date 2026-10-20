# 文档导航

本目录维护 evoLoop 当前采用的产品定义、目标架构、开发方法，以及可公开的研究与验证记录。阅读顺序是**为什么做 → 如何组成 → 怎样工作与验证 → 下一步**；需要了解判断怎样形成时，从[研究与探索](research/README.md)下钻。

## 第一次理解整个架构

从[架构总览](architecture/overview.md)连续读完“问题 → 系统组成 → 一轮工作 → 对象/权威 → 变化/失败 → 实现/状态”，先建立整体模型。总览第 2 节的[结构图](architecture/overview.md#2-四部分如何组成系统)先回答人、session、协调软件与外部权威怎样配合；第 3 节的工作回路再解释一次行动如何走到真实使用和下一步。需要查全部拟议模块、端口与关系时，从[包架构的模块索引](architecture/packages.md#完整模块索引)下钻。

随后按需要深入：[项目数据](architecture/project-data.md)解释对象为何分开，[知识流](architecture/knowledge-flow.md)解释认识如何进入并改变任务，[包架构](architecture/packages.md)把逻辑责任落到拟议运行与源码。查字段、表或具体服务时再进入合同、存储、选型和专题页。不要把所有技术参考当作首读前置条件。

需要先了解用户目标时读[产品定义](product/definition.md)；需要判断当前能做什么时读[阶段路线](roadmap.md)。理解系统后，贡献者仍按具体任务查所属正文。

## 当前正式文档

| 文档 | 负责回答的问题 | 谁在变更时维护 |
| --- | --- | --- |
| [产品定义](product/definition.md) | 用户要去哪里，哪些场景值得做，什么体验算成功 | 负责该产品变化的 session |
| [项目工作台](product/workbench.md) | 每天讨论什么、页面怎样组织、怎样查看依据并复核变化 | 产品与前端责任者 |
| [Agent loop](product/agent-loop.md) | 认知怎样推动下一步，分工怎样演进，任务怎样可靠接续 | 负责行为及协作变化的 session |
| [Wiki 建设与评价](product/wiki-evaluation.md) | 怎样积累、修订和使用认识，怎样判断它是否有效 | 认知维护与相应验证的责任者 |
| [Dogfood 与日常工作](product/daily-loop.md) | 发现如何进入任务、需求谁判断、日常讨论和定时工作怎样接续 | 对应领域与整体协调责任者 |
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
| [开发规范](development/standards.md) | 实际工作如何执行、验证、交接并改善 | 承担相应开发与方法维护工作的 session |
| [文档维护](development/documentation.md) | 文档如何保持一致、生成 HTML 并发布 | 修改正文或构建工具的贡献者 |
| [决定记录](decisions.md) | 哪些是已确定方向，哪些是设计提议与待验证选择 | 作出或接收决定的责任者 |
| [阶段路线](roadmap.md) | 当前在哪，下一阶段交付什么、需要学到什么 | 当前阶段的整体验收负责人 |

这里的维护责任是工作分配，不要求项目第一天就建立同名常设角色。专门产品、架构或开发规范 session 是否出现，由实际任务与职责演进决定。

## 依据与状态

- [研究与探索](research/README.md)：统一收录候选调查、实验协议、两个 Wiki 的完整计划/结果/机制分析及基座改造建议。原验证目录已合并到这里，后续探索也使用此入口。
- [来源与演进](references/lineage.md)：觉察、工作台协作经历与本轮方向之间的关系，以及哪些旧方案被替换。
- [知识底座验证摘要](references/validation-summary.md)：OpenViking 与 nashsu/llm_wiki 的有限实测、缺口和下一步判据。
- [Wiki 功能与流程对比](references/wiki-feature-comparison.md)：两个固定版本的功能清单、分色流程图与接入 evoLoop 的边界。
- [Wiki 机制与有效性验证](references/wiki-effectiveness.md)：从两条原验证会话解释机制、反例和成立条件，提出统一对照、接力与真实使用测试。

**方向已定**表示用户已明确边界；**设计提议**表示当前有理由采用但尚未实现或验收的方案；**已验证**必须同时写出版本、样本与范围。具体能力阶段在阶段路线中汇总，其他文档引用它，避免多个当前状态相互矛盾。

## 怎样使用这套文档

第一次了解产品目标，先读产品定义与阶段路线；第一次建立架构理解，从本页的总览路径开始，产品与路线可在需要时核对。已有具体任务的贡献者先读根目录 [AGENTS](../AGENTS.md)，再选相关产品、架构或规范章节；三种入口按目的选择，不要求每轮加载全部历史。

Markdown 正文在 Git 中维护，`docs/site.json` 选择公开页面，`npm run docs:build` 生成同一份内容的 HTML。修改一个事实时先修改它的所属文档，再检查依赖它的内容。具体方法见[文档维护](development/documentation.md)。

认知 Wiki、原始 session 历史和运行数据位于独立知识空间或本地资料区。公开摘要标明证据边界；读者无需拥有本机私有文件才能理解当前产品与架构。
