# 本机运行与恢复

当前是可运行的本机试用切片：11 个工作区，会话正常关闭候选包含 PostgreSQL 迁移 018；旧试用环境的迁移和运行版本须分别核对，不随候选自动升级。目标、阶段、过程 Document、Task、负责人讨论、Role、Schedule、操作回执和运行记录经同一 coordinator API/工作台/CLI 使用。固定 Git 原件、Blob 与 Markdown/静态 HTML/CSS/SVG 阅读、外置 OpenViking 0.5.1 的写读和重启回读已有受限实测；普通工作台完成过知识候选→审阅→发布、来源变化需复核与 Task 显式采用。两次相连 Task 已有交付、独立 Agent 使用观察与阶段回看；后一次消费者下载新旧 HTML、CSS、SVG 的实际哈希均匹配，首次旧客户端失败观察仍保留。真实人的使用反馈、Wiki 语义索引和生产能力仍未验证。飞书真实租户由使用者明确延后，不是当前退出条件；尚无生产部署。

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

日程 grant 须明确 `projectId`、`actorId`、`scopeId`、`roleId`，与日程当前修订的授权一致；当前身份仍须该项目 `write` 和 `review` 权限。未配置 `template.managedTarget` 时，tick 只创建 `todo` Task 及其固定主正文。新修订可显式绑定已限定同一 active Stage 的既有 `{loopId,stageId}`，同库物化后将经核验的到期来源送给指定 Loop；认知需要工作时复用该 todo，仍按当前 runtime grant、预算与 Task 规则启动，不由 tick 直接运行。旧修订不自动升级为受管工作。停用、失去 coordinator 锁、撤权、过期和异常的状态见 `/api/projects/PROJECT_ID/scheduling/status`。runtime grant 须明确 `projectId`、`actorId`、`roleId`、`authorizationScope`、绝对路径 `cwd` 和 `sandbox`（`read-only` 或 `workspace-write`）；确认实际项目目录和授权后才启用。`repositories` 可按项目登记只读 Git 根目录与路径白名单；`feishu` 启用时须给凭据、Bitable 字段映射及逐项目/行为者、显式 `scope: "project"` 的 `grants`，自动轮询另需 `pollEnabled`。用户已将飞书 connector 留待后续，本轮不以实连为完成条件。飞书尚无真实租户验证，不要把 fake HTTP 测试当作实连；当前配置仅支持明确的项目全范围授权，拒绝未落实入站过滤的 owner 范围。身份和集成配置在启动时读取，修改后重启。

如要接外置 Wiki，另加 `knowledge` 配置：`enabled`、回环 HTTP `baseUrl`、仓库外绝对路径 `manifestRoot`、`maintainerId`、`projectIds`。`maintainerId` 必须与实际发布/对账身份的 `actorId` 一致，且该身份具有对应项目的 review 权限；任意标签或另一个未配置的身份不会取得维护权。Wiki 正文和修订由外置后端持有，PostgreSQL 只保存可核对引用；不要把正文、原始 session 或私有运行材料写入 Git。当前 0.5.1 已通过受限真实写读、重启回读和产品候选审核发布；这不证明语义索引、多写者安全或生产恢复。

```bash
chmod 600 "$EVOLOOP_AUTH_FILE" "$EVOLOOP_INTEGRATIONS_FILE"
npm run db:migrate
npm start
```

访问 `http://127.0.0.1:4318`，用身份文件中的 token 登录。令牌只留在当前页面内存，刷新后需重新登录。更新应用后请刷新已打开的标签页并重新登录；旧标签页仍可能运行旧版本界面，本轮独立消费曾因此失败，刷新后才成功，失败观察仍保留。`EVOLOOP_PORT` 可改端口；服务监听回环地址。迁移不会在启动时自动执行。C5 将 Task 正文归入 Document 并改为四态；既有实例须单独运行迁移并同步服务、CLI 和界面版本，本轮未自动升级其他会话的预览或持久数据。同一数据库只允许一个 coordinator 持有专用连接锁；锁丢失后写入不可用，不是双机自动接管证明。

