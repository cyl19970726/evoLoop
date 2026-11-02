# Leader 结果回程的启用与恢复

业务结果写入后，数据库在同一事务保留可核对的通知。`work leader notices --project PROJECT_ID` 可读通知及其固定来源；`--task TASK_ID` 限定原 Task。通知行的 `pending` 表示尚待投递，`linked` 只表示已保存一条受管 Session 消息。消息的原生 Turn、接收者收阅、Leader 后续安排以及 Task 关闭分别从消息、工作计划和 Task 事实核对。

迁移 `046_leader_result_notice` 增加通知表及针对待编排 Task、封存 Delivery、独立验收、关键问题/阻塞和缺交付终态 Run 的触发器。迁移不重写旧 Delivery 或旧 Task。升级前的工作仍由 `work leader changes` 和工作索引对账；升级后的事件在未启用受管 Leader 时留在通知表。

## 显式接线

当前项目的 Lead 是外部 HostLink。外部 HostLink 可主动查变化，登记它本身不会启动原生 Turn。发布者在切换前须先准备**一条独立的受管 Leader Session**，核其 Role 为项目唯一 active 或 trial 的 system Lead、实际接收 actor、项目写权限、原生 Thread、执行 grant、工作目录和 CLI 身份。现有业务 Session 不作为 Leader 目标。

在现有私有 integrations 配置中保留所有原字段，并增加：

```json
"leaderResultNotices": {
  "enabled": false,
  "pollIntervalMs": 2000,
  "targets": [{
    "projectId": "PROJECT_UUID",
    "sessionId": "MANAGED_LEADER_SESSION_UUID",
    "receiverRoleId": "LEAD_ROLE_UUID",
    "receiverActorId": "ACTUAL_LEADER_ACTOR",
    "senderActorId": "AUTHORIZED_NOTIFIER_ACTOR"
  }]
}
```

`senderActorId` 是配置中明确授权的技术通知者，须与实际 Leader actor 不同，二者都须为项目 writer；Leader 接收 actor 还须有项目 `review` 权限，才能保存计划和复核。现有 `sessionMessages` 必须启用，并有对此 sender、Leader Session、receiver actor、Role、cwd 的**精确 grant**及可用额度。通知只引用 Task/结果固定入口，不能据摘要自动签验收。先保持 `enabled:false` 验证配置、身份和存储，再在所有旧 Leader 消息 Turn 静默且没有未知处理时明确切换到唯一目标，启用并重启服务。不可同时为同一项目配置两个目标。

Leader 读取原 Task、Delivery 或 Observation 后，保存计划和分派；原 Task 的独立验收可用 `session.message.post` 指向 QA 受管 Session，消息带当前 Task/Delivery 与验收范围。QA 本人通过 `observation.record` 回写原 Task 的当前 Delivery；作者 Run 和原 claim 不转给 QA。Queue claim 与受管消息各有原生启动和未知结果对账，不因消息排队就显示实际接手。

## 诊断、回退和发布边界

投递受阻时保留通知、原 message/operation ID 和安全原因。缺 grant、Session 暂不可用或旧 Leader 在途时，修复后从同一固定通知恢复。已固定收件人时不可自动改投新 Session；原消息确认失败、取消或原 post 被确认拒绝后，也不得把可能已经执行的工作自动重发。操作者先核原 operation、消息状态、Task 当前修订和旧目标的 Turn，再以有权身份保存新的人工通知或接续安排，保留原失败记录。配置切回 `enabled:false` 会停止产生新的自动投递，数据库通知和已保存消息仍保留；已在途或 unknown 的原生 Turn 须先按原 operation 对账。数据库迁移不回滚删表，避免丢失结果历史。

切服务前核所有业务 Run 和消息 Turn 已静默，保留当前服务的配置、身份、模型和 CLI manifest；候选集成检查不代替正式原生接力。上线后分别核通知入库、消息已保存、原生接收/已读、Leader 安排、QA 实际观察和 Task 完成。旧修订的 Delivery/观察不得用于关闭新修订。
