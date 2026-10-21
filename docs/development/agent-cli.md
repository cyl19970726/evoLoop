# Agent CLI：按固定依据工作与恢复

默认路径是：人先在工作台看进展、变化和依据，在现有 Agent 会话中沟通目标、授权范围或需要自己的取舍；Agent 通过项目内的 `evoloop-workflow` 业务技能和 CLI 读取固定证据、执行大多数常规修改；人再从同一项目查询看结果，必要时亲用并反馈。工作台主要给人观察、阅读、追溯和反馈，直接人工操作可按需保留，不要求人替 Agent 点击或批准每个常规步骤。CLI 使用与工作台相同的 coordinator API、权限及领域规则；沟通中的意图不能让技能自行增权。CLI 不接管现有 Codex Desktop 聊天，也不创建新的永久职责。开始前需有已授权的项目身份、可访问的服务和 Node.js 24；本机服务准备见[本机运行](local-run.md)。业务对象、固定修订及消费者反馈的含义见[项目数据](../architecture/project-data.md)和[日常闭环](../product/daily-loop.md)。

## 先发现能力，再读任务

从仓库运行 `npm run --silent cli -- help` 查看**当前构建实际支持**的语法；`command types`、`command schema TYPE` 列出通用命令及其校验结构；`request types`、`request schema NAME` 列出专用请求、嵌套必填字段和枚举。不要按文档中的例子猜一个服务器不存在的命令。`--help`、`id`、schema/type 查询无需凭据；业务读取与写入需要 `EVOLOOP_API_URL`、`EVOLOOP_TOKEN`，可用 `EVOLOOP_PROJECT` 指定默认项目。令牌通过私有环境变量提供，不写入命令行参数、JSON 请求文件或公开日志；承载配置的本机文件应在仓库外或明确被 Git 忽略。

```sh
npm run --silent cli -- help
npm run --silent cli -- session
npm run --silent cli -- list tasks --project "$PROJECT_ID" --limit 20
npm run --silent cli -- task "$TASK_ID" --project "$PROJECT_ID"
npm run --silent cli -- context "$TASK_ID" --project "$PROJECT_ID"
npm run --silent cli -- command schema task.create
```

`task UUID --history` 展示已保存的真实修订及当时状态；`document UUID --revision UUID`、`original DOCUMENT_UUID --revision UUID [--out NEW_DIRECTORY]` 指向固定原件。`context` 应带回 Task 的封存依据及可读来源，并明确 `complete` 或逐项 `partial`；总读取预算为 16 MiB，超限时列出未读固定 ID，可按其修订逐项调用 `original`。来源失败时不可把最近版本猜作任务依据。HTML 与资源包导出只进入调用者指定的私有**新目录**，其父目录须已存在；可放在仓库外，或明确被 Git 忽略的本机目录，不公开原件。对于知识页、候选、运行、负责人讨论、日程等，按 `list`/`read` 的实际帮助读取；固定来源、未采纳候选和已发布认识不得混同。普通 `get /api/...` 保留为同源只读兼容入口。

## 提交与核对

拿到当前版本、真实依据和权限后，用 schema 制作 JSON 文件。通用命令经 `command run JSON_FILE`（旧式 `command JSON_FILE` 兼容）提交；同一 `operationId`、行为者及同一内容可重读原回执，不同内容复用 ID 会被拒绝。修改已有对象时使用刚读到的 `expectedVersion`，遇版本冲突重读并重新判断，不能把旧意图直接改个版本重发。专用操作先看 `request types` 和 `request schema NAME`，再用 `request NAME --project UUID --file JSON_FILE [--id TARGET_UUID] [--receipt LOCAL_UUID]`；目标 ID 和是否另需本地回执 ID 由该类型帮助说明。它只分派已实现的具名 API，不是任意 POST 通道。

```sh
npm run --silent cli -- command types
npm run --silent cli -- command schema task.create
npm run --silent cli -- request schema knowledge.propose
npm run --silent cli -- command run "$PRIVATE_REQUEST_FILE"
npm run --silent cli -- operation "$OPERATION_ID" --project "$PROJECT_ID"
```

