# nashsu/llm_wiki 验证结果

> **研究记录，非正式选型。公开整理版：2026-10-19。原始运行证据外置、未发布；本次公开整理未重新运行实验。** 阶段：固定版本实测结果（合成小样本；非当前选型决定）。

2026-10-19 · 已完成本轮有限验证。**当前不建议直接作为多 session 共享认知的权威底座。** 独立 vault、桌面摄入和程序化写页确实可运行，新上下文也完成了三个任务；但旧认识传播、并发覆盖、来源撤回仍有已复现缺口。可保留为人类阅读/整理入口，或在明确限制下试点外部维护接入。没有因此采用或部署到业务环境。

## 版本、输入与运行方式

- 官方 v0.6.12 macOS arm64 应用，源码固定 `48fd970e206a02a6d2028d1dbfc41b7a0345bf0b`；源码 checkout 未修改。发布包 SHA256 `42e1e4aafbb00ebf56631100dbe69182ee644b20b1936206c75fdad0599d250a`，见 实际配置记录（外置证据：`evidence/model-config-redacted.json`）。
- macOS 15.1 arm64；MCP 实际运行 Node 25.5.0。初始计划按 PATH 推断 Node 22.19，已更正。
- 共同 manifest（外置证据：`common/manifest.json`） 三项 SHA256/字节数匹配，结束时再次校验未变。仅 `events.jsonl` 的 S01–S08 按 batch 1→2→3 转成带 ID 的来源。材料是需求重建的合成样本，不是历史会话审计；evaluator 未入库、未给维护者/消费者。
- 独立的外置实验目录保存应用、隔离 HOME、依赖、vault、索引状态、日志、快照和备份。开发仓库的研究目录保存公开整理版，原始证据与知识正文仍外置。未安装全局 Skill/MCP、未建飞书表、未导入私有会话。
- 通过实际桌面创建 General 模板中文项目；官方 `schema.md`/原生 ingest 提示词未改。来源由 Source Watch 与 `/sources/rescan` 驱动，自动队列串行摄入。完整恢复轮得到 39 个 Wiki 页面、8 个来源。
- S01/S02 用既有 `DEEPSEEK_API_KEY` 的 `deepseek-flash`；S03 首次分析以 4,800 输出 token 全用于推理、正文为空而失败。应用拒绝从截断分析生成页面，保留失败队列。
- 配置恢复改为 `deepseek-v4-pro` 与原生 `thinking.disabled`。产品检测同时依赖端点名和 `deepseek-v4` 模型名；当前 `deepseek-flash` 别名及本地凭据转发端点没有满足初始检测。曾遇 3 次 HTTP 402；用户明确确认充值后，原队列恢复，S03–S08 完成。没有重写业务提示词或模型输出。
- 凭据转发层仅监听 loopback，现有密钥只在内存中加到真实 DeepSeek 请求，证据不保存授权头；路由前缀保留厂商识别。无 mock。嵌入关闭；检索返回 `mode: hybrid` 字段不被当作向量检索已经验证。

输入校验（外置证据：`evidence/input-provenance-check.json`） · 模型逐次摘要（外置证据：`evidence/model-summary.json`） · 配置恢复/首轮失败（外置证据：`evidence/config-recovery.json`） · 完整原生批次（外置证据：`evidence/batch3-native-complete.json`）

## 原生能力与共同案例

下表使用上述固定版本/输入；完整输入、响应与操作时刻保存在外置未发布的原始证据中。状态针对具体判据，不以页面数抵消失败。

