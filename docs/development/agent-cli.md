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

工作起点可以是目标、Task、过程文档或现有材料，不要求先创建 Wiki、Role 或讨论。用 `task.create` 提供清楚的 title/content/acceptance/owner，系统一次保存 Task 与主正文；`context` 即使在 todo 时也读取固定主正文。

若声明 `consumer`，须填精确匹配的消费者标识；Agent 消费者应在启动前通过 `session` 核实实际 `principal.actorId`，并确认它会亲自使用当前 Delivery、签署观察。不要填 roleId、显示名或身份解释；解释写入 `evidence` 或 `reason`。外部 human 消费者继续使用现有 reviewer attestation 合同。验收确实要求使用时，应同时声明 `consumer` 并设置 `useRequired: true`；此时 `task.close` 要求当前 Delivery 最新的声明消费者观察结果为 `used`，worker 完成、仅有 Delivery 或其他 actor 使用都不能替代。`command schema task.create` 和 `command schema task.update` 会显示这些字段说明。

`task.start` 校验版本与实际授权，发布主正文并封存本轮依据，进入 in_progress；没有额外规格文档也能工作。服务自动把主 Document 加入依据，显式 `basis` 只列额外固定来源，不重复主 Document。省略 `basis` 会继承并校验原有固定来源；显式 `basis: []` 才表示移除其他来源、仅保留主正文。来源已经改版时须记录适用的保留决定，或明确选择所需固定修订，不能自动换成最新版。新写入口不再使用 task.propose/judge/accept/block/defer/resume/revise；以实际 schema 为准。

若旧 Run 的封存输入缺少后来已采纳的关联报告，项目 reviewer 先核清旧 Run 和当前 Task；进行中须待 Run 确定终态，再 `task.reopen`。在 todo 状态用 `command schema task.update` 读取格式，以当前版本、完整 Task 字段和理由提交显式 `basis`（仅列额外 `documentId/revisionId`），可同次新增 `documentIds` 链接；只有链接不授 worker 原件读取。重选要求 read/write/review，不能由受管 worker 用普通更新白名单代签。保留已被新版取代的修订时，随本次显式 `basis` 提供逐项 `retentions` 的观察采纳版和理由；单独传 retentions 会拒绝。回读新 Task 修订和 sealed Basis，再正常启动。旧 Run 仍按旧固定集合读取；已受理派发若版本过期会在启动时拒绝，不可借重选复活。

原 Task 关联的阶段已经回看时，`task.start` 会明确拒绝。需要同一任务承接新一轮工作，先读取 Task/阶段与 `command schema task.update`，核对正文、验收和权限，再以当前 expectedVersion、完整任务字段和理由提交 `task.update`：省略 `stageId` 保留原关联，显式 `stageId: null` 解除关联，或指定本项目的 active 阶段。显式调整要求 write＋review；实际变更限 todo，无在途或结果未知运行，新非空关联须有 consumer/evidence/stopCondition。旧阶段与旧关联保留。已确认 rejected 的启动记录不改写；范围或关联调整后的新启动是新意图，使用新 operationId，不能把它当作未知结果重试。

任务类型可选实施、调研、验证，四态为 todo/in_progress/done/cancelled。交付与约定检查默认留在进行中的原任务内，标准通过后才 close；只有明确要求的消费者或真人使用才等待对应证据。受阻或暂缓说明原因、责任与下一步，不另开状态或默认验收子 Task。需要改变执行中的正文或验收时先核清在途，再 reopen→update→start；旧交付不可自动算新一轮通过。Task 主正文不能从通用 Document 编辑入口旁路改变。Document 用途、格式、发布/归档及正文写作见[任务与过程文档](../product/tasks-and-documents.md)。

受管认知签署 waiting 且原 Run 已确认终态后，仅恢复 Loop 不会重新消费已处置来源。阻塞确已解除时，有项目 write＋review 的控制者先查看 `command schema loop.resumeWaiting`，以当前 `expectedLoopVersion`、原 `decisionId`/`dispatchId`、解除证据 `evidenceRef` 和理由提交新意图。worker 不能自行解除；以下恢复模式只选一种。

