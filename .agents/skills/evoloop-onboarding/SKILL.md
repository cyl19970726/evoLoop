---
name: evoloop-onboarding
description: 把一个新项目接入 evoLoop：先判断情况，再按步骤建项目与仓库登记、身份、Role、Leader 与业务 Session、消息授权、Leader 每日评估，直到第一个 Task 经独立验收关闭；每一步写明怎样读回确认。用于新项目接入、迁移后重新接入，或核对一个已接入项目还缺什么。日常派单、交付与验收用 evoloop-workflow。
---

# 把一个新项目接入 evoLoop

接入的终点不是“配置写完了”，而是[终态清单](references/end-state.md)里每一项都能用 CLI 读回、并且第一个真实 Task 走完“派发 → 交付 → 独立验收 → 关闭”。每一步做完先读回，读回不符就停在这一步，不往下走。

这份 skill 写给做接入的 Agent，通常是需求 Session（今天它也承担平台维护，即 Root）。它只讲接入的顺序、读回和容易出错的地方；命令字段以所连服务的 `command schema` / `request schema` 为准，私有配置的模板在[私有配置](references/private-config.md)，派单、交付与验收的做法在 [evoloop-workflow](../evoloop-workflow/SKILL.md)，写 Task 与设计验收在 [evoloop-requirements](../evoloop-requirements/SKILL.md)，这里只链接、不复述。

## 谁决定什么

- **决定类**：接受 Role 试行、新建 Session、开放给谁什么权限、选运行时与模型、额度用完后放行。归使用者本人，或使用者明确授权过的需求 Session（DEC-047、DEC-048）。拿不准是否已授权时，把要决定的事写成一句话交给使用者，不自己推定。
- **执行类**：写私有配置、生成令牌与 CLI 包装、发命令、读回。授权范围内直接做。

无论哪一类：不拿使用者本人的令牌做事（DEC-047）；令牌只进 `0600` 文件，不进命令行参数、日志、Task 正文或公开仓库；主机名、域名、本机路径也不进公开仓库。

## 受管 Session 能碰到什么

受管 Session 以服务的系统用户、全权限运行（DEC-033）。**它能读这台主机上该用户能读的一切**：其他项目、其他实例的身份文件、令牌、CLI 回执。工作目录不是读取边界，CLI 身份只限制它经服务做什么。试跑中就发生过：一个 Session 回复被拒后自己去磁盘上找例子，读了另一个实例的回执。所以：