工作起点可以是目标、Task、过程文档或现有材料，不要求先创建 Wiki、Role 或讨论。用 `task.create` 提供清楚的 title/content/acceptance/owner，系统一次保存 Task 与主正文；`context` 即使在 todo 时也读取固定主正文。`task.start` 校验版本与实际授权，发布主正文并封存本轮依据，进入 in_progress；没有额外规格文档也能工作。省略 `basis` 会继承并校验原有固定来源；显式 `basis: []` 才表示移除其他来源、仅保留主正文。来源已经改版时须记录适用的保留决定，或明确选择所需固定修订，不能自动换成最新版。新写入口不再使用 task.propose/judge/accept/block/defer/resume/revise；以实际 schema 为准。

原 Task 关联的阶段已经回看时，`task.start` 会明确拒绝。需要同一任务承接新一轮工作，先读取 Task/阶段与 `command schema task.update`，核对正文、验收和权限，再以当前 expectedVersion、完整任务字段和理由提交 `task.update`：省略 `stageId` 保留原关联，显式 `stageId: null` 解除关联，或指定本项目的 active 阶段。显式调整要求 write＋review；实际变更限 todo，无在途或结果未知运行，新非空关联须有 consumer/evidence/stopCondition。旧阶段与旧关联保留。已确认 rejected 的启动记录不改写；范围或关联调整后的新启动是新意图，使用新 operationId，不能把它当作未知结果重试。

任务类型可选实施、调研、验证，四态为 todo/in_progress/done/cancelled。交付与约定检查默认留在进行中的原任务内，标准通过后才 close；只有明确要求的消费者或真人使用才等待对应证据。受阻或暂缓说明原因、责任与下一步，不另开状态或默认验收子 Task。需要改变执行中的正文或验收时先核清在途，再 reopen→update→start；旧交付不可自动算新一轮通过。Task 主正文不能从通用 Document 编辑入口旁路改变。Document 用途、格式、发布/归档及正文写作见[任务与过程文档](../product/tasks-and-documents.md)。

