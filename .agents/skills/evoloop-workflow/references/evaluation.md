# 固定条件评价：真实运行与结论

这份参考只用于已实现的首片：一个进行中 Task、直接读材料与额外读固定 Wiki 修订两组。先以 `evaluation-source TASK_UUID --project UUID` 读取服务端签名；若 Task 的封存来源已经要求 Wiki，不能把任何一组称为“直接”。协议与共同材料使用固定 Document/Git 修订和 SHA-256，Wiki 组明确页 ID、修订与 hash。两组使用相同共同指令、判据、模型及声明环境；任务、来源或条件变化时另建定义修订，保留旧尝试。

用 `command schema evaluation.create` 核对命令结构，再经 `command run JSON_FILE` 保存定义。每次消费预留新的受管 Session 和带评价绑定的 `runtime.run.reserve`；重试也产生单独 Run/Attempt。协调器派发前构建并绑定受控输入包；绑定后用 `evaluation-packet EVALUATION_UUID --project UUID --revision UUID --attempt UUID` 回读协议、共同材料、Task 必需来源、额外 Wiki、内容 hash 与实际包。缺包、权限或来源验证失败应保留失败事实，不把清单或摘要说成模型已收到的输入。

以 `evaluation EVALUATION_UUID --project UUID --revision UUID` 读取全部尝试。Run 确认 completed/failed/interrupted 后，以 `delivery.record` 的 `runId` 显式登记其产物；登记前服务核对当前正文、验收与固定依据仍等于该 Run 的业务输入。两组可以先运行完，再分别登记。`Delivery.taskRevisionId` 是登记产生的修订，执行修订仍从 Run 读取；二者不能混写。归因登记不证明模型亲自生成了产物字节。旧无 `runId` 的交付仍可读，但不能推断为某次 Attempt 的成果。

逐次记录 `evaluation.assessment.record`，关联 `runId` 与 Attempt 相同的 Delivery 和相应 Observation；来源忠实、知识采用、交付合格、真人效果分别判断。Agent 采用知识不能证明真人效果，成本无凭据时填 `null` 而非零；失败和人工时间同样入账。纠正指定被取代判定 ID，不覆盖原记录。

最后以 `evaluation.conclusion.record` 选入首次和重试的**全部**尝试的当前判定，写明可比性、未知成本、局限、受影响修订与下一步选择。首片缺全阶段成本覆盖与技术隔离证据，只能写 `with_limits` 或 `unknown`，即使两组有局部成本也不能标完全可比。`nextActionRef` 可填已有 Task 的 `{kind:"task",taskId,taskRevisionId}`；修订必须属于同项目该 Task，引用不会自动开始后续工作。结论不自动关闭 Task、采纳或发布 Wiki。此参考不代表已完成一次真实两组对照；正式命令以当时 CLI 的 `help` 和 `command schema TYPE` 为准。