| 案例 | 状态 | 观察与实现层 |
| --- | --- | --- |
| V1 纠正旧建议 | **失败** | 原生 S01 正确保留“助手建议、未确认”；S02 新页采用独立空间。但 batch2 恢复完成后，中心 `认知-wiki.md`、位置问题页仍只引用 S01，继续写“待确认/当前仅一句提案”。新增页没有完成所有受影响认识的修订。批次快照保留，旧页不会因消费者答对而改判通过。 |
| V2 两种 E17 解释 | **失败（来源忠实性）** | 原生合并页保留 S05/S06、不武断定责，提示回执/日志缺口，这一子项可用。但 S06 来源摘要把“检查记录找不到接收痕迹”延伸成“服务端投递日志中找不到”，原文未给日志位置。fresh consumer 下钻后主动排除了该延伸。不能因最终消费者修正而把编译结果计作完全可靠。 |
| V3 同基线/丢响应/重试 | **失败** | 副本中 A/B 同读基线，显式覆盖都200，B覆盖A；`expectedHash` 不被接受（400）。默认 create-only 返回409，有防误覆盖价值。模拟发送完整请求后丢弃响应，读回可核实已经写成；B介入后A盲重试仍覆盖B。原子替换、进程锁及字节读回不是CAS/幂等保证。 |
| V4 撤回 S05 | **失败（实质维护）** | 独立完整副本启用原生 Source Watch、关闭自动模型摄入，再删除 S05。原生删除了来源页，混合页 `sources` 去掉S05、链接转纯文本；5页仍有S05提及，E17正文仍引用已撤回来源的本地提交观察，没有标失效或修订该认识。未把删除S05解释成S06自动为真；该轮0次模型调用。 |
| V5 fresh consumer/T1/T2 | **通过（本样本产物）** | 无历史继承的新 Agent 仅拿任务与正常 HTTP 搜索/读取入口，交付实施说明、诊断任务。采用独立认知空间、仓库正式文档、飞书任务方向、业务认知责任和实际使用反馈闭环；E17区分提交、投递、消费及证据不足。没有实施部署或声称样本业务已经成功。 |
| V6 分工/T3 | **通过（本样本产物）** | A优先处理容量/限流，同职责实例为有条件试验；B限期试行连续体验责任，给替代办法、边界、可观察收益和退出条件。未将增加角色直接判成功。 |
| V7 备份/恢复/重启 | **通过（手动备份层）；原生归档UI未验证** | 将完整冻结项目用普通ZIP备份至新位置，58文件逐一SHA256一致、内部项目ID保留，来源/关联/Review状态均保留；关键查询/原始S02读回及重启后再读均200。并行挂载使用了测试API别名。未运行应用自带归档按钮。原生历史默认关闭，未保存的历史不能“恢复”；另在V3副本显式开启历史，实测生成1文件3条记录。未测向量索引恢复。 |
| V8 人类阅读/纠错 | **未验证完整流程** | Agent实际创建项目、打开认识页，看到来源、Related、Edit入口；至少两个英文Related slug显示“page not found”。重启后CUA多次报无frame/窗口，未完成从依据打开到纠错保存的全链路。截图是实测界面；不代表用户已试用或满意。未测人类主动操作用时。 |

V1 批次恢复页证据（外置证据：`evidence/batch2-recovered.json`） · V3（外置证据：`evidence/v3-native-write.json`） · V4 前后正文（外置证据：`evidence/source-withdrawal.json`） · V7（外置证据：`evidence/backup-restore.json`） · 重启恢复（外置证据：`evidence/restore-after-restart.json`） · 原生历史 opt-in（外置证据：`evidence/history-opt-in.json`） · 实测界面（外置证据：`evidence/ui-old-proposal.png`）

## 程序接口：旧调研结论已纠正

真实 MCP 进程列出12个工具，**包含 `llm_wiki_write_page` 与 `llm_wiki_embed_page`**。已实际经MCP写页、读回；pin项目后跨项目override被拒。HTTP有 `/pages/write`、Review单项PATCH/批量resolve。Review标“Created page”返回200但wiki树hash完全不变，确认是状态标记，不能把API的resolve当作UI执行建页/修订。

另外实测 `127.0.0.1:19827/clip` 能向指定测试项目提交文本来源；同样请求重复两次生成两个文件，无贡献ID去重。它使用web-clip元数据，不能直接当作业务证据的完整变更提案协议。主API端口19828；停止隔离桌面后连接被拒，重启恢复。MCP实际代理桌面API，不是脱离桌面的独立知识服务。

官方独立 Skill 固定 `642b43822ed44f6797082a24483850a4a2c2a010`，仍称只读、写端点不存在，与当前产品源码和实测不符。本轮只作为参考阅读，没有安装或让其限制替代接口核验。原生附带schema/ingest提示词与这个外部Skill是不同层。

MCP真实列表（外置证据：`evidence/mcp-live-probe.json`） · MCP写读及隔离（外置证据：`evidence/mcp-write-probe.json`） · Review标记试验（外置证据：`evidence/review-native-mark-only.json`） · 来源提交/重复（外置证据：`evidence/native-source-contribution.json`）

## 有限适配与独立对照

首轮原生阻塞状态先冻结，再在独立 `adapted-vault` 副本让外部Wiki维护Agent通过原生HTTP读写；维护者未见consumer任务或evaluator，batch2后冻结，再给batch3。27次写入全部获原生字节验证，语义整合由外部GPT-6.1 Sol和新增维护提示词完成。没有把预写答案放进vault证明自动能力。用户充值后原生原队列另行恢复，没有迁入适配正文/提示词；因此**完整原生轮晚于适配产生，时间顺序不是严格无阻塞的顺序实验**。

