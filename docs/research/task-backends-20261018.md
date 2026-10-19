# 第一阶段任务表后端：飞书多维表格 / Notion（2026-10-18）

> **历史研究记录。** 本文保留 2026-10-18 的官方文档核验与当时的第一阶段选择；于 2026-10-19 整理为公开阅读版，未重新调用两家 API、复核最新配额或重跑并发试验。下方官方链接所指页面可能随产品更新；带时间性的限额、版本与接口描述只代表当时的查询结果。它是任务表后端研究，不是任务调度或生产接入完成报告；当前项目边界见[架构总览](../architecture/overview.md)。

## 结论与证据边界

2026-10-18 用户已选择**飞书多维表格作为第一阶段唯一任务事实源**，让人直接在原生界面编辑；先实现飞书 `TaskStore` 适配器，Notion 保留作研究对照与未来替换选项。任务表不等于多 session 调度器。以下是**官方文档核验**（经 Context7 索引与官方网页交叉查看），**未使用真实账号、凭据或 API 进行读写/并发探测**。尤其不能据普通更新接口推断出原子抢占、比较并交换（CAS）或跨记录事务。

| 能力 | 飞书多维表格（Bitable） | Notion |
| --- | --- | --- |
| 任务 CRUD / 查询 | 记录 create/update/delete 及 search；search 支持视图、字段选择、筛选、排序；list 有 `page_size/page_token/has_more`，文档建议新接入优先用 search。删除宜映射成软删除状态，保留审计。 | 数据源里的 page 可 create、PATCH 更新、归档/移入回收站；`data_sources/{id}/query` 支持 filter、sort、`start_cursor/page_size`，返回 `next_cursor/has_more`。需固定 `Notion-Version`，别沿用旧版 database query。 |
| 结构 / 关联 | Base→table→field→record；记录字段支持单/多选、人员、日期、单向/双向关联等。字段名和字段类型须由适配器校验；关联值用目标记录 ID。 | database→data source→page；数据源有属性 schema，page 属性可用 relation。查询关联涉及的数据库也须授予连接访问。 |
| 身份 / 权限 | `tenant_access_token` 以应用身份访问，或 `user_access_token` 以用户身份访问；实际读写受应用 scope、文档访问权限与字段敏感权限共同约束。 | Bearer connection token 加 read/insert/update content capabilities；目标数据库/数据源须分享给 connection。 |
| 变更发现 | 有 Base 记录变更事件，须先订阅云文档事件；公式字段变化不触发该事件。事件只触发重新读取，另配低频全量/增量对账以补漏。 | Webhook 对页面/数据库变更发信号，事件不含完整新内容，要再 retrieve/query；官方说明失败会重试，但目标是 at-most-once，不能只靠 webhook 保证发现所有变更。另配定期对账。 |
| 配额 / 重试 | 单个端点有限流（例如 create 文档 50/s、search 文档 20/s），并可能受企业套餐/月度总量影响；按端点和错误码退避。`client_token` 用于部分写入接口的幂等重放；`ignore_consistency_check=false` 是读写一致性选项，**不是 CAS 证明**。 | 每 connection 按套餐有每分钟预算：Business/Enterprise 600 次，其余 180 次；另有 workspace 共享限制和端点限制。429/529 按 `Retry-After`。写入超时后结果未知，先重读再决定是否重试，以免重复创建或覆盖。 |

## 第一版接口与竞态规则

`TaskStore` 只暴露领域操作：`get(taskId)`、`list(filter,cursor)`、`create(task,operationId)`、`patch(taskId,changes,expectedRevision?,operationId)`、`archive(taskId)`、`watchChanges(cursor?)`；统一返回规范化任务、源记录 ID、源修改时间/版本、分页 cursor。`expectedRevision` 只有在适配器**实测可强制条件写入**时才可标记为强保证；否则返回“不支持原子条件写入”，由上层单写入协调器串行化任务领取。不要做 `read → if free → update owner` 并声称独占成功。

`SessionRegistry` 另行负责 `register/heartbeat/expire/stop` 和 `taskId ↔ sessionId` 绑定、租约期限与恢复扫描；它是进程/会话控制面，不由 SaaS 任务行自动实现。第一版可用**一个协调器作为唯一 agent 写入者**，在其内部队列串行处理 claim；若必须多协调器并行抢占，先选择并实测有条件写保证的锁/租约设施，否则不承诺“至多一个 agent 执行”。执行动作仍需幂等键、超时后重读和外部副作用去重。

人类可在原生表里改标题、优先级、描述与期望状态。建议把 `desired_state`（人类意图）与 `runtime_state/lease_owner/lease_until`（协调器维护）分开；协调器收到 webhook 或轮询变化后重读最新行，合并非重叠字段，遇到同一字段冲突时暂停自动派发并记录冲突供人处理。不要让 agent 无条件覆盖原生编辑。平台事件按事件 ID 去重，不能假设严格顺序；分页遍历期间有新写入时，靠下一轮对账补齐。第一阶段只配置**一个**后端为权威，切换后端通过离线迁移、校验与明确切换点完成，不双写。

## 正式接入前的最小探测

用测试表和两个并发客户端验证：同一任务同时 claim 是否有可依赖的版本条件失败；`client_token`/重复创建在超时重试后的具体行为；人的原生编辑与 API 写入交错时是否丢字段；事件延迟、重复、乱序及漏发；search 翻页期间有写入时的结果；现有租户的 scope、表容量与实际配额。探测通过后再决定哪家更适合，不能仅凭文档宣称抢占安全。

## 官方依据（8 条）

1. [飞书：创建记录（字段类型、权限、幂等参数与一致性参数）](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create)
2. [飞书：搜索记录（筛选、排序、视图、限流）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/search)
3. [飞书：批量更新记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/batch_update)
4. [飞书：Base 记录变更事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file/events/bitable_record_changed)
5. [Notion：查询数据源](https://developers.notion.com/reference/query-a-data-source)
6. [Notion：更新页面](https://developers.notion.com/reference/patch-page)
7. [Notion：请求限制](https://developers.notion.com/reference/request-limits)
8. [Notion：Webhook 事件与投递](https://developers.notion.com/reference/webhooks-events-delivery)
