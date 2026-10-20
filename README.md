# evoLoop

**让项目从真实工作中形成认识，用认识推动下一步，再用实际效果改进产品、方法和 Agent 分工。**

evoLoop 面向一个人和多个 Agent session 共同推进的项目。它连接阶段目标、工作材料、独立认知 Wiki、任务与交接，让每个领域都能发现问题、负责修复，并根据证据逐渐形成适合项目的协作结构。

产品沿**认知演进、协作执行**两个维度展开，由四部分共同支撑：**认知循环、动态多 session、任务与状态机、外置 LLM Wiki 与有效性评价**。认知循环产生有依据的下一步，协作机制将它落实，实际使用结果再修订认识。

当前处于**产品与架构定义、知识底座验证阶段**。仓库提供正式文档与静态文档构建工具；业务 harness、飞书适配器及生产知识服务尚未实现或部署。候选系统的有限实测不等于整个产品已经可用。

## 从这里开始

| 你想了解什么 | 文档 |
| --- | --- |
| 现在可以体验什么，这一轮先做多小 | [当前阶段](docs/roadmap.md#当前基线) · [当前阶段的一个小任务](docs/roadmap.md#当前阶段的一个小任务) |
| 产品是什么、解决谁的什么问题、如何验收 | [产品定义](docs/product/definition.md) |
| 已有具体问题，最少应读哪些章节 | [按眼前任务进入](docs/README.md#按眼前任务进入) |
| 工作台怎样帮助查依据、作决定和看后果 | [项目工作台](docs/product/workbench.md) |
| 四部分怎样共同推动下一步、何时继续或停止 | [Agent loop](docs/product/agent-loop.md) |
| 认识怎样进入 Wiki、被使用及证明有效 | [Wiki 建设与有效性评价](docs/product/wiki-evaluation.md) |
| Dogfood、新需求、日常讨论和定时工作如何接续 | [日常工作闭环](docs/product/daily-loop.md) |
| 包怎样分层，怎样集成 Codex | [包架构](docs/architecture/packages.md) · [Codex 接入](docs/architecture/codex-integration.md) |
| 选择什么语言与核心技术，集成或修改哪个 Wiki | [技术选型与 Wiki 改造](docs/architecture/technology-selection.md) |
| 任务、需求文档、Wiki 和外部平台怎样连起来 | [项目数据与 Connector](docs/architecture/project-data.md) |
| 层级、组件、数据归属和失败恢复 | [架构总览](docs/architecture/overview.md) |
| 任务、会话、知识和交接的最小接口语义 | [接口与协作合同](docs/architecture/contracts.md) |
| 如何开展开发、验证和文档维护 | [开发规范](docs/development/standards.md) · [文档维护](docs/development/documentation.md) |
| 哪些方向已确定、哪些仍需验证 | [决定记录](docs/decisions.md) · [阶段路线](docs/roadmap.md) |
| 与觉察的关系、知识底座试验结果 | [来源与演进](docs/references/lineage.md) · [验证摘要](docs/references/validation-summary.md) |
| 选型探索、实验方法、完整结果与改造建议 | [研究与探索](docs/research/README.md) |

完整导航见 [docs](docs/README.md)。开始贡献请读 [CONTRIBUTING](CONTRIBUTING.md)；Agent 的项目入口为 [AGENTS](AGENTS.md)。

## 当前边界

- **分工随项目演进。** 从实际工作、成果和使用反馈判断是否增加、合并或撤回角色；同职责换会话不等于新角色。
- **各领域都形成和使用认识。** 业务 session 可以发现并解决问题；专门认知 session 综合认识、推动下一阶段并承担初期 Wiki 维护，分工管理者评估职责安排。
- **evoLoop 管理主数据，飞书提供协作入口。** PostgreSQL 保存任务、日程、原生需求文档及关系；connector 映射外部视图和受控编辑，Wiki 与 Git 正文仍各有权威。
- **认知保存在开发仓库外。** 独立 Markdown vault 或知识服务都可；仓库保存代码、正式产品/架构/规范、接入配置和可公开的研究报告。
- **阶段结束要实际使用。** 看交付是否有效、哪些判断需要改、下一阶段为什么值得做。

## 阅读 HTML 文档

使用 Node.js 22 或更新的受支持版本，在仓库根目录运行：

```bash
npm ci
npm run docs:check
npm run docs:build
```

打开生成的 `site/index.html`，即可离线阅读。Markdown 是正文来源，HTML 是可重建视图；生成目录不提交。发布内容由 `docs/site.json` 显式列出，可发布文档默认公开。项目子域名、托管与自动发布仍待实施。

仓库地址：[cyl19970726/evoLoop](https://github.com/cyl19970726/evoLoop)。本地历史归档、实验知识库、凭据与运行日志不属于公开仓库内容。