## 受管自动循环候选

在独立数据库迁移至 **016** 后使用本切片；不要借启动自动升级其他会话的试用库。原有集成可保持关闭。要实连 worker，另配置 `orchestration`：`enabled`、已具本项目 read/write/review 权限的 `controllerActorId`、仓库外绝对路径 `workerRoot`、`credentialTtlMs`（1 分钟至 24 小时）和 `pollIntervalMs`（0.5 至 60 秒）。每个认知或业务职责须有控制者自己的唯一 runtime profile，含现有精确授权字段，可增加 `model`、`approvalPolicy` 和默认关闭的 `networkAccess`。同一项目/actor/职责/scope/目录/sandbox 的重复 profile 被拒绝；各 actor 的网络授权互不借用。当前网络启用只适用于明确授权的 workspace-write profile。

worker 的 `cwd` 应是专用、私有、允许写工作文件的目录；原件权限另按项目引用验证。`workerRoot` 保存 0700/0600 的短期凭据和 wrapper，不能位于开发 checkout。CLI 回执放在其获准工作目录的 `.local/worker-receipts/RUN_ID`，避免只读密钥目录与 sandbox 写目录混用。不要把真实配置、令牌、回执、原始 session 或外部正文提交 Git。配置在启动时读取，变更需要重启；撤销 broker 凭据与暂停 Loop 是不同操作。

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

Codex 适配基于本机核过的 **codex-cli 0.154.0** App Server 协议。受控 `gpt-6-astra` owned Turn 已真实完成，重启后可读回完整答复；当前账号对默认 `gpt-6.1-sol` 请求返回 400，需按实际能力选择。另一次后续运行曾在原生 `completedAt` 为空时过早记为 interrupted，约 89 秒后才报告 completed；终态闸已修复，普通工作台显式复核将同一 Turn 的记录更正为 completed，旧事件保留并追加有署名的 `run.reconciled`，Task/Basis 未改。后续新运行报告实际读到固定 Wiki 和所需源码，但原生 Turn 完成不自动证明技术验收、交付、消费者使用或 Task 关闭。启用前核对安装版本、授权目录和隔离真实任务；CLI 升级须重新核 schema、审批、终态、断线与恢复。HTML/CSS/SVG 原件的二次重写已在真实浏览器核对背景、SVG 与空 sandbox，脚本仍按静态隔离规则不执行。结果未知时保留原操作并人工核对，审批默认拒绝越权请求。

App Server、版本检查与协议探测使用同一份明确的子进程环境白名单，保留本机 Codex 登录目录、基本运行环境和代理/证书配置，不转发协调服务的数据库连接、身份配置路径、API 密钥或 Node 执行注入参数。本片沿用 Codex 的本机 ChatGPT 登录；这项环境筛选不限制读取 HOME 文件，工作目录也不是文件读取白名单。runtime 的 authorizationScope 当前用于精确匹配授权，不应把形似 Task ID 的字符串宣称为单任务执行隔离。

重启或恢复已有 owned Session 前，核持久 Session 的 actor、Role、scope、cwd、model、sandbox、approvalPolicy 及其静态或动态现行 grant，先对账在途和未知 Run。恢复请求会将完整执行配置重新传入原 `thread/resume`；`workspace-write` 的联网设置显式传 `true` 或 `false`，原生降权效果仍须在有 Turn 的原 Session 回读验证。动态授权失效不能借静态授权继续。缺完整 profile 的旧 binding 只供历史读取；修复授权后仍沿原 Session、Thread 和操作对账，不换身份掩盖失败。

