# OpenViking 验证结果

> 状态：研究记录，非正式选型；公开整理版 2026-10-19；原始运行证据外置未发布；未重新运行实验。阶段：固定版隔离运行结果。

2026-10-19，隔离验证已完成。首轮、订阅模型重跑、同模型独立消费与原始材料对照、恢复后独立消费均有实际产物。结论限于共同合成样本。

输入与判定依照[共同协议](../wiki-validation-protocol-20261019.md)。本页保留完整观察，计划、接入限制与固定版功能核查分别见[计划](plan.md)、[接入判断](integration.md)、[功能及流程](feature-workflows.md)；跨候选归纳见[验证摘要](../../references/validation-summary.md)。文中 `evidence/`、`runs/`、`consumers/` 等为未发布的外置原始证据标识，供内部复核定位，不是公开链接。

**已证明它会把资源和归档会话编译为独立、持久的 Wiki，并能采用用户纠正、保留未决解释。0.5.0 的普通页写入可静默丢更新；来源删除不会自动失效 Wiki。当前结论是受限串行试点，不能直接开放多维护者并发发布。**

## 固定版本与输入

- 实际运行：PyPI `openviking[bot]==0.5.0`，标签 `20f9c11362ad16193b0daa4a414e1095061af427`。Darwin arm64 / Python 3.11.11。源码、venv、配置、内容、索引、日志和备份均在开发仓库外的隔离实验空间；个人设备路径不公开。
- 共同包三文件 SHA256/长度 3/3 校验通过；events hash `5ff9caeeca6391a69b608c43fcf746f55fa6fdeff6f9e317080858e6c426cc3c`。按1→2→3实际摄入，evaluator未入库，也未交消费者。全部来源为需求重建合成样本。
- 服务仅绑定本机 `19331/19332`，恢复副本使用 `19341/19342`。验收后停止全部临时服务，不部署公网。正式文档之外，未将认知正文写入开发 repo。

## 模型与实现层

| 轮次 | 生成/消费模型 | 用途与限制 |
| --- | --- | --- |
| 发行版原生首轮 | `deepseek-chat`，响应 `deepseek-flash`；温度0 | 原样官方 Skill、三批编译、冻结结果；之后余额不足，消费API首轮无模型响应 |
| 订阅接入探测 | 原生 CodexVLM，响应 `gpt-6-sol` | 已有 ChatGPT/Codex OAuth只在内存复用，未复制登录文件/密钥 |
| 订阅默认 effort 试跑 | GPT-6 Sol，effort未显式生效 | 单独保留，未计统一模型轮次；发现 bot独立model配置丢根reasoning设置 |
| 正式统一轮次 | GPT-6 Sol / medium | 已核实际CodexVLM运行对象，bot继承完整根配置；三批原生重跑完成，最终5页 |
| 首组独立消费/直接材料对照 | 两者均 GPT-6 Sol / medium | 无历史继承子Agent，已完成六个产物；Wiki由DeepSeek构建，模型差异单列 |
| 跨候选对齐消费/对照 | 两者均 GPT-6.1 Sol / medium | 与另一候选已记录的消费配置对齐，三份产物均完成 |

