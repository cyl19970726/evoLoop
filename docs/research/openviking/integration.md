# OpenViking 接入判断与约束

> 状态：研究记录，非正式选型；公开整理版 2026-10-19；原始运行证据外置未发布；未重新运行实验。阶段：固定版试点接入判断，不表示已接入 evoLoop。

2026-10-19。验证结论：** 可作为受限试点的知识底座，尚不适合按 0.5.0 默认写入方式允许多个维护者并发发布**。独立消费能交付实际方案，但有约束遗漏，小样本未显示优于直接读材料。认知正文在独立空间，飞书仍是任务权威。

本页是实验后的接入提议，非产品采用决定。实验范围与实测数据见[计划](plan.md)、[结果](results.md)；未运行的固定版能力见[功能及流程](feature-workflows.md)；共同门槛与跨候选边界见[验证协议](../wiki-validation-protocol-20261019.md)和[验证摘要](../../references/validation-summary.md)。下文 `evidence/`、`scripts/`、`runs/` 等均为未发布外置证据标识，不是公开链接。

## 角色与最短接口路径

| 使用者 | 贡献/读取方式 | 限制 |
| --- | --- | --- |
| 业务 session | `POST /api/v1/content/write` 提交带 Sxx/观察/假设/来源的资源，或 session messages→commit 归档；读取相关 Wiki 后负责本领域修复 | 不把“写进服务”当成认识已经正确；不让写者直接并发 replace 当前页 |
| Wiki 维护 session | 读 index/页/来源后 `POST /api/v1/compile` + 官方 llm-wiki Skill，检查任务结果、失效来源和更新差异 | 官方 Skill 负责语义综合；不是所有业务判断的审批门。0.5.0 串行发布并留外置快照 |
| 新 session | fs/ls、content/read，必要时 find/grep，下钻来源并引用已读页/来源 | 不能只展示搜索命中；须完成实际产物，并记录知识如何改变动作 |
| 分工管理 session | 读容量、交接、使用反馈和角色效果的知识页，按真实证据提出飞书试行任务 | 积压不自动等于新角色；写出收益、交接成本、回看和退出条件 |
| 人类维护者 | Studio 文件系统读/编辑；API 内容可导出给阅读入口 | 实测来源绝对 viking 链接在 Studio 预览中 href 为空，需手动树导航；不得据 Agent 操作宣称用户满意 |

任务状态只在飞书；仓库 docs 保存正式产品、架构、规范及此类验证报告。Wiki 用稳定 URI 回指来源和正式文档，正式文档可引用 Wiki 指定版本的发布快照，不建立第二份任务数据库。本实验没有创建真实飞书表。

## 模型与配置

0.5.0 已实测原生 CodexVLM 支持现有 ChatGPT/Codex 订阅认证，可不另购生成模型 API key。验证用原登录的 access token 仅在内存传给原生 provider；不复制 auth store，不更改全局登录。官方自动 bootstrap 会另存登录文件，未使用该复制路径。

生成模型统一轮次为 `gpt-6-sol`，`reasoning_effort=medium`，配置层设温度0；VikingBot 必须继承完整 root vlm，不能再单独设置 bot.agents.model，否则本版会丢掉 reasoning_effort。实际对象核验见外置 `evidence/runtime-profile-verified.json`。后续源码核查发现 0.5.0 Codex Responses adapter 未透传 `temperature` 和 `max_tokens`／`max_completion_tokens`，故温度0和生成上限不能算模型端已生效条件；medium 的转发有[固定版源码](https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/openviking/models/vlm/backends/codex_responses_adapter.py)与运行对象依据。嵌入是单独依赖，本轮为 Doubao 1024维，复用已有 ARK 环境变量。

另一候选当前正式记录的外部维护/消费为 GPT-6.1 Sol medium，故本候选正式 fresh consumer/直接材料对照已同用 GPT-6.1 Sol medium，均完成三份实际产物。原生编译 GPT-6 Sol 与外部维护 GPT-6.1 Sol 的小版本差异、产品原生/外部 Agent 的机制差异须单列，不能据此作纯后端准确率归因。早期 DeepSeek 结果及余额不足首轮保留。

## 必须补齐或限制的部分

- 0.5.0 `write replace` 可静默覆盖；batch-write 拒绝 expected_sha256，compile 去重只防同请求重复提交。当前 main 已加入批量基线和新编译冲突处理，建议固定新版后针对同页竞争重测，不能直接把源码改进当成通过。
- 来源撤回不会自动让 Wiki 引用失效。删除后 grep 能按字符串找到候选受影响页，官方重新 compile 能修订；依赖是文本引用，不是完整反向依赖/主张状态系统。
- 当前页文本能保存“已被取代/待证实”等状态；本轮未调用产品[原生显式 snapshot](https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/docs/en/api/11-snapshot.md)，也未证明普通 Wiki 写入自动留版。外置批次快照是实验者留存，不记产品原生修订；“未实测自动留版”不等于“产品没有历史能力”。
- 生产接入需限定服务身份、访问边界、模型调用上限及备份责任。本实验只本机 loopback，不证明多租户安全或公网部署可用。

## 唯一有限适配

外置 `scripts/guarded_write.py` 约60行：单机项目锁、读后 hash 比较、写前快照、operation_id 记录与响应丢失后回读。真实同基线两写者试验一者成功一者 stale，真实写入后主动丢响应可回读恢复，重复操作被识别。

这只是补齐一个关键缺口的验证。所有写者须经过它；直接 API、Studio 和原生 Compile 都能绕过，故不能作为生产级服务端 CAS，也不能把此成绩回填原生 V3。维护责任及复杂度比固定并验证已加入原生基线检查的新版更高。

## 恢复与尚未验证

停服复制整个 data 到新目录后，16页+8来源正文逐字一致，会话原文、官方 Skill、争议与旧提案状态可读。另一个无历史继承的GPT-6.1 Sol medium会话已从恢复入口完成T1（12次读取、0失败、56.049秒），主要安排齐全但漏写Markdown许可；恢复可用与消费质量分开记录。属于人工冷备操作；原生 OVPack 在 dev 模式403，需要 admin 用户认证。一次只配 ROOT 的实验也被拒绝数据访问，已停止该配置路线，不声称原生导出恢复通过。账号/API keys 不在官方 OVPack 备份范围内；来源主张级状态原本不存在，恢复不会凭空增加。

尚未完成用户实际亲用、真实历史规模成本、跨机器/多写者运行、新 main 的并发 CAS 和受认证 OVPack 全链路。本轮结论不能替代这些验收。

## 交付与复现入口

隔离实验根位于开发仓库外，个人设备路径不公开。固定包版本与依赖的外置证据标识为`evidence/version.json`和`evidence/dependencies.txt`，正式轮配置标识为`config/chatgpt.conf`，实际配置对象检查标识为`evidence/runtime-profile-verified.json`；配置仅含环境变量引用。使用外置venv与`scripts/launch_chatgpt.py`启动本机实例，脚本从现有Codex登录在内存传递认证，仍需可用的已有嵌入额度。默认effort试跑与DeepSeek结果分别保留，不能混入正式轮。

输入转换、批次提交/冻结见`scripts/setup_and_batch.py`、`freeze_batch.py`与`runs/chatgpt/`日志；恢复、撤回、并发实验各有独立脚本及JSON证据。正式消费产物和逐次读取记录在`consumers/wiki-aligned/`、`raw-aligned/`、`restored-aligned/`。复现时使用新数据路径与空闲端口，保留原冻结树；本次已停止服务，未接入真实飞书任务或生产业务。
