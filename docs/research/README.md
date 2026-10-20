# 研究与探索

这里保存 evoLoop 的选型调查、机制分析、实验方案、实际结果和改造建议。**探索比验证更宽：我们既要判断一个方案是否有效，也要发现值得问什么、如何解释失败、下一步应该改变什么。** 原验证目录已归入这里，后续探索统一使用此入口。

研究报告是有日期、范围和依据的记录。当前正式约定仍由[产品定义](../product/definition.md)、[架构](../architecture/overview.md)、[开发规范](../development/standards.md)与[决定记录](../decisions.md)维护；持续认知 Wiki 和原始会话仍在开发仓库外。

## 产品文档与使用

| 研究 | 回答的问题 | 证据与状态 |
| --- | --- | --- |
| [产品文档评估与改进建议](product-docs-evaluation-20261020.md) | 当前文档能否帮助理解产品、选择下一步并形成可验收任务？应怎样调整内容层级与颗粒度？ | 保留固定基线初评与修复复测；新增分阶段理解、独立页面/交互推导及浏览器阅读检查，非真人或运行产品验收 |

## 认知 Wiki：先看综合判断，再下钻

| 文档 | 回答的问题 | 证据与状态 |
| --- | --- | --- |
| [基座选择与代码复用](wiki-base-selection-20261019.md) | 愿意修改源码后，更适合以哪个项目为基础？要接手哪些工作？ | 固定版本源码与已有实验；建议，未正式采用 |
| [完整功能与流程对比](../references/wiki-feature-comparison.md) | 两者提供什么能力，完整工作链怎样运行？ | 固定版文档/源码；六张分色流程图 |
| [机制与有效性](../references/wiki-effectiveness.md) | 为什么可能有效，什么条件下失效，该怎么测？ | 综合机制分析及下一轮测试设计；设计不等于已运行 |
| [首轮验证摘要](../references/validation-summary.md) | 已经实际运行了什么，哪些通过或失败？ | 八条需求重建合成材料；非真实历史规模评估 |
| [共同实验协议](wiki-validation-protocol-20261019.md) | 如何控制输入、独立消费与对照，怎样判结果？ | 当轮冻结协议及完成后的状态说明 |
| [nashsu 前端逐文件复用](nashsu-llm-wiki/frontend-reuse.md) | 哪些纯函数可评估直接复用，哪些组件/依赖须改造或排除？ | v0.6.12 锁文件及静态导入核查；未移植运行 |
| [工作台原型审阅](workbench-prototype-review.md) | 原型距离完整产品路径缺什么，哪些模拟交互已补，哪些仍未验证？ | 产品/架构逐项对照与原型检查；不替代真实服务与真人验收 |

两条研究会话的完整报告保留为独立证据链，不能只凭综合摘要替代它们：

| 候选与固定版本 | 计划与执行补记 | 结果与限制 | 接入分析 | 功能、机制与测试设计 | 架构与数据流程 |
| --- | --- | --- | --- | --- | --- |
| OpenViking 0.5.0 | [计划](openviking/plan.md) | [结果](openviking/results.md) | [接入](openviking/integration.md) | [完整研究](openviking/feature-workflows.md) | [架构图](openviking/architecture.md) |
| nashsu/llm_wiki v0.6.12 | [计划](nashsu-llm-wiki/plan.md) | [结果](nashsu-llm-wiki/results.md) | [接入](nashsu-llm-wiki/integration.md) | [完整研究](nashsu-llm-wiki/feature-workflows.md) | [架构图](nashsu-llm-wiki/architecture.md) |

本次公开整理保留实验事实、模型差异、失败和未测项，没有重新运行模型实验。原始日志、消费产物、实验 Wiki 与运行环境继续外置；报告中的证据文件名用于定位保留记录，不代表这些原件已经公开，也不构成公开可完整复现的实验包。

## 运行时与协作接入

[Codex App Server 调查](codex-app-server-20261019.md)固定本机 `codex-cli 0.154.0` 的生成 schema，并核对官方协议。该原调查实际只运行版本、schema 与初始化握手，未验证真实任务、模型执行、桌面聊天互通或定时恢复。后续独立 [PR #2 的固定提交](https://github.com/cyl19970726/evoLoop/pull/2/commits/9c095fce1eee68b3fbd87bfdbd053a0ca58dc195)验证了自管线程的隔离夹具闭环和桌面宿主通知消费；它不证明真实项目任务接通、现有桌面聊天互控或生产恢复。当前阶段另见[路线](../roadmap.md#当前基线)，实现提议见[接入架构](../architecture/codex-integration.md)，代码责任见[包架构](../architecture/packages.md)。

## 早期候选与其他探索

| 研究 | 范围 | 怎样使用 |
| --- | --- | --- |
| [LLM Wiki 候选调查](llm-wiki-candidates-direct-20261019.md) | 直接采用 LLM Wiki 思路的多个项目、部署与接口 | 作为候选发现记录；两个入选项目以后续固定版实测与修正为准 |
| [知识后端调查](knowledge-backends-20261019.md) | Graphiti、Cognee、LightRAG 与 OpenViking 的不同边界 | 理解图、检索、记忆与持续知识页维护的差别 |
| [TencentDB-Agent-Memory 核查](tencent-wiki-20261019.md) | 指定提交的增量编译、来源、写页与部署边界 | 静态源码研究，未运行候选 |
| [任务表后端调查](task-backends-20261018.md) | 飞书多维表格与 Notion 的接口、事件及竞态 | 飞书仍为首个协作入口；主数据改归 evoLoop，connector 能力尚未验证 |

## 后续研究怎样加入

按问题建专题目录，简短调查也可以保留一篇带日期的报告。一个专题可包含 `plan.md`、`results.md`、`integration.md` 和机制分析；不要求为每个小问题制造四份文件。每份至少说明：

1. **问题与决定：** 希望弄清什么，答案会影响哪个产品目标或技术选择。
2. **范围与方法：** 日期、版本、输入、来源、对照、执行环境与必要限制。
3. **观察与解释：** 实际运行、源码推断、外部声明、假设分别标识；失败和相反证据保留。
4. **后续影响：** 建议改变什么、还有什么未知、用什么结果决定继续或放弃；标明是否已被采纳。

新报告链接到此索引，并登记到 `docs/site.json`。原始材料先留在独立实验空间，公开报告不包含凭据、私有端点、本机路径、真实会话原文或可编辑 Wiki 正文。被纠正的研究保留时间顺序并增加更正与后续引用，避免读者把早期假设当作当前结论。
