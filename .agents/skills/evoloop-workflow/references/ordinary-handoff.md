# 普通 Session 接手

本页适用于有 Task 的普通静态或受管 Session，先按项目 `evoloop-workflow` 核身份与本轮协议。Loop/Dispatch broker、故障恢复和更改责任走该 skill 的对应按需入口；普通 wrapper 不等于 worker 身份。

1. **确认本轮工作。** 从可信的派单入口核 `session` 身份、实际 Task owner、Role 职责、适用项目 skill 和收件通道。对新 `evoloop-markdown-v2` Run 执行首包给出的带 hash `handoff`；对旧 v1 读其完整固定指令。首包摘要不是完整 Task。Skill、Role 或上下文发生变化时读适用版本；版本未变也要能定位，不在每个 Task 复制岗位说明。
2. **读足固定目标。** 核 Task 修订、完整验收、主 Document 与封存来源。`handoff` 的 `contentComplete:false` 或截断标记要求按 `fullContentCommand` 分页读完剩余主正文；回答引用与 `requiredLegacyInput` 按本轮变化读取。目录给出原件身份、大小与读取命令，不证明原文已进入模型。必要来源按固定修订/hash 分页或取附件；一次输出截断就补读缺失段。背景资料按当前未知选择，不把每件关联文档无条件读成上下文。
3. **自主行动与提问。** 先说清用户需要什么决定或行为，再选择能支持它的调查或实现。范围、授权、固定来源相互冲突且无法独立解决时，在本 Task 通道把已核事实、具体选择与影响交给派单者；其他可独立部分继续。普通消息与 Task 问答按各自入口，不用“已发送”冒充 Lead 已收到或答复。回答改变范围时由有权者修订 Task，旧输入保留。
4. **交付和回读。** 按[成果写作](results.md)先给可使用结论，再附证据、修订、检查和未验。核固定产物与实际写入回执，在本 Task 通道交给真实接收者。Run completed、Delivery、消费者实际使用及 Task close 分别核；不能替 Lead 签用或关闭。

例如 [Task A 的固定使用报告](http://127.0.0.1:55431/#/p/dfb56cce-4ecd-452d-94dc-bf9611babf11/documents/4c1b6cd2-2de3-41bb-91e6-4cd75ddb1947?revision=a6788bf6-ff31-4854-9b4d-dcd78a8f3cdd)记录：原 11,762 B HTML 分页可见、图片实际送到 `view_image`、最终说明可供 Lead 使用；同时旧 skill/新 CLI 错位导致额外探索与截断。它证明该次资料消费，不能据短首包推定整体接手成本下降。遇类似情况应记录究竟读到哪一版、哪些页缺失及补读结果。