- **固定 Issue**：同时省略 `continuation` 与 `businessRecovery`，保持原合同，要求 active Loop/Stage、无 child 或同源未知/在途派发及剩余预算；不把任意文档当作 Issue。
- **同 Task 研究接续**：原来源为本 Loop bootstrap 或已核实的同 Task 恢复链时，提供 `continuation: { kind: "same-task-study", declarationId, expectedTaskVersion }`。从当前 Task 回读版本，同时核当前有效的完整 Run 声明、原固定材料、来源授权和 reviewer；原 Task 仍为同 Goal/active Stage/认知 Role 的 in_progress，原 waiting 是该 Task 最新派发，且无 child/division/未知或在途 Run。它复用原研究 Task。
- **业务结果后的返工回看**：原 waiting 认知直接承接同 Loop 已确认终态的业务 `worker.outcome` 时，提供 `businessRecovery: { expectedTaskVersion, basisSetId }`。先通过正常任务规则把原业务 Task 准备为 todo；需要新原件时，由有权者显式重选依据并回读当前版本和 sealed basis。服务核原业务派发及其认知父派发、同 Goal/active Stage、原责任者、无后续派发或在途/未知 Run、当前业务授权及固定依据。成功只为这项原业务工作追加一次新的认知回看来源，不重用旧业务 Run，也不自动代做返工。恢复事件本身不增加原件权限；新认知按既有规则读取同 Goal/Stage 内获准 Task 的当前固定主正文、依据及获准规划候选，仍须指定明确修订并通过当前授权检查。后续业务执行者须按自己新 Run 的固定依据亲自读取，不能把认知可读当作业务执行者已经读过。

同 Task 研究与业务返工恢复可在 paused Loop 登记，仍须由有权者显式激活后才派发；stopped 拒绝。来源接纳、派发请求与开始前会再次核任务版本、依据和现行授权；登记后材料改变时先核拒绝与新状态，不偷换为新版。一个 waiting Decision 只能解除一次；同 operationId、同身份同正文仍按既有操作账回读。

成功只追加 `waiting.resumed` 因果事件并递增 Loop 版本，不改旧 Decision、拒绝记录、403 或预算。后续认知、业务返工及独立反馈按实际新 Dispatch 消耗原剩余额度；暂停、恢复登记和记录使用本身不增加额度。新 Session/Run 使用自己的 worker 身份读取固定原件，旧凭证、旧 Run 或把原文复制进提示都不能替代合法读取。恢复成功不证明返工、消费者使用或 Task 验收已经完成。

若经明确的范围与成本决定仍需增加额度，由原登记控制者先读 Loop 和 `command schema loop.extendBudget`，以当前 `expectedLoopVersion`、`expectedMaxRuns`、只比原值多 1 的 `maxRuns`、批准依据 `evidenceRef` 和理由提交。该命令要求项目 write＋review、Loop paused 且无未结派发或在途/未知 Run；旧上限或版本不符、跨控制者、一次加多次、减额、active/stopped 都拒绝。成功追加预算变更事件并更新 Loop 版本，原 `dispatchCount`、策略、全部失败与其他 Loop 不变，也不会激活 Loop。原 operationId 同正文回读，不自动反复增额；worker 不能自行申请或通过新 Loop 重置计数。

