# 普通 Task 定时与后继复制：字段和授权设计

> 2026-11-06 的字段与授权核对。下文保留实施前的风险分析，便于追溯复制边界。候选实现已接线并通过隔离验证；独立验收、合并发布和正式入口复测仍待完成。

## 权威与入口

**现状。** `task.create` 原子创建普通 todo、主 `task` Document、TaskRevision 和 TaskProposal。`task.update` 在同一 Task 上修订要求；`task.start` 才固定主正文及所选依据为 sealed BasisSet，并进入 `in_progress`。`work.plan.set` 另存 `plannedStartAt`、`dueAt`、`priority`；计划时间目前不参与 `task.start` 或 Run 预留的时间守卫。Schedule 的 once/daily、IANA 时区、latest、`scheduleId + plannedAtUtc` 去重已有实现，但重叠 `queue` 时 occurrence 的 `taskId=null`，与本需求每个有效时点生成 todo 不符。

**拟实施。** 用户从普通 Task 设置首次执行时点和可选每日重复；不设时间沿原路径。首次时点只释放原 Task A；后续时点为 B/C 新建普通 Task。系列定义、未来有效要求修订、停止和已发生时点登记应有单一持久权威，Task 详情和总览读取该权威；Schedule 只可复用计算和去重机制，不能另成用户必须同步编辑的模板。`dueAt` 仍为截止时间，执行时点需单独存储并在正常启动/派发入口生效。已有 Task 不自动取得定时语义。

## 字段矩阵

“复制”是把当前**未来有效要求**写入新 Task；“重建”是新 ID/本次事实；“校验/阻断”表示只有当前资格成立才可写入，不能静默降级。表中字段名称对应现有模型；系列字段是拟新增。