嵌入独立使用 `doubao-embedding-vision-251215`，1024维。官方示例Doubao生成模型返回403 AccountOverdueError；不是ChatGPT余额不足。官方支持订阅与API key两种Codex登录方式：[OpenAI认证](https://learn.chatgpt.com/docs/auth)。OpenViking原生接入见[固定版本源码](https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/openviking/models/vlm/backends/codex_vlm.py)。

**原生机制**：存储、REST、队列、归档、Compile运行时、Studio。**官方Skill**：主题整合、引用、时间变化和争议保留。**自写适配**：实验的输入/证据封装、有限写入保护；不填知识答案。**人工操作**：触发批次、审阅、冷备与UI检查。不能把后三者的效果算作数据库强保证。

## V1—V8 首轮冻结结果

| 案例 | 判定 | 实际结果及关键证据（均在外置根） |
| --- | --- | --- |
| V1 纠正旧知识 | 通过：原生+官方Skill | batch1旧方案标未确认；batch2/3现行规则改为独立空间，旧提案明确已否决/被取代，保留S01/S02。`evidence/native-batch-1`、`native-batch-2`、`native-batch-3` |
| V2 不同解释 | 通过：官方Skill | E17页同时保留S05投递猜测、S06接收/唤醒猜测，未按后写入定真，指出两者并非互斥，分析页给出取证方向。`native-batch-3/entity/交接事件 E17.md`、`analysis/交接事件 E17 的归因分歧.md` |
| V3 同基线双写/重试 | 失败：原生页并发；提交去重通过 | A/B读同一hash，均200，最终仅B内容；batch-write正确路径拒绝expected_sha256（400）。重复append出现两份。Compile同key恢复到同任务，参数改变409；不保证页级旧基线。`V3-native.json`、`V3-CAS-correct-route.json`、`V3-compile-retry.json` |
| V4 撤回来源 | 部分通过：需触发维护 | 恢复副本删除S05，API200且读源404；依赖页立即不变，memory_cleanup=no_references。grep可找到词面引用；再用原样官方Skill+同一通用instruction compile，七页变化，所有S05精确链接消失，E17不再断言发送侧事实，也未把S06判真。`V4-native-delete.json`、`V4-review.json`、`V4-after-recompile` |
| V5 新上下文完成任务 | 正式对齐轮次部分通过 | Wiki入口14次HTTP操作、失败0次，94.651秒完成T1/T2/T3；原始材料对照1次读取2773字节、82.784秒完成三份。Wiki T1遗漏“允许Markdown”，对照明确写出；其余主要约束、来源、使用反馈与下一步安排齐全。T2通过。见`consumers/wiki-aligned`、`raw-aligned` |
| V6 容量与新职责 | 部分通过 | 正式Wiki消费者区分A的容量/工具限制与B的持续观察责任，提出替代办法、收益、回看和退出，并比较协调负担；未把交接成本单独落实为可观察安排。按共同rubric保守记部分通过，不要求来源未规定的数值阈值。见`consumers/wiki-aligned/role-proposal.md` |
| V7 新位置恢复 | 冷备恢复通过；消费有约束遗漏；OVPack未完成 | 停服冷备整个data到新路径后，16页+8来源逐字一致，归档S04和原存储Skill一致，争议/取代状态可读。另一个无历史GPT-6.1 Sol medium消费者从恢复入口完成T1，12次操作、失败0次、56.049秒；同样遗漏Markdown许可，不能据恢复成功判任务满分。原生backup/export的dev/ROOT认证实验403，未完成原生打包恢复。`V7-cold-backup.json`、`V7-restored-read.json`、`V7-native-pack-roundtrip.json`、`consumers/restored-aligned/` |
| V8 人阅读追溯纠错 | 部分通过：原生UI | Studio树→index→认识页可读；知识页相对链接可跳转，但绝对viking来源链接href为空，不能一键追S02。测试副本编辑保存后API读回纠错标记。人类参与0，未测用户主动用时/满意度。`V8-ui.json`、`studio-read.png`、`studio-edit-saved.png` |

V4维护使用GPT-6 Sol默认effort处理DeepSeek构建的恢复树，因此只证明该维护路径可运行，不作同模型质量归因。V3最初误写下划线接口得到404，已纠正为真实`/content/batch-write`后400，保留两次证据。

## 正式订阅轮次与独立消费

三批均使用原样官方Skill及同一句通用instruction，GPT-6 Sol / medium，配置层设温度0；bot继承根配置已核实。后续固定版源码核查发现 Codex Responses adapter **未透传 temperature 与 max_tokens／max_completion_tokens**，故不能宣称模型端温度0或输出上限已生效；medium 有运行对象和源码依据。终态用时60.207/90.626/90.659秒，产出2/3/5页、1,387/4,442/9,607字节。Compile实际运行49.6/82.2/83.0秒，总输入127,748、输出7,056 tokens，不含来源语义处理和嵌入。证据为`runs/chatgpt/evidence/metrics.json`及各批快照；[固定版 adapter 源码](https://github.com/volcengine/OpenViking/blob/20f9c11362ad16193b0daa4a414e1095061af427/openviking/models/vlm/backends/codex_responses_adapter.py)。

正式消费者与原材料对照同为GPT-6.1 Sol / medium，均无历史继承，未给rubric。Wiki只通过正常REST读取，原材料对照只读共同events；交付各三份可检查产物，未由构建者补答案。T1中Wiki遗漏Markdown许可；T2保留两个解释，提出区分发送/投递/接收/唤醒/消费的证据及反证条件；T3有协调成本讨论，但未单列交接成本观察，保守记部分通过。恢复后另一名独立消费者读取DeepSeek冷备树，T1主要安排可用，但也遗漏Markdown许可。完整首次结果保留，未为通过而改提示词重跑。

对照在这个8条材料的小样本上更快且约束更完整，未显示Wiki的信息获取优势。每条件仅一次正式消费，不能从约12秒差值推断统计优势。另一候选维护阶段为GPT-6.1 Sol / medium，本候选原生编译为GPT-6 Sol / medium；消费阶段已对齐，生成阶段仍非纯后端对比。

## 资源与会话到 Wiki

首轮三批终态用时30.852/60.346/90.610秒，最终6/9/16页，正文11,628/26,996/59,313字节。三次Compile运行时合计输入386,208、输出26,756 tokens，不含摄入摘要/嵌入等额外调用。它有真实综合效果，但这个仅8条材料的小样本没有显示信息获取节省；不能将页数更多当成更好。

额外用合成S04创建session→messages→commit，实际归档URI为 `viking://user/default/sessions/synthetic-feedback-S04/history/archive_001/messages.jsonl`；原生Compile从该归档生成5页并引用原消息。此实验关闭基础memory提取和working-memory摘要，故没有把memory extraction冒称Wiki compile。证据：`session-ingest.json`、`session-compile-status.json`、`session-wiki/`。

## 版本差异与有限适配

10月19日main `27db441230f451380d03084322d1fde31e4357cb` 的[批量接口](https://github.com/volcengine/OpenViking/blob/27db441230f451380d03084322d1fde31e4357cb/openviking/server/routers/content.py)已有expected_sha256，[编译发布](https://github.com/volcengine/OpenViking/blob/27db441230f451380d03084322d1fde31e4357cb/bot/vikingbot/compile/ops/finalize.py)设置基线并报告冲突。属于源码推断，未运行，不能把0.5.0并发失败泛化为当前main也失败。

原生V3冻结后新增唯一有限适配 `scripts/guarded_write.py`：单机项目锁+hash基线+快照+operation_id。真实并发一成功一stale；真实写入后故障注入丢响应，回读确认后重试可识别。`V3-adapter.json`。直接API/Studio/Compile能绕过它，未形成服务端CAS，不回填原生通过。

## 失败、恢复与证据入口

保留：误用main bot.compile字段导致首次启动失败；消费者在batch3前误启动后中止（无产物）；DeepSeek消费者余额不足；订阅默认effort试跑；一次后台摘要server_is_overloaded；dev/ROOT导出权限拒绝；UI来源链接和工具过期ref错误。没有调知识提示词直到碰巧通过。共同instruction始终是“整理为可供团队检索使用的中文 Wiki，保留每项主张的来源”。

证据索引：`evidence/version.json`、`manifest-check.json`、`model-probes.json`、`codex-probe.json`、`runtime-profile-verified.json`、`dependencies.txt`、`metrics.json`；`logs/api.jsonl`、`data/bot/logs/vikingbot.log`；订阅轮次单列 `runs/chatgpt/`。来源/正文/索引实际在`data/viking/default/...`和`data/vectordb/...`，不在开发仓库。

未验证：真实历史规模、用户亲用、多个维护者生产运行、受认证OVPack完整恢复、当前main CAS、多租户权限、实际角色试行收益。本结果不构成最终采用或生产上线。

## 运行收尾

全部构建、恢复与UI实验仅在本候选外置实验空间进行；浏览器验证窗口已关闭。服务退出、端口与凭据扫描结果见外置证据标识`evidence/closeout.json`。保留数据、快照、日志、依赖和复现脚本，不留后台服务。本目录四篇研究记录公开；原始运行证据未发布。
