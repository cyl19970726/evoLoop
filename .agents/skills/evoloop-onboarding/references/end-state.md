# 接入完成的终态清单

每一项都用 CLI 读回核对，不看配置文件“写了什么”，看服务“认了什么”。命令里的 `cli` 指用对应身份的 CLI 包装；没写身份的，用需求 Session 的包装。每项记下读回时间和结果，写进接入记录。

一项不通过就回到对应步骤补齐，再从这一项重新往下核；不能用“配置里有”代替读回。

| # | 终态 | 读回 | 通过条件 |
| --- | --- | --- | --- |
| E1 | 项目已建好 | `cli project <PROJECT>` | 返回项目，标题正确 |
| E2 | 仓库已登记（有仓库时） | `cli get /api/projects/<PROJECT>/repositories` | `status: available`，`items` 里有本项目的 `repositoryId` 与允许路径 |
| E3 | 各身份已就位 | `cli get /api/projects/<PROJECT>/members`；每个身份用自己的包装 `cli session` | 清单里每个身份都在：使用者本人 `identityKind: human`；需求 Session、Leader `canReview: true`；业务身份、验收者、结果通知者、“代你使用” `canWrite: true` 且 `canReview: false`；`identityFile: unchanged`，各项 `pending: null`；每个包装的 `principal.actorId` 与预期一致 |
| E4 | 启动项已生效 | `cli get /api/projects/<PROJECT>/capabilities` | `runtime`、`taskTiming`（或 `scheduling`）为 `configured`；所有项 `pending: null` |
| E5 | Role 已建好并绑定运行时 | `cli list roles --project <PROJECT>`；`cli role runtime show <ROLE> --project <PROJECT>` | 恰好一个 system Lead；每个业务 Role 为 `trial` 或 `active`；每个 Role 的运行时是选定的那一种 |
| E6 | Session 已建好、绑定 Role、有工作目录 | `cli read role <ROLE> --bindings --project <PROJECT>`；`cli work status owned:<SESSION> --project <PROJECT>` | Leader、每个业务 Session、验收 Session 都绑定到对应 Role，`ready`，各有不同的工作目录 |
| E7 | 消息授权已配好（双向、真实往返） | 先用 Leader 包装 `cli work acceptance --project <PROJECT>`；再按 SKILL 第 4 步请 Leader 发探测消息、对方发新消息回报（不加 `--reply-to`），用 `cli work messages owned:<SESSION>`、`cli work message <MSG>`、`cli work status owned:<SESSION> --message <MSG>` 读回 | 容量视图里每个业务 Session 和验收 Session 的 `missingCapabilities` 为空；对每个这样的 Session，Leader → 它、它 → Leader 两条消息都已处理、有原生 Turn、标记一致；回报消息的发送者是该 Session 的 CLI 业务身份；往返期间没有 Session 读工作目录以外的私有文件 |
| E8 | Leader 结果通知与每日评估已设好 | `cli work leader notices --project <PROJECT>`；`cli get /api/projects/<PROJECT>/task-timings`（或 `cli list schedules`） | 有 Leader 通知目标且至少一条通知已送到 Leader Session；每日评估系列或 Schedule 处于活动状态、`nextAtUtc` 是下一个评估时点、负责人是 Lead Role |
| E9 | 第一个 Task 走完全程 | `cli task <TASK> --project <PROJECT>`；`cli work acceptance <TASK> --project <PROJECT>`；`cli read run <RUN> --project <PROJECT>` | Task `done`；Run 由 Leader 身份预留、在业务 Session 里执行；Delivery 由业务身份签署；验收者对当前 Delivery 签了 `used`；验收者、作者、安排者是三个不同身份 |
| E10 | 接入记录已留存 | `cli document <DOC> --project <PROJECT>` | 一份过程 Document，写了第 0 步的分支、身份与 Session 清单、E1—E9 的读回结果、卡点与未验证项；不含令牌、主机名和本机路径 |

## 只读回、不会发现的问题

- **授权“多给了”**：读回只能证明该有的都在。某个身份多了不该有的项目或权限，`members` 会如实列出，要对照清单人工看。
- **配置写了但还没生效**：看 `members`、`capabilities` 的 `pending`；不为 null 就是改过文件、还没重启。
- **消息授权只配了一个方向**：Leader → Session 方向 `work acceptance` 的容量视图能报出来；Session → Leader 方向只有 E7 的真实往返能发现。`session prepare` 不检查消息授权。
- **Leader 没有某个 Session 的执行授权**：只有 Leader 真去开 Run（E9）时才报 403。
