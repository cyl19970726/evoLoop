# 受管宿主失联：判别与停点

适用：coordinator 的 HTTP 仍响应，但受管原生 runtime 不可用，或其他宿主可能占用原 Thread。保留原 Task、Session、Thread、Run、消息、操作 ID 与队列预算；恢复不是新派单。

1. **分开核事实。** 读服务健康与 runtime 能力、Session 的 Role/绑定/profile 和 PG 状态、原 Run 与 bound Turn、消息及队列、观察时间和外部 writer。PG 的 `owned`、`ready`、`busy`、`running` 不能单独证明当前执行。Turn 空闲不证明 writer 锁已释放；`lsof` 显示打开锁文件不证明锁模式。Desktop 可读历史、可见输入框和实际写入控制权分别核对；原生 `serviceName` 只是 metrics 标记。
2. **选最小合法释放。** 先查当前平台的正常 owner 释放／交还合同，核外部 writer 和后代 Turn 是否仍活动。不能在争用中直接恢复派发。特定已核版本、用户明确授权、指定原聊天空闲且无在途业务时，对该聊天一次 archive/unarchive 可以作为应急选择。核原 Thread ID 与历史保留、writer 确实释放；失败或含糊即停。这不等于常规交还、项目 Session closed 或根因修复，也不成为定期动作。涉及其他聊天的停机先约定维护窗口；不删锁、不强杀共享 Desktop、不换 actor 或 Thread。
3. **恢复后按原 Turn 对账。** 冲突消除或新派发已正式隔离后，有权者按 [CLI 宿主恢复命令](../../../../docs/development/agent-cli.md#受管宿主失联与原会话恢复)执行 `runtime.recover`，再读原 bound Turn 和完成时间。`runtime.reconcile` 只接受 runtime 在线且 PG Run 已知终态，不能把离线的 PG `running` 直接结算。缺 Turn 历史、终态时间、原操作结果或 writer 证据时保留 unknown 与占用，按原 ID 对账，不重放提示或消息。当前 preflight 可能在 `beginDispatch` 后才遇外部 writer 冲突，不能假定一次 recover 会安全保留排队消息。
4. **核真实接续。** 查原生 child 与 writer、原 Turn 结算、同 Thread 下一项已授权真实任务、模型/effort/sandbox/approval，以及后续 grant 余额和 `blockedReason`。额度耗尽与再次失联分别报告，不清计数、不换 sender。临时连接恢复、独立使用和长期代码修复各自留证；不跑空 Turn 凑通过。

此应急选择只在已核宿主版本与指定空闲聊天有观察证据；其他版本和平台尚未验证。命令/schema、权限与回执以所连 CLI 的实际帮助及 [Agent CLI](../../../../docs/development/agent-cli.md#受管宿主失联与原会话恢复) 为准。
