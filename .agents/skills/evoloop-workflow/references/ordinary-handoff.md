# 普通 Session 接手

本页适用于有 Task 的普通静态或受管 Session，先按项目 `evoloop-workflow` 核身份与本轮协议。Loop/Dispatch broker、故障恢复和更改责任走该 skill 的对应按需入口；普通 wrapper 不等于 worker 身份。

1. **确认本轮工作。** 从可信的派单入口核 `session` 身份、实际 Task owner、Role 职责、适用项目 skill 和收件通道。对新 `evoloop-markdown-v2` Run 执行首包给出的带 hash `handoff`；对旧 v1 读其完整固定指令。首包摘要不是完整 Task。Skill、Role 或上下文发生变化时读适用版本；版本未变也要能定位，不在每个 Task 复制岗位说明。
2. **读足固定目标。** 核 Task 修订、完整验收、主 Document 与封存来源。`handoff` 的 `contentComplete:false` 或截断标记要求按 `fullContentCommand` 分页读完剩余主正文；回答引用与 `requiredLegacyInput` 按本轮变化读取。目录给出原件身份、大小与读取命令，不证明原文已进入模型。必要来源按固定修订/hash 分页或取附件；一次输出截断就补读缺失段。背景资料按当前未知选择，不把每件关联文档无条件读成上下文。
3. **自主行动与提问。** 先说清用户需要什么决定或行为，再选择能支持它的调查或实现。范围、授权、固定来源相互冲突且无法独立解决时，在本 Task 通道把已核事实、具体选择与影响交给派单者；其他可独立部分继续。普通消息与 Task 问答按各自入口，不用“已发送”冒充 Lead 已收到或答复。回答改变范围时由有权者修订 Task，旧输入保留。
4. **本人提交和回读。** 按[成果写作](results.md)先给可使用结论，再附证据、修订、检查和未验。在 Run 有效期内按 `request schema ordinary.submit` 以已核业务身份提交固定成果意图，填实际 Task／Session／Run、Task 修订与 Run 输入 hash、产物引用／版本／hash 和技术结果；队列 Run 的预留者不自动成为成果作者。未知响应以原 operation ID、原正文核对，不换 ID 重投。核固定产物与提交回执，在本 Task 通道交给真实接收者，然后结束 Turn；不要等待或轮询自己的 Run 终态。封存器与 Lead 随后核终态、submission 和匹配 Delivery，后续接续时可再读回。阻塞或缺口交给 Lead 处理。Run completed、Delivery、消费者实际使用及 Task close 分别核；不能代消费者签用或关闭。

一次实际接手中，执行者分页读取约 12 KB 的设计 HTML，并将图片实际送到 `view_image`，最终写出供 Lead 使用的说明。同次运行也因旧工作区 skill 与新 CLI 错位而额外探索，并出现工具输出截断。记录应分别说明读到的固定版本、可见页、缺失段和补读结果；资料消费成立，不等于整体接手成本下降。