| 字段或关系 | 处理 | 依据及拟实施规则 |
| --- | --- | --- |
| `projectId` | 校验/阻断 | 固定同项目；跨项目来源、Role、Stage 或依赖不得隐式搬迁。 |
| `taskId`、`version`、`currentRevisionId`、TaskRevision `id/version` | 重建 | B/C 各有新 ID、版本 1；记录源 Task/修订、系列 ID、前一 Task 和应发生 UTC 点，不复用 A 的标识。 |
| `title`、`content`（prompt）、`acceptance` | 复制 | 从该时点的未来有效修订取值，核正文非空及大小；不能从旧已完成副本递归取 prompt。 |
| `contentDocumentId`、`contentRevisionId`、主 Document 的 title/body/hash/author | 重建 | 每份 Task 有自己的 `kind=task` 主 Document 和初始修订；复制正文**字节**、重算 hash、记录来源修订，不共用 A 的主文档或采纳指针。 |
| `kind`、`domainId` | 复制；校验/阻断 | `kind` 保持普通 Task 类型；非空 `domainId` 需重新确认本项目 active，失效不改为空。review 正文不创造另一 Task kind。 |
| `owner` | 复制；校验/阻断 | 必须仍是本项目 `trial`/`active` Role，不能从旧 Session 或临时显示名推断执行权；失效时保留原系列配置并报 Lead。 |
| `state`、`basisSetId` | 重建 / 省略 | 新 Task 为 `todo`，初始无 sealed BasisSet；`done/cancelled/in_progress` 与旧 basis ID 都不继承。新 Task 自己 `start` 时再封存自己的主正文与外部依据。 |
| TaskRevision `actorId/reason/createdAt` | 重建 | 写实际受控物化行为者、来源、时点与创建原因；不能伪作源 Task 作者。 |
| TaskProposal `stageId` | 校验/阻断 | 非空时重查 Stage 同项目且 active、Goal/受管目标仍匹配，并保留完整提案字段；过期不能自动解绑为无 Stage todo。 |
| TaskProposal `consumer`、`useRequired`、`acceptanceMode` | 复制；校验/阻断 | 保持精确消费者 actor、验收模式和使用要求；`human_required` 必须有真实指定 human，不能改成 agent 或 `useRequired=false`。消费者资格和受管决策例外重新校验。 |
| TaskProposal `evidence`、`stopCondition` | 复制；校验/阻断 | 作为本次工作要求继承；有 Stage 时三项（含 consumer）须齐全。旧提案 ID/创建时间重建。 |
| `task_document_link` / `documentIds` | 复制关系；校验/阻断 | 以新 link ID 关联同项目仍可读的原过程文档；链接只是导航，不代表固定采用。源 Task 主文档只可作明确来源引用，不能充当新 Task 主文档。 |
| 额外 `basis` 的 DocumentRevision | 校验/阻断后新建固定集合 | 依据选择必须指向新 Task 已链接、仍 published 且原件/hash 可核的修订；新 Task 开工时由有权者显式选择并封存。旧 `basisSetId`/`basis_member` 不原样复制。 |
| `retentions`、basis 决策及 `impact_review` | 省略；必要时重审 | 旧保留理由和待复核影响属于旧 Task。若仍要采用被新修订取代的旧来源，应对新 Task 重新作显式保留决定并核当前采纳版，不能借 A 的签名。 |
| `task_external_ref_head/snapshot/decision`、Git/Wiki/Run 引用 | 校验/阻断 | 保留来源身份、修订/hash 的候选意图，但为新 Task 重新作有权决定及快照；旧 Task 的 decision ID、slot head 和观察有效性不复制。Run 类引用尤其不能变成 B 的已执行 Run。 |
| `task_work_plan.plannedStartAt` | 重建 | 写 B 本次应发生点；与系列规则、实际承接/开工时间分别显示。既有 plan version/actor/updatedAt 不继承。 |
| `task_work_plan.dueAt`、`priority` | 校验/阻断 / 复制 | `priority` 可复制为本次排序提示；旧绝对 `dueAt` 不复制。若需求有相对截止偏移，须明确规则后算出本次截止并核不早于开始；没有规则时保持空。 |
| `task_dependency`、`dependency_head` | 校验/阻断 | 不盲继承 A 的绝对前置 Task ID。明确声明为系列前一份或仍有效的固定前置才为 B 建新边；核同项目、存在、无自依赖/环，派发时仍须前置当前修订已关闭或 accepted release。系列串行守卫不靠旧依赖边偷换。 |
| `task.assignment`、ack、Session/HostLink、队列 claim | 省略 | B 从未分派开始；Lead 重新选与 owner Role 匹配的 Session，接收者对 B 的确切修订本人 ack。A 的签接手不授权 B。 |
| Run/Turn/Dispatch、运行 grant、预算消耗、`ordinary.submit` | 省略 | B 经正常 start、固定输入、权限和预算核验后再申请新的执行；原操作 unknown 先对账，不因到下一周期重跑。 |
| Delivery、消费者观察、TaskClosure、StageReview、Leader review、关注跟进、成本和结果 | 省略 | 都属于 A 的实际历史。B 的验收与结果必须独立产生；总览可通过系列关系读取 A 的结果。 |
| occurrence、系列水位、前后 Task 关系、下一时点、停止状态 | 重建 / 持久记录 | 每个有效点唯一 `(project, seriesId, plannedAtUtc)`；记录生成/跳过/阻断及源要求修订，副本只属于同一系列，不注册新系列。 |

## 授权和失败边界

**现状的实际门。** 普通 `task.create` 需要项目 `write`，新 owner 必须为 `trial`/`active` Role；`task.start`、关闭、取消、重开、Run 预留需项目 `review`。新业务 Task 默认 `useRequired=true`；唯一 `useRequired=false` 创建例外是 reviewer 创建的 research + Stage、consumer=owner 且 owner 为 cognition 模板 Role 的决策任务，不能作为普通重复 Task 的默认值。`task.update` 一般需 `write`，显式 Stage 决定还需 `review`，显式 basis 需 `read+review`；改变验收模式/消费者需 `review` 且 todo，改变 `human_required` 模式或消费者还需当前 human 消费者本人。`work.plan.set` 和 `work.dependencies.set` 要 `write+review`、Task 当前版本和各自元数据版本；依赖拒绝缺失、自依赖和环。`task.assignment.acknowledge` 只由指定 recipient 签，不能由 Lead 代签。Schedule 创建/修订需 `review` 和 `authorization.authorizedBy=当前 actor`；pump 还要求项目 `write+review` 凭据、启用状态、writer lease、匹配的 `(project, actor, scopeId, roleId)` grant，物化前复核到期授权与 owner Role。普通 `task.create` 的 `write` 权不能单独授权无人值守重复建 Task。

