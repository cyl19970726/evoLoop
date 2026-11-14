# 接入 skill 的试跑记录

2026-11-14 起。本页记录项目 skill `evoloop-onboarding` 每次试跑的设置、结果和据此做的修改。评价方法与判据在 skill 的 `.agents/skills/evoloop-onboarding/references/evaluation.md`；原始会话、令牌、本机路径和试用数据库不随仓库发布。

## 问题与决定

使用者 2026-11-14 要求：新项目要用 evoLoop 这一套时怎样 onboarding，以及怎样验证这套 onboarding 流程有效。本页回答第二问的实际结果：一个没看过接入对话的 Agent，只凭 skill，能不能在自建实例上把一个真实的小项目接入到第一个 Task 被独立验收并关闭；漏配授权时读回能不能发现。结果决定 skill 是否可以交给需求 Session 用于下一个真实项目。

## 共同设置

- **实例。** 自建：独立的 PostgreSQL 18 测试实例与数据库、独立端口、仓库外的私有目录；预置一个“既有项目”、需求 Session 的身份和一个使用者本人的身份（执行者被告知不得用它的令牌），模拟“已有常驻实例、加一个新项目”。一个启停脚本代替主机的服务管理器。
- **运行时。** 真实 Codex（与正式实例同一个可执行文件和登录目录），模型 DeepSeek。
- **样本项目。** `tally`：统计行数、词数、字符数的 Node.js 小工具，本机裸仓库，两条提交，`npm test` 通过，README 列了三项“想做的下一步”。没有网络远端。
- **执行者。** 新起的子 Agent，不继承会话历史；只给它 skill 所在的检出（不含评价页）、实例现场、样本项目、使用者已授权的决定类操作（接受 Role、新建 Session、选模型）和编制上限（Leader、业务、验收各 1 个）。问人的地方写进 `questions.md` 并按默认继续。
- **评价者**（写 skill 的 Session）不插手执行，只复核读回、核查越界，并在试跑之间改 skill。

## 试跑 1（候选 `f1ec6a5c`）

**结果：在 E7（双向消息往返）中止。** 用时约 16 分钟（17:54—18:10 UTC）。

| 终态 | 结果 | 说明 |
| --- | --- | --- |
| E1 项目 | 通过 | |
| E2 仓库登记 | 通过 | `repositories` 条目的写法 skill 没给，执行者读代码得到 |
| E3 身份 | 通过 | 6 个身份，`members` 全部符合，没有 `pending`；没用使用者本人的令牌 |
| E4 启动项 | 通过 | 多重启了一次（见 K3） |
| E5 Role | 通过 | 第一个 Role 的引导 SQL 走通；Lead 与业务 Role 均为 trial |
| E6 Session | 通过 | 验收 Session 改走 reserve + bindSession（见 K7） |
| E7 双向往返 | 未通过 | 回报带 `--reply-to` 被拒，随后发生越界，执行者按规定中止 |
| E8 通知与每日评估 | 未通过 | 第一条 Leader 通知已送达；每日评估未建 |
| E9 第一个 Task | 未到达 | |
| E10 接入记录 | 未到达 | |

**问人 7 次**：5 次属于 skill 本该回答（模型授权与 `models` 互相等待；Leader 通知的发送者用谁；验收 Session 的准备被拒后怎么办；没有“代你使用”身份时怎么办；回报要不要带 `replyToMessageId`），2 次确实要使用者决定（选哪个模型；越界后是否继续）。

**卡点：**

| 编号 | 现象 | 归属 |
| --- | --- | --- |
| K1 | `models --project` 只列调用者已授权的模型，第一次为空，而 grant 模板要求填它列出的值 | skill 没写 |
| K2 | 没有 `repositories` 条目模板 | skill 没写 |
| K3 | 写完 grant 后 `runtime` 为 `grant_directory_unavailable`，要重启才生效：运行器接受的工作目录和 `models` 用的是启动时读入的 grants | skill 与 `agent-cli.md`、`runtime-operations.md` 都写成“每次重读”，**文档有误** |
| K4 | 服务起不来：启动时的当前目录包含了 Blob 目录 | 试跑启停脚本的问题；也补进了常见卡点 |
| K5 | `role.propose` 报 `INVALID_INPUT`：evidence 须含缺口类、效果、成本三类 | skill 没写 |
| K6 | `session prepare` 不接受 `--project`，输出是多段 JSON | skill 没写 |
| K7 | 验收 Session 的 `session prepare` 报 `material_cli_actor_mismatch`：准备检查要求 Session 的 CLI 身份等于 Role 在 `roleActors` 里的业务身份，而 DEC-038 的验收做法要求它有独立身份 | **产品不一致**；skill 改为写明另一条有效路径 |
| K8 | `work events --wait 30` 报 `TIMEOUT`：CLI 默认 15 秒超时 | skill 没写；CLI 可改进 |
| K9 | 跨 Session 回报带 `--reply-to` 被拒 `REPLY_TARGET_MISMATCH` | `runtime-operations.md` §6 写错，**文档有误** |

