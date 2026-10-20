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
npm run --silent cli -- command schema task.accept
```

`task UUID --history` 展示已保存的真实修订及当时状态；`document UUID --revision UUID`、`original DOCUMENT_UUID --revision UUID [--out NEW_DIRECTORY]` 指向固定原件。`context` 应带回 Task 的封存依据及可读来源，并明确 `complete` 或逐项 `partial`；总读取预算为 16 MiB，超限时列出未读固定 ID，可按其修订逐项调用 `original`。来源失败时不可把最近版本猜作任务依据。HTML 与资源包导出只进入调用者指定的私有**新目录**，其父目录须已存在；可放在仓库外，或明确被 Git 忽略的本机目录，不公开原件。对于知识页、候选、运行、负责人讨论、日程等，按 `list`/`read` 的实际帮助读取；固定来源、未采纳候选和已发布认识不得混同。普通 `get /api/...` 保留为同源只读兼容入口。

## 提交与核对

拿到当前版本、真实依据和权限后，用 schema 制作 JSON 文件。通用命令经 `command run JSON_FILE`（旧式 `command JSON_FILE` 兼容）提交；同一 `operationId`、行为者及同一内容可重读原回执，不同内容复用 ID 会被拒绝。修改已有对象时使用刚读到的 `expectedVersion`，遇版本冲突重读并重新判断，不能把旧意图直接改个版本重发。专用操作先看 `request types` 和 `request schema NAME`，再用 `request NAME --project UUID --file JSON_FILE [--id TARGET_UUID] [--receipt LOCAL_UUID]`；目标 ID 和是否另需本地回执 ID 由该类型帮助说明。它只分派已实现的具名 API，不是任意 POST 通道。

```sh
npm run --silent cli -- command types
npm run --silent cli -- command schema task.propose
npm run --silent cli -- request schema knowledge.propose
npm run --silent cli -- command run "$PRIVATE_REQUEST_FILE"
npm run --silent cli -- operation "$OPERATION_ID" --project "$PROJECT_ID"
```

工作起点可以是目标、阶段、Task、过程 Document 或知识证据；不要求为了日常修复先创建 Wiki、Role 或讨论。先查 Task 当前状态：`task.judge` 面向尚待判断的 proposal；已有 `ready` 或 `active` 的 Task 不要重复 judge/accept；交付前须先 start 进入执行。提议、判断、接受、执行、交付和关闭按实际状态与权限前进，不把每项工作硬套完整顺序。需求修订后，旧 Task 固定依据不被静默替换；按影响复核明确采用、保留或补证。交付须指向不可变产物和技术检查结果；原生 Run 完成不等于交付通过。消费者观察要说明实际观察者与使用结果，通知/人工转述不当成已用；关闭、阶段回看及下一步另行记录。负责人讨论可准备交接包并登记人工承接与决定，但目标会话标签不证明 Desktop 送达。

## 未知结果与本地回执

CLI 写入前保存私有本机意图回执；`receipts list`、`receipts show ID`、`receipts reconcile ID` 用于找回原始目标、请求和已知结果。`EVOLOOP_STATE_DIR` 可指定仓库外或明确被 Git 忽略的私有本机目录；本机实现按 0700 目录、0600 文件创建且不覆盖已有回执，但不会强制目录位于仓库外。回执不能进入公开 Git。服务端确认的同一 actor、项目权限与 API origin 允许合法令牌轮换后继续核对；旧回执若没有 actor 记录，只能用原令牌。不同 actor 不可据此换身份接管。`EVOLOOP_TIMEOUT_MS` 仅控制等待，不使写入失败变成未提交证明。CLI 将 JSON 结果写 stdout、诊断写 stderr，失败或冲突退出非零；它不自动重试 POST。

若回包丢失或状态未知，保留原操作 ID、请求正文和读入基线。先按同一 ID 查询 `operation ID --project PROJECT`；若操作涉及外部知识发布、来源或 Runtime，按对应具名恢复/复核接口核对外部原件及本地记录，不能把普通操作查询当成外部发布证明。404 仅表示该次未查到，不能证明未执行；不能换 ID 盲重派。外部动作的状态仍不明时停止该动作并报告未知和需要的人工核对。

## 当前边界

具名读取、固定 context/原件、专用请求 schema、持久回执与服务端核对已实现；当前能力以 `help`、`command types`、`request types`、对应 schema 与实际读回为准。新上下文 Agent 已仅经业务 skill＋CLI 完成一项隔离静态归档任务：上游改版显式保留旧依据，交接引用错误产生的两次失败保留，修正版经另一 Agent 实际读取和字节核验后关闭；普通工作台独立只读 QA 可见相同固定原件、交付、观察和旧历史。整合检查与 C1—C4 状态统一见[阶段路线](../roadmap.md#agent-业务入口-c1c4实施里程碑)。这核验了机器入口与人的观察面能够接续，不能替代真人亲用或证明整体产品效果。外置 Wiki 已有受限写读与候选复核证据，语义索引未验；飞书真实租户延后；生产可靠性与长期效果仍需独立验收。