专用上传、知识和引用仍用 request schema；命令只证明服务回执，不证明长期效果。当前基线及本轮实测见[路线 C5](../roadmap.md#c5-taskdocument-模型简化)。

评价入口的首片针对**一个固定 Task、两组条件**。先读取 `evaluation-source TASK_UUID --project UUID`，取得进行中 Task 当前来源修订及服务端推导的签名；再查看 `command schema evaluation.create`，以固定协议/共同材料、同一指令与判据建立直接组和额外 Wiki 组。直接组要求 Task 本身没有必需 Wiki；两组声明相同模型和运行环境。修订定义用 `evaluation.revise` 追加新版本，既有尝试不搬到新版。`list evaluations --project UUID [--task UUID | --knowledge UUID]` 与 `evaluation EVALUATION_UUID --project UUID [--revision UUID]` 读取定义、全部真实尝试、判定、更正与结论。普通 `runtime.run.reserve` 必须带固定评价绑定，且每次尝试使用新的受管 Session；成功预留才有真实 Attempt，派发前还须完成受控输入包绑定。用 `evaluation-packet EVALUATION_UUID --project UUID --revision UUID --attempt UUID` 回读实际包及固定来源，不能把定义中的材料清单当作已送达证明。

每个尝试用 `evaluation.assessment.record` 记录实际 Run 对应的 Delivery/Observation、失败、采用、真人效果、证据与成本；没有成本回执填 `null`，不填零。更正指定 `supersedesId`；`evaluation.conclusion.record` 必须选取所有首次及重试尝试的当前判定，并明确比较限制和下一步选择。首片只允许 `with_limits` 或 `unknown`，不能把两组记录与局部成本标成完全可比。`nextActionRef` 可固定引用已有 Task 的 `{kind:"task",taskId,taskRevisionId}`，服务端校验同项目及修订归属，不自动创建或开始它。命令结构以 `command schema TYPE` 为准，读回包、Run、交付及观察后再下结论。评价不会自动关闭原 Task 或发布 Wiki。此入口仍需完整本机集成与真实两组运行验收，当前说明不等于业务实测已通过。

## 未知结果与本地回执

CLI 写入前保存私有本机意图回执；`receipts list`、`receipts show ID`、`receipts reconcile ID` 用于找回原始目标、请求和已知结果。`EVOLOOP_STATE_DIR` 可指定仓库外或明确被 Git 忽略的私有本机目录；本机实现按 0700 目录、0600 文件创建且不覆盖已有回执，但不会强制目录位于仓库外。回执不能进入公开 Git。服务端确认的同一 actor、项目权限与 API origin 允许合法令牌轮换后继续核对；旧回执若没有 actor 记录，只能用原令牌。不同 actor 不可据此换身份接管。`EVOLOOP_TIMEOUT_MS` 仅控制等待，不使写入失败变成未提交证明。CLI 将 JSON 结果写 stdout、诊断写 stderr，失败或冲突退出非零；它不自动重试 POST。

若回包丢失或状态未知，保留原操作 ID、请求正文和读入基线。先按同一 ID 查询 `operation ID --project PROJECT`；若操作涉及外部知识发布、来源或 Runtime，按对应具名恢复/复核接口核对外部原件及本地记录，不能把普通操作查询当成外部发布证明。404 仅表示该次未查到，不能证明未执行；不能换 ID 盲重派。外部动作的状态仍不明时停止该动作并报告未知和需要的人工核对。

纯事务核心命令有显式恢复入口：`receipts retry RECEIPT_UUID`。它只接收保留的 `/api/commands` 意图，并要求回执记录的原 actor 与当前服务端核实的 actor 一致；缺少 actor 的旧回执只允许核对。先按原 ID 读回；找到结果就返回，不再次提交。若核心明确返回 OPERATION_NOT_FOUND，可按原 actor、项目、操作 ID、正文和 expectedVersion 原样回放一次，依赖服务端项目锁、命令摘要和同事务日志去重；404 仍不证明前次未执行。它不能改变正文、换 ID、自动提高版本或重放上传/知识发布等外部操作，也不删除本机回执。已拒绝的原操作先重读拒绝原因和对象，不强套通过。恢复中的网络错误、权限变化或摘要不符继续保留 pending，不据此宣布原操作失败。

```sh
npm run --silent cli -- receipts reconcile "$RECEIPT_ID"
npm run --silent cli -- receipts retry "$RECEIPT_ID"
```

## 当前边界

具名读取、固定 context/原件、专用请求 schema、持久回执与服务端核对已实现；当前能力以 `help`、`command types`、`request types`、对应 schema 与实际读回为准。新上下文 Agent 已仅经业务 skill＋CLI 完成一项隔离静态归档任务：上游改版显式保留旧依据，交接引用错误产生的两次失败保留，修正版经另一 Agent 实际读取和字节核验后关闭；普通工作台独立只读 QA 可见相同固定原件、交付、观察和旧历史。整合检查与 C1—C4 状态统一见[阶段路线](../roadmap.md#agent-业务入口-c1c4实施里程碑)。这核验了机器入口与人的观察面能够接续，不能替代真人亲用或证明整体产品效果。外置 Wiki 已有受限写读与候选复核证据，语义索引未验；飞书真实租户延后；生产可靠性与长期效果仍需独立验收。

C5 补充验证了新模型：一项 Task 无需预建主文档，经 CLI 一次创建后直接读取正文、开始并交付；首版错误深链的失败观察保留，修订时实际走 reopen→update→start，省略 basis 仍继承原归档修订。修正版经另一 Agent 重读固定 context、导出并核验 355 字节 HTML/CSS/SVG 后关闭，普通 GUI 独立回读相同正文、交付和历史。图在 390px 下保持可读字号并内部横向滚动；这些仍是隔离样本与 Agent 使用，未升级既有预览或证明真人体验。
