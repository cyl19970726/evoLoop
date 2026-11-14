---
name: evoloop-onboarding
description: 把一个新项目接入 evoLoop：先判断情况，再按步骤建项目与仓库登记、身份、Role、Leader 与业务 Session、消息授权、Leader 每日评估，直到第一个 Task 经独立验收关闭；每一步写明怎样读回确认。用于新项目接入、迁移后重新接入，或核对一个已接入项目还缺什么。日常派单、交付与验收用 evoloop-workflow。
---

# 把一个新项目接入 evoLoop

接入的终点不是“配置写完了”，而是[终态清单](references/end-state.md)里每一项都能用 CLI 读回、并且第一个真实 Task 走完“派发 → 交付 → 独立验收 → 关闭”。每一步做完先读回，读回不符就停在这一步，不往下走。

这份 skill 写给做接入的 Agent，通常是需求 Session（今天它也承担平台维护，即 Root）。它只讲接入的顺序、读回和容易出错的地方；命令的字段以所连服务的 `command schema` / `request schema` 为准，派单、交付与验收的做法在 [evoloop-workflow](../evoloop-workflow/SKILL.md)，写 Task 与设计验收在 [evoloop-requirements](../evoloop-requirements/SKILL.md)，这里只链接、不复述。

## 谁决定什么

接入里有两类动作，分开处理：

- **决定类**：接受 Role 试行、新建 Session、开放给谁什么权限、选运行时与模型、额度用完后放行。归使用者本人，或使用者明确授权过的需求 Session（DEC-047、DEC-048）。拿不准是否已授权时，把要决定的事写成一句话交给使用者，不自己推定。
- **执行类**：写私有配置、生成令牌与 CLI 包装、发命令、读回。授权范围内直接做。

无论哪一类：不拿使用者本人的令牌做事（DEC-047），令牌只进 `0600` 文件、不进命令行参数、日志、Task 正文或公开仓库；主机名、域名、本机路径也不进公开仓库。

## 0. 先判断情况

用下表定下这次接入走哪些分支，写进接入记录（见第 6 步）。

