# OpenViking 隔离验证计划

> 状态：研究记录，非正式选型；公开整理版 2026-10-19；原始运行证据外置未发布；未重新运行实验。阶段：隔离验证计划与当时的完成补记。

2026-10-19；状态：本轮完成。来源为共同协议 v1；样本是需求重建的合成材料，不是历史审计。只拥有本候选目录。

本页保留当时的计划与执行记录。共同验证方法见[协议](../wiki-validation-protocol-20261019.md)，最终观察和后续核查分别见[结果](results.md)、[接入判断](integration.md)与[功能及流程](feature-workflows.md)；面向正式决策的证据边界见[验证摘要](../../references/validation-summary.md)。以下 `evidence/`、`runs/` 等名称均为未发布的外置原始证据标识，不是公开文件链接。

## 固定范围与验收

- 外置隔离实验空间：checkout、venv、配置、AGFS 内容、索引、日志、消费者产物和备份全部保存在开发仓库之外；具体个人设备路径不公开。
- 正式报告：本目录的 plan/results/integration；不存认知正文。
- 共同包三文件的 SHA256 与长度已校验，记录 `evidence/manifest-check.json`。按 batch 1→2→3 输入；evaluator 不入库，也不交消费者。
- 固定源码 commit、Python/平台及实际依赖版本；优先实际源码配套的本地服务 + 官方 Wiki compile Skill。接口、运行时和模型以源码为准，运行前补充本页。
- 安全复用现有进程环境配置；只记录变量名和模型名，不复制/打印密钥。没有真实模型调用便标阻塞，不使用 mock。

## 步骤

1. 核官方 compile/runtime/API/存储，隔离安装，服务绑定本机独占端口；留启动/依赖证据。
2. 注册官方 llm-wiki Skill 到本地实例，batch 1 编译并冻结；batch 2 增量编译并冻结；batch 3 同样处理。记录官方 Skill 与原生 API 各自责任。
3. V1 用户纠正、V2 冲突、V3 同基线双写与重试、V4 副本撤回 S05、V7 新位置恢复、V8 人类阅读纠错路径。缺失能力照实判未提供。
4. 无历史继承 consumer 仅给 T1/T2/T3 与正常知识入口；对照者仅给相同任务和原材料。交付可检查 Markdown，保留首次结果、模型/耗时和操作记录。不能把构建上下文答案计作独立消费。
5. 冻结原生结果后，只为关键缺口作一个有限适配，保留独立成绩；交接集成建议。

## 判定与证据

每例记录通过/失败/未提供/阻塞/未验证，分别标原生机制、官方 Skill、额外适配和人工操作。源码推断与实测分开。核心门槛为纠正采用与可追溯、冲突不武断裁决、并发不静默丢失、撤回影响可发现、真实消费、可恢复。报告不足以代表实际使用；本实验不部署业务、不创建真实飞书表。

## 初始能力假设（待核验）

预计编译与读写由产品+官方 Skill 覆盖；页级 CAS、逐主张依赖和撤回传播可能缺失。不能以 path lock 或 compile 请求去重代替并发修订保护。

## 执行固定值与进展

- 运行版本：PyPI 0.5.0，标签 `20f9c11362ad16193b0daa4a414e1095061af427`。主分支 `27db441230f451380d03084322d1fde31e4357cb` 只作差异核查；其 CAS 改进不计入本版原生成绩。
- REST `http://127.0.0.1:19331`；VikingBot `19332`；CLI/配置在外置 `config`；存储外置 `data`。源码 checkout 已切标签匹配 wheel。
- 模型：`deepseek-chat`（响应 `deepseek-flash`），配置温度0、生成上限12000、VLM并发2；嵌入 `doubao-embedding-vision-251215` 1024维。环境变量插值复用，未写入密钥。配置值是否传到模型请求，应按具体 adapter 核验。
- 官方 llm-wiki Skill 原样以 API 注册 `viking://agent/skills/llm-wiki`，只在本测试实例发现；未安装全局 Skill/MCP。
- 首轮和订阅正式轮batch 1/2/3均已逐批冻结。V3 普通覆盖已复现丢更新、基线字段拒绝；compile 去重同 key 相同请求返回原任务，改参数409。
- 原计划的stateless DeepSeek消费API在正式读取前余额不足，没有模型产物；有效消费改用无历史继承的子Agent，仅给任务和正常REST入口，原材料对照只给共同events，不含构建过程/评价规则。保留首组GPT-6 Sol medium；正式跨候选对齐组为GPT-6.1 Sol medium。
- raw 对照曾因调用时机错误在第三批前启动，已中止，无产物；不是有效模型首轮。加批次完成前提检查，保留失败日志，不改变提示词。

## 用户纠偏后的统一模型轮次

用户指出应优先复用 ChatGPT，且两 Wiki 的模型应类似，避免混淆模型与后端效果。已实测发行版原生 `openai-codex` provider 调用成功：`gpt-6-sol` / medium。现有 Codex OAuth access token 仅在内存读取并传给原生 provider，不复制 auth store、不改全局登录。

新增独立轮次 `runs/chatgpt/`（证据/日志）与 `chatgpt-data/`（知识/索引）。从 batch1 重新开始，保留 DeepSeek 初轮冻结结果。首组消费者和原材料对照为无继承 GPT-6 Sol medium，正式对齐组均为GPT-6.1 Sol medium，与另一候选记录的消费配置一致。嵌入仍为同一个 Doubao 1024维模型。生成阶段仍有GPT-6 Sol与GPT-6.1 Sol的小版本差异，本会话未改另一候选；该差异单列，不能作纯后端质量归因。

恢复实验先记录 dev 模式下原生 OVPack backup/export 均403（需要 api_key模式）；改用停服冷备完整 data 到新目录，再启动读取，明确属于人工运维层，不冒称原生导出通过。

统一轮次的 batch3 使用产品原生 `content/batch-write` 一次提交同批五文件，正文不变，仍等待语义/向量处理完成后 compile；避免每个文件分别触发同一父目录摘要。该接口选择属于原生操作路径，不是额外知识提示词。

## 完成记录

- V1/V2原生与官方Skill实测通过；V3原生静默丢更新，有限适配另列；V4删除后显式维护可修订，非自动传播。
- 正式三批生成、独立Wiki消费/原材料对照和新位置恢复后独立T1均完成，首次产物保留。Wiki T1遗漏Markdown许可，V6未单列交接成本观察，按共同rubric部分通过。
- Studio阅读、相对链接、测试副本纠错通过，来源绝对链接跳转存在缺口；无人类亲用证据。冷备可恢复，受认证OVPack完整流程未完成。
- 最终限制和判定见results.md；接入职责与版本约束见integration.md。服务及凭据收尾证据为外置evidence/closeout.json。

## 公开整理补记（不改写当时实验）

上述温度0与生成上限12000是当时配置记录。后续固定源码核查发现，0.5.0 的 Codex Responses adapter 未把 `temperature` 与 `max_tokens`／`max_completion_tokens` 透传给 Responses 请求；因此订阅模型轮次不能宣称生成端已按这两个值受控，`reasoning_effort=medium` 则有运行对象与源码依据。详见[功能及流程的配置核对](feature-workflows.md#5-studiovikingbot模型网关是不同组件)。

V7 的“恢复通过”指停服复制数据目录后从新位置读取；它是人工冷备验证，**不是原生 OVPack 导出／恢复通过**。原生 OVPack 在当时的 dev／ROOT 身份试验中受权限阻断，见[结果](results.md#v1v8-首轮冻结结果)。
