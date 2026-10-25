# 贡献指南

evoLoop 当前包含正式文档、隔离实验和本机试用切片；当前能力与验证范围见[阶段路线](docs/roadmap.md#当前基线)，运行入口见[本机运行](docs/development/local-run.md)。先按本次任务选入口，再执行下面的变更流程；不要求每次通读全部设计或历史。

## 按任务选择入口

| 本次任务 | 最少阅读 | 何时再下钻 |
| --- | --- | --- |
| 通过 evoLoop Task 承接工作 | 固定 Task/context 与项目内 `.agents/skills/evoloop-workflow/SKILL.md`；写任务时加读其 `references/writing.md` | 再按下列工作类型选工程入口；普通静态 Run 与 Loop worker 按实际身份分流，不能只因有 wrapper 就提交 worker 意图。 |
| 项目 skill、任务表达或开发流程改进 | `.agents/skills/development-workflow/SKILL.md`、相关规范与真实工作样本 | 用实际消费检验改法；普通功能修复不自动触发整套规范重建。 |
| 文字、链接、导航或研究报告维护 | 目标正文及[文档维护](docs/development/documentation.md) | 改变含义时读所属正式正文；新增研究时读研究入口；不加载无关后端测试清单。 |
| 产品目标、体验或架构修订 | 受影响的产品/架构正文、[决定记录](docs/decisions.md)及[文档维护](docs/development/documentation.md) | 从引用追到相关研究；改接口时核对双方与对应验收。 |
| 文档构建工具或原型行为修改 | 相关脚本/资产、现有测试、[开发规范的检查分层](docs/development/standards.md#按变更选择检查) | 只读受影响的产品路径；图、布局或交互变化按文档维护做浏览器检查。 |
| 业务实现、运行时或 connector 接入 | 对应产品目标、相关架构合同及[业务实现入口](docs/development/standards.md#开始业务实现时) | 确认尚未采纳的技术选择，再读该组件的验收项；隔离实验不等于生产实现。 |

更多页面从[文档导航](docs/README.md)查找。当前规则的证据、适用范围与交付口径集中在[开发规范](docs/development/standards.md)。

## 提出与完成变更

1. **定目标与范围。** 在当前任务或 PR 写明问题、希望改变的结果、当前责任、负责文件和可观察验收；让接手者知道第一步及交付给谁。已有 evoLoop Task 就承接其固定输入，PR 引用该 Task，不再维护一份可冲突的任务正文；未接服务的工作仍可用当前任务或 PR 承接。小修可直接准备差异；多步骤工作留简短计划与当前进度。按可独立验收的用户路径或故障边界拆 PR，不按行数或包数机械拆分。
2. **核现场再修改。** 确认当前基线和已有改动，读取上表所选正文、相关代码与证据。领域 session 可完成授权内修复；多人并行时先明确文件所有权，具体边界见[协作规则](docs/development/standards.md#多-session-协作)。
3. **实现并同步。** 行为修复在可行时先保留失败复现，再补能检验失效的回归检查。改一个事实先改唯一正文，再改受影响引用；文档分类、过程结论纳入正式正文和公开边界见[文档维护](docs/development/documentation.md)。
4. **按范围验证。** 使用[检查分层](docs/development/standards.md#按变更选择检查)，文档具体命令只在[文档检查与构建](docs/development/documentation.md#文档检查与构建)维护。检查失败先解决或说明阻断，不以未运行的未来验收冒充通过。
5. **经 PR 审阅和合入。** 共享 `main` 的功能与维护改动从 topic branch 提交聚焦 PR，附目标、实际检查、未验证项及 head/base；按[共享主分支与审阅](docs/development/standards.md#共享主分支与审阅)核当前 head 的 CI 和独立审阅，head 改变时复核受影响差异。不要直接推送、强推或删除 `main`；紧急例外须先有具体授权并记录理由、影响和恢复。尚未提交的小修也须有清楚的差异与检查结果。
6. **回读交付结果。** 合入后核对 merge commit、`main` 对应检查及实际部署或试用环境版本；按[证据与交付](docs/development/standards.md#证据与交付)报告已完成、未知项和下一步。任务验收、合入、构建与部署分别记录。

项目专用技能的位置和安装边界见 [AGENTS.md](AGENTS.md)，不因完成任务而自动扩大安装范围。