验证要分三层记录：fixture 回归检查参数与拒权分支；固定安装版本的无推理协议实验核参数接受及返回策略；部署后在原 Task、Session、Thread 上执行真实 CLI 并回读服务端产物。前两层不证明原业务故障已恢复，Turn 结束或本地报告文件也不等于已提交、验收或使用。

## 受管 worker 只读浏览器候选

这是为本机 GUI 体验任务增加的可选实验入口。常规任务仍使用业务 skill＋CLI；浏览器不替代 `worker.submit` 或独立消费者的 used 观察。当前 origin 固定为 `http://127.0.0.1:55431`，不是任意站点浏览能力。启用前核对安装的 Codex 0.154.0 稳定及实验 schema、实验初始化与动态工具声明，再按下表准备精确 scope；隔离检查通过后还须真实 worker 调用和原路径验收。

在既有 runtime 配置中额外提供 `browserRead: { scopePath, playwrightModulePath }`。两者为绝对路径；scope 放仓库外、当前用户所有的普通 `0600` 文件，拒绝符号链接。`playwrightModulePath` 指向明确安装且核过的 Playwright 模块入口，Chromium 由该安装提供；未配置时不加载它，不为此全局安装技能、插件或依赖。

| scope 字段 | 准备与核对 |
| --- | --- |
| `enabled`、`origin`、`expiresAtUtc` | 明确 true、上述精确本机 origin 和绝对 UTC 截止时间。 |
| `projectId`、`taskId`、`contentRevisionId` | 原 GUI Task 及正常任务更新后已批准的主正文修订。不得用正文相同来跳过 TaskRevision 比较。 |
| `sessionId`、`runId`、`runOperationId` | 唯一预选身份，可从已明确预分配的普通 child Dispatch ID 按 `loopIntentId` 推导；不用首次匹配或历史 Run。 |
| `roleId`、`authorizationScope`、`authorizationKind`、`cwd`、`sandbox` | 当前候选只服务 `temporary-experience`，授权种类为 static 或 dynamic；其余字段与原执行 profile 精确一致。GUI 只读不要求把原 workspace-write 改成 read-only。 |
| `readerActorId` | 派生新身份文件时保留所有原 actor/token，只新增一个恰好有本项目 `read` 的独立 reader；不覆写原身份文件。令牌只由宿主读取。 |
| `entryRouteKey`、`routes` | 唯一普通入口与最多 32 个精确只读路由；每项有 `key`、`hash` 及最多 30 个必要 GET `apiPaths`，全部限同项目。先按普通 UI 观察所需路由和 API，不开放项目任意路径。 |
| `followTaskList` | 默认 false。确需工作列表与阶段关联时显式 true，并在 `apiPaths` 列明本项目精确 `tasks?limit=50` 起点；仅从实际成功页派生下一页、已见 Task 根详情及该页原顺序的精确工作状态 GET。 |
| `followDocumentList` | 默认 false。阶段页确需完整文档列表时显式 true，并列明本项目精确 `documents?limit=50` 起点；只追随实际 `nextCursor` 读取下一列表页，不据此开放文档详情、修订或原件。 |

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

持久化检查用独立 PostgreSQL 18 测试库；例如 `TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/evoloop_local_test' npm run test:integration`。入口从该连接串取得主机和端口，为固定库名测试创建缺失的专用 `evoloop_*_test` 库，逐文件串行运行；测试库不会自动删除，因此执行账号需要 `CREATEDB` 或预先建库。测试有故障注入，绝不能指向正在用的开发库。备份还应在新空库和外部目录做隔离恢复演练。测试入口以 `package.json` 与 CI 工作流为准；最近验收的提交、数量和范围见[当前基线](../roadmap.md#当前基线)。旧轮次的固定结果见相应 PR/实测报告，不作为当前最低通过数量。构建、合成测试和隔离备份不等于生产 OpenViking、飞书双向协作或真人亲用已经验收；当前边界见[阶段路线](../roadmap.md)，S1a 历史证据见[首片实测](../research/design-review-20261020.md)。
