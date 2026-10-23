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

当前 todo Task 尚无 basis 时，`context` 另列 `observedPlanningCandidates`：关联过程文档当时已发布、已采纳的修订、hash、来源 Task 修订与固定原件路径。`planningObservedAtUtc` 记录观察时间；这些指针尚未封存，也不表示本次命令读过候选正文。按指针读取精确 `original`；采纳版改变后旧候选可能失效，应重新观察并说明变化。未发布、归档、超限或不可发现的关联材料会明确列为 partial。历史 `--revision` 与已封存 context 沿用自己的依据，不混入当前候选。此只读发现不启动 Task，也不要求启用自动执行；受管 worker 中仅认知职责可在已授权 Goal/Stage 范围查询。

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

负责人讨论的决定使用 `discussion.decision.record`，由核心同事务追加讨论事件和所属 Document 正文；通用 `document.revise` 不会同步讨论指针。若另行编辑后返回 `DOCUMENT_CHANGED`，先核对原操作的确定拒绝，再完整回读讨论登记版与文档当前版、哈希及最新决定。经实际判断后，以新意图/新操作 ID、当前 Discussion `expectedVersion`、真实当前 `documentRevisionId` 及最新决定的 supersede 引用提交，并显式增加 `documentRecovery: { expectedDocumentVersion, reason }`。核心仅在确有失配、版本匹配且原件可核时，从当前正文追加恢复依据和本次决定；旧修订、拒绝记录及冻结输入不变。不失配时不提供恢复字段，不能直接改数据库指针。操作未知仍先按原 ID 对账，讨论及文档权威见[项目数据](../architecture/project-data.md#3-关系与认知读取)；实际操作也应读取项目内业务技能的讨论指引。

评价入口的首片针对**一个固定 Task、两组条件**。先读取 `evaluation-source TASK_UUID --project UUID`，取得进行中 Task 当前来源修订及服务端推导的签名；再查看 `command schema evaluation.create`，以固定协议/共同材料、同一指令与判据建立直接组和额外 Wiki 组。直接组要求 Task 本身没有必需 Wiki；两组声明相同模型和运行环境。修订定义用 `evaluation.revise` 追加新版本，既有尝试不搬到新版。`list evaluations --project UUID [--task UUID | --knowledge UUID]` 与 `evaluation EVALUATION_UUID --project UUID [--revision UUID]` 读取定义、全部真实尝试、判定、更正与结论。普通 `runtime.run.reserve` 不要求评价；只有声明为评价尝试的 Run 才须固定 `evaluation` 绑定，每次尝试使用新的受管 Session。成功预留才有真实 Attempt，派发前还须完成受控输入包绑定。用 `evaluation-packet EVALUATION_UUID --project UUID --revision UUID --attempt UUID` 回读实际包及固定来源，不能把定义中的材料清单当作已送达证明。

Run 确认终态后，用 `delivery.record.runId` 显式登记产物，先核任务业务输入仍与执行时一致；交付登记修订不等于 Run 的执行修订。每个尝试用 `evaluation.assessment.record` 记录显式关联该 Run 的 Delivery/Observation、失败、采用、真人效果、证据与成本；旧无 Run 归因的交付不能推测为评价成果。没有成本回执填 `null`，不填零。更正指定 `supersedesId`；`evaluation.conclusion.record` 必须选取所有首次及重试尝试的当前判定，并明确比较限制和下一步选择。首片只允许 `with_limits` 或 `unknown`，不能把两组记录与局部成本标成完全可比。`nextActionRef` 可固定引用已有 Task 的 `{kind:"task",taskId,taskRevisionId}`，服务端校验同项目及修订归属，不自动创建或开始它。命令结构以 `command schema TYPE` 为准，读回包、Run、交付及观察后再下结论。评价不会自动关闭原 Task 或发布 Wiki。本轮已由授权的负责人 Agent 完成两组真实运行、完整输入包与产物回读，并登记有限评价；具体范围与阶段决定见[完整旅程接续试用](../roadmap.md#完整旅程接续试用)。Wiki 采用正确不代表增量收益，Agent 使用不代表真人效果。

## 未知结果与本地回执

CLI 写入前保存私有本机意图回执；`receipts list`、`receipts show ID`、`receipts reconcile ID` 用于找回原始目标、请求和已知结果。`EVOLOOP_STATE_DIR` 可指定仓库外或明确被 Git 忽略的私有本机目录；本机实现按 0700 目录、0600 文件创建且不覆盖已有回执，但不会强制目录位于仓库外。回执不能进入公开 Git。服务端确认的同一 actor、项目权限与 API origin 允许合法令牌轮换后继续核对；旧回执若没有 actor 记录，只能用原令牌。不同 actor 不可据此换身份接管。`EVOLOOP_TIMEOUT_MS` 仅控制等待，不使写入失败变成未提交证明。CLI 将 JSON 结果写 stdout、诊断写 stderr，失败或冲突退出非零；它不自动重试 POST。

若回包丢失或状态未知，保留原操作 ID、请求正文和读入基线。先按同一 ID 查询 `operation ID --project PROJECT`；若操作涉及外部知识发布、来源或 Runtime，按对应具名恢复/复核接口核对外部原件及本地记录，不能把普通操作查询当成外部发布证明。404 仅表示该次未查到，不能证明未执行；不能换 ID 盲重派。外部动作的状态仍不明时停止该动作并报告未知和需要的人工核对。

纯事务核心命令有显式恢复入口：`receipts retry RECEIPT_UUID`。它只接收保留的 `/api/commands` 意图，并要求回执记录的原 actor 与当前服务端核实的 actor 一致；缺少 actor 的旧回执只允许核对。先按原 ID 读回；找到结果就返回，不再次提交。若核心明确返回 OPERATION_NOT_FOUND，可按原 actor、项目、操作 ID、正文和 expectedVersion 原样回放一次，依赖服务端项目锁、命令摘要和同事务日志去重；404 仍不证明前次未执行。它不能改变正文、换 ID、自动提高版本或重放上传/知识发布等外部操作，也不删除本机回执。已拒绝的原操作先重读拒绝原因和对象，不强套通过。恢复中的网络错误、权限变化或摘要不符继续保留 pending，不据此宣布原操作失败。

```sh
npm run --silent cli -- receipts reconcile "$RECEIPT_ID"
npm run --silent cli -- receipts retry "$RECEIPT_ID"
```

## 配置周期工作的接续

先用 `command schema schedule.create` / `schedule.revise` 核对当前输入。需要自动承接时，在新修订模板显式设置 `managedTarget: {loopId, stageId}`，指向同项目、已授权且已限定该 Stage 的 Loop 和 active Stage，并核模板责任者、日程 grant 与该业务职责的 runtime profile。缺省仍只创建普通 todo，不借下一次 tick 偷改旧日程范围。

创建/修订后读回日程修订与 occurrence；到期产生的 Task、其固定 Stage、源事件、认知及实际 Run 分别核对。认知复用这项 todo，不另外创建同工作 Task。暂停日程停止后续物化，暂停 Loop 停止新执行，两者都不代替中断在途 Run。结果未知保留原操作/UTC 实例键，不凭下次触发重复启动；旧修订 queued 的处理仍须明确核对。完整状态边界见[日程合同](../architecture/contracts.md#可选的受管目标)。

## 受管执行与自动接续

自动循环使用同一 CLI、业务 core 和 App Server，另有独立的编排命令与回执。`command types/schema/run` 同时发现两类命令；编排命令发往 `/api/orchestration/commands`，原业务命令仍发往 `/api/commands`。用 `list loops`、`list inbox --loop ID`、`list dispatches --loop ID`、`read loop ID --events`、`read dispatch ID` 和 `read submission ID` 回读。编排操作在 `/api/projects/PROJECT_ID/orchestration/operations/OPERATION_ID` 核对原 actor 与命令摘要；CLI 不自动重发。显式 `receipts retry` 只支持其纯事务白名单，原生启动和封存等阶段先对账。

管理员一次配置项目职责、目录、scope 与预算，再 `loop.enroll` 固定 Goal/Stage、起始事件基线、认知职责及允许的业务职责。循环不扫描并启动历史 todo。认知先读取真实依据，核对可复用的 Stage 待办；合适且无在途或 unknown Run 的 todo Task 可按观察到的版本申请子派发，不同工作才新建 Task。`cognitive_review` 与 `next_action` 分别承载同一来源的认知与后续动作，正式子派发在父最终决定前提出，引用父认知 Dispatch；父 Run 已知终态且封存副作用已知后即可执行，无需父报告或 Delivery。每项 Task 不需要人重新开始或预留。业务结果经独立来源订阅去重回到认知，不消费飞书投影的回执。

自动执行中，Task 的 `documentIds` 选择所需过程输入。首次开始会显式封存这些文档的 published/adopted 修订；已有关联但未发布或归档的输入会阻断，不被静默忽略。已有 basis 沿用固定来源及保留决定。过程报告交付使用 `#/p/PROJECT_ID/documents/DOCUMENT_ID?revision=REVISION_ID` 固定入口，`artifactRevision` 与 `contentHash` 要和保存后回读的原文一致，供后续认知精确读取。

受管 worker 使用原生输入提供的私有 wrapper，只带固定 Loop/Task/Run/Session 和职责的独立短期身份。运行期间读取 `context` 和固定原件，并在终态前通过 `worker.submit` 提交有署名的交付意图，或以 `worker.decision` 说明无动作、等待、失败或停止。终态回收者核对原身份、输入修订/hash、原 operation 与实际业务日志后封存 Delivery；提交人和封存人分别留证，final 摘要不代填交付。已终态或 unknown Run 不接受第一次补交；真正终态前已提交的同 ID 操作仍可回读。具体执行方式见仓库内 `.agents/skills/evoloop-workflow/references/managed-workers.md`。

worker 读 Document 一律指定修订：`document ID --revision REV` 或 `original ID --revision REV`；无版本详情和修订列表被拒绝，自己曾写过或任务曾关联也不能借此读取别人后来改写的正文。新建报告直接使用 `document.create` 回执里的 `revisionId` 核对原文，普通负责人身份的文档入口不受这项 worker 限制。

暂停/停止阻止新派发和原生启动，不撤销已经在途的有效凭据；既有运行可在原范围提交、回读和收尾。撤权或到期另行处理，结果不明保留原 ID。未署名、封存未知与缺少职责保留待处理证据，不凭 Run 完成自动 close Task。首片为每次派发建立独立 managed Session，尚未复用会话，也不自动创建永久 Role、桥接 Desktop 或完成长期分工研究。

独立消费者的 `observation.record` 会经真实操作回执与 actor 核对后进入认知来源，按 Delivery 当时的固定 Task 修订、Stage 和 Goal 去重归属；生产者自报和本 Loop 认知自己的观察不算独立使用。认知可据技术失败等其它新证据采取授权内行动，独立观察只用于证明实际消费和效果。

已确认终态却没有署名提交或决定的 Run 会留下 `dispatch.gap`，释放并发，并在原 Loop 的预算、暂停与来源去重约束内进入认知入站。自动恢复最多一跳：恢复认知自身再缺提交时保留新缺口，不自动反复创建恢复工作；有权者核清原因后的显式处理仍须校验原来源与剩余预算。新认知读取原 Dispatch、Run 和执行时的固定 Task 范围，决定调查、修复、等待或停止；不会复活旧凭据、重发旧原生运行、替旧 worker 补签或凭缺口登记交付。旧格式缺口通过原操作回执及原 Run 的不可变绑定还原依据，无法核对时保留缺口。未知 Run 或封存结果不明仍保持原身份与占用，不走此自动恢复分支。

worker 凭据的有限有效期由外部配置 `orchestration.credentialTtlMs` 决定，默认一小时，可在一分钟至一天内按实际运行时序校准。到期后不能首次提交；改配置只影响后来新签发的凭据，不延长旧文件。凭据校准与缺提交恢复是两项独立验证：不能靠重置 Loop 预算或重复失败来替代它们。

## 当前边界

具名读取、固定 context/原件、专用请求 schema、持久回执与服务端核对已实现；当前能力以 `help`、`command types`、`request types`、对应 schema 与实际读回为准。新上下文 Agent 已仅经业务 skill＋CLI 完成一项隔离静态归档任务：上游改版显式保留旧依据，交接引用错误产生的两次失败保留，修正版经另一 Agent 实际读取和字节核验后关闭；普通工作台独立只读 QA 可见相同固定原件、交付、观察和旧历史。整合检查与 C1—C4 状态统一见[阶段路线](../roadmap.md#agent-业务入口-c1c4实施里程碑)。这核验了机器入口与人的观察面能够接续，不能替代真人亲用或证明整体产品效果。外置 Wiki 已有受限写读与候选复核证据，语义索引未验；飞书真实租户延后；生产可靠性与长期效果仍需独立验收。

C5 补充验证了新模型：一项 Task 无需预建主文档，经 CLI 一次创建后直接读取正文、开始并交付；首版错误深链的失败观察保留，修订时实际走 reopen→update→start，省略 basis 仍继承原归档修订。修正版经另一 Agent 重读固定 context、导出并核验 355 字节 HTML/CSS/SVG 后关闭，普通 GUI 独立回读相同正文、交付和历史。图在 390px 下保持可读字号并内部横向滚动；这些仍是隔离样本与 Agent 使用，未升级既有预览或证明真人体验。