| 问题 | 情况 | 怎么走 |
| --- | --- | --- |
| 跑在哪个实例 | 已有常驻实例，新项目加进去 | 跳过实例搭建；所有私有文件改动都在**当前发布版本**的私有目录里做，先备份（文件名加 `.before-<事由>-<日期>` 后缀） |
| | 还没有实例（新主机、或单独试用） | 先按[本机运行](../../../docs/development/local-run.md#环境与启动)建库、迁移、启动；持续使用的数据目录必须持久（不在 `/tmp`） |
| | 迁移来的项目 | 先按[迁移之后重新接入](../../../docs/architecture/deployment.md#5-迁移之后重新接入)核对导入，再从第 1 步起重新建身份与 Session；旧 Session、令牌、授权不迁 |
| 有几台机器 | 一台 | 本 skill 的手工私有配置就是今天的做法 |
| | 多台 | 多机器 Hub（DEC-048、issue #219 H1）**尚未实施**。不要手工把一个项目的 Session 分到两台机器；先在一台上接入，等 Hub 上线后按“机器加入、网页建项目、加成员”接入（见文末“Hub 上线后替换哪些块”） |
| 仓库 | 已有仓库 | 每个要跑 Session 的 Role 一个独立克隆或 worktree 作工作目录；验收者用自己的克隆 |
| | 新仓库 | 先建仓库并有第一个提交，再做第 1 步；工作目录同上 |
| | 没有仓库（纯文档/运营项目） | 不配 `repositories`；工作目录仍要有，放 Session 的工作材料 |
| 有没有现成 Role | 没有（最常见） | 从 **Leader（system Lead）+ 一个业务 Role** 起步，不一次建全阵容（DEC-001）；验收由业务 Role 下另一个有独立身份的 Session 承担，不新建 QA Role（DEC-038、DEC-046） |
| | 想沿用 evoLoop 自己的 Role 写法 | 只借鉴职责写法；每个 Role 仍在新项目里重新提议、重新接受试行 |
| 运行时 | Codex / Claude | 每个 Role 只绑定一种运行时，绑定后不能换（DEC-035）；所选运行时的登录目录要先在主机上登录好（[本机运行](../../../docs/development/local-run.md)的 Codex 与 Claude 两段），接入者不替人登录 |

## 1. 身份与项目（成员块）

1. **定身份清单。** 给每个身份取 `actorId`，按[私有配置·身份](references/private-config.md#1-身份文件与-cli-包装)写进身份文件。新项目至少要有：使用者本人（`identityKind: human`）、需求 Session、Leader、每个业务 Role 一个、验收者一个、“代你使用”身份（读写、无审阅）。Leader、业务与验收身份按项目各建一套，不跨项目复用。
2. **项目 ID 先进身份文件，再重启。** 身份文件只在服务启动时读：先生成项目 UUID，把它写进各身份的 `projectIds`，重启服务，才能用这些身份发 `project.create`。
3. **建项目。** 用需求 Session 的身份按 `command schema project.create` 建项目。
4. **登记仓库。** 需要固定 Git 来源时，在 integrations 的 `repositories` 里登记（启动时读，和下一步的启动项一起重启一次）。

**读回：** `project <PROJECT>`；`get /api/projects/<PROJECT>/members`（每个身份的 `canRead`/`canWrite`/`canReview` 与预期一致，`identityFile` 为 `unchanged`，没有 `pending`）；`get /api/projects/<PROJECT>/repositories`（`status: available`）。每个身份用自己的 CLI 包装跑一次 `session`，`principal.actorId` 与预期一致。

## 2. 启动时读的开关，一次配齐、重启一次

下面这些只在服务启动时读，改了必须重启；放在一起配，接入过程只重启一次：身份文件、`runtime.enabled` 与运行时设置（`provider`/`providers`、`executable`、`codexHome`、`claude.configRoot`、`protocolVersion`）、`repositories`、`scheduling.grants`。其余配置每次使用时重读，后面随用随加，不用重启。完整的“何时生效”表见[运行接线手册·共同做法](../../../docs/development/runtime-operations.md#共同做法)。

`sessionMessages.enabled`、`residentQueue.enabled`、`scheduling.enabled` 也在这一步打开，免得后面漏。

**读回：** `get /api/projects/<PROJECT>/capabilities`：`runtime` 为 `configured`；`pending` 为 `null`（不为 null 说明文件已改、还没重启生效）。`models --project <PROJECT>` 列出将要用的模型。

## 3. Role

1. **第一个 Role 的引导。** 全新项目里 `task.create` 要求负责人是已试行的 Role，而 `role.propose` 要求引用一个已存在、未完成的 Task，**两者互相要求，只经 API 建不出第一个 Role**。今天的绕行见[私有配置·引导](references/private-config.md#2-第一个-role-的引导)；这是已知缺口，不要另找别的办法绕。
2. **提议并接受 Leader 与业务 Role。** Leader 用 `roleClass: system`、`templateKey: lead`，项目里只能有一个 active 或 trial 的 system Lead。按 `command schema role.propose` 写提议（证据、四类替代办法、首个 Task、试行天数与回看日期都要填），再由有审阅权的身份 `role.decide accept-trial`（决定类）。
3. **绑定运行时。** `role runtime set <ROLE> --project <PROJECT> --provider codex|claude --reason …`，首次绑定后不能换。

**读回：** `list roles --project <PROJECT>`：每个 Role `state: trial`；`role runtime show <ROLE> --project <PROJECT>`：运行时与 skill 符合预期。

## 4. Session 与消息授权（目录块）

每个 Session 要的私有配置不在一个地方，缺一项就在某个环节被拒。逐项清单与格式见 [Agent CLI·编制所需私有配置清单](../../../docs/development/agent-cli.md#编制所需私有配置清单session-prepare-缺项时)，填法模板见[私有配置·Session](references/private-config.md#3-每个-session-的配置)。顺序：

1. **先 Leader Session，再业务 Session，最后验收 Session。** 每个都按 `session prepare --file <PRIVATE_JSON>` 建（`mode: create`，`model` 取 `models --project` 列出的精确值）。返回 `status=blocked` 时照 `missingDetails` 补配置，用**同一个** `operationId` 和文件重跑；不换 ID 绕过 `recovery_required`。
2. **验收 Session 用独立身份。** 它属于业务 Role，但要有自己的业务身份、工作目录和按 `sessionId` 精确绑定的 `materialCli`；否则它签的观察和作者是同一身份，关闭时会被判自验。
3. **Leader 要能派活。** Leader 对每个业务 Session 的 Role、范围、工作目录都要有一条自己的 `runtime.grants`，否则它发 `runtime.run.reserve` 得到 403。
4. **消息授权成对配。** 每个业务 Session 与 Leader 之间两个方向都要有 `sessionMessages.grants`。**`receiverActorId` 写接收 Session 里实际干活的 CLI 业务身份（它的 `materialCli.cliActorId`），不是建 Session 的身份；`cwd`、`receiverRoleId` 取接收 Session 的。** 写错时发送报 `MESSAGE_GRANT_MISSING`，或消息能送达但没有职责上下文、验收接力判 `RECIPIENT_BINDING_MISSING`。
5. **Leader 结果通知。** 在 `leaderResultNotices.targets` 里配一个目标：Leader Session、Lead Role、接收者是 Leader 的业务身份、发送者是另一个有写权限的身份（不能同一个）。

**读回（就绪的唯一判据）：** 对每个业务 Session 和验收 Session，按[运行接线手册·第 6 节](../../../docs/development/runtime-operations.md#6-受管-session-编制所需配置)做一次真实往返：用 Leader 的 CLI `work send owned:<SESSION> --file <BODY>` 发带唯一标记的消息，对方处理后反向回复同一标记；两个方向都用 `work message` 与 `work status owned:<SESSION> --message <MSG>` 读回已处理、有原生 Turn、有回复。`session prepare` 成功、`state: ready`、发送返回 `applied` 都**不算**就绪。

## 5. Leader 每日评估

给 Leader 一个每天固定时点的评估 Task（DEC-038）。默认用普通 Task 的每日复制：`scheduling.taskTimingGrants` 每次使用时重读，不用重启；做法见[运行接线手册·普通 Task 的每日复制](../../../docs/development/runtime-operations.md#4-普通-task-的每日复制)。授权的 `actorId` 是建这个系列的身份（要有读写审阅），`roleId` 是 Lead Role。也可以用旧 Schedule（`schedule.create`），但它的 `scheduling.grants` 只在启动时读，改了要重启。

**读回：** `get /api/projects/<PROJECT>/task-timings` 里有这个系列，`nextAtUtc` 是下一个评估时点；或 `list schedules --project <PROJECT>` 里有 active 的 Schedule。

## 6. 第一个 Task 走通全程

接入以第一个真实 Task 被独立验收并关闭为准。选一件小而真实、能在一个 Run 里交付、验收者能实际使用的工作（例如给样本仓库补一个带测试的小功能）。

1. 按 [evoloop-requirements](../evoloop-requirements/SKILL.md) 写 Task：负责人是业务 Role，`consumer` 写验收 Session 的业务身份，`useRequired: true`，验收方式 `independent_agent`，验收方案写清样本、入口、预期和反例。
2. 交 Leader 安排：用需求 Session 的 CLI 给 Leader 发一条消息说明这项 Task。之后开始、分派、开 Run、交付、验收接力和关闭，按 [evoloop-workflow](../evoloop-workflow/SKILL.md) 与[协作要点](../evoloop-workflow/references/coordination.md)走，接入者只读回，不替 Leader、执行者或验收者签。
3. 中途卡住时先看[常见卡点](references/private-config.md#5-常见卡点)，按原 ID 对账，不换 ID 重发。

**读回：** `task <TASK> --project <PROJECT>` 为 `done`；`work acceptance <TASK> --project <PROJECT>` 里验收者对当前 Delivery 签了 `used`；签 `used` 的身份不是交付者，也不是安排者。

最后把接入记录写成项目里的一份过程 Document：第 0 步的分支、身份与 Session 清单（只写 ID 和身份名，不写令牌和路径）、每项读回结果、遇到的卡点与处理、仍未验证的部分。

## 运维时要记住的

- **发布切换会把身份文件和 integrations 从旧版本复制过来**，CLI 包装里写死的发布路径要逐个改指新版本，并各跑一次 `session` 确认。
- **同一 Session 的消息按顺序处理。** 一条卡住的旧消息会挡住后面所有消息；先按[消息卡在队首](../../../docs/development/runtime-operations.md#验收接力的消息卡在队首缺陷-0fd4a99b)对账那一条，不重发新消息。
- **模型额度用完或鉴权失败时，服务暂停该提供方的所有新 Turn**（新消息照常排队）。由账户使用者续费或重新登录后，由有审阅权的身份读 `get /api/projects/<PROJECT>/runtime/provider-holds`，再按 `command schema runtime.providerHold.release` 放行一次。
- **改私有文件前先备份，改完先读回**：`capabilities` 的 `pending` 告诉你哪些改动要等重启。

## Hub 上线后替换哪些块

今天的接入是单机、手工私有配置。DEC-048 的 Hub 上线后，按下表整块替换，第 0、3、5、6 步和终态清单不变：

| 今天的块 | Hub 上线后 |
| --- | --- |
| 第 0 步“有几台机器”与第 2 步的启动项 | 机器加入 Hub：在机器上确认一次允许的根目录 |
| 第 1 步：身份文件、令牌文件、项目 ID 进身份文件、`project.create` | 网页建项目、加成员；人用账号登录，智能体用 Hub 管理员建的服务身份；`members` 读回的 `source` 变为 `hub` |
| 第 4 步里的工作目录与 `runtime.grants` 的 `cwd` | 在已确认的根目录下选项目目录 |

在那之前，不要为“以后多机”提前改动今天的手工步骤。

## 验证这份 skill

怎样用无会话历史的 Agent 在自建实例上实测、记录哪些指标、什么结果算有效，见 [评价方法](references/evaluation.md)。改动本 skill 后按同一办法再跑一次，结果记进那一页的试跑记录。
