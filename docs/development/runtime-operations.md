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
| [受管 Session 编制](#6-受管-session-编制所需配置) | `residentQueue.roleActors`、`runtime.materialCli`、`runtime.grants` 等 | 无（逐项见该节） | `session prepare` 每次重读；只有 `runtime.enabled` 与新增 HTTP 令牌要重启 | [准备或复用受管 Session](agent-cli.md#准备或复用受管-session) |
| [阶段关注](#5-阶段关注) | 没有开关，门槛用命令修订 | 服务运行就评估，每 30 秒一次 | 不适用 | [阶段等待由事实推导](../architecture/contracts.md#阶段等待由事实推导) |
| [用量上限与上下文交接](#7-用量上限与上下文交接) | `runtime.dailyBudget`、`runtime.contextBudget` | 都不限 | 上限与开关在每个普通结果通知前重读；账本时区在启动时读 | [长会话的上下文交接](../architecture/session-runtime.md#长会话的上下文交接与每日用量上限) |

## 1. Leader 结果通知

业务结果写入时，数据库在同一事务里登记一条通知；哪些事实会登记，见 [Leader 通知层](../architecture/contracts.md#leader-通知层)。通知泵把通知作为一条普通 Session 消息发给受管 Leader Session。没打开时，通知照常入库，在表里等待投递。

### 准备

- **一条受管 Leader Session。** 它所在的 Role 是项目里唯一 active 或 trial 的 system Lead。核对实际接收 actor、项目写权限、原生 Thread、执行授权、工作目录和 CLI 身份。业务 Session 不能作为 Leader 目标。
- **两个不同的 actor。** `senderActorId` 是配置里明确授权的技术通知者，`receiverActorId` 是实际的 Leader，二者都要是项目 writer。Leader 还要有 `review` 权限，才能保存计划和复核。
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

要重新投递，由有项目 `write` 和 `review` 权限的操作者处理：

1. **先核对。** 核原 operation 的拒绝、当前 Task、消息状态和旧目标的 Turn。
2. **建立新意图。** 用 `request leader.notice.recover --project PROJECT_UUID --id ORIGINAL_NOTICE_UUID --file BODY.json --receipt LOCAL_RECEIPT_UUID`。BODY 包含原 `expectedOperationId`、全新的 `newNoticeId`、`newMessageId`、`newOperationId` 和处置 `reason`。
3. **读回结果。** 原通知用 `get /api/projects/PROJECT_UUID/work-management/notices/ORIGINAL_NOTICE_UUID` 读取，可以核对关联和结果。写入应答不明时，用 `receipts reconcile LOCAL_RECEIPT_UUID` 核对原通知和新通知的固定身份，不另造一组 ID 重发。

新通知保留源事实和原拒绝的关联，按当前唯一的 Leader 目标投递。原通知、拒绝记录和历史成本都不改写。

### 安排验收

Leader 读到交付后，按 Task 声明的验收方式，用 `acceptance.assign` 安排验收（命令见 [Agent CLI](agent-cli.md#观察会话具体接手与普通消息)）。常规验收由 Leader 指派受管验收 Session；较难的交承担难验收的那个验收身份，样本、反例和判据在 Task 正文中先设计好。消费者写受管验收身份；需求 Session 不做验收者，只照验收结论合并与发布并事后抽查（DEC-046，试行）。消费者一时改不了的在途 Task，以及需求 Session 自己的 PR，由 Leader 另建“合并前验收”或“正式验证”Task 交验收 Session 完成。使用者亲用时写人；Leader 只在使用者为某项 Task 明确要求时验收。交付作者和安排者都不能验收；执行者自检、CI 与 Run 终态是交付证据，不是验收。安排受阻会留下一条 `acceptance_blocked` 通知；验收结果仍以观察通知回到 Leader。

### 关闭与回退

把 `enabled` 改回 `false`，下一轮起就停止自动投递，数据库里的通知和已保存的消息都保留。已在途或结果未知的原生 Turn，先按原 operation 对账。数据库迁移不回滚、不删表，以免丢失结果历史。

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

所有读取都按当前项目、actor 和 review 权限重新授权。客户端自报的 `human`、`direct` 或角色名不能替代授权。

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
- 请求者有当前项目的 review 与 write 权限，以及该 Session 的精确运行授权。
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
- **仍要满足的条件。** actor 在当前项目有读、写和审阅权限，Task owner 是有效 Role，`scheduling.enabled` 已打开。
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

- **怎样运转。** 没有配置开关：服务运行时，每 30 秒为有读、写和审阅身份的项目评估一次。
- **怎样送到 Leader。** 关注项以 `task_attention` 类型的 Leader 通知送达，所以要先打开 [Leader 结果通知](#1-leader-结果通知)；没打开时，关注项照常生成，用 CLI 读取。
- **怎样读。** `work task`、`work attention`、`work attention task`、`work attention item`、`work attention thresholds`（见 [Agent CLI](agent-cli.md#观察会话具体接手与普通消息)）。
- **怎样调整与跟进。** 项目默认门槛和单 Task 检查点用 `task.attention.thresholds.set` 修订并留历史；跟进、发布交接和处置分别用 `task.attention.followUp.set`、`task.attention.publication.record`、`task.attention.resolve`。

门槛只要求核查，不代表 Run 失败；关注项不会自动取消、重试或关闭 Run，也不重置预算。隔离候选页面的截图见[桌面 1280×900](../assets/task-stage-attention/desktop-1280.png) 和[窄窗 390×844](../assets/task-stage-attention/narrow-390.png)，两张都来自合成的测试项目，不代表正式通知已送达或已读。

## 叫停执行中的 Run

业务 Run 的范围变了就叫停，不要等它做完再返工：`command schema runtime.run.stop` 取结构，带 Run 的当前版本和理由，用 `command run FILE` 提交；身份要有 review 权限并持有该 Session 的精确执行授权，原生运行时离线时也能提交（未派发的 Run 在数据库里直接判失败，运行中的由 runner 在运行时恢复后中断）。提交后回读 Run：`stopRequestedAt` 已有、`interruptRequested` 为真表示等运行时中断；终态（`interrupted` 或 `failed`）由运行时观察确认，在此之前仍算未结束，Task 上不能再派新的 Run。用这个 Run 再提交会得到 `RUN_STOPPED`，叫停前已签的意图作废，不会产生交付。停止不会关恢复门，也没有失败通知，只有一条 `run.stopRequested` 运行事件。结果未知的 Run 也可以叫停：标记立即生效，有已知 Turn 的会被中断，Run 仍是 `unknown`，直到读回终态；读回终态后，被它关闭的恢复门自动打开（队列认领持有的门除外）。被叫停作废的排队消息带持久的“被取代”标记，选取与准入都排除，发送人取消或 `session.message.confirmSuperseded` 确认后才重新投递。

## 已知缺口

- **导入通知没有正式命令。** 迁移导入的 Leader 通知只能由维护者直接标记，没有权限检查和操作回执（见[迁移之后先处理导入的通知](#迁移之后先处理导入的通知)）。
- **托管压缩只在 alpha.6 可用。** 隔离测试只用替身，不验证有认证的模型压缩。

## 6. 受管 Session 编制所需配置

给一个 Role 新建受管 Session，要同时配好：业务身份（身份文件里对本项目有 read 与 write）、`runtime.grants`（含工作区 `cwd`）、Role 级 `runtime.materialCli`、**`residentQueue.roleActors`** 与 `residentQueue.enabled`、**成对配置的 `sessionMessages.grants`**，以及 `runtime.enabled`。完整清单、每项的格式和生效时机见 [Agent CLI：编制所需私有配置清单](agent-cli.md#编制所需私有配置清单session-prepare-缺项时)。

**双向消息授权是必配。** 不能因为新 Session“暂时不用消息”而省略，也不能只配一个方向。`sessionMessages.enabled` 须为 `true`，并同时有：

- **新业务身份 → Leader Session。** `sessionId` 指 Leader Session，`senderActorId` 是新业务身份，`receiverActorId`、`receiverRoleId` 与 `cwd` 取 Leader 的，`enabled` 为 `true`。
- **Leader → 新 Session。** `sessionId` 指新 Session，`senderActorId` 是 Leader，`receiverActorId`、`receiverRoleId` 与 `cwd` 取新 Session 的，`enabled` 为 `true`。

发送普通消息时，服务逐次按接收 Session 核对对应方向的那一条；缺项以 `MESSAGE_GRANT_MISSING` 拒绝，消息不保存。`session prepare` 不检查这两条，所以准备结果不能代替实际发送。

**“可报告为就绪”的判据。** `session prepare` 成功、配置缺项为空、`runtime_session.state=ready` 或原生 Thread 可读，只证明编制和原生绑定完成，可能仍早于模型成功运行。对外报告新 Session“就绪”前，必须完成一次真实消息往返：

1. 用 Leader 身份按 `command schema session.message.post` 发一条带唯一标记的约定测试消息，保留返回的 `messageId`。
2. 新 Session 实际处理后，按同一命令和反向授权发回原标记，并带原消息的 `replyToMessageId`。
3. 用 `work message MESSAGE_ID` 和 `work status owned:SESSION_ID --message MESSAGE_ID` 分别读回两个方向的已保存消息、processing 与原生 Turn；目标 Session 一侧还要核到已有回复。

只有两个方向都成功发送并处理、原生 Turn 可核、回复中的标记一致，才报告就绪，并保留两条消息 ID 与读回结果作对照记录。只有配置检查通过、发送返回 `applied`、状态显示 `ready`、消息已保存或没有回复，都不算就绪。

- **缺项怎么看。** `session prepare` 返回 `status=blocked`，`missing` 是代码，`missingDetails` 写明要设的配置项、可复制的修法和是否需重启；`role_actor` 就是缺 `residentQueue.roleActors`（或它没启用、或该身份无写权限）。
- **哪些要重启。** 按代码核对，`session prepare` 每次调用都重读 integrations 与身份文件，补 `residentQueue.roleActors`、`runtime.materialCli`、`runtime.grants` 不需要重启；只有 `runtime.enabled`（运行时只在启动时建立）和新增 HTTP 令牌要重启。

- **身份的额外命令（`extraCommands`）。** 给文档与架构这类只有 read、write 的身份开放归档与恢复时，在身份文件里该凭据上加 `"extraCommands": ["document.archive", "document.restore"]`，不要给它 `review`（那样它还能开始、关闭、分派 Task）。清单只接受这两个值，别的命令写进去则服务启动时读身份文件失败；每条命令各自生效。**身份文件在服务启动时读取，改了要重启服务才生效**（`session prepare` 重读身份文件只用于其编制检查，不改变 HTTP 认证用的启动快照）。
- **同一个事实写两处。** `runtime.materialCli` 的 `cliActorId` 与 `residentQueue.roleActors` 的 `actorId` 在 Role 级必须一致，不一致时报 `material_cli_actor_mismatch`；为什么暂不合并见 Agent CLI 那一节。

## 7. 用量上限与上下文交接

这两项都只拦普通 Leader 结果通知，不拦业务 Task Run，也不拦使用者自己发的消息。默认都不配置，因此升级本身不改变行为。

```json
"runtime": {
  "dailyBudget": {
    "enabled": true,
    "maxInputTokens": 50000000,
    "maxCostUsd": 25,
    "warningRatio": 0.8,
    "pauseOrdinaryTurns": true,
    "timeZone": "Asia/Tashkent"
  },
  "contextBudget": {
    "enabled": true,
    "maxInputTokens": 150000,
    "warningRatio": 0.8,
    "pauseOrdinaryTurns": true
  }
}
```

- **读回用量。** `GET /api/projects/PROJECT_ID/runtime/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` 按 Session 和按天返回输入、输出、缓存输入、费用与上下文压力；工作台智能体页右栏“上下文与用量”（这个 Session 的上下文与今日用量）和统筹安排的“项目用量”（每日上限、近 7 天、计日时区）用同一个读取。费用缺失写“未报告”，不当 0。
- **修复旧账后再打开上限。** 修复累计值被当成增量的版本之前写入的 Codex 日桶不会自行变准。先在维护窗口备份 `session_usage_daily`，再按受影响 Session 与日期，从对应原生 rollout 的 `last_token_usage` 重算输入、缓存输入和输出，替换这些日桶，并记录 Session、日期、修复前后合计与 rollout 路径。无法取得完整原生样本的日桶删除并标为未记录，不能保留旧值后再按它打开每日上限；修复边界之后的记录继续由账本增量维护。
- **警告与暂停。** 达到 `warningRatio` 只显示提示；达到上限后，结果通知消息以 `DAILY_BUDGET_EXHAUSTED` 或 `CONTEXT_HANDOFF_REQUIRED` 留在队列并写阻断原因。业务 Task Run、验收和人工消息仍可执行。要恢复，先处理交接或调整上限，再按原消息记录重试；不要另建一条消息冒充原通知。
- **交接到新线程。** 用同一 Role 开启新 Session，把原 Session、原生 Thread、固定 Task 与未处理通知写进接手说明；新线程读取固定 Task 和当前工作变化后再决定下一步。`contextHandoffSummary()` 的格式可直接作为交接摘要；它不复制原生对话正文。
- **基线。** `node scripts/context-baseline.mjs <rollout.jsonl>` 只读 Codex 原生记录，报告每轮最大输入、均值／中位数／p90、累计用量、压缩次数和字节占比。改动前后用同一口径比较，不以单轮或通知数量代替。

## 已知缺口

- **导入通知没有正式命令。** 迁移导入的 Leader 通知只能由维护者直接标记，没有权限检查和操作回执（见[迁移之后先处理导入的通知](#迁移之后先处理导入的通知)）。
- **即时输入的能力查询不核运行时。** 对 Claude 或非 alpha.6 的 Codex 也可能回答 `steer`，提交时才被拒绝或记为未知（见 [Session 运行时 §3](../architecture/session-runtime.md#3-即时输入执行中收到的消息怎样处理)）。
- **托管压缩只在 alpha.6 可用。** 隔离测试只用替身，不验证有认证的模型压缩。
- **上下文交接仍由维护者执行。** 服务会暂停普通通知并生成摘要，但不会自动创建新原生线程、迁移 Leader 目标或替使用者确认接手；这套操作尚未在正式实例做长期运行验收。

## Session 队伍调度程序

协调器在运行时启用（`runtime.enabled`）后运行队伍调度程序（轮询间隔沿用 `residentQueue.pollIntervalMs`，默认 2 秒）。它只推进由 Leader 凭据控制的队伍，每一步都是普通命令，操作 ID 由队伍项和尝试次数决定，重启后重放不会重复开 Run。队伍项、事件和 `QUEUED_IN_SESSION_LINE` 的含义见 [Session 运行时](../architecture/session-runtime.md#session-队伍dec-045-q1)。迁移 087 新增 `session_line`、`session_line_entry`、`session_line_event`、`task_assignment_confirmation`；不需要改私有配置，**接收者解析规则（队伍写 assignment 的对象）**：队伍项的接收者必须是该 Session 实际签署交付的业务身份，不再按 Role 猜。顺序是：①该 Session 自己的 `runtime.materialCli` 条目（`sessionId` 与它的原生 actor `sessionActorId` 都匹配，条目的 `cliActorId` 就是接收者）；②只有当这个 Role 恰好只有一个未关闭的 Session 时，才用 Role 级 `materialCli` 条目或 `residentQueue.roleActors`（单 Session 的旧配置照常工作）；③否则**在写任何 assignment、确认请求或 Run 之前**把这一项挂起（`RECIPIENT_UNAVAILABLE`），原因点名该 Session 并写明要补的配置（该 Session 的 `materialCli` 条目）。结果还必须是当前项目 writer。同一 Role 下有开发、验收、验收 2 等多个身份不同的 Session 时，每个 Session 都要有自己的 `materialCli` 条目；缺了不会改用别人的身份，也不会产生 `RECIPIENT_UNBOUND` 预检失败的 Run。测试：`apps/coordinator/test/session-line-recipient.test.ts`、`packages/adapter-postgres/test/session-line.test.ts`。

## 调度板与调度事件流（Q2，迁移 105）

**数据从哪来。** 迁移 105 建 `sched_event` 表，并在既有表上挂 AFTER 触发器：事件与引起它的状态变化在同一个事务里写一小行，应用代码的写入路径没有改动，也没有第二次写入。触发器取与 `leader_work_change` 相同的项目锁，所以同一项目里序号不会乱序提交。上线要先看发布顺序：105 不得早于 104（通知分级）等更小的号进入正式库；迁移只加表、函数和触发器，不改既有行为。回退：删除 `sched_event_*` 触发器即停止写入，表和已有事件可留。

**保留期。** 协调器每 6 小时调用 `purge_sched_event(30, 5000)` 直到没有可删的行（只在持有写租约的实例上）。被清理的最高序号按项目记在 `sched_event_floor`；游标低于它的读取返回 `resetRequired:true`。

**推送。** `GET /api/projects/P/work-board/stream`（SSE）和 `GET .../work-board/events?after=N&wait=S`（长轮询）都经进程内一个共享读取者：每个项目一个循环，只在至少有一个订阅者时才存在，每秒先读一次最新序号，只有变了才读新事件并分发给所有订阅者；没人打开页面时没有定时器，也没有查询。

**性能预算怎样读回。**
- 写入：`packages/adapter-postgres/test/leader-notice-packets.test.ts` 里的写入对比用例在同一连接上插入 200 条消息，分别开着和关掉事件触发器，打印每条的耗时（本机一次：0.40 ms 对 0.31 ms；用例要求差距小于 5 ms）。正式实例上可对同一张表临时 `ALTER TABLE ... DISABLE TRIGGER sched_event_message_ins` 在测试库复测，不要在正式库上关。
- 尾部读取和快照：对正式实例各执行 20 次 `work events --after 当前序号` 和 `work board`，取 p95 并与 100 毫秒预算对比；一次读取的耗时可用 `time` 包住 CLI 得到（含 CLI 启动，只作上限）。
- 没有订阅者时没有额外读取：不开任何页面或长轮询，在数据库里看 `pg_stat_statements`（或 `pg_stat_activity` 抽样）中不应出现 `FROM sched_event` 的周期查询。
- 简要输出字节数：`work board --brief` 与 `work board` 各一次，比较字节数（要求不超过 6144，且不超过完整输出的一半）。

**事件量。** 事件表只写元数据，按每天 5 千到 1 万行、5 MB 以内估计，保留 30 天约 150 MB 以内；用 `SELECT pg_total_relation_size('sched_event')` 核对，超出预期时先查哪一类事件最多（`SELECT kind, count(*) FROM sched_event GROUP BY 1 ORDER BY 2 DESC`）。

## Leader 通知包

**开关（默认关闭）。** 在 `leaderResultNotices` 里加 `"packets": true`：之后新产生的通知走通知包；不写或 `false` 时，新通知仍是一条通知一条消息，与未发布这个功能时一致（迁移 089 本身只加一列和一张开关表，不改变既有行为）。通知泵每轮重读配置并把开关抄进数据库，不需要重启。`enabled:false` 时不投递新通知，但已发出的包仍会收尾（对账、取消没开始的包消息）。回退：把 `packets` 改回 `false`——没进过包的通知回到旧路径，进过包的项由包处理完。上线要先看发布顺序：089 不得早于 084–088 进入正式库。

通知泵在发现等待中的新通知时按包送达：最早一项等满 60 秒、Leader 空闲、没有可以开始的人的消息排队、恢复门打开才合成一包并发一条消息。包的步骤（`leader.noticePacket.build`、`.sent`、`.observe`）只由配置里的通知发送身份（`senderActorId`）运行，Leader 和其他复核身份不能运行；它们的处置命令 `leader.notice.handle` 需要 review 权限。逐项状态、各步骤和恢复见[接口合同](../architecture/contracts.md#leader-通知层)。

**受阻的包。** 读到包的那一轮失败而恢复门关闭时包为 `blocked`，出现在 Leader 工作索引的 `blockedNoticePackets`。先恢复恢复门，再 `request leader.notice.recover --id 包编号 --file BODY.json --receipt UUID`（body `{"reason":"..."}`）恢复这一包。