外部维护修正了过时中心页并组织E17/分工依据，但也丢掉了不少产品机器依赖的 `sources` 字段：27页只有3页保留该字段。这是本次外部维护适配的兼容性缺口，不能归罪于原生摄入，也不能把文字引用当作来源级联保证。本轮保留首版产物，没有不断调提示词追求全绿。

外部维护batch2（外置证据：`evidence/external-maintainer/operation.md`） · batch3（外置证据：`evidence/external-maintainer/operation-batch3.md`） · 字段/链接扫描（额外诊断）（外置证据：`evidence/link-and-source-audit.json`）

消费者都用 **GPT-6.1 Sol / medium、无历史继承**；最初GPT-6 Sol因容量不足未运行，已披露替换。三组各自一次交付，未看标准、未改答案重跑。直接原材料对照仅读events和任务；Wiki组经正常入口按引用下钻来源。验收者检查实际三份文件，T1/T2/T3三组均通过本样本内容要求。

| 组 | 成果完成墙钟 | 输入/入口开销 | 内容结果 |
| --- | ---: | --- | --- |
| 直接原材料 | 87.65秒 | 2份输入文件，共3,824字节 | T1–T3通过 |
| 完整原生Wiki | 120.28秒 | 11次入口操作：1搜、9读、1来源清单；知识CLI回包40,937字节，另读任务1,051字节 | T1–T3通过；原始来源纠正了S06摘要延伸 |
| 外部维护后Wiki | 104.08秒 | 19次入口操作：3搜、16读；知识CLI回包79,740字节，另读任务1,051字节 | T1–T3通过；维护成本另计 |

墙钟包括检索、思考和写成果，不是纯检索延迟。字节是原文件/CLI响应的不同传输包装，不是模型token；消费者初始部分未测量，表值由已保留回包一次性推导，没有补跑。消费者人工介入0；整轮需要用户充值1次，其操作用时未知。小材料中没有观察到Wiki的信息获取或行动收益，不能外推大库效果。原生消费者导出文件中的 `../../wiki`/`../../raw` 相对链接不适用于其输出目录，须依API项目相对路径回查；本轮未修消费者首版。

直接对照产物（外置证据：`consumer/raw-control/`） · 原生消费产物（外置证据：`consumer/native/`） · 适配消费产物（外置证据：`consumer/adapted/`） · 逐项验收（外置证据：`evidence/consumer-evaluation.json`）

## 实现层、成本和未验证项

1. **原生机制**：桌面Source Watch/ingest、独立Markdown、HTTP/MCP写读、create-only、来源删除级联、Review存储。API写成功只保证持久化，不保证认识正确或依赖完整。
2. **官方提示词/Skill**：原生schema与摄入提示词实际使用；独立官方Skill只查阅，内容已滞后；没有新增全局入口。
3. **新增适配**：凭据转发/计时、薄HTTP入口、外部维护Agent提示词、额外静态扫描和回包计量。未补CAS、可靠变更提案或完整维护队列，不能算生产集成。
4. **手动操作**：Agent配置/启动、来源转写、复本/ZIP、阶段冻结；真实用户只确认了充值。未做真人体验计时。

本地真实模型请求37次：34次HTTP200、3次402；200中包含首次截断失败，不能全记成功。API报告110,400输入token、45,529输出token，含重试与维护调用；这些不含外部Agent宿主token，不能用作三组全成本对比。batch3输入至完成快照约313秒，含观察间隔。依赖均候选目录本地安装；未付费激活ARK模型，也未购买服务。

仍未验证：产品内置chat完成同组任务、完整原生归档UI往返、真人满意度与纠错用时、向量检索/索引恢复、长期业务收益、跨机器/多进程高并发。只检查了当前环境变量中既有provider密钥值在指定证据/脚本/快照/vault/隔离配置中无落盘匹配，不能宣称通用安全审计。

运行汇总（外置证据：`evidence/run-summary.json`） · 源码推断单列（外置证据：`evidence/source-audit.md`） · 密钥落盘检查（外置证据：`evidence/secret-persistence-scan.json`）

官方依据：[固定源码/API](https://github.com/nashsu/llm_wiki/blob/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b/src-tauri/src/api_server.rs)；[固定MCP源码](https://github.com/nashsu/llm_wiki/blob/48fd970e206a02a6d2028d1dbfc41b7a0345bf0b/mcp-server/src/index.ts)；[官方Skill](https://github.com/nashsu/llm_wiki_skill/blob/642b43822ed44f6797082a24483850a4a2c2a010/SKILL.md)；[DeepSeek推理开关](https://api-docs.deepseek.com/guides/thinking_mode/)。源码推断与实际响应在本报告中分别标明。
