# TencentDB-Agent-Memory 窄范围核查（2026-10-19）

> **历史研究记录。** 本文于 2026-10-19 整理为公开阅读版，保留当日固定提交的静态源码判断；未重新运行服务、核对当前分支或复验外部链接。它评估的是候选机制，不是正式选型或已验证的多 session Wiki 维护能力。后续两候选的运行结果与评价尺度见[首轮验证摘要](../references/validation-summary.md)和[Wiki 功能与流程比较](../references/wiki-feature-comparison.md)：可检索、可写页或能增量 ingest，均不自动证明旧结论已修订。本文提到的 GitHub star 与默认分支元数据仅为当日历史快照。

**基线：** `feat/server_team` → [`e9a82935b52741e0c798c75326e90b7144eb4d5f`](https://github.com/TencentCloud/TencentDB-Agent-Memory/commit/e9a82935b52741e0c798c75326e90b7144eb4d5f)。本报告按该提交静态读源码，未运行服务或模型。GitHub API stars、默认分支与 LICENSE 元数据以主调研记录为准；本核查不把它们当代码证据。

## 查实

1. **是增量编译，不是每轮把 Wiki 当空库重做。** `manager.ts` 对 `raw/sources` 算 SHA-256，只抽新增/变更源，跳过未变源；新候选按现存页合并，完毕后重建索引并在 SQLite 写事务中登记源状态。`merge.ts` 保留旧页与新页 `sources` 并集；旧正文超 4000 字符时只追加 LLM 生成的增量片段，小页整页重写；冲突提示要求并列记录。来源删除会按 `sources` 级联删页或移除来源标记。故它有“增量 + 溯源”机制，但不是逐句、不可变的事实账本。

2. **维护 session 可直接编辑页，不必重新 ingest。** `POST /v3/wiki/page/write` 可 upsert Markdown 页，自动注入 `locked: true`；之后 ingest 会跳过该锁定页。REST 端另有 `/wiki/create`、`/page/read`。但内置 MCP 只注册 `wiki_search/read/list/graph` 等查询工具，没有 create/write 管理工具；维护 session 若走 MCP 以外的带鉴权 HTTP API，可直写页面。若希望 LLM 从原始材料重新编译，则走 `raw/write` 后调用 `ingest`。

3. **冲突与并发有边界保护，版本审计较弱。** 未锁定页冲突时提示保留双方并说明分歧；同一 Wiki ingest 有队列，默认重复请求 409，也支持 replace/取消后排队；处理期间人工页写入被拒。源码/材料有 SHA 和状态记录，但人工页写入是文件覆盖，未见 Wiki 页历史版本、CAS/编辑冲突合并或来源级修订审计。因此适合作为 Markdown 知识产物及独立存储试点，不应假定具备完整协作编辑/审计能力；多人 session 并发改页仍需外部交接约定或 Git/版本快照。

4. **可独立跑 Knowledge 服务，但产品闭环依赖 Panel。** `MemoryKnowledge` 有独立进程、HTTP `/v3`、MCP stdio、SQLite 元数据/全文索引和单独 data volume；Wiki 正文是数据目录中的 Markdown，可与开发仓库分开。README 明说单独启动可用，完整产品链路需 Panel 推 `llm_binding`、接 callback 并写远端元数据。源码默认 LLM `proxy` 必须有 TMC 推送的 binding；可配置 `custom` 直连兼容接口。故可把 Knowledge 当候选独立组件接入，但无需引入/托管整个 MemoryPanel；脱离 Panel 的自管认证、身份/权限、模型配置与回调行为尚未实测。

## 判断与待验证

它符合“认知库与开发 repo 分离、Markdown 可接受”这一硬边界，技术上值得高 star 候选中的小规模适配验证；不能直接视为现成的多 session Wiki 工作台。最小验证应由专门维护 session 用独立 data 目录建一个知识库，测试 REST 页写入/锁定、raw 增量 ingest、来源删除、冲突并发与备份恢复，并测清不接 Panel 时选 `custom` LLM 的鉴权/权限方案。任务入口、session 分工和日常协调继续留在现有飞书与 evoLoop 流程，不能据此把它当全套接管方案。

## 固定源码链接

- [增量 ingest / 来源哈希与事务提交](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/e9a82935b52741e0c798c75326e90b7144eb4d5f/MemoryKnowledge/src/engines/wiki/manager.ts)
- [候选页合并与 sources 保留](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/e9a82935b52741e0c798c75326e90b7144eb4d5f/MemoryKnowledge/src/engines/wiki/ingest-v2/merge.ts) · [来源级联删除](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/e9a82935b52741e0c798c75326e90b7144eb4d5f/MemoryKnowledge/src/engines/wiki/ingest-v2/cascade.ts)
- [Wiki REST 路由](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/e9a82935b52741e0c798c75326e90b7144eb4d5f/MemoryKnowledge/src/routes/wiki.ts) · [页存储/locked 写入](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/e9a82935b52741e0c798c75326e90b7144eb4d5f/MemoryKnowledge/src/store/wiki-service.ts)
- [MCP 查询工具](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/e9a82935b52741e0c798c75326e90b7144eb4d5f/MemoryKnowledge/src/mcp/tools.ts) · [独立运行与 Panel 依赖说明](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/e9a82935b52741e0c798c75326e90b7144eb4d5f/MemoryKnowledge/README.md) · [单服务 Compose](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/e9a82935b52741e0c798c75326e90b7144eb4d5f/MemoryKnowledge/docker-compose.yml)
