# 本机运行与恢复

本页说明怎样在一台机器上运行和恢复 evoLoop：环境与启动、身份与集成配置、运行时、备份与恢复。新实例当前打开了什么、用过什么，以[阶段路线的当前基线](../roadmap.md#当前基线)为准；部署形态见[部署与迁移](../architecture/deployment.md)。各项运行机制的打开与核对步骤见[运行接线手册](runtime-operations.md)。

## 环境与启动

使用 Node.js **24.x**、npm、PostgreSQL **18** 的独立数据库；备份工具 `pg_dump`/`pg_restore` 也须是 18.x。连接串、身份文件、外部 Blob 和 Wiki 正文均留在仓库外。

**承载真实试用的 PostgreSQL 数据目录必须位于持久位置**，例如仓库外的专用应用数据目录；不要沿用 `mktemp`、`/tmp` 或 macOS `$TMPDIR` 中的一次性测试集群。开始保存真实材料前，由数据库管理者核对实际 `data_directory`（具权限时可执行 `SHOW data_directory`）、备份位置及隔离恢复结果；连接串和进程仍在并不能保证底层目录持久。临时实验转为连续试用前，先停写，备份并恢复到新的持久目录，再核数据与未决运行后切换。

先在 PostgreSQL 中建立专用空库及有建表权限的用户，然后安装、构建：

```bash
node --version
pg_dump --version
npm ci
npm run build
export EVOLOOP_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/evoloop_dev'
export EVOLOOP_AUTH_FILE="$PWD/.local/auth.json"
export EVOLOOP_INTEGRATIONS_FILE="$PWD/.local/integrations.json"
export EVOLOOP_BLOB_ROOT="$HOME/.local/share/evoloop-pilot/blobs"
mkdir -p .local "$EVOLOOP_BLOB_ROOT"
```

安装依赖并配置连接后、切换本机真实试用前，运行只读预检：当前系统用户须拥有数据目录，数据库账号须有读取 `SHOW data_directory` 的权限。`--expected-data-directory` 应来自部署计划中的预期持久目录；证据目标的父目录须已存在、位于仓库外且由当前用户私有管理，目标文件须尚不存在：

```bash
npm run pilot:storage:check -- \
  --expected-data-directory /absolute/persistent/evoloop-pg \
  --evidence-out /absolute/private-evidence/storage-preflight.json
```

脚本从 `EVOLOOP_DATABASE_URL` 读取数值回环地址与显式端口，核实际 PostgreSQL 18 的目录、本机规范路径、属主、权限及 postmaster 启动绑定，拒绝临时、缓存或仓库内目录。它以新 0600 JSON 保存当前核验事实，不输出连接凭据；权限不足、路径错配或连接/查询超时会失败，不能当作通过。该检查用于本机持续试用，不约束一次性测试集群，也不替代备份与恢复演练。

`.local` 只放本机私有配置，不放外部正文和备份。下面生成身份文件时拒绝覆盖旧文件，只输出项目 ID：

```bash
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
const projectId = randomUUID();
writeFileSync(process.env.EVOLOOP_AUTH_FILE, JSON.stringify([{
  token: randomBytes(32).toString('hex'), actorId: 'local-owner',
  projectIds: [projectId], permissions: ['task', 'document', 'session', 'management'],
  identityKind: 'human'
}], null, 2), { mode: 0o600, flag: 'wx' });
console.log({ projectId });
JS
```

`permissions` 只列可写的对象类别；进入项目本身即可读取普通任务、文档，以及 Session 的存在、状态和一般对话，不另设 `read`。人类身份随所属类别获得决定权；智能体身份还须显式写 `"decisions": true`。`sessionIds` 为空或省略表示本项目全部 Session；非空数组把 Session 写入和完整原生记录读取限定到列出的 Session。`extraCommands` 只能列出 `document.archive`、`document.restore` 这类逐命令例外，不授予文档类别以外的权限。

旧身份文件中的 `read`/`write`/`review` 不会被服务静默解释。先保留原文件，再用当前 CLI 转换：

```bash
npm run --silent cli -- identity migrate --input legacy-auth.json --out auth.json \
  --confirm-review-as-management
```

`read` 变为项目成员读取；`write` 变为 `task`、`document`、`session` 写权限；`review` 只有在明确确认后才变为 `management` 加决定权。因此 `read` + `write` 的 owner-proxy 身份不会被授予开工、关闭或阶段决定；需要这些动作时，单独给 agent 身份加 `"decisions": true`。命令先打印逐身份的转换前后表，再写 0600 新文件；没有 `--confirm-review-as-management` 时只要含 `review` 就拒绝，避免把旧复核权静默扩大成项目管理。

集成默认关闭。以 `0600` 权限创建 `.local/integrations.json`，初始内容如下（`repositories`、`feishu`、`knowledge` 均可暂时省略）：

```json
{
  "scheduling": { "enabled": false, "grants": [] },
  "runtime": { "enabled": false, "grants": [] }
}
```

给 Role 新建受管 Session 还要 `runtime.materialCli`（Role 级 CLI 绑定）、**`residentQueue.roleActors`**（Role → 业务身份，须与前者 Role 级条目的 `cliActorId` 一致；Session 有自己的精确 `materialCli` 条目时按那一条判断，`residentQueue.enabled` 为 `true`）和 `runtime.grants`；缺哪项，`session prepare` 的 `missingDetails` 会指明配置项与修法，完整清单见 [Agent CLI](agent-cli.md#编制所需私有配置清单session-prepare-缺项时)。

Leader 结果通知、即时输入、托管压缩、普通 Task 的每日复制和阶段关注各有自己的配置、打开和核对步骤，见[运行接线手册](runtime-operations.md)。

日程 grant 须明确 `projectId`、`actorId`、`scopeId`、`roleId`，与日程当前修订的授权一致；当前身份仍须该项目 `management` 权限和决定权。未配置 `template.managedTarget` 时，tick 只创建 `todo` Task 及其固定主正文。新修订可显式绑定已限定同一 active Stage 的既有 `{loopId,stageId}`，同库物化后将经核验的到期来源送给指定 Loop；认知需要工作时复用该 todo，仍按当前 runtime grant、预算与 Task 规则启动，不由 tick 直接运行。旧修订不自动升级为受管工作。停用、失去 coordinator 锁、撤权、过期和异常的状态见 `/api/projects/PROJECT_ID/scheduling/status`。排程与其他 pump 一起在服务开始监听后启动；某一轮失败（包括启动时的首轮）不会停掉排程：日志写出原因（同一原因十分钟一行），30 秒后下一轮重试，成功前 `state` 为 `error`。runtime grant 须明确 `projectId`、`actorId`、`roleId`、`authorizationScope` 与绝对路径 `cwd`；每个新 Session 固定 `danger-full-access`、`approvalPolicy: never` 和正常网络。精确授权仍限定 actor、项目、Role、scope 与业务对象，不要把 OS 执行权限理解为项目数据授权。`repositories` 可按项目登记只读 Git 根目录与路径白名单；`feishu` 启用时须给凭据、Bitable 字段映射及逐项目/行为者、显式 `scope: "project"` 的 `grants`，自动轮询另需 `pollEnabled`。用户已将飞书 connector 留待后续，本轮不以实连为完成条件。飞书尚无真实租户验证，不要把 fake HTTP 测试当作实连；当前配置仅支持明确的项目全范围授权，拒绝未落实入站过滤的 owner 范围。身份在启动时读取，修改后重启；HTTP 认证使用启动时的身份快照，重启后才会采用新凭据。集成配置分两种：是否启用运行时、`runtime` 下的执行配置和 `repositories` 的仓库登记等在启动时读取，改后要重启；日程授权、Leader 通知、即时输入和每日复制授权等在使用时重读，见[运行接线手册](runtime-operations.md#共同做法)。普通 Run 封存器会再读当前身份文件，文件修改可能在 HTTP 重启前提前收紧原签署者的新写入资格；已提交 Delivery 的固定回读仍可继续。

如要接外置 Wiki，另加 `knowledge` 配置：`enabled`、回环 HTTP `baseUrl`、仓库外绝对路径 `manifestRoot`、`maintainerId`、`projectIds`。`maintainerId` 必须与实际发布/对账身份的 `actorId` 一致，且该身份具有对应项目的 `document` 写权限和文档决定权；任意标签或另一个未配置的身份不会取得维护权。Wiki 正文和修订由外置后端持有，PostgreSQL 只保存可核对引用；不要把正文、原始 session 或私有运行材料写入 Git。当前 0.5.1 已通过受限真实写读、重启回读和产品候选审核发布；这不证明语义索引、多写者安全或生产恢复。

```bash
chmod 600 "$EVOLOOP_AUTH_FILE" "$EVOLOOP_INTEGRATIONS_FILE"
npm run db:migrate
npm start
```

在浏览器打开服务监听的本机回环地址（端口由 `EVOLOOP_PORT` 设定，未设时用代码里的默认值），用身份文件中的 token 登录。令牌只留在当前页面内存，刷新后需重新登录。更新应用后请刷新已打开的标签页并重新登录；旧标签页仍可能运行旧版本界面，本轮独立消费曾因此失败，刷新后才成功，失败观察仍保留。服务只监听回环地址。迁移不会在启动时自动执行。C5 将 Task 正文归入 Document 并改为四态；既有实例须单独运行迁移并同步服务、CLI 和界面版本，本轮未自动升级其他会话的预览或持久数据。同一数据库只允许一个 coordinator 持有专用连接锁；锁丢失后写入不可用，不是双机自动接管证明。

### Hub 骨架与机器加入（H1 PR2、PR3）

Hub 是独立进程和独立数据库，不能复用 coordinator 的项目库。先准备一个只给 Hub 的 PostgreSQL 数据库和私有环境文件；不要把数据库 URL、初始密码或恢复 dump 提交到仓库。下面的 `<...>` 都代表私有值。

```sh
export HUB_DATABASE_URL='postgres://.../evoloop_hub'
export HUB_PUBLIC_ORIGIN='https://hub.example'
npm run hub:migrate
npm run hub:init -- --email admin@example.test --name 'Hub Admin' --password-file /private/hub-initial-password
npm run start:hub
```

`hub:init` 只用于创建第一位 Hub 管理员；已有管理员时会拒绝。默认监听 `127.0.0.1:4319`，由同站 HTTPS 入口反向代理；`HUB_PORT` 可覆盖端口。备份、恢复和完整 API 合同见 [Hub 账号、邀请与项目成员](../architecture/hub.md)。

**让一台机器加入 Hub（PR3，本 PR 合入后才算已合入）。** 先在这台机器上装好 evoLoop 并让 coordinator 能正常启动（它仍只听 `127.0.0.1`）。Hub 管理员 `POST /api/admin/machines` 取得一次性加入码（10 分钟、只能用一次），然后在**这台机器上**运行：

```sh
evoloop machine join --hub https://hub.example --code <加入码> --workspace-root <允许的代码根目录>
```

命令会列出要允许的根目录并要求在这台机器上确认一次（终端里回答 y；脚本里确认过后加 `--yes`）；密钥对在本机生成，只有公钥与根目录上传。凭据保存在 `~/.evoloop/machine/machine.json`（`EVOLOOP_MACHINE_DIR` 可改目录），权限 0600。**这台机器自己的 coordinator 必须用 `EVOLOOP_MACHINE_DIR` 指向该目录启动**（`join` 的输出里 `credentialsDirectory` 就是它）；没设这个变量的 coordinator 不读任何机器凭据、也不连 Hub，别的实例（测试、隔离验收实例、本地第二个 coordinator）因此不会抢走正式机器的 Hub 连接，同一凭据的第二个存活连接也会被 Hub 拒绝（见 [Hub 架构](../architecture/hub.md)）。**发布提示：**之前靠默认位置读凭据的正式 coordinator，发布这个改动前要先在它的私有启动配置里加上 `EVOLOOP_MACHINE_DIR`，否则发布后它不再连 Hub（日志里会有一行说明）。**重启 coordinator**，它启动后自己向 Hub 建立长连接并保持心跳；Hub 的 `GET /api/admin/machines` 显示 `online`。本机配置里所有项目目录（运行授权、委派模板、仓库）必须在允许根目录下，否则 coordinator 拒绝加载这份配置。`evoloop machine status` 看状态，`evoloop machine leave` 退出（先通知 Hub 再删本机凭据；项目数据与 coordinator 不受影响）。Hub 管理员 `DELETE /api/admin/machines/{id}` 可从 Hub 一侧移除，凭据当场失效。

核对机器没有新增对外监听：`lsof -nP -iTCP -sTCP:LISTEN` 里应只有原来的 `127.0.0.1` coordinator（连接器只向外连）。浏览器与 CLI 经 Hub 使用项目：`EVOLOOP_API_URL` 指向 Hub，`EVOLOOP_TOKEN` 用个人令牌或服务身份令牌（见[CLI 指南](agent-cli.md)）。

**工作台经 Hub 登录（PR4，本 PR 合入后才算已合入）。** 构建工作台（`npm --workspace apps/workbench run build`）后，Hub 默认托管检出里的 `apps/workbench/dist`（`HUB_WEB_ROOT` 可指向别处；没有 `index.html` 就不托管，只有 API 与纯页面）。`HUB_PUBLIC_ORIGIN` 必须是浏览器实际打开的地址（写请求的 `Origin` 与它比较）；cookie 是 `Secure`，浏览器只在 HTTPS 或回环地址上保存它。打开 Hub 地址，用 Hub 账号邮箱与密码登录，列出的是自己的项目与各自的机器状态。本地令牌模式不变：直接打开 coordinator 的地址仍是粘贴令牌。Hub 账号要经工作台给 Session 发消息，需要在私有配置的 `sessionMessages.grants` 加一项 `"senderKind":"hub"` 的授权（可再写 `"senderClass":"user"` 表示这是使用者本人的账号，或 `"service"` 表示不是人的服务身份，不写则接收方只知道“经 Hub 的身份”），见 [Hub 第 13 节](../architecture/hub.md#13-工作台经-hub-登录h1-pr4task-9ea06625)。

自建一个 Hub 加一台机器做候选核对的最小步骤：用一次性 PostgreSQL 建 Hub 库，`hub:init` 建管理员，起 Hub（`HUB_HOST=127.0.0.1`，同机试用即可，`HUB_PUBLIC_ORIGIN` 填访问用的地址），管理员登录后创建账号、项目（`projectId` 填机器上 coordinator 里已有的项目 ID，`machineId` 填刚登记的机器）、个人令牌与服务身份，再按上面加入机器。不要使用正式实例的端口 `55432`，不要把真实令牌、主机名或路径写进仓库。测试或演练不要连接正式实例的 `55432`；用 `npm run test-pg` 约定的一次性实例，并在演练后停止、删除。

## 在常驻主机上运行

常驻实例按本页同样的步骤安装、迁移和启动，部署形态见[部署与迁移](../architecture/deployment.md#1-部署形态)。与在开发机上试用相比，有四点不同：

- **只经一个 HTTPS 入口访问。** 工作台和 CLI 都走这个入口（CLI 的 `EVOLOOP_API_URL` 指向它）；协调服务仍只监听本机回环，由入口转发。不为 PostgreSQL、运行时或协调服务另开对外端口。
- **按版本发布。** 每个版本单独构建、单独存放；数据库、Blob、备份以及私有身份与 integrations 文件都放在发布目录之外，切换版本不搬动它们。发布按停写、备份、迁移、启动核对的顺序走，见[发布新版本](../architecture/deployment.md#2-发布新版本)。
- **运行时登录属于主机。** Codex 的登录目录和 Claude 的 `configRoot` 留在主机上；换主机时不搬，在新主机上重新登录，见[迁移之后重新接入](../architecture/deployment.md#5-迁移之后重新接入)。
- **地址不进公开文档。** 主机名、入口域名、目录和端口只记在私有运维记录里。

## 受管自动循环候选

在独立数据库迁移至当前代码要求的最新版本（含 **038**）后使用本切片；不要借启动自动升级其他会话的试用库。原有集成可保持关闭。要实连 worker，另配置 `orchestration`：`enabled`、已具本项目 `task`、`document`、`session` 写权限和决定权的 `controllerActorId`、仓库外绝对路径 `workerRoot`、`credentialTtlMs`（1 分钟至 24 小时）和 `pollIntervalMs`（0.5 至 60 秒）。每个认知或业务职责须有控制者自己的唯一 runtime profile，含精确 actor、项目、Role、scope、目录和模型字段；新 Session 均按 full/never/联网创建，不再按职责选择 sandbox 或消息专用 profile。同一项目/actor/职责/scope/目录的重复 profile 被拒绝。

worker 的 `cwd` 是启动上下文，不是文件读取白名单；当前 Session 有完整 OS 执行权限和正常网络。仓库、Task、Document 等业务对象仍由各自精确身份和 API 授权约束。`workerRoot` 保存 0700/0600 的短期凭据和 wrapper，不能位于开发 checkout。CLI 回执放在获准的私有工作目录 `.local/worker-receipts/RUN_ID`。不要把真实配置、令牌、回执、原始 session 或外部正文提交 Git。配置在启动时读取，变更需要重启；撤销 broker 凭据与暂停 Loop 是不同操作。

凭据到期或撤销后，私有 metadata 仍用于判定历史角色及排除认知自反馈；保留这些元数据，不能把删除整个 worker 目录当成令牌清理方式。当前版本尚未把这项历史分类迁到独立数据库记录。已确认终态缺署名提交会留下缺口、释放并发，并可在原 Loop 预算内进入去重的认知恢复；未知原生结果继续占用并沿原 ID 对账。校准 `credentialTtlMs` 只影响新签发凭据，不复活旧运行，具体边界见[缺提交恢复](agent-cli.md#受管执行与自动接续)。

服务启动后，先经普通命令创建/接受真实 Goal 和 Stage，再查看 `command schema loop.enroll` 配置一次范围、职责、来源基线和有限运行预算。自动循环不替用户决定项目目标；配置生效后，认知可在范围内自主形成 Task 和请求执行，控制者不逐 Task 代点 start/reserve。worker 的正式提交、停止与未知恢复协议见[Agent CLI](agent-cli.md#受管执行与自动接续)。运行页和关联任务页显示工作原因、责任、决定、结果与下一步，技术回执可展开核对。第一条真实运行完成也不等于负责人独立验收，更不能提前补算其余两条自动旅程。

## 体验有边界的复核

另开终端设置同一身份。`EVOLOOP_TOKEN` 从本机文件读取，不写入命令历史：

```bash
export EVOLOOP_AUTH_FILE="$PWD/.local/auth.json"
export EVOLOOP_TOKEN="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.env.EVOLOOP_AUTH_FILE,"utf8"))[0].token)')"
node scripts/seed-review-demo.mjs --project YOUR_PROJECT_UUID
```

脚本经 API 建立合成需求、两个已接受但未运行的 Task，再修订并采纳需求新版；不会随启动自动运行。打开输出的项目 URL，分别为任务 A 采用新版依据、为任务 B 保留旧版，并核对决定历史和固定旧修订。任务仍为 `ready`，并非已执行或交付。真实目标→阶段→提案→交付→消费者使用→下一步的路径可在工作台操作，但需人实际试用，不能由合成示例替代。

人主要从工作台观察进展、依据和结果；多数日常修改在与 Agent 沟通后，由 Agent 使用业务 skill 和 CLI 完成。CLI 使用同一令牌和 API，语法、固定原件、专用请求与私有回执恢复见 [Agent CLI](agent-cli.md)：

```bash
npm run --silent cli -- help
npm run --silent cli -- command run .local/command.json
npm run --silent cli -- list tasks --project "$PROJECT_ID"
```

结束一个已绑定且没有在途或未知 Run 的受管 Session，可先 `read session SESSION_ID --project "$PROJECT_ID"` 取得版本，再提交 `runtime.session.close`；CLI 的 `command run` 使用同一命令合同：

```json
{"type":"runtime.session.close","projectId":"PROJECT_UUID","operationId":"NEW_OPERATION_UUID","sessionId":"OWNED_SESSION_UUID","expectedVersion":3,"reason":"该会话工作已完成"}
```

请求成功仅表示关闭意图已保存。回读 Session，只有状态 `closed` 才表示原生归档身份已核验；`closing` 要保留原操作 ID 等待只读对账，不能换 ID 重发归档或新建 Session。该操作不取消 Task、Role 或 Schedule；关闭前保存需要的实际 trace 证据。

已有 `closeAttemptedAt` 而归档仍未核实的 Session，在 runner 重启后仍须显示 `session_close/unknown_outcome`，不能因内存故障记录丢失而显示健康；后续只读核实，只有精确原生归档读回才确认关闭并清除故障。同一进程收到明确原生拒绝时，沿用脱敏的 `native_rejected` 或 `authorization` 分类；超时、丢响应和无归档证明的空回执保持未知，不暴露原生错误正文。该拒绝类别不另行持久化，重启后保守显示未知。零 Turn Thread 可能尚无持久 rollout 或可核验归档记录；这种情况下不能据缺少记录断言成功或失败，也不能为生成记录自动开启 Turn。

命令需稳定的 `operationId`、`projectId`；修改已有对象还需读入的 `expectedVersion`。同一 ID、身份和内容返回原回执；不同内容复用 ID 被拒绝。结果未知时先查 `/api/projects/PROJECT_ID/operations/OPERATION_ID`；404 只表示当次未查到，不能证明外部动作没发生。未知 Turn 必须按已有原生 thread 和 operation 标记对账，不能换 ID 盲目重派。工作台临时恢复索引在当前标签页 `sessionStorage`，不存令牌或正文；关闭标签页可能失去索引，重要操作应另存 ID。

Codex App Server 的协议版本默认是 `0.166.0-alpha.5.1`。要选其他已核版本，在私有运行配置里显式设置 `runtime.protocolVersion`，并核对实际二进制与生成的标准或实验 schema 指纹；旧私有包的版本约束须由发布者另行更新。各版本可用的能力（托管压缩和运行中补入只在 `0.166.0-alpha.6`）见[Codex 接入](../architecture/codex-integration.md#协议版本与可选能力)，新实例用的是哪个版本见[阶段路线](../roadmap.md#当前基线)。未配置 `codexHome` 时，子进程共用使用者自己的 Codex 登录、provider 与历史，evoLoop 创建的线程会出现在使用者自己的 Codex 历史里；Codex 也可能在使用者的 `config.toml` 里为每个新的 Session 工作目录追加一条项目信任条目。新实例或试用应从一开始就配置专用、绝对路径的 `runtime.codexHome`，并把登录、provider 和模型目录在该目录中单独准备好；evoLoop 不复制或改写使用者个人的 Codex 配置。若已经共用，先停止创建新 Session 并备份 `config.toml`，再由使用者按 Codex 的实际格式核对哪些条目只属于本次试用目录并手工清理；不要在会话仍使用这些目录时删除条目，也没有 evoLoop 自动回滚或批量清理，因为条目格式、登录和历史都由 Codex 拥有。Turn 完成不自动证明技术验收、交付、消费者使用或 Task 关闭。启用前核对实际安装版本、schema、授权目录与隔离真实任务；升级须重新核协议、终态、断线与恢复。HTML/CSS/SVG 阅读中的 Document iframe sandbox 是独立内容隔离，不随 Session OS 权限变化。结果未知时保留原操作并人工核对。

App Server、版本检查与协议探测使用同一份明确的子进程环境白名单，保留本机 Codex 登录目录、基本运行环境和代理/证书配置，不转发协调服务的数据库连接、身份配置路径、API 密钥或 Node 执行注入参数。本片沿用 Codex 的本机 ChatGPT 登录；这项环境筛选不限制读取 HOME 文件，工作目录也不是文件读取白名单。runtime 的 authorizationScope 当前用于精确匹配授权，不应把形似 Task ID 的字符串宣称为单任务执行隔离。

Claude 运行时：新实例的 Dev Role 已在用，有真实 Run，尚未验收（计数见[阶段路线](../roadmap.md#当前基线)）。启用时在 runtime 配置中把 `claude` 列入 `providers`（或设 `provider: "claude"`），并设 `claude: { configRoot, executable?, maxTurns?, maxBudgetUsd?, maxConcurrentTurns?, skillBundle?, contextMode? }`。`maxConcurrentTurns` 是所有 Claude Session 同时进行的 Turn 数上限（不写时为 4，每个 Turn 一个 Claude Code 进程），按需要同时工作的 Session 数和主机内存设置；超过上限的 Turn 不会失败，而是等待：普通消息留在队列里、恢复门保持打开，业务 Run 退回 `requested`，有空位后自动开始。`configRoot` 是该协调服务专用的绝对路径，作为 `CLAUDE_CONFIG_DIR`，存放 Claude 会话记录、设置、登录与适配器的 Turn 账本，不与 `~/.claude` 共享；因此需要在该目录单独登录，或由协调服务环境提供 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 等凭据，配置文件不接收凭据。它不会自动复用 `~/.claude` 或 Claude 桌面应用的登录：桌面宿主注入给自身进程的会话令牌在子进程中返回 401。可由使用者本人运行 `claude setup-token`，再把结果设为 `CLAUDE_CODE_OAUTH_TOKEN`；也可以设置 `CLAUDE_CONFIG_DIR=<configRoot>` 后运行一次 `claude` 并登录。每个 Turn 启动一个 Claude Code 进程，使用同样的环境白名单，只加载项目级设置并关闭自动记忆；新 Session 按 DEC-033 使用跳过权限确认的完全访问。Turn 结果结算后，进程若因仍在等待某个工具而没有在 5 秒内自行退出，适配器向它的进程组发 SIGTERM（CLI 会自行停止它启动的工具 shell），再过 5 秒仍在则 SIGKILL；这段仅在退出的时间不算 Session 上有正在运行的 Turn，下一个 Turn 会等它退出后再启动。Turn 只按回显本次 prompt uuid 的 result 结算：续接的 Session 若先处理上个 Turn 之后排队的后台任务通知，那条不调用模型、来源为 `task-notification` 的 result 不算本次 Turn。Claude Session 支持普通消息与空闲直启，不支持会话命名、工作区历史和模型修订（对照见[Session 运行时](../architecture/session-runtime.md#7-codex-与-claude-能力对照)）。每个子进程都以 flag 设置 `crossSessionInbound: "refuse"` 启动，并禁用 SendMessage 与 ListAgents，Claude 的原生会话间消息在两个方向都关闭，Session 之间只通过 evoLoop 的授权消息通信。凭据失效时，Claude Code 在默认重试设置下会让 Turn 长时间没有结果，建议在协调服务环境中设置 `CLAUDE_CODE_MAX_RETRIES`（例如 2），适配器会把它传给子进程。除不调用模型的假 CLI 回归外，`scripts/claude-conformance.mjs` 用真实 CLI 2.1.319 对本机模拟 API 验证过参数、隔离、续接、中断、进程丢失和错误分类。真实模型下的费用与限流行为仍待观察。

同一协调服务可以同时驱动 Codex 与 Claude：`runtime.providers` 列出要驱动的运行时，例如 `["codex", "claude"]`；`runtime.provider` 是尚未绑定的 Role 首次预留 Session 时绑定的默认运行时；不写 `providers` 时只驱动 `provider`。Role 只绑定一次运行时，之后只在该运行时内调整：Role 的 skill 随时可改，Session 的模型修订目前只在 Codex 实现，Claude Session 沿用创建时的模型；不能换成另一种运行时。Session 一直按创建时的运行时分发。未列入 `providers` 的运行时，其 Session 保持可读但不被驱动，绑定到它的 Role 也不能新建 Session。原生会话输入与浏览器读取桥只属于 Codex，只驱动 Claude 时不能开启。迁移 067 把既有 Session 记为 `codex`；068 按既有 Session 的运行时为已有 Role 写入首个绑定，优先未关闭的 Session，未关闭 Session 横跨两种运行时的 Role 保持未绑定，等一侧关闭后再绑定。两者须在新服务启动前依序应用。

Role 的 skill 选择决定每个 Turn 放进模型上下文的 skill，用 `role runtime set` 或工作台角色卡片修改，下一个 Turn 生效。evoLoop 业务 skill 按 Role 配置始终加载；项目、个人与运行时内置 skill 按开关加载，`add`、`remove` 按名称单独增减；会修改运行时自身配置的内置 skill（例如安装器）默认不加载。Codex 由线程配置关闭未选的 skill，业务 skill 经 Role 上下文交付；Claude 在 `claude.skillBundle` 为默认的 `true` 时，把选中的 skill 链接成本次 Turn 的本地插件并关闭其余。工作目录仓库把 `.claude/skills` 链接到 `.agents/skills` 时（本仓库即如此），Claude 原生读到的同一份 skill 会按名称关闭，每个 skill 只经插件加载一次。`runtime.roleSkills[].builtinSkills` 已被这项选择取代，旧配置仍可加载但不再生效。选择只决定上下文，不是安全边界。

`role runtime show` 与工作台角色卡片每次读取时都实时取值。Codex 角色在最近一个 Session 的工作目录（没有时用这个角色自己的授权目录：不按查看者过滤，有多个时取排序后的第一个并写明共几个；路径只给有项目管理决定权或本人持有该角色运行授权的人，其他读者看到“已配置”，项目 skill 的名称对所有项目读者显示；角色没有任何运行授权时写明原因）询问运行中的 App Server 的 skill、插件与 MCP 列表；Claude 角色按文件列出 skill，再用最近一次 Turn 启动时的报告补上内置 skill、插件与 MCP，尚无 Turn 时注明内置 skill 待首个 Turn 后显示。运行时不可用时退回按文件推断，并在结果中标明来源。Codex 由插件提供的 skill 可能不出现在它的列表中。

重启或恢复 owned Session 前，核持久 actor、Role、scope、cwd、model、sandbox、approvalPolicy 与当前业务授权，先对账在途和未知 Run。新 Session 用 `danger-full-access`、`never` 与正常网络；旧 Session、旧 Run 和其配置快照保持原值。恢复时对原 `thread/resume` 明确传入完整配置；新 App Server 可恢复未加载的旧 Thread，同进程已加载而权限回显不符时保持 unknown。只有原生线程/恢复/启动回执明确确认 full/never 权限才标记 active；`thread/read` 不含权限时不能作为丢失回执或恢复成功的证据。模型修订使用原 Thread 上独立、持久的 activation，不创建假 Run，也不改旧 Run snapshot；配置 revision、activation 状态与 provider 实际模型遥测分开记录。旧 readonly protocol 检查字段 `readOnlyProtocolVerified` 仅为解析兼容保留，忽略其值，不要求设置，也不作为新 Session 的准入条件。动态授权失效不能借静态授权继续。

验证要分三层记录：fixture 回归检查参数与拒权分支；固定安装版本的无推理协议实验核参数接受及返回策略；部署后在原 Task、Session、Thread 上执行真实 CLI 并回读服务端产物。前两层不证明原业务故障已恢复，Turn 结束或本地报告文件也不等于已提交、验收或使用。

## 受管 worker 只读浏览器候选

这是为本机 GUI 体验任务增加的可选实验入口。常规任务仍使用业务 skill＋CLI；浏览器不替代 `worker.submit` 或独立消费者的 used 观察。当前 origin 固定为一个本机回环地址（`apps/coordinator/src/runtime/browser-read.ts` 的 `BROWSER_ORIGIN`），不是任意站点浏览能力。启用前核对所选安装版本及实验 schema、实验初始化与动态工具声明，再按下表准备精确 scope；隔离检查通过后还须真实 worker 调用和原路径验收。

在既有 runtime 配置中额外提供 `browserRead: { scopePath, playwrightModulePath }`。两者为绝对路径；scope 放仓库外、当前用户所有的普通 `0600` 文件，拒绝符号链接。`playwrightModulePath` 指向明确安装且核过的 Playwright 模块入口，Chromium 由该安装提供；未配置时不加载它，不为此全局安装技能、插件或依赖。

| scope 字段 | 准备与核对 |
| --- | --- |
| `enabled`、`origin`、`expiresAtUtc` | 明确 true、上述精确本机 origin 和绝对 UTC 截止时间。 |
| `projectId`、`taskId`、`contentRevisionId` | 原 GUI Task 及正常任务更新后已批准的主正文修订。不得用正文相同来跳过 TaskRevision 比较。 |
| `sessionId`、`runId`、`runOperationId` | 唯一预选身份，可从已明确预分配的普通 child Dispatch ID 按 `loopIntentId` 推导；不用首次匹配或历史 Run。 |
| `roleId`、`authorizationScope`、`authorizationKind`、`cwd` | 当前候选只服务 `temporary-experience`，授权种类为 static 或 dynamic；Session 执行为 full/never/联网。GUI 读取仍只使用此 scope 下精确配置的 reader、路由和 Run 证据；完整 OS 权限不会扩大业务对象授权。 |
| `readerActorId` | 派生新身份文件时保留所有原 actor/token，只新增一个恰好有本项目 `read` 的独立 reader；不覆写原身份文件。令牌只由宿主读取。 |
| `entryRouteKey`、`routes` | 唯一普通入口与最多 32 个精确只读路由；每项有 `key`、`hash` 及最多 30 个必要 GET `apiPaths`，全部限同项目。先按普通 UI 观察所需路由和 API，不开放项目任意路径。 |
| `followTaskList` | 默认 false。确需工作列表时显式 true，并在 `apiPaths` 列明本项目精确 `tasks?limit=50` 起点；仅从实际成功页派生下一页、已见 Task 根详情及该页原顺序的精确工作状态 GET。目标与阶段页不需要它：在 `apiPaths` 列明 `work-management/index?view=tasks&limit=50&includeClosed=true`，同一查询带一个游标的后续页随之放行。 |
| `followDocumentList` | 默认 false。确需完整文档列表时显式 true，并列明本项目精确 `documents?limit=50` 起点；只追随实际 `nextCursor` 读取下一列表页，不据此开放文档详情、修订或原件。 |

保持原 Task、旧 Run、失败及预算历史。scope 身份只是预留资源，不承诺认知必派 child；原 todo Task 留给 runner 正常开始。实际调用还须核 ready owned Session、唯一 running Run/native Turn、无中断、当前 Task 修订等于该 Run 固定修订、主正文及 basis 相符、现行执行 grant/binding 和 reader。只读身份看不到的对象如实报告失败，不回退负责人令牌。

正式 scope 必须在目标 Session 的 `thread/start` 前可读；创建后补配置不会追加工具。体验任务正文须明确初始 `entryRouteKey`，再指导 worker 沿实际 snapshot 中的链接和页签继续。运行页还会读取真实派发任务的修订、`worker.decision` 详情及按派发响应顺序去重组成的工作状态 GET；任务运行页为核定默认循环还会单独查询当前 Task 的工作状态，不能以循环级批量 GET 代替这项精确查询。旧 Loop 的路径不能代替新 Loop，预选 child 也不能推出尚未创建的 Inbox 或判断 ID。

如果这些依赖须等待首轮认知产生，可由负责人沿正常 CLI 分段准备，不另开一次业务运行：

1. 先核独立预算、固定任务正文和唯一预选 child；首认知按正常流程运行。只有 child 已正式请求、父 Run 仍在途时才请求暂停。提前暂停会使 `dispatch.request` 被拒，不能假定认知可在暂停中继续派发。
2. 回读确认 Loop 已暂停、child 仍 pending、目标 Session 尚不存在，再等待已接收的父 Run 正常签署判断并结算。此监视不是原子保证；若 child 已开始或线程已创建，保留实际状态，按正常恢复另作判断，不能宣称已拦住。
3. 从实际派发和事件取得任务、判断 ID 及工作状态参数顺序，核完整精确 GET；一次固定私有 scope、核工具配置与原授权后，再恢复 child 承接。预留的业务 Run/Session 此时仍标为未创建，实际工具注册、调用、交付和使用留待后验。

GUI 在途期间保持 scope、服务与任务正文稳定。改变 scope 会使既有浏览器上下文不再匹配，不能将其当作透明的权限补齐或恢复。

上述两个选项只补当前页面的动态网络依赖，不增添导航 `routeKey`。每页须完整通过同项目、合法且不重复的对象 ID、游标及现行 scope/授权校验，才在返回页面前原子登记派生路径；额外参数、重复参数、未见 ID 和其他接口不据此放行。每个上下文对任务、文档分别累计最多 10 页、500 个不同对象，重复读取已批准页不重计，刷新第一页不清预算；异常或循环游标、超限须明确失败。阶段页自身可读取更多对象，本次试点上限不表示全项目完整，分页也不提供某一时刻的冻结快照。Task 根详情包含正文和业务关联；只有确需这些内容时才启用任务派生读取。Document 分支仅放行列表下一页，其条目含标题、类型、状态、修订 ID 与来源等，不含正文；目标及其他依赖继续使用各自精确 `apiPaths`。scope 改变或上下文关闭后，派生许可清除。

worker 可见工具如下；除初始入口外，只能沿当前页面实际观察且 scope 允许的导航继续，不接受任意 URL、选择器、点击或脚本。

| 工具 | 输入与阅读规则 |
| --- | --- |
| `browser_navigate` | `{ routeKey }`，先进入 `entryRouteKey`；后续 key 来自实际可见链接或明确只读页签。 |
| `browser_snapshot` | `{}`，当前可见页面文本、获准导航及折叠/分页状态；排除隐藏路由缓存和未展开正文。 |
| `browser_read_more` | `{}`，继续同一未改变页面的下一段；按 `partial`、`hasMore` 与硬上限判断未读范围，不能把截断当全文。 |
| `browser_expand_details` | `{}`，只展开当前页面可见的折叠证据段；有剩余时继续核返回状态，重新读取页面。 |
| `browser_screenshot` | `{}`，当前获准页面的视口截图及宿主私有 PNG/来源回执路径、哈希和字节数；登录字段和敏感输入不进入输出，截图不证明全文已读。 |

截图回执留在 scope 所在私有目录的 `receipts/`，固定本次 Run/native Turn、调用、实际获准路由及 PNG 哈希，拒绝覆盖冲突内容。消费者可按报告中的精确路径核图和来源；这些文件是界面检查证据，不是业务 Delivery，仍须由 worker 自己署名提交报告。撤权或失败留下的诊断文件不能冒作成功使用。

浏览器使用无持久资料的独立 Chromium context。仅获准 origin/路径的 GET 可达；拒绝写请求、每次重定向、跨站、WebSocket、service worker、下载、超限或压缩响应。宿主按流限长且有期限，令牌不进入工具参数、结果、截图或业务 trace。scope 在后续调用和网络读取时重新核验，当前授权也在工具调用时检查；这不等于数据库撤权能在任意时刻主动推送销毁上下文。停用时移除/关闭 scope、撤销 reader 并核后续工具被拒；需要立即停止在途体验时另按原 Run 中断流程，不把关闭 GUI 当作 Run 已终止。

当前实验动态工具声明仅登记在新建 Thread 的本进程内。服务或原生连接重启后，恢复旧 binding 的动态工具保持拒绝；不要自动新开 Session/Run 重试或把该情形记成业务成功。按原身份核状态，重新授权与预算后再决定后续工作。超时同样返回失败并关闭上下文，晚结果不回报成功。

实际 Chromium 回归可使用已核安装的模块入口，显式运行 opt-in 检查：

```bash
EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE='/absolute/path/to/playwright/index.js' \
  node --import tsx --test apps/coordinator/test/browser-read-playwright.test.ts
```

它使用本机隔离 HTTP 夹具，不连接业务数据库或消费真实 Run。默认单元测试跳过该项时，报告应保留 skipped；本机后端探测、原生初始化成功或取得登录页截图不代表真实业务 worker 已体验。

## 停写备份与空目标恢复

在保存真实不可重建材料前，先定备份周期、保留和恢复目标。脚本覆盖 **PostgreSQL + evoLoop 外部 Blob + 显式提供的 Wiki 外部快照**，不声称三者有原子快照。先排空（`node scripts/release-drain.mjs start --reason …`，见[部署](../architecture/deployment.md#2-发布新版本)）并停止 coordinator，等它的数据库咨询锁真正释放（`node scripts/release-drain.mjs wait-stopped`），再备份；并暂停 OpenViking/其他 Wiki 写者；按 Wiki 后端真实存储方式生成包含正文、修订、来源及 evoLoop `manifestRoot` 的完整外部导出。脚本持有与 coordinator 相同的 PostgreSQL advisory lock，拒绝仍在运行的 coordinator，但不能阻止旁路 SQL 或远端 Wiki 写者。`pg_dump` 给数据库自身一致快照；跨存储一致性依赖停写和后续核对。

确保 `EVOLOOP_PG_BIN_DIR` 指向 PostgreSQL 18 工具目录，或 18.x 工具已排在 `PATH` 前面。备份位置、Blob 根目录和 Wiki 导出均须为仓库外的绝对路径，互不嵌套，父目录已存在；备份目标不能预先存在。Wiki 未启用时明确用 `--wiki-disabled`；启用时改用 `--wiki-snapshot`：

```bash
export EVOLOOP_PG_BIN_DIR='/absolute/path/to/postgresql-18/bin'
node scripts/backup.mjs --out /absolute/private-backups/evoloop-20261020 \
  --blob-root "$EVOLOOP_BLOB_ROOT" --wiki-disabled \
  --integrations "$EVOLOOP_INTEGRATIONS_FILE"
# 已启用 Wiki 时，以 --wiki-snapshot /absolute/external-wiki-export 代替 --wiki-disabled。
```

成功后得到 `db.dump`、`blobs/`、可选 `wiki/` 与含逐文件 SHA-256 和大小的 `manifest.json`。失败清理临时目录，不覆盖旧备份。备份含敏感正文，须限权并留在仓库外。停写时若仍有旁路写入或 Wiki 导出不完整，哈希清单不能补出缺失历史。

恢复前先核 PostgreSQL 18 实例的持久 `data_directory`，必要时在新的持久目录启动独立实例，再建立**新的空数据库**；恢复脚本不会创建或迁移 PostgreSQL 实例的数据目录。不要先运行迁移；选不存在的 Blob 目标目录。脚本先校验清单和全部文件，再确认目标数据库没有用户对象、目标目录不存在，并以单事务运行 `pg_restore`。有 Wiki 快照时给不存在的仓库外导出目标；脚本只解包快照，**不会替 OpenViking 服务导入**：

```bash
export EVOLOOP_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/evoloop_restored_empty'
node scripts/restore.mjs --from /absolute/private-backups/evoloop-20261020 \
  --blob-root /absolute/restored/evoloop-blobs
# 含 Wiki 快照时还需 --wiki-snapshot-out /absolute/restored/wiki-export。
```

若源数据库丢失或损坏，先保全残余文件、日志、原生运行与 CLI 回执，再在独立端口的新空库恢复；初次恢复不连接 coordinator、调度或 runner。备份仅覆盖其一致快照：备份后发生的成功响应、请求或原生结束记录须单独列出，不自动补成恢复库中的 Run、Decision 或操作历史。**恢复快照查不到某操作，不能按普通“未查到”路径重新提交**，因为提交记录本身可能已经丢失。预算也不能退回备份值后直接续跑；须核已消耗和未决派发，明确事故分界及接续范围。无法证明连续性时，记录本轮因存储丢失中断，不宣称无损恢复。

随后按后端流程导入 Wiki，核对修订、来源、Blob 原文哈希、Task/操作回执及待对账运行。全部核实前不要开启 Wiki 或 runtime 写入。跨数据库与文件目录的恢复并非单个事务；若数据库已恢复而文件改名失败，保留现场，用新的空库重做，不在半恢复库上盲目重试。脚本拒绝非空数据库、已有目标目录和仓库内正文路径。

### 线上版本：`/api/version` 与 `build-info.json`

总览顶部的“线上当前版本”读公开只读的 `GET /api/version`（与 `/health` 一样不需要令牌），只返回 `{commit, builtAt, startedAt}`：

- `commit`、`builtAt` 由服务端读**已部署目录根部的 `build-info.json`**（`{"commit": "<7–40 位十六进制>", "builtAt": "<ISO 时间>"}`）。文件缺失、不是合法 JSON 或字段不合规时，两者都是 `null`，页面写“版本未读到”，不回退旧值。
- `startedAt` 是服务进程启动时间，页面叫“启动时间”，不是发布时间。
- 发布脚本在 `build` 步骤（构建和 carry-assets 之后）把 `build-info.json` 写进源码目录根（`commit` 是该目录 `HEAD` 的完整哈希，`builtAt` 是写入时的 UTC 时间）；写不出来（取不到提交哈希、目录不可写）这一步失败，此时还没有停服务，什么都没有变。`post-check` 钩子通过后，发布脚本自己再请求配置里的 `versionUrl`（`GET /api/version`），`commit` 必须与本次发布的提交一致（互为前缀，7–40 位）；服务还没起来会按 `versionCheck.retries`（默认 10）、`intervalMs`（默认 3000）重试，最后仍不一致或读不到提交就**判发布失败**，按现有规则停掉并恢复旧服务，发布记录里 `acceptance.versionCheck` 写 `failed` 与原因，成功时写 `passed` 与读到的提交。`versionUrl` 是必填的（私有配置里写服务自己的地址）；确实不检查要显式写 `skipVersionCheck: true`，发布记录会写 `skipped by config` 并打警告。回滚（`rollback`）不做这个检查。私有发布钩子里原来临时补写 `build-info.json` 的部分在这个版本生效后可以去掉（由需求 Session 处理）。
- 验证阶梯 `/ladder` 读该项目登记的仓库（裸仓库用 `git show`，不联网）里 `refs/remotes/origin/main`（没有则 `refs/heads/main`）的 `docs/roadmap.md`，所以仓库要有 main 分支并随合并同步；没有该文件返回“没有”，没有 main 分支才是 409 `LADDER_UNREADABLE`。
- 阶段与路线图阶段的关联存在 `stage_phase_key`（迁移 101），用 `stage.phaseKey.set`（Task 决定权）设置；未关联显示“未登记”。旧的 `GET /milestones` 已下线（Task 523938fb），总览读 `/stages/milestones` 与 `/ladder`。

### 迁移 118：阶段里程碑与任务归属旁表

迁移 118（`schema/118_stage_milestone_task_stage.sql`）新建 `stage_milestone`、`stage_milestone_history`、`task_stage`、`task_stage_history` 四张表，并在同一个迁移里回填（见[项目数据](../architecture/project-data.md)）；不改任何已有表的行。运行前照常停写备份。回填计数可以先后各数一遍：`stage_milestone` 行数等于 `stage_phase_key` 行数，`task_stage` 行数等于最新提议带阶段的任务数（含已关闭），两张历史表各自同数；`project_stage`、`stage_revision`、`stage_review`、`stage_phase_key`、任务与任务修订各表的行和内容不变。

**回退用前向迁移**（项目迁移 `down=false`）：先发布上一版代码（它从不读这四张表，`stage.phaseKey.set` 照常），再把 `packages/adapter-postgres/rollback/118_drop_stage_milestone_task_stage.sql` 的四条 `DROP TABLE` 抄进下一个编号的迁移执行。它只删这四张表，原有各表不变；删掉的是迁移后新写的里程碑字段和归属，回填的内容可由迁移重新产生。`tests/integration/stage-milestone.test.ts` 在真实 PostgreSQL 上演练了迁移、回填计数、各表内容哈希不变和这条回退。

### 开放 PR 抢同一个迁移号

`npm run check:migrations` 只看一棵合并后的树，看不到两个**都还开着**的 PR 各自占了同一个迁移号（#442 与 #448 都用了 110，合并前验收才发现）。`npm run check:open-pr-migrations -- --pr N`（`scripts/check-open-pr-migrations.mjs`）读开放 PR 的文件列表（`gh pr list --json files`）和基线分支（默认 `origin/main`）上的迁移文件：一个 PR 在某个号上有基线没有的迁移文件就算占了这个号，两个不同的 PR 占同一个号（不管文件名是否相同）就报，**指名两个 PR**（草稿也算并标出），并给一个没人用的号；只有一个 PR 用某个号、或某个 PR 只是改基线上已有的迁移，都不报。给了 `--pr` 只报牵涉该 PR 的冲突，不给则报所有冲突。读不到 PR 列表时退出码为 2（检查没有运行），不当作通过。两个地方运行：CI 的单元切片在 pull request 上运行它（用 `github.token`，工作流已加 `pull-requests: read`）；合并门 `merge-gate.mjs` 在放行一个改了迁移文件的 PR 前再查一次，有冲突就拒绝并指名，读不到开放 PR 也拒绝。限制：`gh` 对每个 PR 只给前 100 个文件，改动极大的 PR 里的迁移文件可能看不到；CI 只在 PR 有新推送时运行，所以后开的冲突 PR 要靠合并门拦。

### 发布脚本

`npm run release -- plan --id ID --ref GIT_REF` 只打印计划；`run ... --execute` 才执行；`rollback --id ID --execute` 把代码切回上一个版本。`--from STEP` 续跑要求该发布记录里前面的步骤都已成功且没有被撤销，`--only A,B` 只跑所列步骤，步骤名拼错直接报错。`--allow-no-previous` 仅用于第一次发布：当前链接不存在时没有可恢复的旧版本，没有该参数一律拒绝。`--allow-off-main` 仅用于演练：发布提交必须已在远端主分支（默认 `origin/main`，可用配置 `remote`、`baseBranch` 改）上，预检会取远端核对，不在就拒绝。不带 `--from` 重跑时，`prepare` 遇到已存在的版本目录，只在它正好是要发布的提交时复用，否则报错。

配置文件放在仓库外，由 `EVOLOOP_RELEASE_CONFIG` 指向，JSON 字段：`releaseRoot`、`currentLink`、`stateDir`（均为绝对路径）、`backup.out`、`backup.blobRoot`（可选 `wikiSnapshot`、`integrations`）、`database.name`（必填，可加 `host`、`port`）、`skipTests`、可选 `sourceSubdir`（版本目录里放源码的子目录；默认空，即版本目录本身就是检出的源码。主机上若是 `<版本目录>/source` 加 `runtime`、`artifacts` 等同级目录的布局，就写 `source`：构建、预检、备份、迁移都在这个子目录里运行，钩子从 `EVOLOOP_RELEASE_SOURCE` 读到源码路径，`EVOLOOP_RELEASE_DIR` 仍是版本目录），以及 `hooks`（各为命令参数数组）。执行前把环境变量 `EVOLOOP_DATABASE_URL` 与 `database` 比对，库名、主机或端口不一致即拒绝，任何步骤都不会运行。不跳过测试时还须设 `EVOLOOP_RELEASE_TEST_DATABASE_URL` 指向独立的 `evoloop_*_test` 库，且不能等于线上库。命令运行时可读 `EVOLOOP_RELEASE_ID`、`EVOLOOP_RELEASE_DIR`、`EVOLOOP_RELEASE_SOURCE`、`EVOLOOP_RELEASE_PREVIOUS`（绝对路径）、`EVOLOOP_RELEASE_CURRENT_LINK`。

**带上上一版的工作台分块。** 工作台的页面是按需加载的分块文件，文件名带内容哈希（如 `assets/ArrangementPage-BFkRO_z-.js`），每次发布都会换名。令牌只存在页面内存里，刷新就要重新输入，所以发布前打开的标签页会一直开着；它之后再打开没打开过的页面，会去取旧名字的文件，旧版本不在了就报 `Failed to fetch dynamically imported module`（2026-11-12 线上“统筹安排”即此）。因此 `build` 步骤结束后，发布脚本（`scripts/release/carry-assets.mjs`）把上一版 `apps/workbench/dist/assets/` 里**新版本没有的文件**复制进新版本的同名目录，只补缺、绝不覆盖（同名即同内容哈希，新版本的文件原样保留）；这一步在停服务之前，失败即中止发布，什么都没动。上一版没有该目录（首次发布）时只记一行日志。配置 `carryAssets` 可选：`false` 关闭；`{ "keep": N, "keepDays": D, "assetsDir": "…" }` 调整，默认 `keep` 为 3、`keepDays` 为 7、`assetsDir` 为 `apps/workbench/dist/assets`（相对源码目录，随 `sourceSubdir`）。
**保留策略（缺陷 581441ad：不再只按代数）：** 每次发布算一代，`assets-carry.json`（新版本目录里的 `apps/workbench/dist/assets-carry.json`）记下每一个仍保留的版本的构建时间和它构建出的文件。一个版本在**最近 `keep` 代之内，或构建不到 `keepDays` 天**时都保留，谁保留得更久听谁的；文件只要还有一个保留的版本在用就留着，所以目录仍然不会无限增长。只按代数时，一天发布三次就把前一天打开的标签页挤出去了（11-13 06:15、09:06、12:00 三次发布，11-12 那一代在 09:06 被删，使用者的标签页从此打不开没访问过的页面）。按每天发布 3 次估：7 天约 20 个版本、一个版本约 7.6 MB，目录约 150 MB，代价可以接受；需要更长或更短时调 `keepDays`（`0` 表示只按代数）。上一版的清单是旧格式（只有代数、没有时间）时按尽力读取：它的各代取清单文件的修改时间，最多比应有的多留 `keepDays` 天，不会提前删。
**构建时间是构建自己的。** 一代的 `builtAt` 取这次构建自己生成的文件里最新的修改时间（不晚于当前时间，也不早于上一代已记录的时间），不是复制或写记录的那一刻；这次构建没有自己的文件、或读不到时间时才退回当前时间。

**读回：** 发布日志和发布状态文件的 `acceptance.carriedAssets` 记录这次复制、过期和同名的文件数及字节数，以及 `oldestUsableEntry`（这次发布之后仍能用的最旧入口：它的构建时间和代数，要求该版本构建出的文件现在都在）和保留的版本数；日志一行“oldest entry still usable after this release: <时间>”。
**超出保留的标签页：** 工作台自己有“已经更新到新版本”页（#396），但比 #396 更早打开的标签页没有。协调服务对 `/assets/` 下取不到的 `.js` 文件不再回 404，而是回 200、`Cache-Control: no-store` 的一小段脚本：在页面上显示“工作台已经更新到新版本……请刷新页面”和刷新按钮，并以 `Failed to fetch dynamically imported module` 失败这次导入（新标签页据此显示它们自己的页面）。其他类型的缺失文件和 `/assets/` 之外仍是 404。这一步只补静态文件，不让旧标签页的接口调用与新服务兼容，接口不兼容的改动仍须靠刷新。

**发布之后同步各工作区的技能（Task 1359be38）。** 技能改了要到得了执行者手里：以前靠需求 Session 临时目录里的一个脚本，脚本丢了之后连续 11 次发布都没有同步，9 个受管 Session 工作区里只有 1 个的 `.agents/skills/` 与主干一致。现在发布脚本在 `post-check` 通过之后对私有配置 `skillSync.workspaces`（绝对路径的列表，必须在仓库外，可加 `baseBranch`、`remote`）里的每个工作区核对一次，规则在 `scripts/release/sync-skills.mjs`，结果写进发布记录的 `acceptance.skillSync` 和日志，**不会让发布失败**：

- 逐个文件比 SHA-256，已经和这次发布一致的不动，算“一致”。
- 技能目录有本地改动（含未跟踪文件）→ 不动、绝不丢弃，记“未同步”和原因；有进程以它为工作目录（Run 或消息轮次在用，用 `lsof` 看工作目录；**两边都按真实路径比较**，清单里写成 `/tmp/…` 的符号链接路径也能认出 `lsof` 报的 `/private/tmp/…`；看不到进程列表时按“不能确认没在用”处理）→ 不切换，记“未同步”。
- 闲置且干净：在主干分支上的快进到发布提交；停在游离提交上的做游离检出到发布提交；在业务分支上的，只有该分支已全部并入发布提交（领先 0 个）、整个工作树干净（含未跟踪文件）、没有进程在其中、它的 Session 没有进行中的 Run，才游离检出发布提交，分支保留不删，日志和 `acceptance.skillSync.updated` 写明“从已合并分支 X 切到发布提交”（`fromBranch`）；有未并入的提交、工作树有改动、有进程或进行中的 Run 的，不切换、不移动分支，记“未同步”并写出具体原因，例如“分支 X 已合并，但工作树有改动”，由负责的人去切换。“它的 Session 有没有进行中的 Run”读协调器，不看进程：Codex 运行时是常驻的 app-server，工作目录在发布源码目录而不在任何工作区，Claude 每个 Turn 才起一个进程，Turn 之间工作区里没有进程。私有配置 `skillSync.sessions` 写 `{ "cli": evoloop CLI 的绝对路径, "project": 项目 ID }`，发布时只读调用它的 `list sessions`（各 Session 的工作目录）和 `work board`（各 Session 此刻在做的 Run 或消息轮次），工作目录是这个工作区（按真实路径比，已关闭的 Session 不算）的 Session 有在做的事或状态不是 ready，就写“它的 Session 有进行中的 Run（…）”不切换。没有配置这一项、或读不到、读不全，一律按“不能确认”不动，原因写出来；`lsof` 看到的进程仍是第二道检查。更新之后逐个文件读回比对，仍不一致的记“未同步”。
- 目录不存在、不是 git 工作区、取不到发布提交都记“未同步”并写原因。
- 汇总一行：“技能同步：N 个工作区，X 个一致（其中本次更新 Y 个），Z 个未同步，下次发布再试”。未同步的在下一次发布时再试，不需要另外安排。只管 `.agents/skills/`，不改 Session 进程里已经载入的内容。

**钩子必须做到什么**（都不得回显密钥，失败时以非零退出；每个都要能重复执行而不出错）：

| 钩子 | 必须做到 | 失败时 |
| --- | --- | --- |
| `wait-idle`（必填） | 没有在途或结果未知的 Run 和消息 Turn 时才退出 0；有排空模式时在这里开启并等到空闲 | 尚未停服，什么都没改 |
| `stop`（必填） | 协调服务已停止、其他写者已暂停后才退出 0；**退出前**对外端口已释放、协调服务持有的数据库租约（advisory lock）已释放，可以重试到超时再失败；已经停了再调用也要退出 0。自动恢复和回滚也先调用它，以停掉可能还在跑的新版本 | 服务状态不明，自动恢复旧版本 |
| `repoint-cli`（可选） | 把**每个身份**的 CLI 包装指向 `EVOLOOP_RELEASE_CURRENT_LINK`，退出 0 前逐个调用一次只读命令确认可用 | 自动恢复旧版本 |
| `start`（必填） | 启动 `EVOLOOP_RELEASE_CURRENT_LINK` 指向的版本，**端口开始监听且协调服务拿到租约**后才退出 0；回滚和恢复时用来启动旧版本 | 自动恢复旧版本 |
| `post-check`（必填） | 只读核对，至少覆盖：版本与构建提交、登录、读写路径、数据库租约、**每个身份的 CLI 都能连上新版本**、**页面静态资源与构建产物一致**（例如逐个比对哈希）；通过才退出 0 | 自动恢复旧版本 |
| `post-migrate`（可选） | 迁移之后、切换之前（服务仍停着）运行的项目专项核对，例如 069 迁移的修订链查询与 `VACUUM`；约定先写在这里，由私有钩子实现 | 视为迁移步骤失败，自动恢复旧版本 |
| `data-counts`（可选） | 向标准输出打印稳定的数据计数文本（相同数据输出相同文本）；**在服务停止期间**取：停服完成后一次，迁移完成后一次，两次文本相同记为 `countsEqual`。服务运行时取的计数会混入正常写入，不能用 | 只记录，不触发任何恢复或回滚 |

**失败分流。** 停服之前（准备、构建、测试、预检、等空闲）失败不改任何东西，修好后用 `--from` 续跑。停服及之后失败，脚本先停掉可能还在运行的新版本，再把链接指回旧版本、重指 CLI、启动旧版本并执行发布后检查，结果写入 `recovery`（`restored` 或 `failed`；停不掉新版本时不会去启动旧版本，直接记 `failed`）。恢复成功后，`wait-idle`、停服及其后的步骤在记录里标为 `undone`：系统已经回到旧版本，这些步骤不再成立，**只能从 `--from wait-idle` 重新开始**（会重新备份，备份目录每次尝试不同，形如 `ID-1`、`ID-2`），从 `migrate` 等中间步骤续跑会被拒绝。恢复失败时服务可能没有运行：先人工恢复，再加 `--acknowledge-manual-recovery --from wait-idle`。迁移步骤及之后的失败还会记 `dataMayBeChanged`：数据库可能已迁移，核对后才能信任旧版本。成功续跑后清掉 `failedAt`、`recovery`，历史留在 `failures`。

**发布记录**写在状态目录的 `release-ID.json`：每步起止与结果（含 `undone`）、`previous`（绝对路径）、`releaseDir`、`commit`（发布提交、远端主分支提交、是否在远端主分支上、是否正好等于它）、`backup`（目录、尝试序号、清单哈希、文件数）、`acceptance.stopCompletedAt`、`downtimeSeconds`、`postCheck`、`postMigrateCheck`、`migrationsBefore`/`migrationsAfter`/`migrationsApplied`（本次实际应用的迁移）、`countsBefore`、`countsAfter`、`countsEqual`（取不到时是 `countsBeforeError`/`countsAfterError`）、`dataMayBeChanged`、`recovery`、`failures`，回滚另记 `rollbacks`。它对应验收方案的停服时间、数据计数一致、发布后检查和回滚演练。**回滚**先核对：当前链接必须指向本次发布（已回滚或被后一次发布替换的拒绝）、上一版本目录必须还在，然后才停服；它只切回代码，不撤销已写入新 schema 的数据，也不改记录里的步骤。回滚演练须在非线上环境或经发布负责人同意后单独执行并保留记录。发布步骤和边界见[发布新版本](../architecture/deployment.md#2-发布新版本)。

## 验证边界

```bash
npm run build
npm run typecheck
npm test
npm run docs:check
npm run docs:build
git diff --check
```

**开发和测试只用独立的 PostgreSQL 实例，不连线上实例**：怎样确认、怎样自己起一个、仓库里的保护和维护者隔离步骤见[开发与测试用哪个数据库](database-isolation.md)；测试库名对但服务器上还有 `evoloop` 等非 `evoloop_*` 库时，测试和 `test:integration` 会直接拒绝。持久化检查用独立 PostgreSQL 18 测试库；例如 `TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/evoloop_local_test' npm run test:integration`。入口从该连接串取得主机和端口，为固定库名测试创建缺失的专用 `evoloop_*_test` 库；同一个库的文件逐个运行，不同库分组并行（默认最多 4 组，`EVOLOOP_INTEGRATION_CONCURRENCY=1` 恢复全部串行）；两个文件最多的大组按每库最多 4 个文件拆成 `evoloop_*_shard_X_test` 额外库并行（`EVOLOOP_INTEGRATION_SHARD_SIZE` 调整，设很大即不拆；本次运行新建的分库在全部通过后自动删除，失败时保留以便检查，`EVOLOOP_INTEGRATION_KEEP_SHARDS=1` 保留以加快重跑）；CI 的单元与集成测试是并行任务，必需检查名仍是汇总任务 `app`；`npm run metrics:ci -- --limit 20 --event pull_request --success-only` 只读取 GitHub Actions 的步骤耗时、排队与重跑（自动翻页：`--before` 之后即使有 100 次以上更新的运行也会继续翻到够数；`--before`/`--after` 窗口里取不满 `--limit` 一律报错，不返回短样本；失败率按同窗口全部已完成运行计算），用于前后对比；测试库不会自动删除，因此执行账号需要 `CREATEDB` 或预先建库。测试有故障注入，绝不能指向正在用的开发库。备份还应在新空库和外部目录做隔离恢复演练。测试入口以 `package.json` 与 CI 工作流为准；最近验收的提交、数量和范围见[当前基线](../roadmap.md#当前基线)。旧轮次的固定结果见相应 PR/实测报告，不作为当前最低通过数量。构建、合成测试和隔离备份不等于生产 OpenViking、飞书双向协作或真人亲用已经验收；当前边界见[阶段路线](../roadmap.md)，S1a 历史证据见[首片实测](../research/design-review-20261020.md)。

### 脚本测试要接进 CI 会执行的那组

`scripts/` 下的每个 `*.test.mjs` 都由 `npm run test:unit` 自动发现并运行：命令里先 `files=$(node scripts/lib/script-tests.mjs)` 再把 `$files` 交给 `node --test`，发现脚本递归找出 `scripts/**` 下的测试文件，**新增脚本测试只需把文件放进 `scripts/` 的任何子目录，不要改 `package.json`**。以前是在 `test:unit` 的同一行里逐个列文件，两个 PR 各加一个测试就在这一行冲突，每次都要作者变基、验收者再核“只有变基”。不要把文件重新逐个列回那一行（`ci-test-coverage` 会检查）。

**发现失败会让 `test:unit` 失败。** 发现脚本在找不到任何测试、输出不是 `scripts/…test.mjs` 路径、有重复项或崩溃时，先不输出任何东西并以非零退出；命令里的 `files=$(…) && [ -n "$files" ] &&` 让整条命令随之停止（发现脚本被改坏而“退出 0 却什么也不输出”时，`[ -n "$files" ]` 也会拦住），而不是少跑脚本测试还显示通过。

**排除与分组。** 发现脚本只跳过另有归属的目录：`scripts/docs`、`scripts/architecture-map`（它们的 `.js` 套件属 `test:docs`）和 `scripts/research`（研究代码）。但**覆盖检查的全集不套用这份跳过表**，只排除 `node_modules`：在这些目录里放一个 `.test.mjs`，既没有 `test:unit` 发现它，`test:docs` 也只匹配 `*.test.js`，覆盖检查会失败——把它移出这些目录、改成 `.test.js` 让 `test:docs` 跑，或登记到 `MANUAL_ONLY` 并写明理由。确实无法在 CI 运行的测试登记在 `scripts/lib/script-tests.mjs` 的 `MANUAL_ONLY` 里，这是唯一的排除办法，发现脚本据此跳过（目前只有 `scripts/backup.test.mjs`：它需要专用的 `evoloop_backup_test` 库和 PostgreSQL 18 客户端工具，CI 里没有，按本页的备份章节手动运行）。`scripts/ci-test-coverage.test.mjs` 沿工作流里的 `npm run` 逐层展开，找出没人运行、也不在 `MANUAL_ONLY` 里的测试并失败；`MANUAL_ONLY` 里的条目失效（文件不在了，或 CI 开始运行它）时也失败，免得清单悄悄过期。

### 浏览器测试要接进 CI 的 `browser` 作业

**新增一个会在 CI 里跑的浏览器测试，只需新增文件 `apps/workbench/test/<名字>-ci-browser.test.ts`（子目录也可），不要改 `package.json`。** `npm run test:browser` 先用 `files=$(node scripts/lib/browser-tests.mjs)` 找出文件再交给 `node --test`，命令本身不再列文件。以前所有文件逐个列在 `test:browser` 的同一行里，#469 与 #470 各加一个测试就在这一行冲突，#470 因此做了两次纯冲突返工。

- **命名规则就是入口。** 以 `-ci-browser.test.ts` 结尾的文件进 CI；其余 `*-browser.test.ts` 仍只在本机运行，和以前一样。
- **冻结的旧名单。** `scripts/lib/browser-tests.mjs` 里的 `LEGACY` 只收迁移前就在 CI 跑、但名字不以 `-ci-browser` 结尾的 6 个文件（button-colors、flow-view、runtime-fault-display、session-live-shape、task-used-waits、theme-switch），**不要往里加**，新测试按命名规则取名。名单里的文件不存在时，发现会报错退出。
- **发现失败会让 `test:browser` 失败。** 找不到任何测试、输出不是 `apps/workbench/test/…-browser.test.ts` 路径、有重复或崩溃时，发现脚本先不输出任何东西并以非零退出，命令里的 `files=$(…) && [ -n "$files" ] &&` 随之停止，而不是少跑浏览器测试还显示通过。`scripts/lib/browser-tests.test.mjs` 固定了迁移前的 10 个文件必须仍被收集，并检查新增文件无需改任何清单即被发现。
- 本机运行与环境变量见[开发规范](standards.md)里 hook 检查一节（先 `npm run build`，再设 `EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE`）。

### 集成测试与 PostgreSQL 锁表

**现象。** CI 的 `app` 检查偶尔报 `out of shared memory`，提示调大 `max_locks_per_transaction`（#347 一次，#339 一次；#347 重跑通过，#339 的失败当时有 4 个文件同时挂）。

**根因（实测）。** PostgreSQL 在事务结束前一直持有它拿到的每一个锁，所有连接共用一张大小为 `max_locks_per_transaction × (max_connections + max_prepared_transactions)` 的锁表，默认 64×100=6400。集成测试每个文件在自己的库里建一个测试 schema、结束时 `DROP SCHEMA … CASCADE`，几个文件同时进行（默认并发 4）时锁都落在这同一张表里。用 `pg_locks` 按 5–20 毫秒采样，在 `postgres:18.6` 默认配置上：

| 操作 | 持有的锁行数 | 说明 |
| --- | --- | --- |
| 迁移一个测试 schema（单事务，71 个迁移） | 约 2.2k | 各自独立库并发 N 个：N=4 峰值 8.7k，N=8 峰值 17.3k 仍成功，N=12 峰值 21.8k 起报错 |
| `DROP SCHEMA … CASCADE`（已迁移的测试 schema） | 约 4.7k | 713 个关系锁加约 3.96k 个依赖对象锁 |
| 整套集成测试，默认并发 4 | 峰值 10–14k | 峰值时同时有 2–3 个连接各持有约 4.7k（都在删 schema） |

名义容量 6400 实际能承载约 17.3k–21.8k 行（共享内存有余量，下限按名义容量的 2.7 倍估计）。默认并发 4 时同时删 4 个 schema 就要约 19k，再叠一个迁移或一个同时持有多个 schema 的文件就越过上限，所以只是偶发。#347 的失败日志里三个连接在同一毫秒因 `CREATE TABLE`（迁移）报错，时间点与这一机制一致；失败那一刻各连接的锁数没有被记录，不能事后还原，这一点没有证实。

**可复现实验。** 同一提交、同一镜像 `postgres:18.6`，只改锁表大小（本机 colima，`scripts/test-integration.mjs`）：

| 服务器 | 并发 | 结果 |
| --- | --- | --- |
| `max_locks_per_transaction=24`（名义 2400） | 自动限流 | 并发 1 仍有 22 个文件失败、41 次 `out of shared memory`：单个文件自己的迁移加删 schema 就超了，这个值太小不能用 |
| `max_locks_per_transaction=40`（名义 4000） | 强制 4 | 16 个文件失败、17 次 `out of shared memory`，随后有测试进程挂住不结束 |
| `max_locks_per_transaction=40`（名义 4000） | 自动限流到 1 | 前 50 个文件 0 次 `out of shared memory`（未等整套跑完） |
| `max_locks_per_transaction=256`（名义 25600），CI 使用的配置 | 4 | 97–99 个文件通过，0 次，墙钟 96–99 秒，锁峰值 13.7k，客户端连接峰值 13 |

本机另有 2–4 个文件（如 `session-conversation-queue`）在这个 colima 容器里失败，错误是触发器的状态检查，与锁无关，同一提交在 GitHub CI 上通过；原因没有查清，不影响上面的结论。

**处理。**
- **隔离（运行器）。** `scripts/test-integration.mjs` 启动时读取服务器的 `max_locks_per_transaction`、`max_connections`、`max_prepared_transactions`，在没有显式设置 `EVOLOOP_INTEGRATION_CONCURRENCY` 时，把并发限制为 `⌊2.7 × 名义容量 ÷ 7050⌋`（每个并发文件按一次删 schema 的 4.7k 行再留 1.5 倍余量，至少 1）；默认配置的服务器得到 2，并打印原因。公式与常数在 `scripts/lib/lock-budget.mjs`，有单元测试。
- **取值（CI）。** `.github/actions/test-postgres` 用 `max_locks_per_transaction=256`、连接数保持默认 100：名义容量 25600，公式允许并发 9，按实测上限约为并发 4 同时删 schema 所需 19k 的 4 倍；多占共享内存约 10 MB（`pg_shmem_allocations` 对比 64→256：149.8→160.1 MB），客户端连接峰值只有 13，无需调大连接数。不是只调大：服务器参数被改小或换了服务器，运行器仍按容量限流，不会再随机失败。
- **JIT（CI）。** 测试容器另设 `-c jit=off`：官方镜像带 JIT，正式库（Homebrew PostgreSQL）没有。表有了统计信息（CI 里是 autoanalyze 恰好跑过）后，`work-index.test.ts` 的“5000-row ceiling”那个测试每条查询的代价越过 `jit_above_cost`，每次都付 JIT 编译：在 CI 同款镜像上本机实测，批量插入后 `ANALYZE`、JIT 开 159 s（每页约 3 s），同样条件 `jit=off` 11 s，原样 10 s；CI 日志里两次 323–327 s 的运行正是四张表都已 autoanalyze 的那两次（12 次里 2 次）。JIT 对这些小查询没有收益。
- **挂住。** 内存不足后曾有测试进程不再结束，会拖到整个作业超时。运行器给每个文件设单文件超时（`EVOLOOP_INTEGRATION_FILE_TIMEOUT_SECONDS`，默认 600 秒，最大的文件约 60 秒），超时即杀掉并计为失败；两个测试作业另设 `timeout-minutes`。
- **范围外。** 没有改 90 个测试文件的清理方式（例如按库删除代替删 schema）：能把每个文件的占用降到接近零，但要逐个动夹具，留作建议。

### 候选验收里的假执行服务

自建的候选实例没有真实的执行服务时，涉及消息派发、Session 或原生回合的验收条件，可以用仓库测试里的假执行服务走通，不用模型、不花额度。它证明的是“消息被保存、被派发、进了原生回合并有回复”这条路径；模型的行为和真实提供方的故障不在它的范围里。

- **夹具。** `packages/adapter-claude-agent-sdk/test/fake-claude.mjs` 是假的 Claude Code 命令行，按固定版本 SDK 的控制协议应答，不调用任何模型接口。`packages/adapter-codex-app-server/test/fixture.mjs` 是假的 Codex App Server，同目录还有 `direct-input-fixture.mjs` 和 `native-input-fixture.mjs`。两个夹具都不用改代码。
- **私有配置要填的键**（以 Claude 一侧为例；值写在仓库外的私有集成配置里）：
  - `runtime.provider` 写 `claude`；`runtime.claude.executable` 指向检出目录里的 `fake-claude.mjs`；`runtime.claude.configRoot` 用一个私有目录。
  - `runtime.grants` 里的模型写夹具报告的 `claude-fake-1`。
  - `runtime.materialCli` 和 `residentQueue.roleActors`：把 Role 绑到一个业务身份。
  - `sessionMessages.grants`：发送者到新 Session 的消息授权。
- **Role。** 用 `tests/integration/role-fixture.test.ts` 里的 `seedFixtureRole` 种入。
- **建 Session。** 用 `session prepare`：第一次返回 `waiting_for_native_thread`，再读一次为 `ready`，原生线程已绑定、`missing` 为空。
- **走通一条消息。** 用 `work send` 发一条普通消息，保存后是 `queued`；调度程序处理后读回 `replied`，`processing.state` 为 `completed`，`responseKind` 为 `native`。适配器账本里这一回合的输入以发送者那一行开头，后面是 Role 的固定修订和消息正文。
- **反例。** 把这条消息授权关掉再发，返回 `MESSAGE_GRANT_MISSING`，消息不保存。

实例用自己的 PostgreSQL 和自己的 coordinator，不连 Hub、不连线上库（见[开发与测试用哪个数据库](database-isolation.md)）；核完后停掉进程并删除数据、私有配置和令牌。这条路径在 PR #463 的合并前验收（Task `354dc1d7`）里实际走通过。

### 磁盘回收与测试实例约定

常驻主机的磁盘曾只剩 4.4 GB：工作区里 46 个工作树各带一份约 758 MB 的依赖，约 20 个测试用 PostgreSQL 实例（每个约 1.4 GB）没人停。手工清理不会自己重复，所以由脚本回收，并在例行报告里报告剩余空间。

**怎样用。** 私有路径放在仓库外的配置里，由 `EVOLOOP_DISK_CONFIG` 指向，JSON 字段：`repos`（各克隆的绝对路径，用来列出它们的工作树）、`workspaceRoots`（只在其下回收）、`protectedPaths`（正式数据库目录、发布目录等，**永不触碰**）、可选 `protectedPorts`、`testPgRoots`（测试实例所在的根目录）、`legacyPgNames`（旧实例的目录名正则）、`minFreeGB`（默认 20）、`pgMinAgeMinutes`（默认 30）、`pgIdleMinutes`（默认 120）、`baseBranch`、`remote`、`repo`。

- `npm run disk:reclaim -- report`：预演，不删任何东西；输出剩余空间、工作树数量与总大小、运行中的测试实例数、将回收和跳过的清单（每项写明原因）；`--json` 给机器读。
- `npm run disk:reclaim -- run --execute`：真正回收；`--branch NAME` 只处理一个分支的工作树，以及归属标记指向它的测试实例，或标记里的工作树已不存在、分支等于 NAME 的测试实例（不碰别的实例；顺序是：第一次运行时实例因有客户端连接被跳过、工作树已回收，客户端离开后再带 `--branch NAME` 运行就能回收这个实例，不必等下一次不带 `--branch` 的例行运行），用于刚合并完一个 PR 之后（合并者或作者的收尾步骤）。
- 剩余空间低于 `minFreeGB` 时，报告第一行是“⚠ 剩余空间 … 需要 Leader 处理”，退出码为 3，调度器能看到；回收之后仍不够属于 Leader 的事项（加盘、清理其他项目的缓存），不在本脚本范围内。
- 谁来触发：CI/CD 每 12 小时的例行任务运行 `run --execute` 并把 `report` 的输出写进报告开头；这与作者 Session 是否还在无关。也可以由主机上的定时器运行同一条命令（macOS 的 launchd 或 cron，安装属于全局设置，需要使用者授权，仓库不替人安装）。

**回收的安全条件**（都是脚本里的检查，缺一不回收，原因写进报告）：
- 工作树：只回收 git 的链接工作树，主克隆本体永不回收；它的分支对应的 PR 已**合并**（还开着、已关闭未合并、没有 PR、查询失败都跳过）；没有未提交内容（已修改、已暂存、未跟踪的文件都算）；没有未进入远端主分支或 PR 头的提交；没有进程以它为工作目录（Session 或 Run 在里面工作就会在 `lsof` 里出现；列不出进程时全部跳过）；在 `workspaceRoots` 之内且不在 `protectedPaths` 之内；没有被锁定。**不按“多久没改动”判断。** 回收用 `git worktree remove`（不加 `--force`），分支和提交都还在。
- 测试实例：只处理 `testPgRoots` 之下、且能确认是测试实例的：带 `test-pg.mjs` 写的归属标记，或目录名匹配 `legacyPgNames`；其他项目的数据库即使在同一目录下也不碰。受保护的路径和端口永不触碰；没有客户端连接（从进程表数 postmaster 的客户端子进程，不登录；数不出来按有连接处理）；数据目录最近 `pgIdleMinutes` 分钟没有写入（零连接可能只是两次跑测试之间）；不是刚启动；停止前再复查一次连接；带标记的实例，其工作树还在使用时保留，工作树已不在或本次一并回收时才回收。停止用 `pg_ctl stop -m fast`，再删除实例目录。

**依赖目录回收（node_modules，可重装；源码、未跟踪文件、分支和提交都不碰）。** 2026-11-15 可用空间跌到 4.2 GB，大头在整棵删条件覆盖不到的地方，所以另有三类，各自的检查都在脚本里，报告分类列出回收量和跳过清单：
- `/tmp 验收临时副本`：`tmpCopyRoots`（如 `/private/tmp`）之下、目录名匹配 `tmpCopyNames` 的目录（验收 Session 的临时克隆和实例）；
- `已合并 PR 的工作树依赖`：链接工作树里 PR 已合并、但因有未提交/未跟踪内容或未推送提交而过不了整棵删条件的，只删它的 `node_modules`，工作树本身和未跟踪文件留着；PR 还开着、已关闭未合并、没有 PR、查询失败都跳过；
- `旧发布依赖`：`releaseRoot` 之下名字匹配 `releaseNames`（默认 `<名字>-main-<7 位提交>-<yyyymmdd>`）的发布目录；**当前发布**（`current` 指向）与**上一个完整发布**（除当前外最新、且部署过的：有 `source/` 和 `runtime/`；只构建过或中断的构建不算——这条规则最初只看 `source/`，2026-11-15 实跑时误把一个没部署过的较新构建当作上一个发布，真正的上一个发布 b285313 的依赖被删，已用当前发布的同锁文件依赖克隆恢复）保留，比当前发布还新的目录（可能是正在准备的下一个发布）不动；受保护路径（正式库目录、隧道配置目录，**必须写进 `protectedPaths`**，名字也符合发布目录命名）永不触碰。
三类共同的条件：路径不在 `protectedPaths` 内；没有进程以它为工作目录（列不出进程时全部跳过）；`depsIdleMinutes`（默认 120）分钟内没有文件改动（`find -mmin`，忽略 `node_modules` 与 `.git`；查不出按有改动处理）。删除只作用于名为 `node_modules` 的目录，别的名字会被拒绝。报告里还有执行前后的可用空间（`statfs`）和脚本回收合计：二者可以不同（`du` 是占用大小，回收后文件系统还有别的变化），以主机 `df -k` 复核。新增配置字段都是可选的：`tmpCopyRoots`、`tmpCopyNames`、`releaseRoot`、`releaseNames`、`depsIdleMinutes`。

**内置保护，不依赖配置。** 一个目录里有 `bootstrap-receipt.json`、`launchd-receipt.json`、`tunnel-receipt.json` 或 `postgres/PG_VERSION` 就是正式实例目录，有 `runtime/cloudflared.*` 就是隧道配置目录：这两类永不回收，也不会被当成“上一个发布”；`protectedPaths` 是在此之外的补充。配置里没有 `releaseRoot` 时旧发布这一类根本不运行。

**不依赖例行 Task 的巡检与告警（`npm run ops:patrol`）。** 例行日程（每 12 小时）在上一轮的 Task 没结束时会按 `overlap: skip` 跳过，2026-11-13 20:00 到 11-15 08:00（+05）连跳 4 次，磁盘回收、报告和低空间告警一起停了两天。`scripts/ops/ops-patrol.mjs` 把这几件事从那个 Task 里拿出来：运行 `disk-reclaim`（加 `--execute` 才真正回收）、读被监视日程最近的时刻、发现被跳过的时刻或可用空间低于 `minFreeGB` 时用 `work send` 把计数、编号和时间发给 Leader Session（不含路径和命令）。同一个被跳过的时刻只告知一次，低空间在 `alertIntervalMinutes`（默认 360）内不重复；告警那一行按实际状态写（仍低于阈值就写“空间仍低于阈值”，不会写“空间正常”）；告警没送出、日程读不出来都使退出码为 1（调度器看得见），低空间为 3。私有配置里加 `patrol` 对象：`cli`（智能体 CLI 的绝对路径）、`projectId`、`leaderSessionKey`、`watchSchedules`（日程 ID 列表）、`stateFile`（仓库外的绝对路径，记录已告知的内容）、可选 `skipLookbackHours`（默认 48）、`messagePrefix`（放在消息前面的文字，例如标明这是测试）。**谁来触发它**要选一个不会被例行 Task 卡住的方式：主机定时器（launchd/cron；安装是全局设置，需要使用者授权，仓库不替人安装），或一个单独的日程（它自己的 overlap 只看自己上一个 Task；Task 内容就是运行这条命令并贴出输出，交付即关闭；创建日程需要日程授权者）。

**测试实例的约定**（`scripts/ops/test-pg.mjs`，现有位置有四种、名字对不上工作树，回收只能靠猜）：
- 位置：`EVOLOOP_TEST_PG_ROOT/<名字>/`（私有的绝对路径，不在仓库内），一个实例一个目录，数据在 `data/`。
- 名字：工作树目录的名字（小写字母、数字、`-`、`_`），数据库名 `evoloop_<名字，- 换成 _>_test`，符合集成测试的保护检查。
- 归属标记：`<目录>/.evoloop-test-pg.json`，记录名字、工作树路径、分支、端口；回收脚本据此把实例和工作树对上。分支取启动时工作树检出的分支（也可 `--branch` 指定；游离 HEAD 记为空）。**这次改动之前启动的实例，标记里没有分支**，工作树回收后不能靠 `--branch` 找到，要等不带 `--branch` 的例行运行回收。
- 启动 `node scripts/ops/test-pg.mjs start`（在工作树里运行，输出 `TEST_DATABASE_URL`），停用 `stop`，列出 `list`；需要 `EVOLOOP_PG_BIN_DIR`。用完请 `stop`，忘了也会在工作树被回收时一并回收。

**新工作树不再各带一份依赖。** 用 `node scripts/ops/new-worktree.mjs --path 绝对路径 --branch 名字 --seed 装好依赖的克隆`（`--seed` 默认读 `EVOLOOP_DEPS_SEED`）：seed 的 `package-lock.json` 与新工作树一致时，把它的 `node_modules` 用 APFS 写时复制克隆过来（`cp -c`，共享磁盘块，文件被改时才各占各的），否则回退 `npm ci`；不在 macOS 上、克隆失败也回退。本机实测（APFS）：普通复制 `node_modules` 约占用 960 MB，克隆约 40 MB；克隆出的工作树 `npm run build:packages` 与测试可正常运行。依赖在工作树里被 `npm install` 改过之后，被改的文件才会额外占用空间。在工作树里构建或预览工作台之前，先在这个工作树里 `npm run build:packages`；依赖用上面的脚本克隆，不要用符号链接共用 `node_modules`（包链接会指回共享检出，vite 报 `MISSING_EXPORT`）。

### 每日边界核对

谁能做什么只写在 Role 的文字里；11-12 一天里，一个 Session 用另一个 Session 的私有合并配置合并了 13 个 PR，改了正式私有配置，另一个 Session 以使用者身份发了输入，都是事后从原始记录里查出来的。`npm run boundary:check` 每天（随 CI/CD 的 12 小时例行任务）把这些在当天读出来，**只读，不拦截、不改任何配置**，输出写进例行报告：

- **命令**：`EVOLOOP_BOUNDARY_CONFIG=<私有配置> node scripts/ops/boundary-check.mjs --day YYYY-MM-DD`（或 `--from ISO --to ISO`；`--flagged-only` 只列要看的行，`--json` 给机器读）。配置在仓库外、绝对路径，字段：`repo`、`utcOffsetMinutes`（本地时区偏移，如塔什干 300）、`databaseUrl`（只读事务打开，不写）、`humanActors`（使用者的身份名）、`identityFiles`（存放身份令牌的文件路径片段）、`mergeTrainLogs.dir`、`transcriptRoots`（Codex 与 Claude 会话记录目录）、`privateFiles[].globs`（正式运行目录里的私有文件，含备份）。私有路径和数据库地址只在这份配置里，不进仓库，也不进输出。
- **四张表**：①窗口内合并的 PR 与实际发起者：GitHub 的合并者永远是同一个账号，所以看合并列车日志里有没有、会话记录里谁运行了 `merge-gate.mjs merge … --execute`（含 `for` 循环和一行多条）、`gh pr merge`，并把该会话平时用的身份（它的命令里最常出现的 `agent-cli/<身份>/`）和合并配置所属身份对照；不同则写“借用他人合并配置”，两处都没有则写“发起者无记录”。②私有文件的修改时间、备份、是否仍能解析、键名与条目数变化（只写名字和数量，不写值），以及改动前后 5 分钟内命令里提到该文件的会话。③`humanActors` 名下的写入（直接输入、`operation_journal`、会话消息）；库里没有“是否出自工作台”这一项，所以只给能核对的证据：写入前后 10 分钟内有哪个会话的命令引用了身份文件，没有就写“来源未证实”，不猜。④窗口内的关闭记录和依据观察：依据里提到“候选”且没有“正式……读回/已验证”字样的列出，并写任务声明的阶段。
- **只写会话编号、时间和条数**，不写命令原文、文件内容或令牌值。会话记录是本机文件，脚本只在本机读。
- **不会给出假的“全部正常”**：下面这些都**列出来或写“核对不完整”**，不会归到“本人发起”：认不出发起会话的身份或合并配置所属身份的合并（含用环境变量 `EVOLOOP_MERGE_CONFIG` 传配置；同一会话用过多个 CLI 身份时不按用得最多的认定，写出各身份次数）、没有经过合并门的合并（`gh pr merge`、`gh api …/merge`，写明方式和发起会话）、合并列车日志与会话记录冲突的合并、没有任何记录的合并、合并命令晚于 GitHub 合并时间或已失败（或结果记录缺失）而不能证明是它合并的 PR、GitHub 没给合并时间的 PR；会话记录里读不了的行（坏 JSON，或真正的调用记录——Claude 的 `assistant`、Codex 的 `function_call`——缺时间戳；Claude 的 `api-request-blob` 之类按设计不带时间戳的镜像记录不算，同一次调用在相邻的 `assistant` 行里有时间）按文件和行号计数，读不了的单个文件（会话记录、合并列车日志、私有文件）只隔离那一个并写出名字，任何一种都使报告第一行写“核对不完整”、退出码非零；报告首部写明所依据的判定约定修订号（边界核对判定约定 7c58f1f4 修订 2）；没有交付可核依据的关闭；依据里是正向判定：只认“正式环境/实例/数据库/版本被读回且成功”、并且同一句里带时间、版本/提交、PR/Run 编号或命令这类完成证据的；条件、地点、截止时间、下一步这类措辞**按整句检查**（同一句里别的子句出现也不算读回），完成证据必须在读回所在子句里、紧跟读回之后（括号里的“时间，提交号”算同一子句），并且证据要**验证**，不靠词表判断真假：提交号必须能在本仓库解析到（`deadbeef` 这类解析不到的十六进制词不算）、Run/交付/观察编号必须在库里存在、时间必须不晚于依据观察的写入时间（任何晚于观察的时间都是计划、排期或 ETA，整个证据作废；没有年份的时间按观察所在年份、UTC 读）；单独的 PR 编号、只有日期、命令、版本号都不算；证据短语里出现 之前/之后/以前/以后/计划/截止/下一步/待/预计/将/会 这类截点或将来措辞也作废（“已进行”“已完成”除外）；没法验证时（没有观察时间、解析不了）一律列出。**读回后紧邻的证据短语是一张白名单**：括号里（没有括号时是同一子句里读回之后的部分）只能有实际时间、提交号、带标签的 Run/交付/观察/操作/会话编号、分隔符，以及“已/已经/已完成/已进行”；多出任何别的词（planned、pending、TBD、稍后、届时、明天、等…合入、发版后、回头…再看、will run、命令、PR 编号、版本号、环境说明）都是“其他内容”，整句列出，哪怕时间在过去、提交号能解析。英文计划词（ETA、scheduled、pending、planned、TBD、will）按整词匹配，BETA 不是 ETA。**计划语义优先于时间和提交号**：句子里出现 预定、排期、定于、scheduled、ETA、再做、还没、等…合并/发布/部署、拟、目标、下一步 等，即使提交号能解析、时间在观察之前也列出；“发布后/合并后/部署后/上线后”同理，除非同一句明说“已读回/已验证/已通过”；没有证据的空话、条件（只要…就、要是…就、如果…则）、先后（读回通过后签）、希望/目标/期望/计划一律列出。读回的具体写法是（“正式”要直接限定环境，“非正式”“正式包”不算；读回通过/成功/一致、已验证、实测通过；同一分句里出现自建、候选、本地、沙箱、演练等处所的不算；“读回通过后再签”“需…才能关闭”“如果…则关闭”“预计/预期/计划/拟/将”这类条件和计划措辞也不算），“正式发布成功”“已通过评审”“发布前候选已通过”“读回另行安排”“读回失败/等正式读回/TODO/缺/未/待”都不算读回；`transcriptRoots` 指向存在但没有任何会话记录的目录、或窗口内有使用者身份的写入却没有任何会话命令可核对来源，同样写“核对不完整”；任何来源没有配置（`transcriptRoots`、`privateFiles`、`identityFiles`、`mergeTrainLogs.dir`、`databaseUrl`）或读不到、GitHub 合并列表达到上限，报告第一行写“⚠ 核对不完整”，命令以非零退出码（2）结束。声明了“阶段：候选”的任务按候选关闭不列。
- **局限**：判断“借用”靠会话记录里被执行的命令（heredoc 里写的、grep/echo 里引用的不算；Codex 数组形式 `["bash","-lc","…"]` 取其中的脚本；`for` 循环、一行多条、`gh pr merge` 的任意参数顺序、同一条命令里的 `NAME=…merge-gate.mjs` 变量都能读）；写进脚本文件里的循环、别名、变量定义在别的命令里的会漏，漏掉的显示为“发起者无记录”。表③看会话的所有工具调用参数（含 Read/Edit 的 `file_path`、数组形式的命令），范围是整个窗口，并写出最近一次与写入相差几分钟——距离远的证据弱，由人判断。表②只看最后修改时间（写入后把时间改回去或复制保留时间的看不到），按完整文件名匹配会话。表④靠文字匹配，不是结构化的阶段字段；一句话里同时有“正式”和成功字样、而该句带否定、失败、待办的，不算正式读回。

## 原生文字与选项提问

现代固定协议的 `runtime.nativeUserInput` 默认 `false`。仅在独立运行环境验证后，配置为 `true` 可让本 coordinator 拥有的 App Server 子进程以 `-c features.default_mode_request_user_input=true` 启动；该开关不写用户全局配置、不将任务切到 Plan，也不改变 full/never 或业务授权。0.154 不支持且启动前拒绝该组合。当前 0.164、0.166 alpha.5.1／alpha.6 与 0.167 alpha.3.2 共用已核协议分支；每次升级仍须重新核 schema 和可达性。

Default 下请求为非阻塞且仅 root Agent 可调用；子 Agent 与通用 MCP／认证／secret 表单不在本片支持范围。回复使用真实认证者的 `session.input.reply`，原连接失效不重播。原生工具实际发起、回复进入同一 Turn、CLI 接线与工作台亲用应分别留证；仅假进程测试通过不能证明当前业务环境可用。持久记录需要迁移 `037_native_user_input`，迁移不从历史 Session 推断问题或答复。

## 原生当前进度投影

迁移 `038_native_observation` 新建独立当前投影，每个 Session 一行；不回填推测的历史进度或用量，不改 Task、Run 和既有原始事件。原生进度不依赖 `runtime.nativeUserInput` 开关；只接收本服务已登记 Thread 的白名单事件，按现有 runner 周期合并持久化，再由当前 Session snapshot／变化游标读取。重启使旧连接投影过期，缺乏新的事实时不会显示为当前运行。

包含工具、计划与 diff 的有界预览、原生累计 Token 与最近 24 个 Turn 的逐轮读数；不保存 reasoning、完整 delta 或费用猜测。推理内容按需从原生历史读出，不入此投影。观察刷新不进入业务活动历史，最终原件、Run 终态与交付验收继续沿原流程核对。离线真实 Token 样本、隔离 PostgreSQL、浏览器回归和部署后的实际查看分别留证。
