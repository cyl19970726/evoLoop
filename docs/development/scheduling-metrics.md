# 调度质量指标

调度架构以调度质量作为验收主线。`scripts/scheduling-metrics.mjs` 是 M0 的只读测量工具：它按固定的 Asia/Tashkent 日窗口读取正式 PostgreSQL 与 Leader 的 Codex rollout，输出上线前后可对照的基线；它不写数据库、不调用业务写命令、不改任何 Task。

## 运行

连接串只从显式环境变量或参数读取，不读取仓库内的开发/测试库配置：

```bash
EVOLOOP_METRICS_DATABASE_URL='postgres://READONLY_USER@HOST:PORT/evoloop' \
  node scripts/scheduling-metrics.mjs \
  --project PROJECT_UUID \
  --days 3 \
  --end 2026-11-10 \
  --format json \
  --out /private/scheduling-baseline.json \
  --markdown-out /private/scheduling-baseline.md
```

默认取“昨天”之前的 3 个完整日窗口；`--end` 指定最后一个完整日，`--start` 与 `--end` 可指定任意连续区间。窗口固定为当地 00:00 至次日 00:00（UTC+05:00），不随服务器时区变化。

常用选项：

| 选项 | 作用 |
| --- | --- |
| `--format text\|json\|markdown` | 终端输出格式；JSON 供复算，Markdown 可直接贴入报告 |
| `--out FILE` | 另写完整 JSON |
| `--markdown-out FILE` | 另写 Markdown |
| `--rollout FILE` | 指定 Leader 的 Codex rollout；可重复 |
| `--rollout-dir DIR` | rollout 搜索根；默认 `$CODEX_HOME/sessions` 或 `~/.codex/sessions` |
| `--leader-thread ID` | 指定 Leader 原生线程；默认从 `runtime_session` 的 Leader 角色读取 |
| `--downtime-file FILE` | 服务停机区间 JSON，见下文 |
| `--samples N` | 报告抽查样本条数，默认 10 |

脚本在 `BEGIN TRANSACTION READ ONLY` 中执行，并在发送每条 SQL 前拒绝非 `SELECT`/`WITH` 语句；连接串与凭据不会写入输出或错误信息。生产数据只读取，不能指向开发或测试库来“验证”指标。

## 指标口径

| 指标 | 计算方式 | 当前边界 |
| --- | --- | --- |
| Leader 回合 | Leader 线程 rollout 的 `task_started` 数；同时读消息处理表作对照 | rollout 缺失时回合与 token 为不可用，不以 0 代替 |
| Leader 输入 token | rollout 中窗口内每次模型调用的 `last_token_usage.input_tokens` 之和 | 缓存输入计入总输入，同时单列缓存量 |
| 上下文中位数 | 每个回合内最大的单次输入 token，再取中位数 | 另给 p90 与单次调用中位数 |
| 通知等待：到队列 | `leader_result_notice.occurred_at` 到关联消息创建 | 只统计窗口内发生的通知 |
| 通知等待：开新一轮 | 通知发生到该消息的 `session_message_processing.started_at` | 这是当前“一条通知开一轮”的主要口径 |
| 通知等待：送入 | 通知发生到 `session_direct_input` 创建 | 当前没有送入行时必须报不可用，不能写成 0 |
| 就绪到开 Run | Task 首次 `in_progress` 修订（定时 Task 取计划时间与修订时间的较早者）到 `runtime_run.created_at` | 有队伍后应改为进队等待并按 Leader/日程来源分开 |
| Session 空转 | 窗口内扣除 Run 与消息处理区间后的空闲；再与同 Role 的“就绪到首个 Run（或窗口末）”区间求交 | 事件流上线前是近似值；同 Role 多个 Session 可能重复计入同一段就绪工作 |
| 被叫停的 Run | `state='interrupted'` 或 `interrupt_requested=true` 的 Run，对照 `delivery.run_id` | 交付以 Delivery 为准，不以 Run 结束或通知为准 |
| 业务工作经普通消息 | Leader 发给业务 Session 且带 `context_task_id` 的消息，与 Task 首个 Run、首个 assignment 对照 | “在任何 Run 之前且此前没有 assignment”才是绕过正式安排的主要候选；关键词只作辅助 |

恢复门关闭区间由 `session_recovery_decision` 的恢复时间与失败原因回溯得到，并按窗口裁剪；当前仍为 `blocked` 的恢复门从 `session_recovery_gate.updated_at` 计到窗口末。服务停机只认显式输入，不从静默或事件空档猜测：

```json
[
  { "start": "2026-11-09T01:00:00Z", "end": "2026-11-09T01:20:00Z", "reason": "coordinator restart" }
]
```

## 复算与抽查

JSON 报告中每天都有 `notices.items`、`readyToRun.items`、`stoppedRuns.samples` 与 `businessMessages.samples`，包含原始记录 ID、起止时间、原始秒数与扣除恢复门/停机后的秒数。报告顶部的 `samples` 是供验收抽的 10 条跨类样本。

抽查一条通知时，可直接对照：

```sql
SELECT n.notice_id, n.occurred_at, sm.created_at AS message_created_at,
       p.started_at AS turn_started_at, d.created_at AS steer_at
FROM leader_result_notice n
LEFT JOIN session_message sm ON sm.project_id=n.project_id AND sm.message_id=n.message_id
LEFT JOIN session_message_processing p ON p.project_id=n.project_id AND p.message_id=n.message_id
LEFT JOIN session_direct_input d ON d.project_id=n.project_id AND d.processing_id=p.processing_id
WHERE n.project_id=$1 AND n.notice_id=$2;
```

抽查一条“就绪到开 Run”时，对照 Task 最早的 `in_progress` 修订与 `runtime_run.created_at`：

```sql
SELECT min(tr.created_at) FILTER (WHERE tr.state='in_progress') AS ready_at,
       min(r.created_at) AS first_run_at
FROM task_revision tr
LEFT JOIN runtime_run r ON r.project_id=tr.project_id AND r.task_id=tr.task_id
WHERE tr.project_id=$1 AND tr.task_id=$2
GROUP BY tr.task_id;
```

基线报告作为独立过程 Document 保存在 evoLoop 项目中；报告里的每个汇总数都能用同一脚本和同一固定窗口复现。脚本测试见 `scripts/scheduling-metrics.test.mjs`，不连接数据库。

## 已知缺口

- 送入（steer）尚未上线，`session_direct_input` 没有记录时，送入等待明确为不可用。
- Session 空转与“新情况纳入”在调度事件流上线前只能用 Run、消息与通知近似；报告必须保留这个标记。
- 服务停机没有数据库内的权威区间；基线若没有提供停机清单，应写“未提供”，不能推断为没有停机。
- 工作是否经普通消息派发目前只能识别候选；正式工作仍以 Task、assignment、Run 与 Delivery 为主证据。
