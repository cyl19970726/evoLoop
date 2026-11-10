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
  projectIds: [projectId], permissions: ['read', 'write', 'review']
}], null, 2), { mode: 0o600, flag: 'wx' });
console.log({ projectId });
JS
```

集成默认关闭。以 `0600` 权限创建 `.local/integrations.json`，初始内容如下（`repositories`、`feishu`、`knowledge` 均可暂时省略）：

```json
{
  "scheduling": { "enabled": false, "grants": [] },
  "runtime": { "enabled": false, "grants": [] }
}
```

Leader 结果通知、即时输入、托管压缩、普通 Task 的每日复制和阶段关注各有自己的配置、打开和核对步骤，见[运行接线手册](runtime-operations.md)。

日程 grant 须明确 `projectId`、`actorId`、`scopeId`、`roleId`，与日程当前修订的授权一致；当前身份仍须该项目 `write` 和 `review` 权限。未配置 `template.managedTarget` 时，tick 只创建 `todo` Task 及其固定主正文。新修订可显式绑定已限定同一 active Stage 的既有 `{loopId,stageId}`，同库物化后将经核验的到期来源送给指定 Loop；认知需要工作时复用该 todo，仍按当前 runtime grant、预算与 Task 规则启动，不由 tick 直接运行。旧修订不自动升级为受管工作。停用、失去 coordinator 锁、撤权、过期和异常的状态见 `/api/projects/PROJECT_ID/scheduling/status`。runtime grant 须明确 `projectId`、`actorId`、`roleId`、`authorizationScope` 与绝对路径 `cwd`；每个新 Session 固定 `danger-full-access`、`approvalPolicy: never` 和正常网络。精确授权仍限定 actor、项目、Role、scope 与业务对象，不要把 OS 执行权限理解为项目数据授权。`repositories` 可按项目登记只读 Git 根目录与路径白名单；`feishu` 启用时须给凭据、Bitable 字段映射及逐项目/行为者、显式 `scope: "project"` 的 `grants`，自动轮询另需 `pollEnabled`。用户已将飞书 connector 留待后续，本轮不以实连为完成条件。飞书尚无真实租户验证，不要把 fake HTTP 测试当作实连；当前配置仅支持明确的项目全范围授权，拒绝未落实入站过滤的 owner 范围。身份在启动时读取，修改后重启；HTTP 认证使用启动时的身份快照，重启后才会采用新凭据。集成配置分两种：是否启用运行时、`runtime` 下的执行配置和 `repositories` 的仓库登记等在启动时读取，改后要重启；日程授权、Leader 通知、即时输入和每日复制授权等在使用时重读，见[运行接线手册](runtime-operations.md#共同做法)。普通 Run 封存器会再读当前身份文件，文件修改可能在 HTTP 重启前提前收紧原签署者的新写入资格；已提交 Delivery 的固定回读仍可继续。

如要接外置 Wiki，另加 `knowledge` 配置：`enabled`、回环 HTTP `baseUrl`、仓库外绝对路径 `manifestRoot`、`maintainerId`、`projectIds`。`maintainerId` 必须与实际发布/对账身份的 `actorId` 一致，且该身份具有对应项目的 review 权限；任意标签或另一个未配置的身份不会取得维护权。Wiki 正文和修订由外置后端持有，PostgreSQL 只保存可核对引用；不要把正文、原始 session 或私有运行材料写入 Git。当前 0.5.1 已通过受限真实写读、重启回读和产品候选审核发布；这不证明语义索引、多写者安全或生产恢复。

```bash
chmod 600 "$EVOLOOP_AUTH_FILE" "$EVOLOOP_INTEGRATIONS_FILE"
npm run db:migrate
npm start
```

在浏览器打开服务监听的本机回环地址（端口由 `EVOLOOP_PORT` 设定，未设时用代码里的默认值），用身份文件中的 token 登录。令牌只留在当前页面内存，刷新后需重新登录。更新应用后请刷新已打开的标签页并重新登录；旧标签页仍可能运行旧版本界面，本轮独立消费曾因此失败，刷新后才成功，失败观察仍保留。服务只监听回环地址。迁移不会在启动时自动执行。C5 将 Task 正文归入 Document 并改为四态；既有实例须单独运行迁移并同步服务、CLI 和界面版本，本轮未自动升级其他会话的预览或持久数据。同一数据库只允许一个 coordinator 持有专用连接锁；锁丢失后写入不可用，不是双机自动接管证明。

## 在常驻主机上运行

常驻实例按本页同样的步骤安装、迁移和启动，部署形态见[部署与迁移](../architecture/deployment.md#1-部署形态)。与在开发机上试用相比，有四点不同：

- **只经一个 HTTPS 入口访问。** 工作台和 CLI 都走这个入口（CLI 的 `EVOLOOP_API_URL` 指向它）；协调服务仍只监听本机回环，由入口转发。不为 PostgreSQL、运行时或协调服务另开对外端口。
- **按版本发布。** 每个版本单独构建、单独存放；数据库、Blob、备份以及私有身份与 integrations 文件都放在发布目录之外，切换版本不搬动它们。发布按停写、备份、迁移、启动核对的顺序走，见[发布新版本](../architecture/deployment.md#2-发布新版本)。
- **运行时登录属于主机。** Codex 的登录目录和 Claude 的 `configRoot` 留在主机上；换主机时不搬，在新主机上重新登录，见[迁移之后重新接入](../architecture/deployment.md#5-迁移之后重新接入)。
- **地址不进公开文档。** 主机名、入口域名、目录和端口只记在私有运维记录里。

## 受管自动循环候选

在独立数据库迁移至当前代码要求的最新版本（含 **038**）后使用本切片；不要借启动自动升级其他会话的试用库。原有集成可保持关闭。要实连 worker，另配置 `orchestration`：`enabled`、已具本项目 read/write/review 权限的 `controllerActorId`、仓库外绝对路径 `workerRoot`、`credentialTtlMs`（1 分钟至 24 小时）和 `pollIntervalMs`（0.5 至 60 秒）。每个认知或业务职责须有控制者自己的唯一 runtime profile，含精确 actor、项目、Role、scope、目录和模型字段；新 Session 均按 full/never/联网创建，不再按职责选择 sandbox 或消息专用 profile。同一项目/actor/职责/scope/目录的重复 profile 被拒绝。

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

Codex App Server 的协议版本默认是 `0.166.0-alpha.5.1`。要选其他已核版本，在私有运行配置里显式设置 `runtime.protocolVersion`，并核对实际二进制与生成的标准或实验 schema 指纹；旧私有包的版本约束须由发布者另行更新。各版本可用的能力（托管压缩和运行中补入只在 `0.166.0-alpha.6`）见[Codex 接入](../architecture/codex-integration.md#协议版本与可选能力)，新实例用的是哪个版本见[阶段路线](../roadmap.md#当前基线)。未配置 `codexHome` 时，子进程共用使用者自己的 Codex 登录、provider 与历史，evoLoop 创建的线程会出现在使用者自己的 Codex 历史里；需要隔离时配置专用 `codexHome`。Turn 完成不自动证明技术验收、交付、消费者使用或 Task 关闭。启用前核对实际安装版本、schema、授权目录与隔离真实任务；升级须重新核协议、终态、断线与恢复。HTML/CSS/SVG 阅读中的 Document iframe sandbox 是独立内容隔离，不随 Session OS 权限变化。结果未知时保留原操作并人工核对。

App Server、版本检查与协议探测使用同一份明确的子进程环境白名单，保留本机 Codex 登录目录、基本运行环境和代理/证书配置，不转发协调服务的数据库连接、身份配置路径、API 密钥或 Node 执行注入参数。本片沿用 Codex 的本机 ChatGPT 登录；这项环境筛选不限制读取 HOME 文件，工作目录也不是文件读取白名单。runtime 的 authorizationScope 当前用于精确匹配授权，不应把形似 Task ID 的字符串宣称为单任务执行隔离。

Claude 运行时：新实例的 Dev Role 已在用，有真实 Run，尚未验收（计数见[阶段路线](../roadmap.md#当前基线)）。启用时在 runtime 配置中把 `claude` 列入 `providers`（或设 `provider: "claude"`），并设 `claude: { configRoot, executable?, maxTurns?, maxBudgetUsd?, skillBundle?, contextMode? }`。`configRoot` 是该协调服务专用的绝对路径，作为 `CLAUDE_CONFIG_DIR`，存放 Claude 会话记录、设置、登录与适配器的 Turn 账本，不与 `~/.claude` 共享；因此需要在该目录单独登录，或由协调服务环境提供 `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN` 等凭据，配置文件不接收凭据。它不会自动复用 `~/.claude` 或 Claude 桌面应用的登录：桌面宿主注入给自身进程的会话令牌在子进程中返回 401。可由使用者本人运行 `claude setup-token`，再把结果设为 `CLAUDE_CODE_OAUTH_TOKEN`；也可以设置 `CLAUDE_CONFIG_DIR=<configRoot>` 后运行一次 `claude` 并登录。每个 Turn 启动一个 Claude Code 进程，使用同样的环境白名单，只加载项目级设置并关闭自动记忆；新 Session 按 DEC-033 使用跳过权限确认的完全访问。Turn 结果结算后，进程若因仍在等待某个工具而没有在 5 秒内自行退出，适配器向它的进程组发 SIGTERM（CLI 会自行停止它启动的工具 shell），再过 5 秒仍在则 SIGKILL；这段仅在退出的时间不算 Session 上有正在运行的 Turn，下一个 Turn 会等它退出后再启动。Turn 只按回显本次 prompt uuid 的 result 结算：续接的 Session 若先处理上个 Turn 之后排队的后台任务通知，那条不调用模型、来源为 `task-notification` 的 result 不算本次 Turn。Claude Session 支持普通消息与空闲直启，不支持会话命名、工作区历史和模型修订（对照见[Session 运行时](../architecture/session-runtime.md#7-codex-与-claude-能力对照)）。每个子进程都以 flag 设置 `crossSessionInbound: "refuse"` 启动，并禁用 SendMessage 与 ListAgents，Claude 的原生会话间消息在两个方向都关闭，Session 之间只通过 evoLoop 的授权消息通信。凭据失效时，Claude Code 在默认重试设置下会让 Turn 长时间没有结果，建议在协调服务环境中设置 `CLAUDE_CODE_MAX_RETRIES`（例如 2），适配器会把它传给子进程。除不调用模型的假 CLI 回归外，`scripts/claude-conformance.mjs` 用真实 CLI 2.1.319 对本机模拟 API 验证过参数、隔离、续接、中断、进程丢失和错误分类。真实模型下的费用与限流行为仍待观察。

同一协调服务可以同时驱动 Codex 与 Claude：`runtime.providers` 列出要驱动的运行时，例如 `["codex", "claude"]`；`runtime.provider` 是尚未绑定的 Role 首次预留 Session 时绑定的默认运行时；不写 `providers` 时只驱动 `provider`。Role 只绑定一次运行时，之后只在该运行时内调整：Role 的 skill 随时可改，Session 的模型修订目前只在 Codex 实现，Claude Session 沿用创建时的模型；不能换成另一种运行时。Session 一直按创建时的运行时分发。未列入 `providers` 的运行时，其 Session 保持可读但不被驱动，绑定到它的 Role 也不能新建 Session。原生会话输入与浏览器读取桥只属于 Codex，只驱动 Claude 时不能开启。迁移 067 把既有 Session 记为 `codex`；068 按既有 Session 的运行时为已有 Role 写入首个绑定，优先未关闭的 Session，未关闭 Session 横跨两种运行时的 Role 保持未绑定，等一侧关闭后再绑定。两者须在新服务启动前依序应用。

Role 的 skill 选择决定每个 Turn 放进模型上下文的 skill，用 `role runtime set` 或工作台角色卡片修改，下一个 Turn 生效。evoLoop 业务 skill 按 Role 配置始终加载；项目、个人与运行时内置 skill 按开关加载，`add`、`remove` 按名称单独增减；会修改运行时自身配置的内置 skill（例如安装器）默认不加载。Codex 由线程配置关闭未选的 skill，业务 skill 经 Role 上下文交付；Claude 在 `claude.skillBundle` 为默认的 `true` 时，把选中的 skill 链接成本次 Turn 的本地插件并关闭其余。工作目录仓库把 `.claude/skills` 链接到 `.agents/skills` 时（本仓库即如此），Claude 原生读到的同一份 skill 会按名称关闭，每个 skill 只经插件加载一次。`runtime.roleSkills[].builtinSkills` 已被这项选择取代，旧配置仍可加载但不再生效。选择只决定上下文，不是安全边界。

`role runtime show` 与工作台角色卡片每次读取时都实时取值。Codex 角色在最近一个 Session 的工作目录（没有时用授权目录）询问运行中的 App Server 的 skill、插件与 MCP 列表；Claude 角色按文件列出 skill，再用最近一次 Turn 启动时的报告补上内置 skill、插件与 MCP，尚无 Turn 时注明内置 skill 待首个 Turn 后显示。运行时不可用时退回按文件推断，并在结果中标明来源。Codex 由插件提供的 skill 可能不出现在它的列表中。

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

在保存真实不可重建材料前，先定备份周期、保留和恢复目标。脚本覆盖 **PostgreSQL + evoLoop 外部 Blob + 显式提供的 Wiki 外部快照**，不声称三者有原子快照。先停止 coordinator，并暂停 OpenViking/其他 Wiki 写者；按 Wiki 后端真实存储方式生成包含正文、修订、来源及 evoLoop `manifestRoot` 的完整外部导出。脚本持有与 coordinator 相同的 PostgreSQL advisory lock，拒绝仍在运行的 coordinator，但不能阻止旁路 SQL 或远端 Wiki 写者。`pg_dump` 给数据库自身一致快照；跨存储一致性依赖停写和后续核对。

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

## 验证边界

```bash
npm run build
npm run typecheck
npm test
npm run docs:check
npm run docs:build
git diff --check
```

持久化检查用独立 PostgreSQL 18 测试库；例如 `TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/evoloop_local_test' npm run test:integration`。入口从该连接串取得主机和端口，为固定库名测试创建缺失的专用 `evoloop_*_test` 库；同一个库的文件逐个运行，不同库分组并行（默认最多 4 组，`EVOLOOP_INTEGRATION_CONCURRENCY=1` 恢复全部串行）；测试库不会自动删除，因此执行账号需要 `CREATEDB` 或预先建库。测试有故障注入，绝不能指向正在用的开发库。备份还应在新空库和外部目录做隔离恢复演练。测试入口以 `package.json` 与 CI 工作流为准；最近验收的提交、数量和范围见[当前基线](../roadmap.md#当前基线)。旧轮次的固定结果见相应 PR/实测报告，不作为当前最低通过数量。构建、合成测试和隔离备份不等于生产 OpenViking、飞书双向协作或真人亲用已经验收；当前边界见[阶段路线](../roadmap.md)，S1a 历史证据见[首片实测](../research/design-review-20261020.md)。

