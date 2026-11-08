# 受管 Session 的一次原生压缩维护

`runtime.compact.start` 只面向有当前项目复核、写入和精确 Session 运行授权的维护者。请求指明原 managed Session、原 native Thread、当前 Session 版本和**blocked** 恢复门版本。服务先核原失败 Run 或消息的已知终态及其最后原生 Turn，再将意图存入 `session_compaction`，随后才在当前 owner 的 App Server 连接发送一次 `thread/compact/start`。这里不产生普通业务消息，也不开启恢复门。

发包前的 native request ID 仅表示尝试。原 owner 连接在发包后捕获的精确 `turn/started` ID 可直接用于同一 Turn 的只读对账，即使 RPC 应答丢失或连接随后更换。没有精确 Turn ID 时，只有同一 owner 连接收到合法 `{}` 应答，才记录受理时间和连接 ID；历史回填还要求该连接仍有效、原基线之后只有一个 Turn，且该 Turn 有持久 compaction Item。既无 ACK 又无精确 Turn、连接已更换或历史有歧义时，原操作保持 unknown，按原 ID 对账，不再次发送。

命令入口：`request runtime.compact.start --project PROJECT --id SESSION --file intent.json`。文件正文为 `operationId`、`threadId`、`expectedSessionVersion`、`expectedGateVersion`、`evidenceRef`、`reason`。先用 `request schema runtime.compact.start` 核字段。相同 operation ID 和完全相同正文只读回原结果；不同正文被拒绝。原操作可用 `get /api/projects/PROJECT/runtime/compactions/OPERATION` 读取，再用 `request runtime.compact.reconcile --project PROJECT --id OPERATION --file empty.json` 只读原生证据并更新原记录。`empty.json` 为 `{}`。

压缩 RPC 的 `{}` 应答只记录为 `accepted`。完成需同一个已绑定压缩 Turn、`contextCompaction` Item 的完成时间、Turn 终态和原 Thread idle。丢失 `turn/started` 通知时，仅在合法应答和原 owner 连接均已持久确认、该连接仍有效、原失败 Turn 基线仍可见、其后只有一个 Turn 且该 Turn 有持久压缩 Item 时回填 Turn ID；分页不完整或多于一个后继 Turn 保持 `unknown`。已绑定 Turn 明确 `failed` 且有完成时间时，即使没有 Item 也记为失败，并保留 blocked 门。外层 Turn `completed` 缺成功 Item 不算成功；不得以新操作 ID 重发或自行打开恢复门。确认完成后，仍由现有 `runtime.session.recovery.resume` 对当前 cause、version 和 pin 作独立决定。

此功能使用迁移 058，紧接正式已发布的 057；其它在途 PR 原占 058–063，须在各自整合时按最新 main 顺次重排并验证迁移。隔离迁移与 PG/HTTP 回归不代表原 Leader 的真实压缩已验证。正式操作前应回读原 Thread 的模型、思考强度、权限、当前 writer、最后原生 Turn、未知在途和有效 hooks；若其中任一项无法证明，保留 blocked 门并记录准确缺项。

独立 QA 可在专用 PostgreSQL 测试库运行 `TEST_DATABASE_URL=postgresql://USER@127.0.0.1:PORT/evoloop_compact_test E1_MANIFEST_PATH=/private/tmp/evoloop-compact-e1.json E1_PORT=55493 node --import tsx tests/manual/session-compaction-e1.ts`。脚本启动真实 HTTP 服务并将随机项目、Session、Thread、gate 版本和两种测试身份的 token 写入权限为 0600 的私有 manifest；它的 native 接口是**受控丢回复替身**。QA 从 manifest 取值，通过普通 HTTP 或 CLI 发一次 `runtime.compact.start`，再用同一 operation ID 读回、复核、测试改正文和只读身份拒绝。重启脚本产生新的独立 schema 和未消费样本；结束后先停脚本，再核对 manifest 中 `compact_e1_` 前缀的 schema，使用专用测试库的 `DROP SCHEMA ... CASCADE` 清理。该入口不验证有认证的 alpha.6 模型压缩。

原生 `thread/read` 的 Thread 投影没有可靠的压缩前后 token 总量字段，因此回执中的 `beforeInputTokens`、`afterInputTokens` 可以为 `null`。完成判据读取 `thread/turns/list` 的精确 Turn，再从 `thread/items/list` 取同一 Turn 的持久 Item 完成时间；只读到 Turn 摘要不算完成。原失败 Thread 为 `systemError` 或重启后为 `notLoaded` 时，维护入口要求原失败 Turn 有完成时间，再由当前 owner 用完全相同的 profile 执行 `thread/resume`；恢复后最后 Turn 必须仍为原失败 Turn，且无活动 writer。原生拒绝、profile 变化或状态无法核定时保留原操作为待对账，不借新 Thread 绕过。