- 给 Session 的每条消息和 Task 正文都写明：只用本 Session 绑定的 CLI 和自己的工作目录；命令被拒时把错误码原样回报，结束本轮，不到磁盘上自行排查。
- 同一主机上已有正式实例时，**新建的试用或单独实例**要把运行时可执行文件包一层系统沙箱，拒绝读写正式实例的私有目录、拒绝连正式实例的端口，做法见[私有配置·隔离](references/private-config.md#6-同一主机上的隔离)。包好后先实测一次拒绝生效。
- **把新项目加进正式实例**时，两个项目的 Session 是同一个系统用户，互相读得到对方的令牌，今天没有技术隔离（DEC-047 的隔离代价还在评估）。接入前把这一点告诉使用者，由使用者决定是否接受。

## 0. 先判断情况

用下表定下这次接入走哪些分支，写进接入记录（第 6 步）。

| 问题 | 情况 | 怎么走 |
| --- | --- | --- |
| 跑在哪个实例 | 已有常驻实例，新项目加进去 | 跳过实例搭建；所有私有文件改动都在**当前发布版本**的私有目录里做，先备份（文件名加 `.before-<事由>-<日期>`）；先读上一节最后一条 |
| | 还没有实例（新主机、或单独试用） | 先按[本机运行](../../../docs/development/local-run.md#环境与启动)建库、迁移、启动；持续使用的数据目录必须持久（不在 `/tmp`）；同一主机已有正式实例时按上一节做隔离 |
| | 迁移来的项目 | 先按[迁移之后重新接入](../../../docs/architecture/deployment.md#5-迁移之后重新接入)核对导入，再从第 1 步起重新建身份与 Session；旧 Session、令牌、授权不迁 |
| 有几台机器 | 一台 | 本 skill 的手工私有配置就是今天的做法 |
| | 多台 | 多机器 Hub（DEC-048、issue #219 H1）**尚未实施**。不要手工把一个项目的 Session 分到两台机器；先在一台上接入，等 Hub 上线后按文末“Hub 上线后替换哪些块”接入 |
| 仓库 | 已有仓库 | 每个 Session 一个独立克隆作工作目录；验收者用自己的克隆 |
| | 新仓库 | 先建仓库并有第一个提交，再做第 1 步 |
| | 没有仓库（纯文档/运营项目） | 不配 `repositories`；工作目录仍要有，放 Session 的工作材料 |
| 有没有现成 Role | 没有（最常见） | 从 **Leader（system Lead）+ 一个业务 Role** 起步，不一次建全阵容（DEC-001）；验收由业务 Role 下另一个有独立身份的 Session 承担，不新建 QA Role（DEC-038、DEC-046） |
| | 想沿用 evoLoop 自己的 Role 写法 | 只借鉴职责写法；每个 Role 仍在新项目里重新提议、重新接受试行 |
| 运行时与模型（决定类） | Codex / Claude | 每个 Role 只绑定一种运行时，绑定后不能换（DEC-035）；运行时要先在主机上登录好（[本机运行](../../../docs/development/local-run.md)的 Codex 与 Claude 两段），接入者不替人登录。每个 Session 用哪个模型由使用者定；没定时按使用者已表达的偏好选，并写进接入记录 |

## 1. 定清单、预生成全部 ID

先把要建的东西列全，并**一次性生成它们的 UUID**（`cli id`）：项目、每个 Role、每个 Session，外加 `role.propose`、`session prepare` 要用的操作 ID。这些 ID 都由调用方指定，先生成好，第 2 步才能把全部私有配置一次写完、只重启一次。

- **身份**：按[私有配置·身份](references/private-config.md#1-身份文件与-cli-包装)的清单，至少有使用者本人、需求 Session、Leader、每个业务 Role 一个、验收者一个、结果通知者、“代你使用”。Leader、业务、验收和结果通知者按项目各建一套，不跨项目复用。
- **Session**：Leader 1 个、每个业务 Role 1 个、验收 1 个；每个一个工作目录（规范绝对路径）。
- **模型**：`models --project` 只列出调用者的 `runtime.grants` 已授权的模型，第一次接入时它是空的。候选值从运行时自己的模型目录取（Codex：codexHome 配置里的模型目录；Claude：`sonnet`/`opus`/`haiku` 或完整模型 ID），先写进 grant，第 2 步重启后再用 `models --project` 读回确认。

## 2. 一次写完私有配置，重启一次

按[私有配置](references/private-config.md)写好：身份文件（含新项目 ID）、每个身份的令牌与 CLI 包装、integrations 里的全部条目（运行时设置、`runtime.grants`、`materialCli`、`roleActors`、`repositories`、成对的 `sessionMessages.grants`、`leaderResultNotices`、`scheduling`），然后重启服务一次。

只在启动时读、改了必须重启的有：身份文件；`runtime.enabled` 与运行时设置；`runtime.grants` 里的**工作目录和模型**（运行器建 Session、开 Run 时只认启动时登记的目录，`models` 也只列启动时的授权）；`repositories`；`scheduling.grants`。其余（`materialCli`、`roleActors`、消息授权、Leader 通知目标、`taskTimingGrants`）每次使用时重读。完整的“何时生效”表见[运行接线手册·共同做法](../../../docs/development/runtime-operations.md#共同做法)。漏了一项，补上后能否免重启就按这张表判断。

**读回：** 每个身份用自己的包装跑一次 `cli session`，`principal.actorId` 正确；用需求 Session 的身份 `cli get /api/projects/<PROJECT>/members`：每个身份的 `canRead`/`canWrite`/`canReview` 与清单一致、`identityFile: unchanged`、没有 `pending`；`cli models --project <PROJECT>` 列出了要用的模型。项目还没建，`capabilities` 和 `repositories` 在第 3 步之后读。

## 3. 项目与 Role

1. **建项目。** 用需求 Session 的身份按 `command schema project.create` 建项目（`projectId` 用第 1 步的值）。
2. **第一个 Role 的引导。** 全新项目里 `task.create` 要求负责人是已试行的 Role，而 `role.propose` 要求引用一个已存在、未完成的 Task，**两者互相要求，只经 API 建不出第一个 Role**。今天的绕行见[私有配置·引导](references/private-config.md#2-第一个-role-的引导)；这是已知缺口，不要另找办法绕。
3. **提议并接受 Leader 与业务 Role。** Leader 用 `roleClass: system`、`templateKey: lead`，项目里只能有一个 active 或 trial 的 system Lead。`role.propose` 的硬性要求：`evidence` 至少含缺口类（`backlog`/`omission`/`rework` 之一）、`effect`、`cost` 各一条；`alternatives` 恰好四条，`method`、`knowledge`、`another-instance`、`temporary-assignment` 各一；`reviewAtUtc` 在现在之后、`trialDays` 之内；`firstTaskId` 指一个未完成的 Task（业务 Role 也可以先引用引导 Task）。再由有审阅权的身份 `role.decide accept-trial`（决定类）。
4. **绑定运行时。** `role runtime set <ROLE> --project <PROJECT> --provider codex|claude --reason …`，首次绑定后不能换。

**读回：** `cli project <PROJECT>`；`cli get /api/projects/<PROJECT>/repositories`（`status: available`）；`cli get /api/projects/<PROJECT>/capabilities`（`runtime` 为 `configured`，所有项 `pending: null`）；`cli list roles --project <PROJECT>`（每个 Role `trial`）；`cli role runtime show <ROLE> --project <PROJECT>`。

## 4. Session 与消息往返

1. **Leader 与业务 Session 用 `session prepare --file <PRIVATE_JSON>` 建**（`mode: create`）。它不接受 `--project`（项目 ID 写在文件里）；标准输出是多段 JSON（中间回执加最终结果），存进文件逐段解析。返回 `status=blocked` 时照 `missingDetails` 补配置，用**同一个** `operationId` 和文件重跑；不换 ID 绕过 `recovery_required`。
2. **验收 Session 不用 `session prepare`。** 它要按 `sessionId` 精确绑定自己的 CLI 身份，而 `session prepare` 要求 CLI 身份等于该 Role 在 `roleActors` 里的业务身份，会报 `material_cli_actor_mismatch`；照它给的修法改，验收者就和作者成了同一身份。改用 [Agent CLI](../../../docs/development/agent-cli.md#准备或复用受管-session) 写明同样有效的路径：`runtime.session.reserve` → `role.bindSession` → `session profile set`（显示名；版本取 `session profile show` 读到的值）。这是服务端的已知不一致，待修。
3. **让 Leader 自己做往返测试。** 用需求 Session 的 CLI 给 Leader 发一条消息（`work send owned:<LEADER_SESSION> --file <BODY>`），请它用自己的 CLI 给每个业务 Session 和验收 Session 各发一条带唯一标记的探测消息；探测消息里写明：对方处理后，**另发一条新消息**给 Leader（`work send owned:<LEADER_SESSION> --file <BODY>`，**不加 `--reply-to`**）带回同一标记。`--reply-to` 只能指向发给同一个接收 Session 的消息，跨 Session 回复会报 `REPLY_TARGET_MISMATCH`。探测消息的正文同样写上“只用本 Session 的 CLI 和工作目录，被拒就回报错误码”。

**读回：** 先做不花模型的：用 Leader 的 CLI `work acceptance --project <PROJECT>`，容量视图里每个业务 Session 和验收 Session 的 `missingCapabilities` 为空（它核“Leader → 该 Session”的消息授权、`receiverActorId` 是否等于该 Session 绑定的 CLI 身份、执行授权；**不核反方向**）。再核往返：用 `work messages owned:<SESSION>`、`work message <MSG>`、`work status owned:<SESSION> --message <MSG>` 读回两个方向的消息都已处理、有原生 Turn、标记一致，且回报消息的发送者是该 Session 的 CLI 业务身份。`session prepare` 成功、`state: ready`、发送返回 `applied` 都**不算**就绪。往返期间看着各 Session 的 `work timeline`，出现越出工作目录的读取就停下（见“受管 Session 能碰到什么”）。

## 5. Leader 每日评估

给 Leader 一个每天固定时点的评估 Task（DEC-038）。默认用普通 Task 的每日复制：建一个负责人是 Lead Role 的评估 Task 并设每日时点，授权 `scheduling.taskTimingGrants` 每次使用时重读；做法见[运行接线手册·普通 Task 的每日复制](../../../docs/development/runtime-operations.md#4-普通-task-的每日复制)。授权的 `actorId` 是建这个系列的身份（要有读写审阅），`roleId` 是 Lead Role。也可以用旧 Schedule（`schedule.create`），但它的 `scheduling.grants` 只在启动时读。

**读回：** `cli get /api/projects/<PROJECT>/task-timings` 里有这个系列，`nextAtUtc` 是下一个评估时点；或 `cli list schedules --project <PROJECT>` 里有 active 的 Schedule。

## 6. 第一个 Task 走通全程

接入以第一个真实 Task 被独立验收并关闭为准。选一件小而真实、能在一个 Run 里交付、验收者能实际使用的工作（例如给样本仓库补一个带测试的小功能）。

1. 按 [evoloop-requirements](../evoloop-requirements/SKILL.md) 写 Task：负责人是业务 Role，`consumer` 写验收 Session 的业务身份，`useRequired: true`，验收方式 `independent_agent`，验收方案写清样本、入口、预期和反例；正文写明交付放在哪里（例如推到裸仓库的某个分支）、验收者从哪里取。
2. 交 Leader 安排：用需求 Session 的 CLI 给 Leader 发一条消息说明这项 Task。之后开始、分派、开 Run、交付、验收接力和关闭，按 [evoloop-workflow](../evoloop-workflow/SKILL.md) 与[协作要点](../evoloop-workflow/references/coordination.md)走；接入者只读回，不替 Leader、执行者或验收者签。
3. 中途卡住先看[常见卡点](references/private-config.md#5-常见卡点)，按原 ID 对账，不换 ID 重发。

**读回：** `cli task <TASK> --project <PROJECT>` 为 `done`；`cli work acceptance <TASK> --project <PROJECT>` 里验收者对当前 Delivery 签了 `used`；签 `used` 的身份不是交付者，也不是安排者。

最后把接入记录写成项目里的一份过程 Document（`document.create`，`kind` 按 `command schema` 选报告类）：第 0 步的分支、身份与 Session 清单（只写 ID 和身份名，不写令牌和路径）、每项读回结果、遇到的卡点与处理、仍未验证的部分。

## 用 CLI 等待与读回

- 长轮询（`work events --wait N`、`work updates --wait-ms N`）要把 `EVOLOOP_TIMEOUT_MS` 设得比等待时间长（例如 60000），否则 CLI 默认 15 秒超时先报 `TIMEOUT`。
- 包装脚本里写了默认项目时，操作别的项目一律显式加 `--project`。

## 运维时要记住的

- **发布切换会把身份文件和 integrations 从旧版本复制过来**，CLI 包装里写死的发布路径要逐个改指新版本，并各跑一次 `session` 确认。
- **同一 Session 的消息按顺序处理。** 一条卡住的旧消息会挡住后面所有消息；先按[消息卡在队首](../../../docs/development/runtime-operations.md#验收接力的消息卡在队首缺陷-0fd4a99b)对账那一条，不重发新消息。
- **模型额度用完或鉴权失败时，服务暂停该提供方的所有新 Turn**（新消息照常排队）。由账户使用者续费或重新登录后，由有审阅权的身份读 `get /api/projects/<PROJECT>/runtime/provider-holds`，再按 `command schema runtime.providerHold.release` 放行一次。
- **改私有文件前先备份，改完先读回**：`members`、`capabilities` 的 `pending` 告诉你哪些改动要等重启。

## Hub 上线后替换哪些块

今天的接入是单机、手工私有配置。DEC-048 的 Hub 上线后，按下表整块替换；第 0 步的其余分支、第 3 步的 Role、第 5、6 步和终态清单不变：

| 今天的块 | Hub 上线后 |
| --- | --- |
| 第 0 步“有几台机器”与第 2 步的启动项 | 机器加入 Hub：在机器上确认一次允许的根目录 |
| 第 1、2 步的身份文件、令牌、项目 ID 进身份文件，第 3 步的 `project.create` | 网页建项目、加成员；人用账号登录，智能体用 Hub 管理员建的服务身份；`members` 读回的 `source` 变为 `hub` |
| 第 1、2 步的工作目录与 `runtime.grants` 的 `cwd` | 在已确认的根目录下选项目目录 |

在那之前，不要为“以后多机”提前改动今天的手工步骤。

## 验证这份 skill

怎样用无会话历史的 Agent 在自建实例上实测、记录哪些指标、什么结果算有效，见[评价方法](references/evaluation.md)。改动本 skill 后按同一办法再跑一次，结果记进那一页的试跑记录。