## 原生文字与选项提问

现代固定协议的 `runtime.nativeUserInput` 默认 `false`。仅在独立运行环境验证后，配置为 `true` 可让本 coordinator 拥有的 App Server 子进程以 `-c features.default_mode_request_user_input=true` 启动；该开关不写用户全局配置、不将任务切到 Plan，也不改变 full/never 或业务授权。0.154 不支持且启动前拒绝该组合。当前 0.164、0.166 alpha.5.1／alpha.6 与 0.167 alpha.3.2 共用已核协议分支；每次升级仍须重新核 schema 和可达性。

Default 下请求为非阻塞且仅 root Agent 可调用；子 Agent 与通用 MCP／认证／secret 表单不在本片支持范围。回复使用真实认证者的 `session.input.reply`，原连接失效不重播。原生工具实际发起、回复进入同一 Turn、CLI 接线与工作台亲用应分别留证；仅假进程测试通过不能证明当前业务环境可用。持久记录需要迁移 `037_native_user_input`，迁移不从历史 Session 推断问题或答复。

## 原生当前进度投影

迁移 `038_native_observation` 新建独立当前投影，每个 Session 一行；不回填推测的历史进度或用量，不改 Task、Run 和既有原始事件。原生进度不依赖 `runtime.nativeUserInput` 开关；只接收本服务已登记 Thread 的白名单事件，按现有 runner 周期合并持久化，再由当前 Session snapshot／变化游标读取。重启使旧连接投影过期，缺乏新的事实时不会显示为当前运行。

包含工具、计划与 diff 的有界预览和原生累计 Token；不保存 reasoning、完整 delta 或费用猜测。观察刷新不进入业务活动历史，最终原件、Run 终态与交付验收继续沿原流程核对。离线真实 Token 样本、隔离 PostgreSQL、浏览器回归和部署后的实际查看分别留证。
