# 私有配置：接入时要写的内容

本页给出接入一个项目时私有文件里要写的内容与模板。字段的权威定义在服务代码（`apps/coordinator/src/auth.ts`、`apps/coordinator/src/configuration.ts`）和 [Agent CLI·编制所需私有配置清单](../../../../docs/development/agent-cli.md#编制所需私有配置清单session-prepare-缺项时)；两者不一致时以代码和所连服务的读回为准。

模板里 `<…>` 是占位符。私有文件（身份文件、integrations、令牌、包装脚本、准备文件、回执）都放在仓库外、只有当前用户可读的目录里，改之前先复制一份带 `.before-<事由>-<日期>` 后缀的备份。

## 1. 身份文件与 CLI 包装

### 身份清单

| 身份 | `permissions` | `identityKind` | `senderClass` | 跨项目 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 使用者本人 | read, write, review | `human` | — | 可以 | 只给本人用，Agent 不拿它的令牌 |
| 需求 Session | read, write, review | `agent` | `requirements` | 可以 | 写 Task、私有配置、接受 Role（受使用者授权） |
| Leader | read, write, review | `agent` | `leader` | 不要 | 排程、分派、验收接力、每日评估 |
| 每个业务 Role 一个 | read, write | `agent` | `session` | 不要 | 业务 Session 里签 `ordinary.submit` 的身份 |
| 验收者 | read, write | `agent` | `session` | 不要 | 验收 Session 里签 `used` 的身份，必须不同于作者 |
| 结果通知者 | read, write | `agent` | — | 不要 | 只作 `leaderResultNotices` 的发送者，不给任何 Session 用；必须不同于 Leader |
| “代你使用” | read, write | `agent` | — | 可以 | 不给 review（DEC-047）；实例里没有就新建。只给样本 Session（例如模拟用户）的消息与即时输入授权；项目还没有样本 Session 时先不给任何授权 |

- “跨项目：可以”的身份，把新项目 ID 加进它已有条目的 `projectIds`；其余按项目新建 `actorId`，一个项目的 Session 令牌碰不到另一个项目。
- 同一 `actorId` 在同一项目里的所有条目必须是同一个 `identityKind` 和 `senderClass`，否则服务启动时拒绝整个身份文件。
- `extraCommands` 只接受 `document.archive`、`document.restore`，不要用它代替 review。
- 身份文件在启动时读，改了要重启；`session prepare` 会重读它，但只用于编制检查，HTTP 登录仍用启动时的快照。

身份文件条目（数组中的一项）：

```json
{ "token": "<64 位十六进制，见下>", "actorId": "<actorId>", "projectIds": ["<PROJECT>"],
  "permissions": ["read", "write"], "identityKind": "agent", "senderClass": "session" }
```

### 令牌与包装

每个身份一个私有目录 `<CLI_ROOT>/<actorId>/`（`0700`），里面：

- `.token`（`0600`）：`node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > .token`；不回显、不进命令历史。身份文件里的 `token` 由同一个值填入（用脚本读文件写入，不手抄）。
- `state/`：CLI 本地回执目录。
- `evoloop`（`0700`）包装脚本：

```sh
#!/bin/sh
set -eu
TOKEN=$(cat <CLI_ROOT>/<actorId>/.token)
export EVOLOOP_API_URL=http://127.0.0.1:<PORT> EVOLOOP_PROJECT=<PROJECT> EVOLOOP_TOKEN="$TOKEN" EVOLOOP_STATE_DIR=<CLI_ROOT>/<actorId>/state
exec <NODE_ABSOLUTE_PATH> <RELEASE_SOURCE>/apps/cli/dist/main.js "$@"
```

**包装脚本的绝对路径只能含字母、数字和 `_ . / -`**。路径里有空格、`@`、`+` 时，`materialCli` 预检直接判 `material_cli_incompatible`，看起来像“CLI 太旧”。`<RELEASE_SOURCE>` 写死了发布目录，每次发布后要改指新版本。

**读回：** 每个包装跑一次 `<wrapper> session`，`principal.actorId`、`projectIds`、`permissions` 与清单一致。

## 2. 第一个 Role 的引导

**缺口：** `task.create` 要求 `owner` 是 trial 或 active 的 Role（`TASK_OWNER_ROLE_REQUIRED`）；`role.propose` 要求 `firstTaskId` 指向一个已存在且未完成的 Task（`INVALID_FIRST_TASK`）。全新项目里两者互相要求，只经 API 建不出第一个 Role。仓库里的合成数据脚本（`scripts/seed-frontend-scenarios.mjs`）也因此要求先有一个试行 Role。这个缺口待服务端补上一个正式的引导办法，在那之前用下面的绕行。

**绕行（只做一次，只在本项目还没有任何 Role 和 Task 时）：** 由实例维护者直接在数据库里插入一个 Task，负责人写**将要提议的 Lead Role 的 UUID**（此刻还不存在）；随后经 API 正常提议该 Role（`firstTaskId` 指这个 Task）并接受试行，这个 Task 就成了 Leader 的第一项工作（例如“接入后的第一次编制评估”）。此后所有 Task 都经 `task.create`。

- 正式实例上：先停写备份（[停写备份](../../../../docs/development/local-run.md#停写备份与空目标恢复)），在维护窗口里做，写进接入记录。
- 只插这一行，不插 Role、不改别的表。

```sh
psql "$EVOLOOP_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v project=<PROJECT> -v lead_role=<将要提议的 LEAD_ROLE_UUID> \
  -v task=<新 UUID> -v rev=<新 UUID> -v doc=<新 UUID> -v content=<新 UUID> \
  -v title='接入后的第一次编制评估' -v body='<Task 正文 Markdown>' -v acceptance='<验收条件>' <<'SQL'
BEGIN;
SELECT 1/(CASE WHEN (SELECT count(*) FROM role_definition WHERE project_id=:'project')=0
                AND (SELECT count(*) FROM task WHERE project_id=:'project')=0 THEN 1 ELSE 0 END) AS empty_project_check;
INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
  VALUES(:'project',:'doc',:'title',1,:'content','task','draft');
INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
  VALUES(:'project',:'doc',:'content',:'body','markdown',encode(sha256(convert_to(:'body','UTF8')),'hex'),'onboarding-bootstrap',now(),'first Role bootstrap','text/markdown',:'doc'||'.md','[]'::jsonb);
INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id)
  VALUES(:'project',:'task',1,:'rev',:'title',:'acceptance',:'lead_role','todo',:'doc',:'content');
INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,content_document_id,content_revision_id,actor_id,reason,created_at)
  VALUES(:'project',:'task',:'rev',1,:'title',:'acceptance',:'lead_role','todo',:'doc',:'content','onboarding-bootstrap','first Role bootstrap',now());
COMMIT;
SQL
```

第一行检查不满足时除零报错、整段回滚。之后用 `role.propose`（`roleId` 就是上面的 `lead_role`）提议 Lead，再 `role.decide accept-trial`。

**读回：** `task <TASK> --project <PROJECT>` 可读、`owner` 是 Lead Role；`list roles` 里 Lead 为 `trial`。业务 Role 的首个 Task 从此正常用 `task.create` 建（负责人可先写 Lead，Role 接受后再按交接规则转给业务 Role），或直接以 Lead 已有的 Task 为 `firstTaskId`。

## 3. 每个 Session 的配置

以下都在 integrations 文件里。`runtime.enabled` 与运行时设置、`runtime.grants` 的工作目录和模型、`repositories`、`scheduling.grants` 只在启动时读；其余每次使用时重读（见 SKILL 第 2 步）。

**`repositories`**（有仓库时，启动时读）：

```json
{ "projectId": "<PROJECT>", "repositoryId": "<短名>", "root": "<仓库的绝对路径，可以是裸仓库>",
  "allowedPaths": ["README.md", "src/", "test/"] }
```

`allowedPaths` 是仓库内的相对路径，以 `/` 结尾的按目录前缀匹配；写绝对路径或跳出仓库的路径，整份登记都会被拒（`repositories` 读回 `registration_invalid`）。

**工作目录 `cwd`** 必须是规范绝对路径（与 `realpath` 结果一致；macOS 上 `/tmp/…` 的规范形式是 `/private/tmp/…`），每个 Session 一个，验收 Session 不与作者共用。

**`runtime.grants`**（执行授权，工作目录与模型在启动时登记）：Session 由谁建，就给谁一条；Leader 要对每个业务 Session、验收 Session **和它自己的 Session** 各有一条以 Leader 身份为 `actorId` 的，才能开 Run（Lead Role 的 Task，例如引导评估和每日评估，在 Leader 自己的 Session 里跑；缺这条时报 `FORBIDDEN`）。

```json
{ "projectId": "<PROJECT>", "actorId": "<建 Session 或开 Run 的身份>", "roleId": "<ROLE>",
  "authorizationScope": "<范围名，例如 project:<短名>:<Role 短名>>", "cwd": "<该 Session 的工作目录>",
  "sandbox": "danger-full-access", "models": ["<models --project 列出的精确值>"] }
```

`models` 的候选值从运行时的模型目录取（`models --project` 只列已授权的，第一次是空的），重启后再用 `models --project` 确认。

**`runtime.materialCli`**（Session 里用哪个 CLI 身份）：Role 级一条（业务身份）；验收 Session 再加一条按 `sessionId` 精确绑定的（验收身份），精确绑定优先。**同一 Role 有两个及以上 Session 时（例如作者与验收者同在业务 Role），每个 Session 都要一条按 `sessionId` 的精确绑定**：服务这时不再用 Role 级条目推断业务身份，缺的那个 Session 收到的队伍条目会被挂起（`RECIPIENT_UNAVAILABLE`）。验收 Session 因此不能用 `session prepare` 建（会报 `material_cli_actor_mismatch`），改用 `runtime.session.reserve` → `role.bindSession` → `session profile set`，各按 `command schema` 填写，`runtime.session.reserve` 的 `cwd`、`authorizationScope`、`model` 与上面的 grant 一致。

```json
{ "projectId": "<PROJECT>", "roleId": "<ROLE>", "sessionActorId": "<建 Session 的身份>",
  "cliActorId": "<该 Role 的业务身份>", "command": "<CLI_ROOT>/<业务身份>/evoloop" }
{ "projectId": "<PROJECT>", "sessionId": "<验收 SESSION>", "sessionActorId": "<建 Session 的身份>",
  "cliActorId": "<验收身份>", "command": "<CLI_ROOT>/<验收身份>/evoloop" }
```

**`residentQueue.roleActors`**：每个 Role 一条 `{projectId, roleId, actorId}`，`actorId` 等于 Role 级 `materialCli` 的 `cliActorId`（不一致报 `material_cli_actor_mismatch`），`residentQueue.enabled: true`。

**`sessionMessages.grants`**（成对，`sessionMessages.enabled: true`）：每条按“接收 Session”写。

```json
{ "projectId": "<PROJECT>", "sessionId": "<接收 SESSION>", "senderActorId": "<发送身份>",
  "receiverActorId": "<接收 Session 的 CLI 业务身份>", "receiverRoleId": "<接收 Session 的 ROLE>",
  "cwd": "<接收 Session 的工作目录>", "enabled": true }
```

- Leader → 业务/验收 Session：`senderActorId` 是 Leader 的身份。
- 业务/验收 Session → Leader：`senderActorId` 是该 Session 的业务身份，`receiverActorId` 是 Leader 的业务身份。
- 需求 Session → Leader：接入者要给 Leader 发消息、交 Task。
- 结果通知者 → Leader：Leader 结果通知要用。
- 一个“接收 Session + 发送者”只能有一条。
- 回复：`work send --reply-to` 只能指向发给**同一个接收 Session** 的消息；反方向回报一律发新消息，不加 `--reply-to`（否则 `REPLY_TARGET_MISMATCH`）。

**`leaderResultNotices`**：`{ "enabled": true, "packets": true, "targets": [{ "projectId", "sessionId": "<LEADER_SESSION>", "receiverRoleId": "<LEAD_ROLE>", "receiverActorId": "<Leader 身份>", "senderActorId": "<结果通知者>" }] }`；每个项目一个目标，发送者和接收者必须是不同身份，且有“结果通知者 → Leader”的消息授权。

**`scheduling.taskTimingGrants`**：`{ "projectId", "actorId": "<建每日系列的身份，需读写审阅>", "roleId": "<LEAD_ROLE>" }`，`scheduling.enabled: true`。

**`session prepare` 准备文件**（私有 JSON，首次调用后固定在该 `operationId` 上，改内容要换新 ID）：

```json
{ "projectId": "<PROJECT>", "sessionId": "<新 UUID>", "operationId": "<新 UUID>", "roleId": "<ROLE>",
  "mode": "create", "cwd": "<工作目录>", "authorizationScope": "<与 runtime.grants 一致>",
  "displayName": "<界面上显示的名字>", "model": "<精确 model 值>", "purpose": "<一句话用途>" }
```

## 4. 读回时用到的命令

| 要核什么 | 命令 |
| --- | --- |
| 成员与权限、改了没重启 | `get /api/projects/<PROJECT>/members` |
| 各能力是否生效、重启后会变成什么 | `get /api/projects/<PROJECT>/capabilities`（看 `state`、`reason`、`pending`） |
| 仓库登记 | `get /api/projects/<PROJECT>/repositories` |
| Role 与运行时 | `list roles`、`read role <ROLE> --bindings`、`role runtime show <ROLE>` |
| Session | `list sessions`、`work list`、`work status owned:<SESSION>`、`session profile show <SESSION>` |
| Leader → 各 Session 的消息授权与绑定（不花模型） | 用 Leader 的 CLI：`work acceptance`（看每个 Session 的 `missingCapabilities`） |
| 消息往返 | `work send`、`work messages owned:<SESSION>`、`work message <MSG>`、`work status owned:<SESSION> --message <MSG>` |
| Leader 通知 | `work leader notices` |
| 每日评估 | `get /api/projects/<PROJECT>/task-timings`、`list schedules` |
| 验收与关闭 | `work acceptance <TASK>`、`work acceptance mine`（验收者自己）、`task <TASK>` |
| 额度暂停 | `get /api/projects/<PROJECT>/runtime/provider-holds` |

命令都加 `--project <PROJECT>`（包装脚本已设默认项目时可省略）。

## 5. 常见卡点

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 新身份登录 401，或 `members` 里有 `pending` | 身份文件改了没重启 | 重启服务后再读回 |
| 服务起不来，日志 `Document originals must stay outside the development checkout` | 启动服务时的当前目录包含了 Blob 目录 | 从不包含 Blob 目录的位置启动（服务管理器通常从 `/` 启动） |
| `models --project` 为空 | 调用者还没有授权这些模型的 `runtime.grants`，或 grant 改了没重启 | 候选值从运行时模型目录取，写进 grant 后重启 |
| `capabilities` 的 `runtime` 为 `grant_directory_unavailable`、`pending` 显示重启后 `configured` | 新的工作目录只在启动时登记 | 重启 |
| `role.propose` 报 `INVALID_INPUT`（evidence 或 alternatives） | `evidence` 缺缺口类/`effect`/`cost` 之一，或 `alternatives` 不是四类各一 | 按 SKILL 第 3 步补齐 |
| `session prepare` 报参数错误 | 传了 `--project` | 项目 ID 只写在准备文件里 |
| 验收 Session 的 `session prepare` 报 `material_cli_actor_mismatch` | 准备检查要求 CLI 身份等于 Role 的业务身份 | 不照它的修法改；改用 reserve + bindSession + profile set（第 3 节） |
| 队伍条目被挂起 `RECIPIENT_UNAVAILABLE`（“shares its Role with … other live Session(s) and has no runtime.materialCli entry of its own”） | 同 Role 有多个 Session，这个 Session 没有按 `sessionId` 的精确绑定 | 第 3 节补精确绑定（每次使用时重读），再按 `work board` 读回条目是否恢复 |
| `session prepare` 返回 `waiting_for_native_thread`，立刻重跑又得到 `blocked` | 原生 Thread 还没就绪 | 等 `read session` 显示 `ready` 和原生 Thread，再用同一文件重跑 |
| 回报消息报 `REPLY_TARGET_MISMATCH` | `--reply-to` 指向了发给另一个 Session 的消息 | 发新消息，不加 `--reply-to` |
| `work events --wait 30` 报 `TIMEOUT` | CLI 默认 15 秒超时短于等待时间 | `EVOLOOP_TIMEOUT_MS=60000` |
| `project.create` 被拒 | 发命令的身份的 `projectIds` 里还没有这个项目（或没重启） | 先写身份文件、重启 |
| `TASK_OWNER_ROLE_REQUIRED` / `INVALID_FIRST_TASK` | 第一个 Role 的引导缺口 | 第 2 节 |
| `INVALID_TRIAL` | 回看日期不在试行期内，或已经过去 | `reviewAtUtc` 设在现在之后、`trialDays` 之内 |
| `session prepare` 返回 `blocked` | 缺配置 | 照 `missingDetails` 补，用同一 `operationId` 重跑 |
| `material_cli_incompatible` | 包装路径含不允许的字符 | 换到只含 `A-Za-z0-9_./-` 的路径 |
| `role_actor` / `material_cli_actor_mismatch` | `roleActors` 缺、未启用、身份无写权限，或与 `materialCli` 不一致 | 第 3 节 |
| `cwd` 缺项或 Session 不能执行 | 工作目录不是规范绝对路径，或与 grant 不完全相同 | 用 `realpath` 的结果 |
| 发消息报 `MESSAGE_GRANT_MISSING` | 这个方向没有授权，或 `receiverRoleId`/`cwd` 与接收 Session 不符 | 第 3 节，成对补齐 |
| 消息送达但对方没有职责上下文；验收接力报 `RECIPIENT_BINDING_MISSING` | `receiverActorId` 写成了建 Session 的身份 | 改成接收 Session 的 `materialCli.cliActorId` |
| Leader `runtime.run.reserve` 403 | Leader 没有该 Session 的 Role/范围/目录的执行授权（包括它自己的 Session） | 给 Leader 加一条对应的 `runtime.grants`，新目录要重启 |
| 关闭报 `STORAGE_REJECTED … lacks linked consumer use`，或验收者关联时报 `ACCEPTANCE_NOT_USED` | 有验收接力时，验收者的 `used` 观察要关联到接力：观察须记在签 `session.message.receipt` 之后，接力那条消息处理完才会关联 | 按 [Leader 安排验收](../../evoloop-workflow/references/leader-scheduling.md) 的规则；没关联上时由 Leader 再给验收 Session 一轮，验收者用 `work acceptance observe` 补关联，再关闭 |
| `runtime.run.reserve` 报分派缺失或过期 | `task.start` 会让旧分派过期 | `task.start` 之后重新 `task.assignment.set` 并等接手确认 |
| 关闭被拒（`SELF_ACCEPTANCE`、`INDEPENDENT_OBSERVER_REQUIRED`、`CONSUMER_MISMATCH`） | 签 `used` 的身份是作者、或不是声明的 `consumer` | 验收 Session 用独立身份，`consumer` 写它的 `actorId` |
| 某个 Session 一直不处理新消息 | 队首旧消息卡住 | 对账那一条（见 SKILL“运维时要记住的”），不重发 |
| 所有 Session 都停了、新消息只排队 | 模型额度用完或鉴权失败，提供方被暂停 | 账户使用者处理后由审阅身份 `runtime.providerHold.release` |
| 改了 `scheduling.grants` / `repositories` / `runtime.enabled` / grant 的工作目录或模型没生效 | 这些只在启动时读 | 重启；每日复制改用 `taskTimingGrants` 免重启 |
| Session 读了工作目录以外的文件 | 受管 Session 是全权限、与服务同一系统用户 | 停实例；按第 6 节加隔离；消息与 Task 正文写明活动范围 |

## 6. 同一主机上的隔离

受管 Session 能读服务的系统用户能读的一切。同一主机上已有正式实例、又要另起一个试用或单独实例时，把新实例的运行时可执行文件换成一个包装脚本，用 macOS 的 `sandbox-exec` 拒绝读写正式实例的私有目录、拒绝连正式实例的端口；沙箱会继承给运行时启动的每个子进程（Session 里的 shell 命令）。

```sh
#!/bin/sh
# <TRIAL_ROOT>/bin/codex-sandboxed：integrations 的 runtime.executable 指向它
exec /usr/bin/sandbox-exec -p '(version 1)(allow default)
  (deny file-read* file-write* (subpath "<正式实例的私有根目录>"))
  (deny network-outbound (remote ip "localhost:<正式实例端口>"))
  (deny network-outbound (remote ip "localhost:<正式数据库端口>"))' <原运行时可执行文件> "$@"
```

- 被拒的目录按实际情况补全：正式实例的数据目录、发布目录、身份文件与 CLI 包装所在目录，以及其他不该让 Session 看到的个人目录。不要拒绝运行时自己的登录目录（例如 codexHome），否则 Session 起不来。
- 包好后先实测：用同一个沙箱参数跑 `ls <被拒目录>` 应失败、`curl` 正式端口应失败、读试用目录与访问外网应成功；写进接入记录。
- 这只隔离新实例的 Session，不隔离正式实例里不同项目的 Session（同一服务、同一沙箱）；后者仍是 DEC-047 待定的隔离问题。
- `sandbox-exec` 是 macOS 自带、已不再维护的工具；换平台时用该平台的等价办法（独立系统用户、容器）。