专用上传、知识和引用仍用 request schema；命令只证明服务回执，不证明长期效果。当前基线及本轮实测见[路线 C5](../roadmap.md#c5-taskdocument-模型简化)。

负责人讨论的决定使用 `discussion.decision.record`，由核心同事务追加讨论事件和所属 Document 正文；通用 `document.revise` 不会同步讨论指针。若另行编辑后返回 `DOCUMENT_CHANGED`，先核对原操作的确定拒绝，再完整回读讨论登记版与文档当前版、哈希及最新决定。经实际判断后，以新意图/新操作 ID、当前 Discussion `expectedVersion`、真实当前 `documentRevisionId` 及最新决定的 supersede 引用提交，并显式增加 `documentRecovery: { expectedDocumentVersion, reason }`。核心仅在确有失配、版本匹配且原件可核时，从当前正文追加恢复依据和本次决定；旧修订、拒绝记录及冻结输入不变。不失配时不提供恢复字段，不能直接改数据库指针。操作未知仍先按原 ID 对账，讨论及文档权威见[项目数据](../architecture/project-data.md#3-关系与认知读取)；实际操作也应读取项目内业务技能的讨论指引。

评价入口的首片针对**一个固定 Task、两组条件**。先读取 `evaluation-source TASK_UUID --project UUID`，取得进行中 Task 当前来源修订及服务端推导的签名；再查看 `command schema evaluation.create`，以固定协议/共同材料、同一指令与判据建立直接组和额外 Wiki 组。直接组要求 Task 本身没有必需 Wiki；两组声明相同模型和运行环境。修订定义用 `evaluation.revise` 追加新版本，既有尝试不搬到新版。`list evaluations --project UUID [--task UUID | --knowledge UUID]` 与 `evaluation EVALUATION_UUID --project UUID [--revision UUID]` 读取定义、全部真实尝试、判定、更正与结论。普通 `runtime.run.reserve` 不要求评价；只有声明为评价尝试的 Run 才须固定 `evaluation` 绑定，每次尝试使用新的受管 Session。成功预留才有真实 Attempt，派发前还须完成受控输入包绑定。用 `evaluation-packet EVALUATION_UUID --project UUID --revision UUID --attempt UUID` 回读实际包及固定来源，不能把定义中的材料清单当作已送达证明。

Run 确认终态后，用 `delivery.record` 并提供 `runId` 显式登记产物，先核任务业务输入仍与执行时一致；交付登记修订不等于 Run 的执行修订。每个尝试用 `evaluation.assessment.record` 记录显式关联该 Run 的 Delivery/Observation、失败、采用、真人效果、证据与成本；旧无 Run 归因的交付不能推测为评价成果。没有成本回执填 `null`，不填零。更正指定 `supersedesId`；`evaluation.conclusion.record` 必须选取所有首次及重试尝试的当前判定，并明确比较限制和下一步选择。首片只允许 `with_limits` 或 `unknown`，不能把两组记录与局部成本标成完全可比。`nextActionRef` 可固定引用已有 Task 的 `{kind:"task",taskId,taskRevisionId}`，服务端校验同项目及修订归属，不自动创建或开始它。命令结构以 `command schema TYPE` 为准，读回包、Run、交付及观察后再下结论。评价不会自动关闭原 Task 或发布 Wiki。本轮已由授权的负责人 Agent 完成两组真实运行、完整输入包与产物回读，并登记有限评价；具体范围与阶段决定见[完整旅程接续试用](../roadmap.md#完整旅程接续试用)。Wiki 采用正确不代表增量收益，Agent 使用不代表真人效果。

## 仓库工程任务与动作交接

收到代码或正式文档任务，先以实际 `session` 身份、Task 当前版本、固定 `context` 和必要原件确认问题、预期结果、边界、验收及消费者；核对仓库当前基线和已有修改。形成与复杂度相称的方案，在隔离 worktree 完成变更与必要回归，审阅集成差异，再按[贡献流程](../../CONTRIBUTING.md#提出与完成变更)完成聚焦 PR、自审、当前 head 必要检查、独立审阅和正常合并。报告型任务没有仓库改动时说明不适用，不制造空 PR。`session`、Task owner、承载 Role、broker 身份、仓库提交者和合并者须分别核实；业务 CLI 身份不能代替 Git 或外部平台授权。

若 skill 目录、Git common dir、PR 或合并等动作超出当前执行环境/授权，留下持久的精确动作请求或现有受控交接：关联 Task/固定修订和 Run、请求者、预期有权执行者、具体动作及 repo/worktree/path/commit/PR 范围、理由、输入版本、截止/验收与当前阻塞。记录批准或拒绝、实际执行 actor、操作 ID、结果及证据；请求本身不是批准。若尚无对应业务命令，先核 `help`、`command types`、`request types` 和 schema，使用当前已授权的交接路径并明确待接续，不编造命令或声称消息已自动送达。自动审批拒绝后不换身份、借 owner 凭据、放大沙箱或关闭检查重试；结果未知先以原 ID 对账。收到实际动作回执后，原执行者须在自己的后续运行中读取，核对固定输入、产物和未完成项。

工程回执让下一位可以复核：问题与实际改动、Task/Run/Session 及固定输入版本、commit/PR/merge commit、当前 head 的检查和失败项、固定产物链接与修订/hash、各动作真实执行者、部署状态与使用入口、已知限制及下一责任。没有发生的 PR、合并、部署或使用写为待办/未验，不能填占位符充完成。普通静态 Run 由有权 Lead 核终态和产物后登记 Delivery；broker worker 按下文签真实提交意图，封存者另留身份。独立消费者沿实际入口使用当前 Delivery，要求 `useRequired` 时由声明消费者亲签观察；失败保留原观察并回原 Task 修复、重新交付和复测，新发现的独立问题才另建有来源 Task。Run 终态、Delivery、合并、部署、消费者使用和 Task close 是不同证据。当前通用常驻队列及 Desktop 自动唤醒未在此文档声明为可用；后项接续按实际已部署能力和授权核验。

## 未知结果与本地回执

CLI 写入前保存私有本机意图回执；`receipts list`、`receipts show ID`、`receipts reconcile ID` 用于找回原始目标、请求和已知结果。`EVOLOOP_STATE_DIR` 可指定仓库外或明确被 Git 忽略的私有本机目录；本机实现按 0700 目录、0600 文件创建且不覆盖已有回执，但不会强制目录位于仓库外。回执不能进入公开 Git。服务端确认的同一 actor、项目权限与 API origin 允许合法令牌轮换后继续核对；旧回执若没有 actor 记录，只能用原令牌。不同 actor 不可据此换身份接管。`EVOLOOP_TIMEOUT_MS` 仅控制等待，不使写入失败变成未提交证明。CLI 将 JSON 结果写 stdout、诊断写 stderr，失败或冲突退出非零；它不自动重试 POST。

若回包丢失或状态未知，保留原操作 ID、请求正文和读入基线。先按同一 ID 查询 `operation ID --project PROJECT`；若操作涉及外部知识发布、来源或 Runtime，按对应具名恢复/复核接口核对外部原件及本地记录，不能把普通操作查询当成外部发布证明。404 仅表示该次未查到，不能证明未执行；不能换 ID 盲重派。外部动作的状态仍不明时停止该动作并报告未知和需要的人工核对。

纯事务核心命令有显式恢复入口：`receipts retry RECEIPT_UUID`。它只接收保留的 `/api/commands` 意图，并要求回执记录的原 actor 与当前服务端核实的 actor 一致；缺少 actor 的旧回执只允许核对。先按原 ID 读回；找到结果就返回，不再次提交。若核心明确返回 OPERATION_NOT_FOUND，可按原 actor、项目、操作 ID、正文和 expectedVersion 原样回放一次，依赖服务端项目锁、命令摘要和同事务日志去重；404 仍不证明前次未执行。它不能改变正文、换 ID、自动提高版本或重放上传/知识发布等外部操作，也不删除本机回执。已拒绝的原操作先重读拒绝原因和对象，不强套通过。恢复中的网络错误、权限变化或摘要不符继续保留 pending，不据此宣布原操作失败。

```sh
npm run --silent cli -- receipts reconcile "$RECEIPT_ID"
npm run --silent cli -- receipts retry "$RECEIPT_ID"
```

## 建立常驻业务职责与首个受管任务

以下是既有合同下的操作路径，不表示当前项目已登记目标 Role、配置所需授权或完成首次运行。缺少精确 grant 时保留待承接；不能套用其他职责的授权、替换原任务或绕过暂停与预算限制来启动新职责。

1. **定职责和首项工作。** 现有负责人核清职责缺口、范围、替代办法、试行期限及回看条件。用 `task.create` 建 todo Task，写明真实工作、验收、首任 owner 和所需来源；已有正式 Role 时直接沿用。
2. **接受试行并交接。** 按 `command schema role.propose` 引用未完成的首 Task 提案；有 review 权限者按 `command schema role.decide` 作 `accept-trial` 决定。回读 Role 修订；若首任 owner 不同，在 todo 状态按正式 Task 更新与交接规则转给新 Role，并回读新版本。交接记录不代替 Task owner 变更。
3. **固定任务依据和授权。** 负责人读取 Task 正文与关联原件，按 `task.start` 封存本轮依据并进入 in_progress。另落实项目、Role、actor、scope 的当前精确 runtime grant，核目录、模型、沙箱、审批及所需网络能力；Role 文本和其他 Role 的 grant 不授执行权。
4. **建立并绑定承载。** 按 `command schema runtime.session.reserve` 预留 Session；runner 创建 owned Thread 后，回读原生身份和实际目录，确认为 `ready`。再按 `command schema role.bindSession` 绑定同项目、同 Role 的项目 `sessionId`；不能填 Desktop chat ID 或原生 session ID。
5. **派发并核运行。** 按 `command schema runtime.run.reserve` 提供当前 Task 版本、ready Session 与固定工作输入，回读 Turn 和终态。Task 须 in_progress 且 owner 与 Session Role 一致，Task 和 Session 均无在途或 unknown Run；普通后续 Turn 可复用空闲 ready Session，评价尝试须另建 Session。结果不明时按[原操作恢复](#未知结果与本地回执)核对。
6. **核产物与交付。** 负责人亲验产物、检查、Run 终态与输入一致性后，以自身授权执行 `delivery.record`，提供 `runId`、真实产物引用、修订/hash 与检查证据，结构以命令 schema 为准。按原 Task 判据关闭；仅声明 `useRequired` 时才要求指定消费者真实 `used` 观察。

普通 Run 不发 worker CLI 身份或自动生成 Delivery，控制者不能代签 `worker.submit` 或冒充 Agent 消费者亲用；外部真人消费仍按既有 reviewer attestation 合同记录。worker 自助报告须走[受管 Dispatch/broker 路径](#受管执行与自动接续)。自动 Loop 逐 Dispatch 新建 Session，绑定不触发复用；Desktop 自动桥接和侧栏注册没有已验证保证，普通业务长期自动巡检仍未实现。Role 与承载实例的合同见[RoleRegistry 与 SessionRuntime](../architecture/contracts.md#4-roleregistry-与-sessionruntime)。

## Lead 分派、返工与再次承接

Task 写清问题、希望改变的结果和唯一当前责任后，Lead 按实际职责选择承接者：规范负责人处理项目 skill、任务写法及工程方法，功能开发负责人处理业务能力，产品文档负责人处理产品模型。职责名称不表示已经建立 Role 或承载；先查正式记录。普通领域修复无需先经过规范负责人审批，跨域工作只需明确文件所有权和最终回收者。Lead 在这里是本项工作的协调责任，不新增平台权限或中心审批岗位。

| 交接时点 | 谁做什么 | 回读什么才能继续 |
| --- | --- | --- |
| 选择责任 | Lead 读现有 Role；适合就沿用。没有合适职责时先说明缺口与临时承接办法，需新持续职责再走试行。 | 正式 Role 承接时核对 Task owner；临时逻辑 owner 则写明实际执行者、权限和人工交接，不推定已绑定承载。consumer 是实际使用者身份，不拿 Role ID 代填。 |
| 选择承载 | 有执行授权者核 Role 绑定和 Session。已有空闲 ready owned Session 可供普通 Run 复用；无可用实例再按上节建立。 | 真实 project sessionId、roleId、原生 Thread 和 cwd，以及 Task/Session 上无在途或 unknown Run。ready 只表明可用，不证明正在工作。 |
| 固定并启动 | Lead 核正文、验收和所需固定来源，正常 start 后显式 reserve Run；执行者读自己的身份与固定 context。 | TaskRevision、basis 与 Run 输入一致；wrapper 仅是入口，不据此推定 worker 权限。普通静态 Run 不调用 worker.submit。 |
| 接收交付 | 执行者交实际差异、产物、检查与限制；普通 Run 已知终态后，Lead 核实再关联 runId 登记 Delivery。 | 固定产物修订/hash 与实际检查；Run 完成、Delivery、使用观察和 Task 关闭分别核对。要求使用时由声明消费者实际使用并记录。 |
| 返工 | Lead 把具体未满足的原判据、复现和下一责任留在原 Task 的反馈中。改正文或依据前先处理在途/未知，再按 reopen→update→start 建新修订。 | 保留原 Run/交付/失败观察，新 Run 只承接新固定输入；不因验收失败另造同工作的 Task。 |
| 下一项工作 | Lead 明确分派第二项真实 Task，核 owner、固定输入、当前授权及空闲状态后，显式在原 Session 预留新 Run。 | 两项 Task、两次 Run 对应同一项目 Session 和同一原生 Thread；新聊天、同名 Role 或相同 cwd 均不能代替。常驻承载不因首 Task 结束自动关闭。 |

普通显式路径可保留同 Session 连续承接，但仍须 Lead 驱动。受限自动 Loop 只在自己的来源、职责、范围、预算及活动状态内接续，当前逐 Dispatch 新建 Session；`role.bindSession` 不让 Loop 自动选择原常驻承载。通用常驻路由、任意 Desktop 聊天挂载与自动唤醒不可据此宣称已实现。产品语义见[任务与过程文档](../product/tasks-and-documents.md)、[工作台](../product/workbench.md)及[Codex 承载关系](../architecture/codex-integration.md#任务职责与定时触发)。

正在集成的常驻队列另提供同一 owned Session 的候选路径。实际启用前先从所连接服务的 `help`、`command types`、各 `command schema` 与读回确认是否具备 `domain.*`、`role.classify`、`host.*`、`queue.*` 和 Task `discussion.*`；仓库里有源码不证明当前服务已部署。Task `context` 中固定的领域 ID 与按观察时间读取的当前路由元数据应分开理解，路由信息不复制正文、也不授启动权。Lead 先核 Role/domain 映射、owned Session 与当前精确授权，为已封存的进行中 Task 明示排序理由、依赖、消费者、总 Run 预算，再采纳队列版本。未领取时改序用所见版本 CAS；Task 正文或依据变化须修订条目并重新采纳。队列控制者领取时重验当前 grant、绑定、Task 输入、同 Session 占用和未知 Run；每次续跑计入同一预算。外部 Desktop link 即使已核人工领取，也不能填作 owned Session 自动派发。Loop broker、常驻队列控制者与业务 CLI actor 各按真实身份行事，不互相代签。

执行者用自己的业务身份读固定 context 与本 Run 的 Task 通道；问题、答复、进度和阻塞引用固定过程 Document 修订。发出、收到、已读、实际采用和解决各看独立事件/回执。在途 Turn 不接收静默改写；需要答复接续时，原 Run 已知终态后由当前有权控制者用 `queue.continue` 固定前一通道的真实问答，在原 Session 开新 Run，并核输入含精确答复；若答复改变 Task 范围，先按普通任务改版和队列重采纳处理。受限工程动作按[工程交接](#仓库工程任务与动作交接)保留请求、批准及实际执行回执，外部结果 unknown 沿原 ID 对账；`request` 不授执行权。默认等当前通过的交付、Task 验收关闭及声明消费者实际使用后才释放前项；无依赖后项的提前放行须 Lead 留有界决定及原 Task 下一责任，依赖项仍等验收。上述是候选合同，尚无队列真实部署和独立验收；不要把命令名当作本机已可执行示例。

核当前记录可从 `list roles`、`read role ROLE_ID --bindings`、`list sessions`、`list runs` 和 `task TASK_ID` 开始，均带实际 `--project`；详情按 `help` 使用 `read session` / `read run`。Role 列表可分页；Session/Run 列表当前不接受 `--limit` 或 `--cursor`。用绑定关联 Session，再用 Run 关联 Task，不从会话名称猜当前任务。私有 ID、地址与回执放过程报告，不放公开规范。普通工作台是否能直接找到同样关系，须另做实际阅读验证；API 可读不等于页面可见，列表或讨论区缺口不能用文档说明冒充前端已补齐。

## 配置周期工作的接续

先用 `command schema schedule.create` / `schedule.revise` 核对当前输入。需要自动承接时，在新修订模板显式设置 `managedTarget: {loopId, stageId}`，指向同项目、已授权且已限定该 Stage 的 Loop 和 active Stage，并核模板责任者、日程 grant 与该业务职责的 runtime profile。缺省仍只创建普通 todo，不借下一次 tick 偷改旧日程范围。

创建/修订后读回日程修订与 occurrence；到期产生的 Task、其固定 Stage、源事件、认知及实际 Run 分别核对。认知复用这项 todo，不另外创建同工作 Task。暂停日程停止后续物化，暂停 Loop 停止新执行，两者都不代替中断在途 Run。结果未知保留原操作/UTC 实例键，不凭下次触发重复启动；旧修订 queued 的处理仍须明确核对。完整状态边界见[日程合同](../architecture/contracts.md#可选的受管目标)。

## 受管执行与自动接续

自动循环使用同一 CLI、业务 core 和 App Server，另有独立的编排命令与回执。`command types/schema/run` 同时发现两类命令；编排命令发往 `/api/orchestration/commands`，原业务命令仍发往 `/api/commands`。用 `list loops`、`list inbox --loop ID`、`list dispatches --loop ID`、`read loop ID --events`、`read dispatch ID` 和 `read submission ID` 回读。编排操作在 `/api/projects/PROJECT_ID/orchestration/operations/OPERATION_ID` 核对原 actor 与命令摘要；CLI 不自动重发。显式 `receipts retry` 只支持其纯事务白名单，原生启动和封存等阶段先对账。

动态职责的首包可用 `command schema division.decide` / `division.revoke` / `worker.decision` 查看受限命令，以 `read policy UUID`、`read binding UUID`、`read loop UUID --events` 和原 operation 回读固定选择、授权及历史。`division.decide` 只能在认知父 Dispatch 已接受、其 Run 仍活跃且尚未签最终 worker Decision 时记录一个持久意图；它固定来源事件、父 Dispatch、Document 修订/hash、首 Task/version 与现有或试行 Role。非方法分支必须命中外置 `runtime.delegationTemplates` 的精确 project/Goal/Loop/首 Task、资源、期限及版本/hash。模板可通过 `decisionActorIds` 明示控制者，或通过默认空的 `cognitionRoleIds` 明示本 Loop 认知 Role；后者还要由服务端核真实 broker 的 parent/Run/Task/Loop 身份，不能仅凭角色文字。`waiting` 的 `worker.decision` 须引用同一父 Run 之前记录的唯一 `divisionDecisionId`；`no_action`、`stop`、`failed` 不消费意图。新增 Role 必须经原有 `role.propose` / `role.decide accept-trial` 正式规则，既可使用此前已接受的试行 Role，也可在明确创建许可下与分工决定原子提交；模板至多允许一次新职责分配，撤回不归还名额。旧单 Role runtime grant 不代表可委托。要在同一次 `division.decide` 内新提出并接受试行 Role，模板另须显式设置 `newRoleAllocation.creation: {allowProposeAndAcceptTrial: true, maxTrialDays: 1..90}` 并更新 revision/hash；命令携完整 `proposedRole` 与 `expectedFirstTaskOwner`。首 Task 必须仍为精确版本的 todo、同 Goal／Stage 且无在途或未知执行；试行回看不越模板到期。研究者需有权读回固定诊断 Document 原文，服务端按其身份核读；控制者以自身 reviewer 身份在同一项目事务内依正式 Role 规则接受试行，留下两条 Role 操作/效果记录并累计占用名额。原 operation 可回查和原样重放，异载荷拒绝。创建决定先固定 Role、binding 与不可变 Loop policy，不直接转移 Task 或启动 Session/Run。父 Run 已知完成且最终决定为 waiting 后，controller 才能在原预算内预留 child，经普通 Task 更新和 `division.confirmTransfer` 确认交接；目标 worker 之后需按自己的 Run 与固定原件签 `division.ackHandoff`。隔离测试覆盖该接续路径，真实 native 试行和实际收益尚未验证。既有静态 Loop 的预算、来源与历史派发保持原值，历史 child 按派发时 policy 核验，当前新启动仍需现行授权。

管理员一次配置项目职责、目录、scope 与预算，再 `loop.enroll` 固定 Goal/Stage、起始事件基线、认知职责及允许的业务职责。循环不扫描并启动历史 todo。认知先读取真实依据，核对可复用的 Stage 待办；合适且无在途或 unknown Run 的 todo Task 可按观察到的版本申请子派发，不同工作才新建 Task。`cognitive_review` 与 `next_action` 分别承载同一来源的认知与后续动作，正式子派发在父最终决定前提出，引用父认知 Dispatch；父 Run 已知终态且封存副作用已知后即可执行，无需父报告或 Delivery。每项 Task 不需要人重新开始或预留。业务结果经独立来源订阅去重回到认知，不消费飞书投影的回执。

后台 runner 已运行时，需研究首轮认知的正规顺序是 `loop.enroll` 指定可选 `initialState: "paused"` → 在该 Loop 当前 version 上 `loop.studyMaterial.declare` → 回读后以 `loop.state active` 启动。暂停期间后台轮询不会创建认知 Task、Dispatch 或 Run；声明只固定材料，不刷新预算。省略 `initialState` 仍按旧合同立即 active，原 operation 摘要和回执可原样重放。不能先 active enroll 再赶在下一轮扫描前抢声明。

真实执行轨迹的认知研究先由有项目 read/write/review 权限的非 worker 在当前 active Loop 上调用 `loop.studyMaterial.declare`。以 `command schema loop.studyMaterial.declare` 查看字段：声明一个来源 Task 的固定修订和最多十个已正式采纳的 Run decision ID，指定配置中的 controller actor，并用当前 Loop version 做 CAS。来源 Run 必须终态、Session ready，且当前执行 grant 仍允许读取；来源 Task 与被研究业务 Task 已正式完成并不妨碍声明。`read study DECLARATION_ID` 回读服务端解析出的 Run ID、目标 Task 修订和输入 hash，`read loop LOOP_ID --events` 回读声明与撤销。每个 Loop 同时只有一个当前声明；`loop.studyMaterial.revoke` 使用当前 version 撤销新读取权，保留历史 operation、decision 与固定引用。声明不重置执行预算。

controller 为新的认知 inbox 自动创建 Task 后，把声明中的每项 Run 作为正式外部引用复制到该 Task 的精确修订，再按更新后的 Task version 请求派发。复制中断以同一 operation ID 恢复，不提前开 Run；复制不全、来源 slot 被替换、Session 关闭、grant 撤销，或原声明者失去当前项目 read/write/review 凭据，都会阻断新复制、派发和 trace 读取。未声明时仍按普通认知流程推进，但不会自动得到轨迹权限。普通 reviewer 直接执行 `reference.task` 正式采纳 Run 的既有语义保留；受管 worker 只能读自己 Run 固定 Task 修订实际包含、且仍有当前来源与自身执行权限的轨迹。新 slot、正文里的 UUID 和事后给自动 Task 补普通引用都不能扩大自动研究范围。

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