**越界事件。** K9 之后，试用实例里的验收 Session（Codex、DeepSeek、全权限）为了找“怎样回复”的例子，自己在磁盘上搜索，列出了正式实例 CLI 回执目录下的文件，并读出其中 6 份回执的部分内容（发送者、状态、消息正文前 120—1500 字）进入模型上下文。评价者逐条核对了该 Session 的 48 次工具调用：没有读令牌、身份文件或 integrations，没有写入，没有连接正式实例的端口；Leader 和业务 Session 没有越界。执行者发现后停了实例。原因不是执行者违规，而是受管 Session 以服务的系统用户、全权限运行（DEC-033），同一主机上任何实例的 Session 都能读到正式实例的私有文件。这是 DEC-047 待定的隔离问题的一个实际案例。

## 据试跑 1 对 skill 和文档的修改（候选 `deaf452e`）

- 第 1 步改为先列全清单、预生成全部 ID（项目、Role、Session），第 2 步一次写完全部私有配置、只重启一次；把 `runtime.grants` 的工作目录与模型列入“启动时读”。
- 写明 `models` 的候选值从运行时模型目录取、重启后再读回（K1）；补 `repositories` 模板（K2）；写明 `role.propose` 的硬性要求（K5）；写明 `session prepare` 的参数与输出（K6）；写明长轮询要调大 `EVOLOOP_TIMEOUT_MS`（K8）。
- 验收 Session 不用 `session prepare`，改用 `runtime.session.reserve` → `role.bindSession` → `session profile set`（K7）。
- 往返测试改由 Leader 自己发探测消息，对方另发新消息回报、不加 `--reply-to`（K9）；读回先用 Leader 的 `work acceptance` 容量视图（不花模型，核 Leader → Session 方向的消息授权与绑定），再核真实往返。
- 新增“受管 Session 能碰到什么”：消息与 Task 正文写明活动范围；同一主机上另起实例时用系统沙箱包住运行时可执行文件；把新项目加进正式实例前告诉使用者两个项目之间没有技术隔离。
- 身份清单加“结果通知者”（`leaderResultNotices` 的发送者），写明“代你使用”在没有样本 Session 时先不给授权。
- `runtime-operations.md` §6 与“共同做法”表、`agent-cli.md` 的配置清单表：改正“`runtime.grants` 每次重读”和“回报带 `replyToMessageId`”两处。

## 试跑 2（候选 `deaf452e`）

进行中，结果待补。设置与试跑 1 相同，另加：试用实例的运行时可执行文件用 macOS `sandbox-exec` 包住，拒绝读写正式实例的私有目录、评价者的工作区和 Claude 的私有目录，拒绝连接正式实例与试跑 1 实例的端口；评价者实时扫描试跑 Session 的原生记录，一旦出现指向这些位置的命令即报警。

## 产品缺口（不归 skill，另建 Task）

1. **全新项目建不出第一个 Role。** `task.create` 要求负责人是 trial/active Role，`role.propose` 要求引用已存在的未完成 Task；skill 暂用一次性的数据库引导绕过。
2. **同 Role 下有独立身份的验收 Session 过不了 `session prepare`**（`material_cli_actor_mismatch`），与 DEC-038 的验收做法冲突。
3. **`models` 不列出未授权的模型目录**，第一次授权只能从运行时文件里找候选。
4. **CLI 长轮询的默认超时短于等待时间**（`--wait 30` 对 15 秒）。
5. **受管 Session 没有文件系统隔离**：同一系统用户下，任何实例、任何项目的 Session 都能读到其他实例和项目的令牌与回执（DEC-047）。

## 未验证

- 发布切换、额度用完后的放行、多机器（Hub 尚未实施）不在本次试跑范围内。
- 只用了 Codex 运行时与 DeepSeek 模型；Claude 运行时的接入路径未试。
- “把新项目加进正式实例”只在模拟的既有实例上走过，没有在正式实例上做。