**实施的授予边界。** 每个系列以首次 Task A 的 ID 得到固定范围 `task-timing:<A taskId>`；创建每日规则、修改未来要求、以及物化 B/C 都要求 grant 的 project、actor、Role 和 `scopeId` 四项精确匹配。仅本次定时不消耗调度 grant，停止系列在 grant 撤销后仍可执行。未配置范围时，可先创建普通或一次性 Task，配置该 ID 的范围后再改为每日。B/C 沿 A 的范围，不从各自 ID 派生新的 grant。物化在同一事务重核 Role、Stage、材料、验收政策、系列版本和唯一时点；不能从旧 Task owner、旧 Schedule、旧业务 Run 或 Task 正文推导新权限。普通消费者仍按 B 的验收合同亲用；runner 仍按 B 的 Session/Role/assignment、固定 basis、运行 grant 与预算单独核验。当前 grant 配置没有单独的有效期字段，撤权以当前配置和 pump 读取为准。

**显式阻断。** 缺少/撤销 grant 或过期、owner 退休、Stage 失活/目标不匹配、消费者资格不成立、文档不可达或 hash 不符、旧依据待复核、无效依赖/环、版本冲突、来源或系列已改、旧 Run/物化操作结果 unknown，均保留原记录和可读原因，交 Lead 处理。不能改为无 Stage、无消费者、弱验收或空 basis 后继续。`task.update` 当前对已结束 Task 拒绝，执行范围变化在 `in_progress` 也要求先 reopen；未来要求应有独立系列修订入口，不能为改后续而重开 A。现有 Schedule 的 queued occurrence 不含 Task，需改变物化边界才能兑现每个有效时点有独立 todo；原 `overlap=queue` 语义不可直接声称已达标。

## 时间、编辑与历史

- **一次性。** 到点仅允许 A 进入原执行流程；延误时仍处理 A 一次。时间守卫须覆盖正常 start/队列及直接 Run 入口，不能只在列表标记等待。实际开始另记，不覆盖计划时点。
- **每日。** 使用 IANA 时区固定本地 HH:mm；计算不随 A 完成时刻漂移。复用 Schedule 对不存在的夏令时时点跳过、重复本地时点选较早 UTC 的算法，并把该处理展示在时点记录中。每个有效点至多一个 B/C。
- **漏时与重叠。** `latest` 只补最近一个漏时点，保留漏掉数量/范围；正常按时的连续点各建 todo。A 未完成、失败待处置或 Run unknown 时，B 仍生成但显示系列串行等待，不自动开工；B 未结算时 C 同理。停止系列只停未来物化，不取消历史或在途 Task。
- **改时和范围。** 默认“仅本次”走当前 Task 正常修订门；显式“本次及后续”同时修订未来要求；已开始/结束的 Task 只能选“仅后续”。系列修订记录从哪个尚未生成时点生效，改规则不能追改已生成 B 或 A 的固定输入。当前 Task 不可改时不能借系列入口覆盖它。更改时点前核已登记/queued 点；旧时点和操作留历史，新规则以系列加 UTC 时点唯一键去重。
- **固定历史。** 每份 Task 的 TaskRevision、主 DocumentRevision、sealed BasisSet、Run 输入、Delivery/观察/关闭各留原 ID；新副本记录采用的未来要求修订和来源 Task 修订。A 的后续编辑不改 B 的已生成正文，B 的正文编辑也不分叉成第二个周期来源。

## 核对入口

- 固定需求：Task `f8c2ede7` 修订 `8d5629cd`，主 Document `d8f6a199` 修订 `7a89b1bd`（SHA-256 `acee7f83…ecb8`）；Lead 已选的首版异常策略在该主文末节。
- Task 字段与创建/更新/启动：`packages/contracts/src/index.ts`、`packages/contracts/src/workflow.ts`、`packages/core/src/index.ts`、`packages/core/src/runtime/basis.ts`。
- 计划、依赖、分派：`packages/contracts/src/work-index.ts`、`packages/contracts/src/session-assignments.ts`、`packages/adapter-postgres/src/work-index.ts`、`packages/core/src/runtime/reserve.ts`；使用说明见 `docs/development/agent-cli.md`。
- Schedule 时间/授权/物化：`packages/contracts/src/scheduling.ts`、`packages/core/src/scheduling/{commands,due,index}.ts`、`packages/adapter-postgres/src/scheduling.ts`、`apps/coordinator/src/scheduling/pump.ts`；语义合同见 `docs/architecture/contracts.md` §7。
- 依据与外部引用：`packages/core/src/task-input.ts`、`packages/contracts/src/references.ts`、`packages/adapter-postgres/schema/{008_references,042_leader_work_index}.sql`。
