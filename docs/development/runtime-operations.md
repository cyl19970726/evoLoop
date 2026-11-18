# 运行接线手册

本页写给负责打开、核对和关闭运行机制的维护者，覆盖五项：Leader 结果通知、即时输入、托管压缩、普通 Task 的每日复制和阶段关注。它们都已合入 main。Leader 结果通知、即时输入和每日复制要在私有配置里打开或授权后才生效；托管压缩默认开着，但只在特定 Codex 协议版本下可用；阶段关注没有开关，随服务运行。新实例当前打开了哪几项，看[阶段路线](../roadmap.md#已实现但新实例未用)。规则和设计理由在架构页：[接口与协作合同](../architecture/contracts.md)、[Session 运行时](../architecture/session-runtime.md)。服务的启动、身份、备份见[本机运行](local-run.md)，CLI 的通用用法见 [Agent CLI](agent-cli.md)。

## 共同做法

- **配置放在私有文件里。** 前四项的配置都写在 `EVOLOOP_INTEGRATIONS_FILE` 指向的私有 integrations 文件中；阶段关注没有开关，门槛用命令修订。这个文件放在仓库外，或明确被 Git 忽略。改动时保留所有原字段，只增加本节要的键；令牌、地址和真实 ID 不写进公开文档或日志。
- **先关着核对，再打开。** 先在关闭状态下核配置、身份和存储，再切换。同一项目同一时刻只配一个目标。
- **状态只说明到了哪一步。** 已保存、平台已接受、原生 Turn 已开始、接收者已读、实际处理和 Task 关闭，各看各的记录；前一步成立，不代表后一步也成立。
- **结果不明时按原 ID 对账。** 回包丢失或状态为 `unknown` 时，用原 operation ID 或原输入 ID 读回，不换 ID 重发。
- **注意配置什么时候生效。** 有的配置在运行中重读，有的只在服务启动时读一次：

| 机制 | 私有配置 | 默认 | 改动什么时候生效 | 规则在哪 |
| --- | --- | --- | --- | --- |
| [Leader 结果通知](#1-leader-结果通知) | `leaderResultNotices` | 不投递（未配置或 `enabled:false`） | 通知泵每轮重读，默认约 2 秒一轮；`pollIntervalMs` 只在启动时读 | [Leader 通知层](../architecture/contracts.md#leader-通知层) |
| [即时输入](#2-即时输入) | `directInputs` | 关闭 | 每次请求重读；前提是服务启动时已启用运行时 | [即时输入](../architecture/session-runtime.md#3-即时输入执行中收到的消息怎样处理) |
| [托管压缩](#3-托管压缩) | `runtime.compaction.owned` | `true` | 启动时读，改后重启 | [托管压缩](../architecture/session-runtime.md#4-托管压缩) |
| [普通 Task 的每日复制](#4-普通-task-的每日复制) | `scheduling.taskTimingGrants` | 空 | 每次创建、改时和物化时重读 | [一次与每日复制](../architecture/contracts.md#普通-task-的一次与每日复制) |
| [受管 Session 编制](#6-受管-session-编制所需配置) | `residentQueue.roleActors`、`runtime.materialCli`、`runtime.grants` 等 | 无（逐项见该节） | `session prepare` 每次重读；`runtime.enabled`、新增 HTTP 令牌、`runtime.grants` 新增的工作目录或模型要重启 | [准备或复用受管 Session](agent-cli.md#准备或复用受管-session) |
| [阶段关注](#5-阶段关注) | 没有开关，门槛用命令修订 | 服务运行就评估，每 30 秒一次 | 不适用 | [阶段等待由事实推导](../architecture/contracts.md#阶段等待由事实推导) |
| [用量上限与上下文交接](#7-用量上限与上下文交接) | `runtime.dailyBudget`、`runtime.contextBudget` | 都不限 | 上限与开关在每个普通结果通知前重读；账本时区在启动时读 | [长会话的上下文交接](../architecture/session-runtime.md#长会话的上下文交接与每日用量上限) |

## 1. Leader 结果通知

业务结果写入时，数据库在同一事务里登记一条通知；哪些事实会登记，见 [Leader 通知层](../architecture/contracts.md#leader-通知层)。通知泵把通知作为一条普通 Session 消息发给受管 Leader Session。没打开时，通知照常入库，在表里等待投递。

### 准备

- **一条受管 Leader Session。** 它所在的 Role 是项目里唯一 active 或 trial 的 system Lead。核对实际接收 actor、Session 类别与范围、原生 Thread、执行授权、工作目录和 CLI 身份。业务 Session 不能作为 Leader 目标。
- **两个不同的 actor。** `senderActorId` 是配置里明确授权的技术通知者，须可写 `session`；`receiverActorId` 是实际的 Leader，须有 `session` 类别与决定权。二者都须是当前身份文件里的项目成员。
- **消息授权。** `sessionMessages` 已启用，并有针对这个 sender、Leader Session、receiver actor、Role 和 cwd 的**精确授权**，额度可用。 经 HTTP/CLI 发普通消息时，这项授权在**发送时**就核对：缺了当场拒绝（`MESSAGE_GRANT_MISSING`），并写明缺 `sessionMessages.grants` 里的哪一项和可复制的条目，消息不保存。服务内部自动发的消息（通知、验收接力）仍按各自的投递规则处理。已经入队、后来才因授权撤销而受阻的消息，原因以 `MESSAGE_GRANT_MISSING:` 开头，**不占用同一 Session 的队列**：它保持 queued、会话页可见，补上授权后按原顺序记录继续，后面的消息不再等它。

在私有 integrations 文件中增加：

```json
"leaderResultNotices": {
  "enabled": false,
  "pollIntervalMs": 2000,
  "packets": false,
  "targets": [{
    "projectId": "PROJECT_UUID",
    "sessionId": "MANAGED_LEADER_SESSION_UUID",
    "receiverRoleId": "LEAD_ROLE_UUID",
    "receiverActorId": "ACTUAL_LEADER_ACTOR",
    "senderActorId": "AUTHORIZED_NOTIFIER_ACTOR"
  }]
}
```

`packets`（默认 `false`）控制通知包，见[下文](#leader-通知包)。同一项目只配一个目标。通知只引用 Task 和结果的固定入口，Leader 不能凭通知摘要自动签验收。

### 打开

1. 保持 `enabled:false`，核对配置、身份和存储。
2. 确认旧 Leader 的消息 Turn 都已静默，没有结果未知的处理。
3. 新实例第一次打开前，先处理迁移导入的通知（见下一小节）。
4. 把 `enabled` 改成 `true`。通知泵每轮都重读这份配置，所以打开、关闭和改目标都不用重启服务；只有 `pollIntervalMs` 在启动时读取。
5. 用 `work leader notices --project PROJECT_ID` 核对通知从 `pending` 变成 `linked`，再用 `work message MESSAGE_ID --project PROJECT_ID` 核对消息的原生 Turn。这两条命令的完整参数见 CLI 自带的用法说明。

打开之后，分别核对：通知已入库、消息已保存、原生已接收和已读、Leader 已作安排、验收方已实际观察、Task 已完成。旧修订的 Delivery 和观察不能用来关闭新修订。

### 迁移之后先处理导入的通知

导入业务历史时，数据库触发器和正常写入一样会登记通知（[部署与迁移 §5](../architecture/deployment.md#5-迁移之后重新接入)）。这些通知对应的事实在旧主机上大多已经送达或处理过，直接打开会让 Leader 重新收到一遍。打开之前，先用 `work leader notices` 列出 `pending`，逐类处理：

- **通知泵会自动处置的两类。** 待编排 Task 的通知：Task 已不是当前修订下未分派的 todo 时，投递前会自动处置。阶段关注的通知：来源已过期时同样自动处置。
- **要人工处置的其他类型。** 交付、观察等通知不会被自动处置。旧主机已送达、已关闭，或已被后来的交付取代的，由维护者在打开前标为 `blocked`，并逐条写明原因。

2026-11-09 新实例打开前，维护者一次性把 163 条导入通知标为 `blocked`，其中 160 条带 `MIGRATION_REPLAY_*` 原因；另有 5 条由通知泵自动处置（`ATTENTION_SOURCE_EXPIRED` 3 条、`TODO_SOURCE_NOT_TODO` 2 条），合计就是[阶段路线](../roadmap.md#当前基线)里的 168 条阻塞。维护者用到的原因有：

| 原因 | 含义 |
| --- | --- |
| `MIGRATION_REPLAY_DELIVERED_ON_SOURCE` | 旧主机已送达 |
| `MIGRATION_REPLAY_SOURCE_CLOSED` | 来源 Task 在旧主机已关闭 |
| `MIGRATION_REPLAY_COVERED_BY_BACKLOG_TRIAGE` | 已由积压整理覆盖 |
| `MIGRATION_REPLAY_BLOCKED_ON_SOURCE:<原因>` | 旧主机上就已受阻 |
| `SUPERSEDED_BY_LATER_DELIVERY` | 已被后来的交付取代 |
| `LEADER_OWN_DELIVERY` | Leader 自己的交付 |

这一步现在**没有正式命令**。服务和 CLI 都不会写这些原因；这批标记由维护者在通知泵关闭时直接改写数据库里的通知记录（`state` 与 `blocked_reason`），不经过权限检查，也没有操作回执。

### 读取与诊断

- **读取。** `work leader notices --project PROJECT_ID` 读取通知及其固定来源，`--task TASK_ID` 限定一个 Task。
- **三种状态。** `pending` 是尚待投递，会记下最近一次没能投出的原因，例如 `LEADER_NOTICES_DISABLED`、`LEADER_TARGET_UNCONFIGURED`、`MESSAGE_GRANT_MISSING`、`LEADER_SESSION_UNAVAILABLE`、`OLD_LEADER_NOTICE_IN_FLIGHT`。`linked` 只表示已保存一条受管 Session 消息。`blocked` 带不可重试的原因。
- **修复后自动继续。** 缺授权、Session 暂不可用或旧 Leader 有在途处理时，修好之后，通知泵会从同一条通知继续投递，不必新建。
- **收件人固定后不改投。** 已固定收件人的通知不会自动改投到新 Session。

### 被拒绝之后恢复

原 `session.message.post` 的操作日志明确拒绝时，原通知转为 `blocked`，不再用原 ID 自动重试；结果未知时只读原 operation 对账。

要重新投递，由有 `management` 类别与决定权的操作者处理：

1. **先核对。** 核原 operation 的拒绝、当前 Task、消息状态和旧目标的 Turn。
2. **建立新意图。** 用 `request leader.notice.recover --project PROJECT_UUID --id ORIGINAL_NOTICE_UUID --file BODY.json --receipt LOCAL_RECEIPT_UUID`。BODY 包含原 `expectedOperationId`、全新的 `newNoticeId`、`newMessageId`、`newOperationId` 和处置 `reason`。
3. **读回结果。** 原通知用 `get /api/projects/PROJECT_UUID/work-management/notices/ORIGINAL_NOTICE_UUID` 读取，可以核对关联和结果。写入应答不明时，用 `receipts reconcile LOCAL_RECEIPT_UUID` 核对原通知和新通知的固定身份，不另造一组 ID 重发。

新通知保留源事实和原拒绝的关联，按当前唯一的 Leader 目标投递。原通知、拒绝记录和历史成本都不改写。

### 安排验收

Leader 读到交付后，按 Task 声明的验收方式，用 `acceptance.assign` 安排验收（命令见 [Agent CLI](agent-cli.md#观察会话具体接手与普通消息)）。常规验收由 Leader 指派受管验收 Session；较难的交承担难验收的那个验收身份，样本、反例和判据在 Task 正文中先设计好。消费者写受管验收身份；需求 Session 不做验收者，只照验收结论合并与发布并事后抽查（DEC-046，试行）。消费者一时改不了的在途 Task，以及需求 Session 自己的 PR，由 Leader 另建“合并前验收”或“正式验证”Task 交验收 Session 完成。使用者亲用时写人；Leader 只在使用者为某项 Task 明确要求时验收。交付作者和安排者都不能验收；执行者自检、CI 与 Run 终态是交付证据，不是验收。安排受阻会留下一条 `acceptance_blocked` 通知；验收结果仍以观察通知回到 Leader。

### 关闭与回退

把 `enabled` 改回 `false`，下一轮起就停止自动投递，数据库里的通知和已保存的消息都保留。已在途或结果未知的原生 Turn，先按原 operation 对账。数据库迁移不回滚、不删表，以免丢失结果历史。

## Session 不可用：读板、被拒与同因连续失败

`work board`、`list sessions`、Session 目录（`dispatch`）、容量和工作台状态行里写“不可用”的 Session 不要派活，原因和补法写在旁边：没有绑定业务身份或身份不是项目写入者（给这个 Session 配 `runtime.materialCli` 精确绑定，同 Role 只有一个 Session 时才可由 `residentQueue.roleActors` 代替，身份须是项目写入者；两处每次使用重读，不需要重启）、没有原生线程记录或状态不是 ready（恢复或重建 Session）、`USABILITY_UNKNOWN`（判断本身出错：读私有配置或身份文件失败，查服务日志；没有结果前一律按不可用处理）。向它预留 Run 得到 `SESSION_UNUSABLE` 或 `SESSION_USABILITY_UNKNOWN`，没有 Run 产生，对每个需要执行的 Task 都一样。补齐后下次读取即恢复。同一 Session 连续三次以同一原因没能开工（预检失败的 Run 和被拒的预留算同一序列）时，Leader 收到一条 `session_repeated_failure`（立即级），需求 Session 也各收到一条消息；项目里没有受管的需求 Session（正式项目常见）时，不会丢：`get /api/projects/PROJECT/session-attention` 里该项带 `skipped: NO_REQUIREMENTS_SESSION`，投递失败的带原因，Leader 的通知照常；需求 Session 是身份文件里 `senderClass` 为 `requirements` 的身份所对应的 Session，消息用 Leader 通知的发送者发出，所以该项目要配置了 `leaderResultNotices` 的发送者，没配置时投递行记 `NOTICE_SENDER_UNAVAILABLE` 并每轮重试。处理原因后不需要手动清除。**判断不到的**：原生线程在运行时一侧不可用而数据库里仍有线程记录的情形，数据库看不出来，这类 Session 仍可能显示可用，直到 Run 失败；连续三次同因失败的通知会兜住它。

## Leader 停摆时的代派预案（草稿）

**状态：草稿。** 只在自建隔离实例上用真实 CLI 实跑过（脚本 `tests/manual/leader-down-dispatch.ts`，替身与未走的部分见下），没有在正式环境做过，也不是已采纳的分工；分工文字由需求 Session 在使用者取舍后决定。

- **触发。** Leader 的 Session 因提供方暂停（`work board` 里 Leader 那一行 `held`）或别的原因超过 30 分钟没有回合，且需要派的 Task 只需要没被暂停的提供方（例如 Claude）。
- **范围。** 已就绪（`todo`、不在任何队伍里、没有分派）、负责 Role 在没被暂停的提供方上有可用 Session 的 Task。暂停只按目标 Session 的提供方判断：Codex 暂停时，追加给 Claude Session 的队伍项照常开始，追加给 Codex Session 的则等在确认一步、不产生 Run（自建实例读回）。
- **身份。** 需要读、写、**审阅**三项权限的非 Leader 身份；只有读写的身份 `line.append` 与 `acceptance.assign` 都得到 `FORBIDDEN`（读回）。队伍的推进（确认、预留、开始）由协调服务的队伍泵做，不需要 Leader 的模型回合；泵要能解析目标 Session 的业务身份（该 Session 自己的 `runtime.materialCli` 条目）。
- **步骤与命令。**
  1. `work board --project P --brief`：确认目标 Session 没被暂停、不是“不可用”，Task 在“已就绪、没在队伍里”里。
  2. `command run`：`{"type":"line.append","sessionId":S,"taskId":T,"expectedTaskVersion":V,"reason":"Leader 停摆，由需求 Session 代派：<原因与时间>"}`。读回 `applied`。
  3. 等目标 Session 做执行确认（它自己的回合，`task.assignment.acknowledge` verdict=confirm）；确认后泵开出 Run，队伍项为 `started`。
  4. 交付后安排验收：**只发一条普通消息不够**——它让验收 Session 知道有活，但验收接力记录为空，之后没有可链接的安排；用 `request acceptance.assign --project P --id T --file BODY.json`（`mode: session`，`sessionId` 是验收 Session，`senderActorId` 是自己），读回接力 `linked`、消息 `queued`；验收者用自己的身份读 `acceptance-relay/mine?direct=1` 能看到这一项。
  5. 记录：`reason` 里写明代派与时间；事后在需求 Session 的过程文档里留一条。
- **Leader 恢复后对账。** 额度释放后 Leader 的看板不会把该 Task 当作“已就绪、没在队伍里”再提；它的 `task.start` 因 `QUEUED_IN_SESSION_LINE` 被拒。对当前修订已交付的 Task，Leader（或任何有审阅权限的身份）再 `line.append`（给原 Session 或同一职责的另一个 Session）、`task.assignment.set`、`runtime.run.reserve`，在当前 main（含 1314c6f5 守卫）上**都返回 `TASK_ALREADY_DELIVERED`**，Run 数、assignment 和队伍项都不变（自建实例读回，原文返回见 Task b6afe4a5 的复跑报告）。要重做同一个 Task，只能由声明的消费者对最新交付记 `notUsed`／`failed`，服务端只为原交付登记一条 `source=rework` 的内部队伍项，原 Session 确认后开出一个新 Run（并派生新的 Task 修订），新交付登记后外部三入口对新修订同样被拒。Leader 的“新 Task 待分诊”类通知可能仍在待处理，它的通知泵在这个实例里没有运行，是否会被判过期没有验证。
- **没验证的部分。** 原生步骤（开始派发、绑定 Turn、记录完成）由脚本替身；交付行直接写入（真实交付要经 Run 的签名提交）；验收 Session 对消息的处理与已读回执、观察链接与 `task.close` 没有走；没有在正式环境做任何一步。
- **产品守卫已有。** 原先的缺口（对已交付 Task 再 `line.append` 会开出第二个 Run）已由 1314c6f5 的 `TASK_ALREADY_DELIVERED` 守卫关闭，见上一条。

## 2. 即时输入

即时输入让用户从工作台发给 owned Session 的消息立即进入执行：Session 正在跑时补入当前 Turn，空闲时直接在原会话开一个新 Turn。设计和规则见 [Session 运行时 §3](../architecture/session-runtime.md#3-即时输入执行中收到的消息怎样处理)。

### 配置

`directInputs` 默认关闭。打开时，要为同一个 Session 另加一条即时输入授权，并且它必须与普通消息授权 `sessionMessages.grants` 一起使用：即时输入授权不能替代 sender、receiver、Role、cwd 或累计 Turn 上限。

```json
{
  "directInputs": {
    "enabled": true,
    "grants": [
      {
        "projectId": "PROJECT_UUID",
        "sessionId": "OWNED_SESSION_UUID",
        "senderActorId": "USER_ACTOR",
        "canSteer": true,
        "canStart": true
      }
    ]
  }
}
```

即时输入授权只增加“可送入 / 可空闲直启”，准入还要求一条同 sender、同 Session 的普通消息授权。普通消息授权里的 `receiverActorId` 写该 Session 的**业务身份**（`runtime.materialCli` 的 `cliActorId`，或 `residentQueue.roleActors` 里该 Role 的 `actorId`），不是预约或创建 Session 的 `runtime_session.actor_id`；准入按普通消息路径的业务身份绑定核对它，不再要求它与预约身份相等。

```json
{
  "sessionMessages": {
    "enabled": true,
    "grants": [
      {
        "projectId": "PROJECT_UUID",
        "sessionId": "OWNED_SESSION_UUID",
        "senderActorId": "USER_ACTOR",
        "receiverActorId": "SESSION_BUSINESS_ACTOR",
        "receiverRoleId": "ROLE_UUID",
        "cwd": "/absolute/session/cwd",
        "enabled": true
      }
    ]
  }
}
```

**验收前置。** 即时输入的验收除“发布并重启（加载新特性表）”外，还要求私有配置里已启用 `runtime`、写好 `directInputs` 和同 Session 的 `sessionMessages.grants`，且 `receiverActorId` 与该 Session 的当前业务身份一致；缺任一项时能力查询只会回答不可用，不能据此判定实现通过。

服务每次请求都会重读这份配置；但只有服务启动时已启用运行时，即时输入入口才存在。

### 入口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/projects/:projectId/sessions/:sessionId/direct-input-capability` | 能力查询：返回 `steer`（补入）、`start`（空闲直启），或都不可用 |
| `POST /api/projects/:projectId/sessions/:sessionId/direct-inputs` | 提交，正文含 `inputId`、`operationId`、`content`、`expectedTurnId` |
| `GET /api/projects/:projectId/sessions/:sessionId/direct-inputs/:inputId` | 读回一条输入 |
| `POST /api/projects/:projectId/sessions/:sessionId/direct-inputs/:inputId/reconcile` | 按原 `inputId` 只读对账 |

所有读取都按当前项目、actor、Session 类别与 `sessionIds` 范围重新授权。客户端自报的 `human`、`direct` 或角色名不能替代授权。

能力查询和提交使用同一组检查：当前 writer、Session 执行授权、普通消息授权、即时输入授权、cwd、原生资格，以及 Session 实际绑定的运行时能力。只有查询明确返回 `steer` 或 `start` 时，工作台才显示即时发送；否则只保留普通消息入口。`steer` 需要 `delivery.midTurnInput`，`start` 需要 `delivery.idleTurnStart`。

**运行时限制。** Codex 的 `0.166.0-alpha.6` 与 `0.167.0-alpha.3.2` 支持运行中补入；所有现代 Codex 协议支持空闲直启。Claude 不支持即时输入。`thread/settings/update` 只属于执行配置切换，alpha.6 支持，0.167 不支持；不要再把补入与配置切换绑成一个开关。

**发送给 Leader 的两条路与 `TURN_CHANGED`。** 工作台和 CLI 都可以选“插入当前这一轮”或“排队”。插入时若人看到的那一轮已经换了、主回合还没绑定 Turn，或人以为空闲而 Session 已在运行，输入自动转为一条排队消息（原输入 ID 和操作 ID，只有一条），回执 `state=rejected`、`queuedMessageId` 非空、原因以 `TURN_CHANGED:` 或 `NOT_BOUND:` 开头；重复提交同一输入 ID 返回同一份回执，仍只有一条；`session.message.post` 不接受已是即时输入的消息 ID。迁移 096 放宽 `session_direct_input` 的检查约束，允许“被转排队的直启”这一行。缺授权时能力查询在 `detail` 里写出缺哪一项，提交的 `DIRECT_GRANT_MISSING` 也一样（只写项目名称，不回显授权内容）。CLI：`session input send SESSION --project P --mode insert|queue --content TEXT`、`session input show SESSION INPUT --project P`，说明见 [CLI 指南](agent-cli.md)。

**并发与不可补入回合。** 业务 Run 或普通消息开新一轮、用户即时输入和后续通知包送入共用每 Session 一把短锁。锁前撞车返回 409 `SESSION_INPUT_BUSY`，没有预占输入；适配器在途检查在已持久化意图后拒绝时，也证明没有写入原生传输，服务保留同一输入编号与操作编号供重试。两种情况都不关闭恢复门；业务 Run 保持 `requested` 等下一轮，普通消息留下待处理原因后下一轮重试同一操作，工作台保留草稿和原输入编号。只有结构化 `codexErrorInfo.activeTurnNotSteerable`（`turnKind` 为 `review` 或 `compact`）或 0.167 的精确文字才把 direct input 记为 `rejected`，并把同一内容写成一条普通排队消息；`TurnError.misalignment.steer` 是失败回合的继续指令，不是补入拒绝。补入已被接受、回合随后失败且没有对应输入 Item 时，该输入保持未读，不因送达回执算作已读。

### 占用、未知与恢复

- **一个 Session 同时只有一个槽位。** 直启在 PostgreSQL 事务里锁定原 Session，并检查业务 Run、消息处理和排队消息。处于 `requested`、`dispatching`、`running` 或 `unknown` 的占用，都不会因为“原生看起来空闲”而被越过；重复点击也只会得到一条处理记录。
- **先存意图，再调用运行时。** 回执丢失、数据库提交结果不明或历史尚未物化时，记为 `unknown` 并保留槽位，不换 ID 重发。
- **对账只读原输入。** 恢复只读取原 `inputId` 的原生 Turn 和 Item 历史，或由现有 owner 泵对账原 operation 标记。零 Turn、方法不可用、多个候选或读取不完整，都继续保持 `unknown`；“查不到”不等于被拒绝。
- **什么才算拒绝。** 只有明确的原生拒绝，或发送前授权发生变化，才记为 `rejected`。终态按原处理记录、operation、原生 Turn 和版本做 CAS 释放；迟到的旧终态不能清掉后来建立的槽位。
- **撤权之后。** sender 撤权后不能再建立新补充；受信的 owner 仍可完成原 Turn 和原处理记录的对账与结算。

预占之前的明确拒绝不是 `unknown`。例如提交得到 409 `DIRECT_GRANT_MISSING`，再读原输入得到 404：工作台按可信回执显示“明确未接收”，清除待决状态，只保留可展开的 input 和 operation ID 作审计，不把它恢复成未知草稿，用户修正后可以重新发送。

证据表是 schema 059 的 `session_direct_input`：记录不可删除，身份不可改写；只有原处理记录到达终态，或精确的 Turn 前拒绝之后，才释放对应的恢复门。它不改已有 Run 的固定输入。

### 检查

| 检查 | 覆盖什么 |
| --- | --- |
| `apps/workbench/test/direct-input-client.test.ts` | 能力响应；503 之后 404 时保留原输入；400、409 等预占前明确拒绝的区分；`SESSION_INPUT_BUSY` 可重试 |
| `apps/coordinator/test/direct-input-admission.test.ts` | 准入把普通消息授权的 `receiverActorId` 解析为 Session 业务身份；A 预约、业务身份 B、授权写 B 时通过，授权仍写预约身份时拒绝 |
| `apps/coordinator/test/direct-input-service.test.ts` | 按实际运行时能力回答；共享送入锁的撞车、重试与无持久写入；不可补入回合转为普通排队消息；期望的 Turn 已换时存储层转排队、不向运行时发送；缺授权时名称写在能力和提交里 |
| `packages/adapter-postgres/test/direct-input.test.ts` | 在独立 PostgreSQL schema 里检查双启动唯一槽位、Run 与消息两种主来源、同一 Turn 的两条补入、TaskRevision 与输入哈希不变、额度、撤权、未知和终态 CAS |
| `apps/coordinator/test/direct-input-native-live.mts` | 用 `LIVE_CODEX_VERSION` 固定的真实二进制在隔离的 HTTP、PostgreSQL 和 Thread 中执行一次直启和两条补入，回读三个精确的 client ID 和 Item；W3 用 0.167.0-alpha.3.2 记录 |
| `apps/coordinator/test/direct-input-native-sources-live.mts` | 同一隔离边界里，分别对已有业务 Run 和普通消息处理各补入两条；前者核对固定 Run 输入未变，后者由现有泵完成终态结算 |

浏览器回归要看：普通 owned 入口、长历史、unknown 卡、409 明确拒绝与刷新后的审计和不恢复策略、390 宽与正常宽与短窗、减少动态效果、工具详情授权、Task 往返和滚动锚点。390 宽用真实的 CSS 宽高、DPR 和 `visualViewport.scale` 验收，不靠缩字、放大视口或隐藏 unknown 通过。页面本身的设计见 [Sessions 页面](../frontend/pages/sessions.md)。

隔离环境里的原生试跑只证明固定二进制和隔离数据路径，不证明正式服务已启用配置、已部署迁移，也不证明验收方或用户已在正式入口使用过。

## 3. 托管压缩

Session 因失败被恢复门挡住时，维护者可以显式请求一次原生压缩，再决定是否恢复。设计和完成判据见 [Session 运行时 §4](../architecture/session-runtime.md#4-托管压缩)；记录表是 schema 058 的 `session_compaction`。

### 前提

- 运行时是 Codex 固定 `0.166.0-alpha.6`；Claude 不支持托管压缩。
- 私有配置 `runtime.compaction.owned` 不为 `false`（默认 `true`，启动时读取）。设为 `false` 时关闭这组入口，压缩完全交给运行时自己。
- 请求者有当前项目的 Session 类别与 Session 决定权，以及该 Session 的精确运行授权。
- 恢复门处于 `blocked`，原失败 Run 或消息有已知终态。

正式操作前，回读原 Thread 的模型、思考强度、权限、当前 writer、最后一个原生 Turn、未知的在途处理和有效 hooks。任何一项无法证明，就保留 blocked 门，并记录准确缺了什么。

### 命令

1. 用 `request schema runtime.compact.start` 核对字段。
2. 提交 `request runtime.compact.start --project PROJECT --id SESSION --file intent.json`。文件正文为 `operationId`、`threadId`、`expectedSessionVersion`、`expectedGateVersion`、`evidenceRef`、`reason`。相同 operation ID 加完全相同的正文只会读回原结果，不同正文被拒绝。
3. 用 `get /api/projects/PROJECT/runtime/compactions/OPERATION` 读取原操作。
4. 用 `request runtime.compact.reconcile --project PROJECT --id OPERATION --file empty.json` 只读原生证据并更新原记录，`empty.json` 的内容为 `{}`。
5. 确认完成后，仍由有权者单独执行 `runtime.session.recovery.resume`。压缩本身不开门。

### 怎样读结果

| 结果 | 什么时候出现 | 怎么办 |
| --- | --- | --- |
| `accepted` | 压缩 RPC 得到合法的 `{}` 应答 | 继续对账，等完成证据 |
| `completed` | 同一个已绑定的压缩 Turn 有完成的 `contextCompaction` Item、Turn 已结束、原 Thread 空闲 | 由有权者决定是否恢复 |
| `failed`，`nativeRequestId` 为空 | 发出压缩请求之前，owner 恢复、Thread 读取、执行配置、基线或连接检查明确失败，记带阶段码的失败 | 按阶段码修正；这不是原生结果未知 |
| `failed`，有原生请求 | 已绑定的 Turn 明确失败且有完成时间，或没有匹配 Turn 的明确原生拒绝 | blocked 门保留 |
| `unknown` | 丢回包、发送中断、连接已更换、历史有歧义；或已收到匹配的 Turn 开始事件后又收到无法归属的服务端错误 | 按原 ID 对账，不用新 ID 重发 |

外层 Turn 显示 `completed`，但缺少成功的压缩 Item，不算成功。原生 Thread 读取没有可靠的压缩前后 token 总量，所以回执里的 `beforeInputTokens`、`afterInputTokens` 可以为 `null`。

原失败 Thread 为 `systemError`，或重启后为 `notLoaded` 时，入口要求原失败 Turn 有完成时间，再由当前 owner 用完全相同的执行配置执行 `thread/resume`；恢复后，最后一个 Turn 必须仍是原失败 Turn，且没有活动的 writer。不借新 Thread 绕过。

### 隔离测试

验收方可以在专用的 PostgreSQL 测试库运行手工脚本：

```sh
TEST_DATABASE_URL="$DEDICATED_TEST_DATABASE_URL" \
E1_MANIFEST_PATH="$PRIVATE_MANIFEST_FILE" \
E1_PORT="$FREE_LOCAL_PORT" \
node --import tsx tests/manual/session-compaction-e1.ts
```

三个变量分别指向专用测试库、仓库外的私有 manifest 文件和一个空闲端口。

- **脚本做什么。** 启动真实的 HTTP 服务，把随机生成的项目、Session、Thread、恢复门版本和两种测试身份的令牌写进权限为 0600 的 manifest。它的原生接口是一个**受控的丢回复替身**。
- **验收方做什么。** 从 manifest 取值，通过 HTTP 或 CLI 发一次 `runtime.compact.start`，再用同一 operation ID 读回，并测试改正文被拒、只读身份被拒。
- **重启与清理。** 重启脚本会得到新的独立 schema 和未用过的样本。结束时先停脚本，再按 manifest 里 `compact_e1_` 前缀的 schema，用专用测试库的 `DROP SCHEMA ... CASCADE` 清理。

这个入口不验证有认证的 alpha.6 模型压缩；隔离迁移和 PostgreSQL、HTTP 回归也不代表原 Leader 的真实压缩已经验证。

## 4. 普通 Task 的每日复制

普通 Task 可以设一个执行时点，并可选每天重复。一次性时点和停止复制不需要额外授权；**每日重复**需要私有配置授权。复制规则见[一次与每日复制](../architecture/contracts.md#普通-task-的一次与每日复制)，命令见 [Agent CLI](agent-cli.md#提交与核对)。

### 授权

在私有 integrations 文件的 `scheduling` 对象中配置 `taskTimingGrants`，每项只含精确的 `projectId`、业务 `actorId` 和 Task owner 的 `roleId`：

```json
{"scheduling":{"enabled":true,"grants":[],"taskTimingGrants":[{"projectId":"<PROJECT_UUID>","actorId":"<BUSINESS_ACTOR>","roleId":"<OWNER_ROLE_UUID>"}]}}
```

- **授权范围。** 有了这项授权，该业务 actor 可以用普通 `task.create` 或 `task.timing.set`，为同一 Role 的新 Task 设每日重复，不必为每个尚未创建的 Task ID 预先添加范围。
- **仍要满足的条件。** actor 在当前项目是成员，有 `task` 类别与 Task 决定权，Task owner 是有效 Role，`scheduling.enabled` 已打开。
- **每次重读。** 创建、改时和物化时都重读授权；物化只选同项目、同 actor、同 Role 的已保存系列，并重核当前授权和身份资格。撤权后不能再创建、修改未来要求或继续复制。

`taskTimingGrants` 与旧的 `scheduling.grants` 是两回事：

- 后者按精确 scope 授权旧 Schedule，不能填 `task-timing:*`。
- 前者不能创建或物化旧 Schedule，也不授予新的 Session 或 Run 执行资格。
- 已经存在的 `task-timing:<首个 Task ID>` 精确授权，仍可继续管理原系列。

### 读时间

读取 `tasks/TASK_ID/timing` 得到下面这些字段：

| 字段 | 含义 |
| --- | --- |
| `executeAtUtc` | 当前这份 Task 自己的约定时点 |
| `nextTaskId` | 已生成的后一份 Task，可能已经完成 |
| `occurrences` | 每份历史时点 |
| `nextAtUtc` | 只对活跃的每日系列有值：下一个尚未物化的日历时点；停止或一次性时为 `null` |

项目内全部系列（含已停止的）可读 `GET /api/projects/PROJECT_ID/task-timings`，工作台日程页的“定时任务”一栏用它。工作台对停止的系列显示“已停止后续复制”，对一次性时点显示“仅本次”。已生成的后续 Task 的时间和链接仍可读。活跃系列的下一时点已过、却还没物化时，标为待补约定时点，并保留等待原因。

物化时的阻断（授权撤销、owner 退休、Stage 失活、消费者资格不成立、材料不可读、版本冲突、结果未知等）会保留原记录和可读原因，交给 Leader 处理。这个功能实施前的逐字段分析，见[普通 Task 定时复制：实施前分析](../references/task-timing-copy-design.md)。

## 5. 阶段关注

服务从已有事实推出每项进行中的 Task 停在哪一环、在等谁，并对超过门槛的环节生成持久关注项。规则、来源和门槛见[阶段等待由事实推导](../architecture/contracts.md#阶段等待由事实推导)。

- **怎样运转。** 没有配置开关：服务运行时，每 30 秒为有 `management` 类别与决定权身份的项目评估一次。
- **怎样送到 Leader。** 关注项以 `task_attention` 类型的 Leader 通知送达，所以要先打开 [Leader 结果通知](#1-leader-结果通知)；没打开时，关注项照常生成，用 CLI 读取。
- **怎样读。** `work task`、`work attention`、`work attention task`、`work attention item`、`work attention thresholds`（见 [Agent CLI](agent-cli.md#观察会话具体接手与普通消息)）。
- **怎样调整与跟进。** 项目默认门槛和单 Task 检查点用 `task.attention.thresholds.set` 修订并留历史；跟进、发布交接和处置分别用 `task.attention.followUp.set`、`task.attention.publication.record`、`task.attention.resolve`。

门槛只要求核查，不代表 Run 失败；关注项不会自动取消、重试或关闭 Run，也不重置预算。隔离候选页面的截图见[桌面 1280×900](../assets/task-stage-attention/desktop-1280.png) 和[窄窗 390×844](../assets/task-stage-attention/narrow-390.png)，两张都来自合成的测试项目，不代表正式通知已送达或已读。

## 叫停执行中的 Run

业务 Run 的范围变了就叫停，不要等它做完再返工：`command schema runtime.run.stop` 取结构，带 Run 的当前版本和理由，用 `command run FILE` 提交；身份要有 Session 类别与 Session 决定权并持有该 Session 的精确执行授权，原生运行时离线时也能提交（未派发的 Run 在数据库里直接判失败，运行中的由 runner 在运行时恢复后中断）。提交后回读 Run：`stopRequestedAt` 已有、`interruptRequested` 为真表示等运行时中断；终态（`interrupted` 或 `failed`）由运行时观察确认，在此之前仍算未结束，Task 上不能再派新的 Run。用这个 Run 再提交会得到 `RUN_STOPPED`，叫停前已签的意图作废，不会产生交付。停止不会关恢复门，也没有失败通知，只有一条 `run.stopRequested` 运行事件。结果未知的 Run 也可以叫停：标记立即生效，有已知 Turn 的会被中断，Run 仍是 `unknown`，直到读回终态；读回终态后，被它关闭的恢复门自动打开（队列认领持有的门除外）。被叫停作废的排队消息带持久的“被取代”标记，选取与准入都排除，发送人取消或 `session.message.confirmSuperseded` 确认后才重新投递。

## 处理关不掉的 Task：旧的或卡住的验收接力（迁移 109）

`task.close` 被 `SQLSTATE 23514 effective acceptance arrangement lacks linked consumer use` 拒绝，说明同一交付上还有一条有效接力没有已链接的 used。先读这个 Task 的接力（`work acceptance TASK`，或 `get /api/projects/PROJECT/tasks/TASK/acceptance-relay`），确认哪条是旧的（接收者当时记 notUsed，后来有另一条接力记了 used）或卡住的（`blocked`），再用 `request acceptance.release` 逐条释放（需要 Task 类别与决定权、写明理由；同一阶段至少要留下另一条有效接力，否则拒绝），释放后重试 `task.close`。

发布迁移 109 后对两个正式 Task 的处理（**不做迁移里的一次性数据修复**：哪条过时是 Leader 的判断，理由要留在记录里）：

- `d596d7f6`：交付 1f21590f 上的接力 807c9510（11-11 18:03，当时记 notUsed，因为 #322 还没合并）释放，理由写“已由 aad18785（11-11 21:16，正式补核，记 used）取代，按需求 Session 的决定”；然后 `task.close`。
- `dcd01bb1`：交付 b42af967 上现在只有一条接力 964982d7（候选，blocked：`MESSAGE_BINDING_CHANGED`，版本 2，消息已 replied）。**直接释放它会得到 `LAST_ARRANGEMENT`**（同一阶段不能一条有效接力都不剩），所以先要有一条能记 used 的新接力。顺序固定，命令都用 `request`，操作编号只写在 body 的 `operationId`（不带 `--receipt`）：
  1. **读现状。** `work acceptance dcd01bb1-18a1-4431-8dd3-8077d0c4e23b --project PROJECT` 与 `task dcd01bb1-18a1-4431-8dd3-8077d0c4e23b --project PROJECT`：记下 964982d7 的 `version`（释放时要用）、交付 b42af967 仍是最新交付且 `taskRevisionId` 等于 Task 当前修订、Task 当前 `version`（`expectedTaskVersion`）。
  2. **新建一条候选接力。** `request acceptance.assign --project PROJECT --id dcd01bb1-18a1-4431-8dd3-8077d0c4e23b --file BODY.json`，body：`projectId`、`taskId`、`relayId`（新 UUID）、`operationId`（新 UUID）、`expectedTaskVersion`、`deliveryId`=b42af967 的完整编号、`stage`=`candidate`、`scopeKey`（**必须换一个新的**，如 `usage-ledger-followup-candidate-2`；同一交付、阶段、范围已有有效接力会得到 `ACCEPTANCE_ALREADY_ASSIGNED`）、`scopeDescription`、`entrypoint`、`publicationRef`、`mode`=`session`、`recipientActorId`=`acceptance-claude-agent`、`sessionId`（验收 Session）、`senderActorId`（发起安排的身份，须等于调用者）、新的 `messageId` 与 `messageOperationId`、`reason`、`supersedesRelayId`=null。需要 Task 类别与决定权。不能用“取代”（`supersedesRelayId` 指向 964982d7）代替：取代要求同一范围，且旧接力的消息已处理完（replied）时得到 `ACCEPTANCE_IN_FLIGHT`。失败分支：`DELIVERY_CHANGED`（交付或修订变了，重新读第 1 步）、`VERSION_CONFLICT`（Task 版本变了，重读后用新版本重提）、`SESSION_NOT_READY` / `SENDER_MISMATCH` / `INDEPENDENT_SESSION_REQUIRED`（验收 Session 或发起身份不满足条件，由有权者补齐，不要绕过）。
  3. **验收者对新接力记一次新的 used，并链接。** 消息送达后，验收 Session 读它、再用自己的身份 `observation.record`（`used`，`observerKind` 为 `agent`），然后 `request acceptance.observe --project PROJECT --id 新接力 --file BODY.json`（body：`projectId`、`taskId`、`relayId`、`operationId`、`expectedVersion`=新接力当前版本、`observationId`）。**不能链接已有的观察 d3917f31**：它记于 11-13 02:03，早于新接力的创建时间，会得到 `OBSERVATION_MISMATCH`（观察必须不早于它所链接的接力）；d3917f31 留作证据，不改。链接成功后读回新接力的 `observationResult` 为 `used`。
  4. **释放 964982d7。** 先重读它的 `version`（若不是 2 就用读到的），再 `request acceptance.release --project PROJECT --id 964982d7-25d1-45a5-b97a-92b10c677955 --file BODY.json`，body：`projectId`、`taskId`、`relayId`、`operationId`（新 UUID）、`expectedVersion`、`reason`（“消息绑定的 Task 修订与交付修订不一致；已由新接力 <新接力ID> 取代并记 used”）。失败分支：`LAST_ARRANGEMENT`（新接力没建成或已不是有效状态，回第 2 步）、`ACCEPTANCE_CHANGED`（版本变了，重读后重提）、`ACCEPTANCE_IN_FLIGHT`（只在这条接力的消息真的还没落定时出现：消息状态是 processing 或 unknown。等它落定——replied、completed_without_reply、failed 或 cancelled——后重提；消息已经 replied 或 completed_without_reply 的卡住接力可以直接释放，不会得到这个错误，这正是 dcd01bb1 的情形）、`ARRANGEMENT_SATISFIED`（它已有 used，那是证据，不释放）、`FORBIDDEN`（身份没有 Task 类别或决定权）。读回：接力 `state` 为 `released`，`blockedReason` 带这条理由。
  5. **按决定关闭。** `command run` 提交 `task.close`（`expectedVersion`=Task 当前版本，`deliveryId`=b42af967 的完整编号，`acceptanceResult`、`acceptanceEvidence`、`reason`）；成功后 `task` 读回关闭记录。仍得到 23514 时说明还有别的有效接力没有已链接的 used，回第 1 步读全部接力。

**`dcd01bb1` 每一步一览**（命令、目标对象、身份与权限、回读、失败怎么办；顺序不能换，第 4 步在第 2、3 步之前得到 `LAST_ARRANGEMENT`）：

| 步 | 命令 | 目标对象 | 谁、要什么权限 | 回读 | 失败怎么办 |
| --- | --- | --- | --- | --- | --- |
| 1 | `work acceptance TASK`、`task TASK` | Task `dcd01bb1…`，交付 `b42af967…`，卡住的接力 `964982d7…` | 任何有读权限的身份 | 接力 `state`/`blockedReason`/`version`、Task `version`、交付的 `taskRevisionId` 等于 Task 当前修订 | 交付不是最新或修订对不上：先处理交付，不继续 |
| 2 | `request acceptance.assign --id TASK` | 新接力（新 `relayId`、新 `scopeKey`、同一交付、`stage`=`candidate`） | 有 Task 类别与决定权且等于 `senderActorId` 的身份（Leader） | `work acceptance TASK` 里新接力 `state` 为 `pending`，`version`=1 | `ACCEPTANCE_ALREADY_ASSIGNED`（换 `scopeKey`）、`DELIVERY_CHANGED`/`VERSION_CONFLICT`（回第 1 步）、`SESSION_NOT_READY`/`SENDER_MISMATCH`/`INDEPENDENT_SESSION_REQUIRED`（由有权者补齐，不绕过） |
| 3 | `observation.record`（`used`），再 `request acceptance.observe --id 新接力` | 新接力与验收者**在新接力创建之后**记的观察 | 验收者本人的凭据（接收者；agent 接收者用 agent 身份，人类接收者先 `acceptance.read`） | 新接力 `observationResult` 为 `used`、`observationId` 非空 | `OBSERVATION_MISMATCH`（观察早于新接力、或不是该接收者、该交付，比较精确到毫秒；重新记一条）、`HUMAN_READ_REQUIRED`、`AGENT_OBSERVER_REQUIRED`、`ACCEPTANCE_CHANGED`（版本变了，重读） |
| 4 | `request acceptance.release --id 964982d7…` | 卡住的接力 | 有 Task 类别与决定权的身份（Leader），写明理由 | 接力 `state` 为 `released`、`blockedReason` 带理由；`task_acceptance_relay_release` 有不可改的一行 | `LAST_ARRANGEMENT`（回第 2 步）、`ACCEPTANCE_CHANGED`（重读版本）、`ACCEPTANCE_IN_FLIGHT`（消息还在 processing／unknown，等其落定；replied／completed_without_reply 不算）、`ARRANGEMENT_SATISFIED`（已有 used 的不释放）、`FORBIDDEN` |
| 5 | `command run`（`task.close`） | Task，交付 `b42af967…` | 有关闭权限的身份 | `task TASK` 的 `task.state` 为 `done`，有一条关闭记录 | 仍是 `23514`：还有别的有效接力没有已链接的 used，回第 1 步读全部接力 |

两条都只用新命令，不改库。每次释放先读 `version`（`expectedVersion`），释放后读回接力状态为 `released`，`blockedReason` 带这条理由（`task_acceptance_relay_release` 里也有，不可改）。这一步需要发布后由 Leader 执行，我没有在正式实例上做。上述顺序（新接力 → 链接新的 used → 释放 → 关闭，以及其中的 `LAST_ARRANGEMENT`、`OBSERVATION_MISMATCH` 拒绝）已在自建实例用真实 CLI 进程走过一遍，见 `tests/integration/acceptance-release-cli.test.ts`（用的是人类接收者；`session` 模式的消息发送与处理没有在这条测试里走，那一段由 `tests/integration/acceptance-relay.test.ts` 在服务层覆盖）。设 `EVOLOOP_RELEASE_CLI_TRANSCRIPT=1` 运行它会逐条打印真实 CLI 命令原文（凭据来自环境，不显示）、退出码和输出，可作为照文档执行的对照。第 3 步的“早于新接力的观察不能链接”此前按秒比较（`Date.parse` 作用在数据库时间对象上会丢掉毫秒），同一秒内的早观察会被放过；现在按毫秒比较。

## 工作台之外的告警（Task 5da8b6d9，迁移 110）

提供方暂停、全组织停摆这两类事，原来只有桌面会话里的文字和工作台页面顶部的横幅，没人打开工作台就没人知道（2026-11-13 DeepSeek 额度用完，暂停 34.5 小时，使用者全程没有收到任何工作台之外的通知）。现在系统自己向一个**配置好的出口**发一条消息，不依赖 Leader、需求 Session 或有人打开工作台。

**什么时候发。** 每个有读、写、审阅身份的项目，每 15 秒评估一次（`pollIntervalMs`）：
1. **提供方暂停打开**：发一条“提供方已暂停”，写明提供方、原因类别（额度用完／认证失败）、开始时间（UTC）、受影响的 Session（职责和短编号，最多列 6 个，另报总数）、当时压着几件活（就绪未派、在队伍里排队、等验收各多少）和提供方给的原因（先脱敏、截到 200 字）。**放行**时再发一条“已放行”，写共暂停多久、放行人和理由。
2. **停摆**：从最近一次**真正开始的 Run** 起、或最近一次提供方放行起、或项目创建起，超过 `stallMinutes`（默认 30 分钟）没有新的 Run，现在没有 Run 在跑，**没有提供方暂停（暂停已经说明了原因，不再叠一条）**，并且有活在等（就绪未派的 Task、队伍里排队的项、**还没有任何观察的**等验收交付），才发一条“已超过 N 分钟没有新的 Run”。**普通消息 Turn 不算 Run，两个方向都不算**：它不会让停摆发不出来（周期性的需求代班消息短于阈值时，若算活动就永远不告警），也不会结束一次已发出的停摆（否则先发“停摆已解除”、再发第二条新告警，周期性消息会来回刷屏）。停摆只在**停摆开始之后创建了一个真正开始的新 Run**（越过启动前检查、有原生 Turn，或已在运行／已结束）、或不再有活在等时结束；**真正开始＝正在运行，或运行过并结束（completed、interrupted，或拿到原生 Turn 之后才 failed）；停在 requested 或 dispatching（预留了、没开始，派发卡住正是这条告警要抓的）、结果未知（unknown），以及启动前检查失败（RECIPIENT_UNBOUND 一类，没有原生 Turn）的 Run 都不算开始**：它既不结束已发出的停摆（不发恢复、不重发 opened，重复多少次都一样），也不推迟尚未发出的停摆，发一条“停摆已解除”；停摆期间新打开的提供方暂停不结束它。已有 `notUsed`／`failed` 观察的交付是已退回作者的，已有 `used` 观察的是已验收的，都不算等验收。安静时段没有活在等不发。

**不重复。** 每次事件是一行 `ops_alert`（提供方暂停按暂停编号 `hold:<id>`，停摆按开始时刻 `stall:<时间>`），开始消息和恢复消息各记送达时间；服务重启、换一个协调器实例、重复评估都不会再发一遍。

**出口。** 只有一种通用出口，由需求 Session 在私有集成配置（`EVOLOOP_INTEGRATIONS_FILE`）的 `alerts` 里接到使用者实际收得到的通道，用哪个通道不在这里决定：

```json
{ "alerts": { "enabled": true, "pollIntervalMs": 15000, "stallMinutes": 30,
  "outlet": { "kind": "webhook", "url": "https://…", "headers": { "authorization": "Bearer …" }, "timeoutMs": 5000 } } }
```

或 `"outlet": { "kind": "command", "argv": ["/绝对路径/notify", "…"], "timeoutMs": 10000 }`。webhook 把告警作为 JSON `POST` 出去（只接受 http/https，不跟随重定向，不读取也不保存对方的回答）；command 不经 shell，告警 JSON 写到它的标准输入，环境只有 `PATH`（要别的环境变量请在脚本里自己设）。没有 `alerts` 或 `enabled` 为 false 就一条也不发。

**消息格式。** JSON：`schema`（`evoloop.alert.v1`）、`projectId`、`key`（同一事件不变，接收方可据此去重或串成一串）、`kind`（`provider_hold`／`stall`）、`event`（`opened`／`resolved`）、`text`（一段中文，可直接当消息正文）、`facts`（同样的信息，结构化）。例：`【evoLoop 告警】Codex 提供方已暂停（额度用完）。从 2026-11-13T05:23:00.000Z 起不再开始新的 Turn；3 个 Session 受影响：功能开发（ab12cd34）…；当时压着 5 件活（就绪未派 2，在队伍里排队 1，等验收 2）。原因：…。放行后会再发一条恢复消息。`

**出口不可达时。** 告警只读系统状态、只写自己的 `ops_alert`：**暂停与放行本身不受影响**，没有任何东西在等告警送出去。送不出去就记错误类别（只记“请求失败／超时／HTTP 状态／命令失败”，不记地址或对方的回答），以 30 秒起倍增的间隔重试（最长 30 分钟，最多 12 次，之后放弃并在服务日志里写一行）；开始消息没送出去之前，恢复消息不会越过它先发。

**读回与限制。** `ops_alert` 表里可以读到每条的状态、开始／结束时间、送达时间、尝试次数和最后一次错误（没有专门的 CLI 命令）。限制：只有一个出口；告警只在协调器运行时发，协调器自己停了发不出（这类情况需要出口之外的存活探测，不在本 Task）；正式环境的出口配置和一次送达核验在发布后另做。

### 额度读数：读真实余额，报余额、每小时掉多少、还能撑几小时（Task a319d0ef；Task a19196b0 改成按余额）

DeepSeek 额度已用完四次，没有一次事先预警。有一个只读脚本 `scripts/ops/quota-reading.mjs`（任何人或定时任务可运行）。**它原来把“上一个完整周期用掉的量”当成这次的额度，再推算几点用完；但每次充值能撑的量差了近 10 倍（用完之前的输入 token 分别是 7.06 亿、3.35 亿、2.70 亿、0.72 亿），结果四次用完只提前报中一次，11-17 02:21 起还连续 10 次报“已超过额度”（140% 涨到 825%）而实际 20 小时没停。** 现在改成吃真实的余额读数，不再有“相当于上个周期的百分之几”，也不再有据此得出的“已超过额度”：

- **输入：余额读数文件。** 每行一条“时刻, 金额”（如 `2026-11-17T08:00:00Z, 38.5`，时刻与金额之间可用逗号、制表符或空格；也可写成 `{"at":"…","balance":38.5}`）；空行和以 `#` 开头的行跳过，读不出的行在输出第一行点出行号、不猜。位置经 `EVOLOOP_QUOTA_BALANCES`、`--balances` 或配置里的 `balanceReadings` 传入，必须是仓库外的绝对路径。文件不存在就是“没有余额读数”，不是错误。读数从哪里来、多久读一次，由需求 Session 在私有运维里接，不在这个脚本里。
- **输出（一行中文结论）。** 例如“余额 38 元（11-17 08:00 读数，刚刚），最近 3 小时每小时掉 2.1 元，照这个速度还能撑约 18 小时（约 11-18 02:00）”。余额取最后一条读数并写明读数多久以前；每小时掉多少只用**最后一次余额变多（充值）之后**的读数，且只看最后一条读数之前 `rateWindowHours`（默认 3）小时内的；还能撑多久 = 余额 ÷ 每小时掉多少，按读数时刻起算。
- **提醒与说不出的情形。** 还能撑不到 `lowHours`（默认 4）小时时，在结论末尾写“不足 N 小时，请提醒”，`--json` 的 `flags` 含 `low`，供调用方提醒；最后一条读数比 `staleHours`（默认 3）小时还旧时写明“读数已有 N 小时没更新”并标 `stale`。只有一条读数（或刚充值只有一条）只报余额，写明算不出速度；读数没有下降不估计；暂停还开着时输出“暂停中”（并附最后一次余额读数）；**没有余额读数时**只报放行以来的用量，并明说“没有余额读数，无法估计还能撑多久”，不给百分比，也不给时间。
- **其余数据来源不变。** 各 Codex Session 原生记录（`rollout-*-<线程>.jsonl`）里带时间戳的 `token_count` 累计值取差，得到放行以来的用量并分 Session 列出；提供方暂停/放行记录读自 `runtime_provider_hold`（只读事务），也可在配置里直接给 `holds`。不读账单、不调提供方接口、不写库、不发消息。`--json` 给机器读，`--now ISO` 回放某个历史时刻。
- **配置。** 私有配置经 `EVOLOOP_QUOTA_CONFIG` 传入（仓库外的绝对路径）：`codexSessionsRoot`、`utcOffsetMinutes`、`databaseUrl`+`projectId` 或 `holds`，可选 `provider`、`balanceReadings`、`balanceUnit`（默认“元”）、`rateWindowHours`、`lowHours`、`staleHours`、`sessionLabels`。旧键 `weights`、`warnAt`、`windowHours`、`recharge` 仍能读入，但不再起作用。读不到某个记录文件或某行余额读数读不出时，第一行写“读数不完整”，退出码 2。
- **接进定时代班**由需求 Session 做，不在这个脚本里。余额读数与使用者在提供方后台看到的是否一致，要使用者提供一次读数，由需求 Session 在接好之后另建核验 Task。

## 6. 受管 Session 编制所需配置

给一个 Role 新建受管 Session，要同时配好：业务身份（身份文件里对本项目是成员，并至少有一类任务、文档或 Session 写权限）、`runtime.grants`（含工作区 `cwd`）、Role 级 `runtime.materialCli`、**`residentQueue.roleActors`** 与 `residentQueue.enabled`、**成对配置的 `sessionMessages.grants`**，以及 `runtime.enabled`。完整清单、每项的格式和生效时机见 [Agent CLI：编制所需私有配置清单](agent-cli.md#编制所需私有配置清单session-prepare-缺项时)。

**双向消息授权是必配。** 不能因为新 Session“暂时不用消息”而省略，也不能只配一个方向。`sessionMessages.enabled` 须为 `true`，并同时有：

- **新业务身份 → Leader Session。** `sessionId` 指 Leader Session，`senderActorId` 是新业务身份，`receiverActorId`、`receiverRoleId` 与 `cwd` 取 Leader 的，`enabled` 为 `true`。
- **Leader → 新 Session。** `sessionId` 指新 Session，`senderActorId` 是 Leader，`receiverActorId`、`receiverRoleId` 与 `cwd` 取新 Session 的，`enabled` 为 `true`。

发送普通消息时，服务逐次按接收 Session 核对对应方向的那一条；缺项以 `MESSAGE_GRANT_MISSING` 拒绝，消息不保存。`session prepare` 不检查这两条，所以准备结果不能代替实际发送。

**“可报告为就绪”的判据。** `session prepare` 成功、配置缺项为空、`runtime_session.state=ready` 或原生 Thread 可读，只证明编制和原生绑定完成，可能仍早于模型成功运行。对外报告新 Session“就绪”前，必须完成一次真实消息往返：

1. 用 Leader 身份按 `command schema session.message.post` 发一条带唯一标记的约定测试消息，保留返回的 `messageId`。
2. 新 Session 实际处理后，按同一命令和反向授权**另发一条新消息**带回原标记，不带 `replyToMessageId`：`replyToMessageId` 只能指向发给同一个接收 Session 的消息，指向发给对方 Session 的原消息会被拒（`REPLY_TARGET_MISMATCH`），消息不保存。
3. 用 `work message MESSAGE_ID` 和 `work status owned:SESSION_ID --message MESSAGE_ID` 分别读回两个方向的已保存消息、processing 与原生 Turn；目标 Session 一侧还要核到已有回复。

只有两个方向都成功发送并处理、原生 Turn 可核、回复中的标记一致，才报告就绪，并保留两条消息 ID 与读回结果作对照记录。只有配置检查通过、发送返回 `applied`、状态显示 `ready`、消息已保存或没有回复，都不算就绪。

**换路径后先实跑一次。** 换 Role、换验收者或换 Session 后，新的路径必须先实际跑通一次才算落地：第一次派单要真的开出 Run，或新 Session 真的处理过一条消息。换验收者时，新的验收安排也要真正送达并由接收 Session 处理；只改配置、只换绑定、只保存一条分派记录或只在文档里写计划，都不算。保留这次 Run 或消息的 ID、实际处理结果与读回证据，作为新路径可用的对照记录。

- **缺项怎么看。** `session prepare` 返回 `status=blocked`，`missing` 是代码，`missingDetails` 写明要设的配置项、可复制的修法和是否需重启；`role_actor` 就是缺 `residentQueue.roleActors`（或它没启用、或该身份在本项目没有任务、文档或 Session 写类别）。
- **哪些要重启。** 按代码核对，`session prepare` 每次调用都重读 integrations 与身份文件，补 `residentQueue.roleActors`、`runtime.materialCli` 不需要重启。`runtime.grants` 的授权匹配每次重读，但运行器建 Session、开 Run 和恢复时接受的工作目录、`models` 列出的模型，用的是服务启动时读入的 grants（`apps/coordinator/src/main.ts` 把启动时的 `allowedRuntimeCwd` 交给运行器），所以**新增工作目录或模型的 grant 要重启**才可用；2026-11-14 的接入试跑里，只改文件不重启时 `capabilities` 的 `runtime` 显示 `grant_directory_unavailable`、`pending` 显示重启后才是 `configured`。另外 `runtime.enabled`（运行时只在启动时建立）和新增 HTTP 令牌要重启。

- **身份的额外命令（`extraCommands`）。** 给文档与架构这类只有 `document` 类别的身份开放归档与恢复时，在身份文件里该凭据上加 `"extraCommands": ["document.archive", "document.restore"]`，不要给它 `management` 或 `task` 决定权（那样它还能开始、关闭、分派 Task）。清单只接受这两个值，别的命令写进去则服务启动时读身份文件失败；每条命令各自生效，仍须 `document` 类别。**身份文件在服务启动时读取，改了要重启服务才生效**（`session prepare` 重读身份文件只用于其编制检查，不改变 HTTP 认证用的启动快照）。
- **同一个事实写两处。** `runtime.materialCli` 的 `cliActorId` 与 `residentQueue.roleActors` 的 `actorId` 在 Role 级必须一致，不一致时报 `material_cli_actor_mismatch`；Session 有自己按 `sessionId` 精确的 `materialCli` 条目时按这一条判断（它须在当前身份文件里可写至少一类任务、文档或 Session 对象，否则 `material_cli_actor_not_writer`），所以同一 Role 下用独立身份签字的验收 Session 可以直接 `session prepare`。为什么暂不合并见 Agent CLI 那一节。

## 7. 用量上限与上下文交接

这两项都只拦普通 Leader 结果通知，不拦业务 Task Run，也不拦使用者自己发的消息。默认都不配置，因此升级本身不改变行为。

### 最小配置

```json
"runtime": {
  "dailyBudget": {
    "enabled": true,
    "maxInputTokens": 1000000000,
    "warningRatio": 0.8,
    "pauseOrdinaryTurns": true,
    "timeZone": "Asia/Tashkent"
  },
  "contextBudget": {
    "enabled": true,
    "maxInputTokens": 200000,
    "warningRatio": 0.8,
    "pauseOrdinaryTurns": true
  }
}
```

- **每日上限。** `dailyBudget` 至少要设 `maxInputTokens` 或 `maxCostUsd` 之一。Codex 当前可能没有完整费用，因此优先用输入词元上限；只有运行时确实报告费用时才用 `maxCostUsd` 判定，未报告不会当成 0。上面的数字只是示例，启用前必须按当前用量调整；上限低于当日已用量会立即暂停普通通知。
- **时区与生效时机。** `timeZone` 必须是 IANA 时区。账本按启动时读到的 `dailyBudget.timeZone` 分日，改动时区后要重启协调器；上限和 `pauseOrdinaryTurns` 则在每个普通结果通知前重读。即使不重启也能改变文案和字段，但分日键仍会沿用启动值，不能用这种不一致状态做验收。
- **先只告警再暂停。** 若只想先核对提示，可先设 `pauseOrdinaryTurns:false`；确认工作台和 `runtime/usage` 的 `warning` 状态后再改为 `true`。不要为了制造告警，在正式实例临时压低上限。

### 启用步骤与验收前置

1. **维护者读当前用量。** 在工作台智能体页右栏“环境与用量”或 `GET /api/projects/PROJECT_ID/runtime/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` 核对最近几天、今日和 Leader 的上下文，记下读取时区与时间。阈值由维护者按实际预算决定，不由执行代码的 Session 代填私有值。
2. **维护者改私有配置。** 保留 `EVOLOOP_INTEGRATIONS_FILE` 原有字段，只增加或修订上例中的两个对象；令牌、Session ID 和真实限额不进入仓库。时区改动后重启协调器，并读回服务已使用新配置。
3. **跑无生产副作用的固定验证。** 下面的场景测试只在临时目录写合成配置，不连数据库、不启动原生 Turn、不发送业务消息：

   ```sh
   npm run build:packages
   node --import tsx --test \
     packages/core/test/usage-context.test.ts \
     apps/coordinator/test/ordinary-turn-admission.test.ts \
     apps/coordinator/test/session-budget-verification.test.ts \
     apps/workbench/test/usage-budget-panel.test.ts \
     apps/workbench/test/usage-presentation.test.ts
   ```

   它覆盖配置解析、`warning`、每日上限与上下文上限的阻断、非通知消息不受影响、交接摘要和工作台提示。这个测试证明代码路径可重复，不证明某套私有配置已经启用或正式实例已经实际阻断。
4. **只读读回启用状态。** 配置启用后重新读取 `runtime/usage` 和工作台：`budget.state` 应为 `ok`、`warning` 或 `exhausted`，目标 Session 的 `context.state` 应为 `ok`、`warning` 或 `handoff_required`；未知数据保持“未知/未报告”。这一步不触发通知，也不制造用量。
5. **正式阻断与交接另行验收。** 需要观察真实阻断时，在隔离候选或专用测试库用合成通知验证，不在正式实例强压低阈值。交接仍由维护者用同一 Role 开启新 Session，写清原 Session、原生 Thread、固定 Task 和未处理通知；服务不会自动搬线程。发布与私有配置启用后，由独立验收 Session 按此入口核对，作者不能代签 `used` 或把代码测试写成正式启用。

- **读回用量。** `GET /api/projects/PROJECT_ID/runtime/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` 按 Session 和按天返回输入、输出、缓存输入、费用与上下文压力；工作台智能体页右栏“上下文与用量”（这个 Session 的上下文与今日用量）和统筹安排的“项目用量”（每日上限、近 7 天、计日时区）用同一个读取。费用缺失写“未报告”，不当 0。
- **输入是含缓存的总量。** 账本和每日上限里的“输入”统一指模型处理过的全部输入词元，缓存读取与缓存创建都算在其中；`cachedInputTokens` 只是其中的子集，供展示，不再另加一次。Claude SDK 的 `input_tokens` 不含 `cache_read_input_tokens` 与 `cache_creation_input_tokens`，写账时三者相加；Codex v2 的 `input_tokens` 已包含 `cached_input_tokens`，由 `non_cached_input = input_tokens - cached_input_tokens` 可核。每日上限比较的是全项目当日所有 Session、所有运行时的输入合计，不只 Leader，也不只 Codex。
- **账本误差的方向与范围。** 正常 Codex 路径按 Thread 累计快照取差；同一个 pump 内的多个用量通知仍逐个参与差值，不能只拿最后一条的 `last`。修复前有三类误差：重连后首个不含 usage 的事件曾把持久化基线覆盖为 `null`，到下一条通知只记 `last`，单次少算一条请求的量；复位后又在一个 pump 内继续请求时，曾只记最后一条 `last`，少算该间隔内其余请求的 `last` 之和；Claude 的输入曾漏掉缓存读取与缓存创建，少算这两项之和，并把与 Codex 不同口径的数直接相加。现在前两类按持久化基线与逐个通知修复，Claude 按上述含缓存口径写账。
- **只适用于正常协议的范围。** 当前固定的 Codex `0.166.0-alpha.6` 与 `0.167.0-alpha.3.2` 都已把 v2 `ThreadTokenUsage.total` 定为必填字段（`codex-rs/app-server-protocol/src/protocol/v2/thread.rs` 的 `ThreadTokenUsage`），每条实时通知都带累计值；连接已有 Thread 时只重放 rollout 中最新的一条 `TokenCount` 快照，不把任意旧读数序列重投给同一连接（`codex-rs/app-server/src/request_processors/token_usage_replay.rs` 的 `rposition` 与 `conversation.token_usage_info()`）。因此正常实时路径不会触发“只有 `last` 的重复通知”。**但“重放的那条最新持久化快照”仍可能比账本已见到的读数旧**：账本先收到内存里更新的实时读数，连接断开后重连，原生端重放的是 rollout 里落盘较早的最新快照，它的累计值就小于账本基线（发布切换、子进程丢失都会触发重连）。这条依据来自上面引用的 `token_usage_replay.rs`（只重放 rollout 里最新的 `TokenCount`），“落盘可能落后于实时读数”是推断，本机没有 Codex 源码，未能在本机核实。
- **较小的累计值怎么判（缺陷 cbce1ba5）。** 同一 Thread 内累计值小于基线时，旧版本一律当复位：记这条读数的 `last` 并把基线退回这条旧读数，之后每条读数再按差值记一遍，三条旧读数重放就多记三条请求再加一遍差值。现在只有读数自己证明计数器重新开始才算复位——它的 `last` 等于 `total`（复位后的第一个请求，整个计数器就是这一个请求），记这条 `last` 并以它为新基线；除此之外一律是旧读数：不记任何增量、不退基线（持久化的基线也不退），并写一条 `runtime_record_event`，种类 `usage.staleReadingIgnored`，说明原因、这条读数、它对照的基线和“没有记入账本”。**没有可靠依据时宁可少记，不重复计入。** 局限：复位后的第一条读数若恰好也不满足 `last == total`（例如压缩后第一个请求之前就有别的请求），会被当旧读数忽略，该间隔的增量少记，直到累计值超过旧基线才继续按差值记；遇到时按原生 rollout 对账。
- **没有 `total` 的重复事件。** 只有 `last` 的事件仍是兼容分支（v2 协议里 `total` 必填，正常路径不会进来；只在非标准写入方时进入）。同一 Turn 里紧接基线、`last` 与基线完全相同的这类事件当作同一事件再投递，不再记第二次，并写同一种 `usage.staleReadingIgnored` 记录（原因 `total_less_repeat_of_baseline_last`）；同一 Turn 里恰好连续两个大小完全相同的无 `total` 请求会少记一个——兼容分支里无法区分，取少记。
- **每日费用现在含全部轮次（缺陷 44ba20f6，迁移 112）。** 用量账本的 token 列一直含全部轮次，费用列此前只累加 Run：消息 Turn 写 token 的同时费用记 0，所以以回复消息为主的 Claude Session（例如验收者）的日费用只是按用量折算的一小部分（复盘：本期系统记约 104 美元，按全部轮次折算约 254 美元）。现在消息 Turn 结算时按这一轮运行时报告的成本一并累加，口径与 Run 相同；没有报告成本的轮次费用记 0 且 `cost_reported=false`，不会编出数字；Codex 不受影响（它的 token 由原生观察累计，不报告费用）。**历史不重写**：一个过去的消息 Turn 的费用从来没有存在数据库里，无法从库重建，所以迁移把已有的每一行标为 `cost_scope='runs_only'`（费用只含 Run，token 含全部），此后新建的行是 `all_turns`；迁移当天已经有行的那一天也保持 `runs_only` 到当天结束。读回里每个日桶和合计都带 `costScope`（合计里有一天是 `runs_only` 就是 `runs_only`），工作台的费用在这样的桶后写“（此前只含 Run）”，数字本身没有改动。要给历史补全，按下一条从原生会话记录重算，并以边界为准。
- **修复旧账后再打开上限。** 累计值被当成增量的版本（PR #410 之前）写入的 Codex 日桶会偏大；本页这组重连、pump 与 Claude 口径修复之前的日桶还可能偏小。先在维护窗口备份 `session_usage_daily`，再按受影响 Session、日期与代码边界，从对应原生 rollout 的 `last_token_usage` 或真实 Turn 用量重算输入、缓存输入和输出，替换这些日桶，并记录 Session、日期、修复前后合计与 rollout 路径。无法取得完整原生样本的日桶删除并标为未记录，不能保留旧值后再按它打开每日上限；修复边界之后的记录继续由账本增量维护。
- **警告与暂停。** 达到 `warningRatio` 只显示提示；达到上限后，结果通知消息以 `DAILY_BUDGET_EXHAUSTED` 或 `CONTEXT_HANDOFF_REQUIRED` 留在队列并写阻断原因。业务 Task Run、验收和人工消息仍可执行。要恢复，先处理交接或调整上限，再按原消息记录重试；不要另建一条消息冒充原通知。
- **交接到新线程。** 用同一 Role 开启新 Session，把原 Session、原生 Thread、固定 Task 与未处理通知写进接手说明；新线程读取固定 Task 和当前工作变化后再决定下一步。`contextHandoffSummary()` 的格式可直接作为交接摘要；它不复制原生对话正文。
- **基线。** `node scripts/context-baseline.mjs <rollout.jsonl>` 只读 Codex 原生记录，报告每轮最大输入、均值／中位数／p90、累计用量、压缩次数和字节占比。改动前后用同一口径比较，不以单轮或通知数量代替。

## 已知缺口

- **导入通知没有正式命令。** 迁移导入的 Leader 通知只能由维护者直接标记，没有权限检查和操作回执（见[迁移之后先处理导入的通知](#迁移之后先处理导入的通知)）。
- **即时输入的能力查询不核运行时。** 对 Claude 或非 alpha.6 的 Codex 也可能回答 `steer`，提交时才被拒绝或记为未知（见 [Session 运行时 §3](../architecture/session-runtime.md#3-即时输入执行中收到的消息怎样处理)）。
- **托管压缩只在 alpha.6 可用。** 隔离测试只用替身，不验证有认证的模型压缩。
- **上下文交接仍由维护者执行。** 服务会暂停普通通知并生成摘要，但不会自动创建新原生线程、迁移 Leader 目标或替使用者确认接手；这套操作尚未在正式实例做长期运行验收。

## Session 队伍调度程序

协调器在运行时启用（`runtime.enabled`）后运行队伍调度程序（轮询间隔沿用 `residentQueue.pollIntervalMs`，默认 2 秒）。它只推进由 Leader 凭据控制的队伍，每一步都是普通命令，操作 ID 由队伍项和尝试次数决定，重启后重放不会重复开 Run。队伍项、事件和 `QUEUED_IN_SESSION_LINE` 的含义见 [Session 运行时](../architecture/session-runtime.md#session-队伍dec-045-q1)。迁移 087 新增 `session_line`、`session_line_entry`、`session_line_event`、`task_assignment_confirmation`；不需要改私有配置，**接收者解析规则（队伍写 assignment 的对象）**：队伍项的接收者必须是该 Session 实际签署交付的业务身份，不再按 Role 猜。顺序是：①该 Session 自己的 `runtime.materialCli` 条目（`sessionId` 与它的原生 actor `sessionActorId` 都匹配，条目的 `cliActorId` 就是接收者）；②只有当这个 Role 恰好只有一个未关闭的 Session 时，才用 Role 级 `materialCli` 条目或 `residentQueue.roleActors`（单 Session 的旧配置照常工作）；③否则**在写任何 assignment、确认请求或 Run 之前**把这一项挂起（`RECIPIENT_UNAVAILABLE`），原因点名该 Session 并写明要补的配置（该 Session 的 `materialCli` 条目）。结果还必须是当前项目 writer。同一 Role 下有开发、验收、验收 2 等多个身份不同的 Session 时，每个 Session 都要有自己的 `materialCli` 条目；缺了不会改用别人的身份，也不会产生 `RECIPIENT_UNBOUND` 预检失败的 Run。控制者自己的 Session 也不能被追加：判据复用这里的业务身份解析，而不是 `runtime_session.actor_id` 创建者；该路径返回 `SELF_SESSION_LINE_FORBIDDEN`，不写队伍、确认消息或 Run。测试：`apps/coordinator/test/session-line-recipient.test.ts`、`packages/adapter-postgres/test/session-line.test.ts`。
协调器在运行时启用（`runtime.enabled`）后运行队伍调度程序（轮询间隔沿用 `residentQueue.pollIntervalMs`，默认 2 秒）。它只推进由 Leader 凭据控制的队伍，每一步都是普通命令，操作 ID 由队伍项和尝试次数决定，重启后重放不会重复开 Run。队伍项、事件和 `QUEUED_IN_SESSION_LINE` 的含义见 [Session 运行时](../architecture/session-runtime.md#session-队伍dec-045-q1)。迁移 087 新增 `session_line`、`session_line_entry`、`session_line_event`、`task_assignment_confirmation`；不需要改私有配置，**接收者解析规则（队伍写 assignment 的对象）**：队伍项的接收者必须是该 Session 实际签署交付的业务身份，不再按 Role 猜。顺序是：①该 Session 自己的 `runtime.materialCli` 条目（`sessionId` 与它的原生 actor `sessionActorId` 都匹配，条目的 `cliActorId` 就是接收者）；②只有当这个 Role 恰好只有一个未关闭的 Session 时，才用 Role 级 `materialCli` 条目或 `residentQueue.roleActors`（单 Session 的旧配置照常工作）；③否则**在写任何 assignment、确认请求或 Run 之前**把这一项挂起（`RECIPIENT_UNAVAILABLE`），原因点名该 Session 并写明要补的配置（该 Session 的 `materialCli` 条目）。结果还必须是当前项目成员且至少可写一类任务、文档或 Session 对象。同一 Role 下有开发、验收、验收 2 等多个身份不同的 Session 时，每个 Session 都要有自己的 `materialCli` 条目；缺了不会改用别人的身份，也不会产生 `RECIPIENT_UNBOUND` 预检失败的 Run。控制者自己的 Session 也不能被追加：判据复用这里的业务身份解析，而不是 `runtime_session.actor_id` 创建者；该路径返回 `SELF_SESSION_LINE_FORBIDDEN`，不写队伍、确认消息或 Run。测试：`apps/coordinator/test/session-line-recipient.test.ts`、`packages/adapter-postgres/test/session-line.test.ts`。

## 验收接力的消息卡在队首（缺陷 0fd4a99b）

**现象与原因。** 验收接力的消息排在接收 Session 的队首，接力却不能开始（已 blocked、等发布，或已被取代）时，旧版本只让准入判断返回“不开始”：不写原因、不撤下，而同一 Session 里更早的 queued 消息先走，于是后面所有消息（别的 Task 的接力、普通对话）都被堵住，页面上只显示 queued。

**现在怎样处理。**
- 接力 `superseded` 或 `released`：它的 queued 消息撤下（cancelled），原因写 `ACCEPTANCE_RELAY_SUPERSEDED` / `ACCEPTANCE_RELAY_RELEASED`。
- 接力 `blocked`：消息保留（接力可能被重试：规则变了、发送者回来了），消息上写 `ACCEPTANCE_RELAY_BLOCKED: <接力原因>`（原因变了才写，不会每轮写一次）。
- 正式接力在等发布（`PUBLICATION_PENDING`）：消息上写 `PUBLICATION_PENDING: …`，发布标记写上后下一轮准入通过。
- 队列规则：消息的 `blocked_reason` 以 `MESSAGE_GRANT_MISSING:`、`PUBLICATION_PENDING:` 或 `ACCEPTANCE_RELAY_BLOCKED:` 开头时仍留在队里、仍被重新看，但不再让它后面的消息等它（Leader 判断“有没有人在等”的检查用同样的例外）。不放松：接力的交付或 Task 修订变了的消息仍然不开始（接力被取代，消息撤下）；前面有消息正在处理时，后面的仍按原规则等待；前面有普通 queued 消息时它先走。

**`MESSAGE_POST_applied` 的原因。** 接力保留了一个消息 ID 和一个操作 ID。Leader 若自己发了这条接力消息，用了保留的操作 ID 却用了自己的消息 ID，日志里这个操作确实是 applied，但创建的实体不是保留的消息 ID，旧代码就把接力置为 blocked 并写 `MESSAGE_POST_applied`——而这条消息其实是正确的。现在：那个操作创建的消息若是同一发送者、同一 Session、同一 Task 修订、用保留的操作 ID 写的，接力绑定到它（接力的消息 ID 改成它）并继续；否则接力 blocked，原因写 `MESSAGE_OPERATION_ID_USED_BY_ANOTHER_MESSAGE: operation … created …`，说明发生了什么。复现与修复前后输出见 `packages/adapter-postgres/test/acceptance-relay-queue-head.test.ts` 的第 5 个用例（修前该用例得到 `blocked / MESSAGE_POST_applied`）。

**正式实例上已卡住的消息。** 发布后，acceptance-claude 队伍里已卡的接力消息会在下一轮准入时按上面处理：被取代、已释放的接力其消息被撤下；blocked 的接力其消息写上原因、不再堵后面；等发布的在发布标记写上后开始。消息已被 Leader 先撤下的不再处理。逐条核对用 `work messages` 读消息状态与 `blocked_reason`，用 `work acceptance TASK` 读接力状态。

## 消息泵日志与关闭的恢复门

**消息泵的错误日志。** 服务 stderr 里的 `Session message needs reconciliation` 现在写成一行带原因的话：`code=错误码 message=消息ID session=SessionID project=项目ID state=消息状态 error=摘要`。错误码是业务错误的 code、原生 JSON-RPC 错误（如 `RuntimeServerError(-32600)`）或错误类名。**摘要怎么来：** 平台自己写文案的错误（`DomainError`、`RuntimeServerError`）保留摘要（最多 200 字、去换行），其它错误（普通 `Error`、网络错误等）不回显文字，只写“text withheld: 类名”；保留的摘要还要统一脱敏：引号里的长文本、`Bearer …`、`token=…`/`password=…`/`authorization: …` 之类、`sk-…`、JWT、绝对私有路径（`/Users`、`/home`、`/private`、`/tmp`、`/var` 或盘符路径）、长十六进制与长不透明串，都替换成占位符。行里没有消息正文、令牌或配置值。**限流键是“消息 ID + 错误码”**，不是整行文字：同一条消息的同一个错误码一分钟内只写一行，即使错误文字每次都不同（带计数或时间戳）；一分钟后的那一行写最新一次的文字并说明期间压下了几次。另一条消息或另一个错误码各自有自己的行。只是在等的消息（Session 在运行、排空中、模型服务暂停、授权缺失、预算用尽、本地正在发送：`SESSION_BUSY`、`PROVIDER_HELD`、`MESSAGE_GRANT_MISSING`、`MESSAGE_BUDGET_EXHAUSTED`、`SESSION_NOT_READY`、`MESSAGE_NOT_QUEUED`、`SESSION_INPUT_BUSY`、`RuntimeLocalBusyError`）不是错误，不写日志。

**每秒一条的那个错误。** 排在运行中回合后面的消息不会被泵遍历（待处理列表只含能开始或正在处理的消息），所以每秒一条并不来自“正在排队的消息”。每个 tick 对每条正在处理的消息都会读一次原生历史（`listTurns`、`listItems`），这里抛出的错误会进日志；有两条在运行的消息就是每秒两次尝试。已读代码能指出的候选是：原生线程刚开的第一个回合在历史还没物化时 `thread/turns/list` 返回 -32600（直接输入的对账代码里有同样的处理注释）。这只是推断，没有在正式实例上确认：新日志会直接写出错误码和消息，发布后看第一行就能知道。

**关闭的恢复门。** 恢复门处于 `blocked`（等人恢复；`retrying`、`reworking`、`message_pending`、`awaiting_acceptance` 是正常等待，不触发）、更新时间已超过 30 分钟（一轮 Leader 安排和一次正常恢复通常都比这短；再短会把刚停下一轮后的正常恢复也算进来），并且有 owned 消息排在它后面时，`work board` 的 `awaitingLeader` 里出现一项 `kind=recovery_gate`：`id` 是 Session，`title` 写职责、阶段和排队条数，`waitingOn` 是最近一次为这个门做过恢复决定的身份（`{kind:"actor", id}`），没有人决定过时是 `{kind:"reviewer", id:null}`（任一有 Session 类别与决定权的身份可以执行 `runtime.session.recovery.resume`）。这一项每次读取时从门和队列算出：门重新打开（或进入正常等待的阶段）、或后面不再有排队消息，它就没有了。**它总排在列表最前**（完整快照和 `--brief` 都是），`--brief` 在各档截断时先保留所有门项再填其它项，所以其它待办项再多也挤不掉它；`--brief` 输出里带 `waitingOn`。Leader 每轮读 `work board --brief`，定时代班读同一份，所以不需要另外的通知。

**绑定的一轮从未开始（Task a533cb64）。** 消息已记下绑定的原生 Turn，但这一轮没有出现在原生历史里，以前只能一直是 `unknown`（`Bound native Turn is not currently readable`）。这条 processing 占着 Session，所以恢复门 resume 返回 `SESSION_BUSY`；manual stop 也要先读到这一轮，同样走不通。例如 11-18，主机在 `turn/start` 之后、原生记录写入之前停机，Leader 因此停了 12 个多小时。现在泵在读不到绑定 Turn 时多做一次判断，同时满足下面几条就把消息记为 `failed`：
- 原生轮次列表读得到（两个适配器都按新到旧排）；
- 第一页里没有这一轮；
- 第一页每一轮都已结束，且结束时间早于这条 processing 的开始时间；
- 开始时间已超过 10 分钟。
失败原因写成 `Bound native Turn … never appeared in native history … Treated as never started; not resent.`，并带上作证据的最新一轮 ID 和时间；服务在事务里按存下的 processing 再核一遍。消息不自动重发；之后照常由有决定权的身份 resume 恢复门，被挡住的通知包由 Leader 用 `leader.notice.recover` 恢复。

以下情况仍记 `unknown`，等人核对：列表为空、最新一轮还在进行、有一轮在开始时间之后才结束、列表读取出错，或还在宽限期内。

## 调度板与调度事件流（Q2，迁移 105）

**数据从哪来。** 迁移 105 建 `sched_event` 表，并在既有表上挂 AFTER 触发器：事件与引起它的状态变化在同一个事务里写一小行，应用代码的写入路径没有改动，也没有第二次写入。触发器取与 `leader_work_change` 相同的项目锁，所以同一项目里序号不会乱序提交。上线要先看发布顺序：105 不得早于 104（通知分级）等更小的号进入正式库；迁移只加表、函数和触发器，不改既有行为。回退：删除 `sched_event_*` 触发器即停止写入，表和已有事件可留。

**保留期。** 协调器启动一分钟后和之后每 6 小时调用 `purge_sched_event(30, 5000)` 直到没有可删的行（只在持有写租约的实例上；重启比 6 小时频繁也会清理）。迁移 107 补上 Session 队伍（`session_line_entry`）的事件触发器，并让空闲即时输入只记 `message.started`；回退同样是删除 `sched_event_*` 触发器。被清理的最高序号按项目记在 `sched_event_floor`；游标低于它的读取返回 `resetRequired:true`。

**推送。** `GET /api/projects/P/work-board/stream`（SSE）和 `GET .../work-board/events?after=N&wait=S`（长轮询）都经进程内一个共享读取者：每个项目一个循环，只在至少有一个订阅者时才存在，每秒先读一次最新序号，只有变了才读新事件并分发给所有订阅者；没人打开页面时没有定时器，也没有查询。

**性能预算怎样读回。**
- 写入：`packages/adapter-postgres/test/leader-notice-packets.test.ts` 里有两个写入用例。单连接用例插入 200 条消息，分别开着和关掉事件触发器，打印每条耗时（本机一次：0.40 ms 对 0.31 ms）。并发用例用 8 个写入者各做 40 次“一个事务一次插入”，打印开着触发器和项目级 advisory 锁时的 p50、p95 与每秒提交数（本机一次：p50 0.95 ms、p95 3.25 ms、5771 次/秒；关掉触发器 p50 0.92 ms、p95 2.60 ms、6729 次/秒）。锁一直持有到提交，所以长事务会让同项目的其他写入排队：这个测量只覆盖短事务，正式实例上的锁等待要在真实负载下读 `pg_locks`/`pg_stat_activity` 的 advisory 锁等待。正式实例上可对同一张表临时 `ALTER TABLE ... DISABLE TRIGGER sched_event_message_ins` 在测试库复测，不要在正式库上关。
- 尾部读取和快照：对正式实例各执行 20 次 `work events --after 当前序号` 和 `work board`，取 p95 并与 100 毫秒预算对比；一次读取的耗时可用 `time` 包住 CLI 得到（含 CLI 启动，只作上限）。
- 没有订阅者时没有额外读取：不开任何页面或长轮询，在数据库里看 `pg_stat_statements`（或 `pg_stat_activity` 抽样）中不应出现 `FROM sched_event` 的周期查询。
- 简要输出字节数：`work board --brief` 与 `work board` 各一次，比较字节数（要求不超过 6144，且不超过完整输出的一半）。

**事件量。** 事件表只写元数据，按每天 5 千到 1 万行、5 MB 以内估计，保留 30 天约 150 MB 以内；用 `SELECT pg_total_relation_size('sched_event')` 核对，超出预期时先查哪一类事件最多（`SELECT kind, count(*) FROM sched_event GROUP BY 1 ORDER BY 2 DESC`）。

## Leader 通知包

**开关（默认关闭）。** 在 `leaderResultNotices` 里加 `"packets": true`：之后新产生的通知走通知包；不写或 `false` 时，新通知仍是一条通知一条消息，与未发布这个功能时一致（迁移 089 本身只加一列和一张开关表，不改变既有行为）。通知泵每轮重读配置并把开关抄进数据库，不需要重启。`enabled:false` 时不投递新通知，但已发出的包仍会收尾（对账、取消没开始的包消息）。回退：把 `packets` 改回 `false`——没进过包的通知回到旧路径，进过包的项由包处理完。上线要先看发布顺序：089 不得早于 084–088 进入正式库。

通知泵在发现等待中的新通知时按包送达：最早一项等满 60 秒、Leader 空闲、没有可以开始的人的消息排队、恢复门打开才合成一包并发一条消息。包的步骤（`leader.noticePacket.build`、`.sent`、`.observe`）只由配置里的通知发送身份（`senderActorId`）运行，Leader 和其他有 `management` 类别与决定权的身份不能运行；它们的处置命令 `leader.notice.handle` 需要 `management` 类别。逐项状态、各步骤和恢复见[接口合同](../architecture/contracts.md#leader-通知层)。

**受阻的包。** 读到包的那一轮失败而恢复门关闭时包为 `blocked`，出现在 Leader 工作索引的 `blockedNoticePackets`。先恢复恢复门，再 `request leader.notice.recover --id 包编号 --file BODY.json --receipt UUID`（body `{"reason":"..."}`）恢复这一包。

