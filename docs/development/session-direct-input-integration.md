# Session 连续工作区与即时输入

本页说明 owned Session 的连续阅读、活动 Turn 补充和空闲直接启动怎样共用现有 Run、消息处理、原生 Thread 与授权。页面目标见[团队与具体 Session](../frontend/pages/team-and-sessions.md)，历史与实时读取合同见[Codex 接入](../architecture/codex-integration.md#session-工作区的历史与实时读取)。

## 一个主来源，一份原输入

一个 Turn 只有一个主执行来源：业务 Run，或 `session_message_processing`。用户补充不另建主来源，也不改写原 Run 的固定 TaskRevision、inputHash 或消息 processing：

- 有活动的 `running` 主来源时，补充以 `turn/steer` 附加到它的确切原生 Turn，不新建 Turn，不扣新的 Turn 额度。
- 主来源不是当前可附着的 running Turn 时，普通发送保持原有排队或人工可用的表达；未接 direct 能力时仍显示“保存待处理”，不能把排队冒充即时送达。
- 原 Thread 空闲时，direct start 保存一份 `session_message` 和唯一 `session_message_processing`，再对该 Thread 调用 `turn/start`。它沿用发送者的普通消息授权与累计 Turn 上限；未配置 `maxTurns` 表示不设累计上限，不创建独立免费额度。

每次补充有自己的 `inputId`、`operationId`、actor、期望 Turn、实际 Turn、Item 和状态。原生 `turn/steer` 回执只证明入队，不证明 Agent 已读、采用、回复或形成交付。脚本标记、原生 client ID 和 Item ID 必须全部对上原记录，才进入公开时间线；其他读者只看到署名和来源，正文仍受原输入授权约束。

## 唯一槽位、未知与恢复

direct start 在 PostgreSQL 事务中锁定原 Session，并检查业务 Run、消息 processing 和排队消息。`requested`、`dispatching`、`running` 或 `unknown` 占用不会被“原生看起来空闲”越过；重复点击也只能得到一个 processing。

- 原生调用前先持久化原意图。回执丢失、数据库提交结果不明或历史尚未物化时，记录为 `unknown` 并保留槽位，不换 ID 重发。
- 恢复只读取原 `inputId` 的原生 Turn/Item 历史，或由现有 owner pump 对账原 operation marker。零 Turn 历史、方法不可用、多个候选或读取不完整都继续 unknown；不能把“查不到”当成拒绝。
- 只有明确的原生拒绝或发送前的授权变化可以记为 rejected。精确终态以原 processing、operation、native Turn 和 version 的 CAS 释放；迟到的旧终态不能清掉后来建立的槽位。
- sender 撤权后不能建立新补充；受信 owner 仍可完成原 Turn、原 processing 的对账和结算。

迁移 `059_session_direct_input.sql` 保存不可删除、身份不可改写的输入证据，并在原 processing 终态或精确 pre-Turn 拒绝后只释放对应的恢复门。它不重放旧迁移号，也不修改已有 Run 的固定输入。

## 普通入口与布局

owned Session 的 composer 先读取 `direct-input-capability`，能力与提交使用同一组当前 writer、Session 执行、普通消息 grant、direct grant、cwd 和原生资格检查。只有服务明确返回 `steer` 或 `start` 时才显示即时发送；否则保留原消息入口。

等待原生回执时，页面保留原输入 ID，并提供“按原输入核对”。未知状态不能被隐藏、合并成新消息或靠再次 POST 清除；明确未接收后才移除本机原意图。移动输入草稿放在可键盘展开的 disclosure 中，等待核对卡不得把历史阅读区压成一行。390px 条件使用真实 CSS 宽高、DPR 和 `visualViewport.scale` 验收，不能缩字、放大大视口或隐藏 unknown 换绿。

连续阅读的当前来源、当前工具和本轮公开进展使用已关联的 Turn 与公开 Item；工具折叠仍保留最近运行、最近失败和实时项。工具原始输入输出只在服务再次核权的原位详情中读取，不进入所有读者共享的公开摘要。Task 往返、滚动锚点、键盘焦点、短窗和 `prefers-reduced-motion` 与这条输入路径一起回归。

## 配置与入口

`directInputs` 默认关闭。启用时另加与普通消息 grant 指向同一精确 Session 的 direct grant：

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

当前 HTTP 入口为：

- `GET /api/projects/:projectId/sessions/:sessionId/direct-input-capability`
- `POST /api/projects/:projectId/sessions/:sessionId/direct-inputs`
- `GET /api/projects/:projectId/sessions/:sessionId/direct-inputs/:inputId`
- `POST /api/projects/:projectId/sessions/:sessionId/direct-inputs/:inputId/reconcile`

提交正文包含 `inputId`、`operationId`、`content` 和 `expectedTurnId`。所有读取按当前项目、actor 与 review 权限重新授权。不要用客户端自报的 `human`、`direct` 或角色名替代 grant。

## 检查边界

- `direct-input-client.test.ts` 检查能力响应和 503 后 404 的原输入保留，以及明确预占前拒绝的区分。
- `direct-input.test.ts` 在独立 PostgreSQL 18 schema 检查双启动唯一槽位、Run/消息两种主来源、两条同一 Turn 的 steer、TaskRevision/inputHash 不变、额度、撤权、未知和终态 CAS。
- `direct-input-native-live.mts` 使用固定 alpha.6 二进制在隔离 HTTP/PG/Thread 中执行 direct start 和两条 steer，并回读三个精确 client ID/Item。
- `direct-input-native-sources-live.mts` 在同一隔离边界分别使用已有业务 Run 和普通自动消息 processing，各送入两条 steer；前者核对固定 Run 输入未变，后者由现有 pump 完成终态结算。
- 浏览器回归检查普通 owned 入口、长历史、unknown 卡、390/正常/短窗、减少动态、工具详情授权、Task 往返和滚动锚点。

真实原生试跑证明固定二进制和隔离数据路径；它不证明正式服务已启用该配置、已部署迁移、独立 acceptance-owner 已亲用或用户已在正式入口使用。发布后的普通入口复测、独立使用和 Task 验收仍分别留证。
