# nashsu/llm_wiki 验证计划（冻结 v1）

> **研究记录，非正式选型。公开整理版：2026-10-19。原始运行证据外置、未发布；本次公开整理未重新运行实验。** 阶段：实验计划与执行补记（历史记录；实际结果以同目录 results.md 为准）。

2026-10-19，输入为需求重建的合成样本，不是历史审计。当前状态：版本与材料已固定，推进原生运行。

- 固定源码：[v0.6.12 / 48fd970e206a02a6d2028d1dbfc41b7a0345bf0b](https://github.com/nashsu/llm_wiki/tree/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b)；当时 main 与本次研究版本一致，不代表此后仍一致。发布版 v0.6.12（2026-09-28），优先使用官方 macOS arm64 二进制；若数据目录无法安全隔离，先记录阻塞再采用仅路径隔离构建。
- 环境：macOS 15.1 arm64；Node 25.5.0（实际MCP执行版本；初始按PATH推断22.19已更正）。源码、依赖、应用/profile、vault、索引、备份、证据只在外置专属目录。此处“正式文档只在本目录”是原计划的写作范围；当前四页为公开研究记录，正式权威另见站点文档。
- 输入：common/manifest.json 的三份文件 SHA256 与字节数全部通过校验，见 evidence/manifest-check.json。只将 events 转为带稳定 Sxx ID 的来源，按 1→2→3 逐批导入。evaluator 绝不进入产品或 consumer。
- 原生接口：桌面 Tauri 命令、127.0.0.1:19828/api/v1、官方 mcp-server；先核实所有写入/Review/导入路径。禁止为原生成绩手写答案进 vault。
- 模型：安全检查现有可用配置，不回显、复制到证据或命令参数；记录脱敏后的 provider/model/endpoint 类型。没有可用模型时明确阻塞并继续无模型检查。
- V1/V2：每批原生摄入后备份产物，检查最新约束、修订、冲突依据与不确定性。
- V3/V4：在副本上两写者同基线、重试，撤回 S05，检查静默覆盖与引用依赖。
- V5/V6：无继承子 Agent 只给 T1–T3 与正常知识入口，交付三个可检查文件；另一子 Agent 同任务只读共同原材料作对照。记录模型、时间、调用与人工介入。
- V7/V8：重启持久化与新位置导出恢复；实际界面打开认识→来源→修订，记录截图/步骤和主动操作时间，Agent 观察不冒充用户满意。
- 冻结原生成绩后，至多一个有价值的关键缺口做有限适配；严格区分原生、官方提示词、追加适配、人工操作。
- 验收：以共同协议和 rubric 检查成果，不以安装、搜索命中判通过。逐项登记通过/失败/未提供/阻塞/未验证及证据。

交付：[实验计划](plan.md)、[实测结果](results.md)、[接入边界](integration.md) 与 [功能流程核查](feature-workflows.md) 的公开整理版；运行记录与完整产物外置。共同判据见[验证协议](../wiki-validation-protocol-20261019.md)。另一候选并行，所有编辑只在本候选两处目录。

## 执行补记与复现入口

历史计划先写“核实所有写入路径”；固定版本实际已确认 MCP `llm_wiki_write_page` 与 HTTP `/pages/write`，并完成写入读回。后文计划时态保留，不代表接口缺失；详情见[实测结果](results.md)和[功能流程核查](feature-workflows.md)。

本轮完成，详见 results.md / integration.md。保留所有首轮失败和恢复产物，不覆盖首轮评分。

- 原生首轮：batch1→batch2；S03推理截断，后遇余额不足。snapshots/native-frozen 为首轮冻结，不是完整通过记录。
- 用户确认充值后：原生原队列恢复S03，再输入batch3；snapshots/batch1、batch2、batch3 保留顺序证据。完整原生39页，外部维护副本27页。S03原文只因触发原生重扫增加空白行，事件正文逐字未改。
- 独立消费者：原材料/原生/外部维护三个无历史继承上下文，同为GPT-6.1 Sol medium，T1–T3首次产物均已检查。原先GPT-6 Sol容量不足没有运行。模型与入口差异单列，未称端到端同模型实验。
- V1/V2/V3/V4有失败或实质缺口；V5/V6本样本产物通过；V7手动项目备份与重启读取通过、原生归档UI未验；V8只完成部分Agent界面观察，不代表用户体验验收。
- 只做一个关键适配：外部Wiki维护Agent经原生HTTP读写。完整原生恢复晚于适配，适配内容/提示词没有进入原生vault；外部维护缺失sources字段已单列，未追加提示追求全绿。

复现材料都在外置目录（不是全局安装）：

1. release-source / checkout 固定源码与官方二进制；evidence/manifest-check.json、input-provenance-check.json、model-config-redacted.json 固定输入及配置。
2. runtime/isolated-home 是应用专属HOME；scripts/runtime.py start 以该HOME启动官方App。实际项目通过原生New Project界面创建General模板、中文输出、外置父目录。应用配置位于隔离HOME的Library/Application Support/com.llmwiki.app/app-state.json；token文件权限0600，不回显。
3. scripts/model-relay.py 从既有DEEPSEEK_API_KEY读取凭据，仅转发到真实官方服务；关闭时不能把没有模型响应当通过。配置模型deepseek-v4-pro，maxContextSize128000，流式、reasoning/ingestReasoning off，嵌入关闭，API/MCP开启且token保护、LAN关闭。
4. scripts/batches.py、native-interface-tests.py、review-probe.py、mcp-probe.mjs、mcp-write-probe.mjs、history-probe.py、backup-restore.py、withdrawal-probe.py 记录了本轮实际动作。它们是一次性实验脚本，部分断言要求新副本目录不存在；复跑应在新的专属目录并据原生流程新建项目，不删除现有证据或覆盖用户库。
5. consumer/三个目录保存首次成果与trace；evidence/entry-*.jsonl保存实际读写回包，model-*-request/response保存无授权头的合成输入输出，snapshots/保存各批冻结。evaluator从未入库或给消费者。
6. 备份验证为普通ZIP完整项目树，不冒称原生UI归档。重启/撤回在测试副本上做，未改业务环境。服务最终停止，证据与可启动环境保留；无真实外部任务表或全局Skill/MCP注册。

源码本身未改，未跑整库测试套件；本轮证据来自真实桌面、HTTP/MCP、模型调用、同基线覆盖试验、实际消费者产物与恢复校验。
