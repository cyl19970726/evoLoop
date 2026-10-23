# 本机运行与恢复

当前是可运行的本机试用切片：11 个工作区，会话正常关闭候选包含 PostgreSQL 迁移 018；旧试用环境的迁移和运行版本须分别核对，不随候选自动升级。目标、阶段、过程 Document、Task、负责人讨论、Role、Schedule、操作回执和运行记录经同一 coordinator API/工作台/CLI 使用。固定 Git 原件、Blob 与 Markdown/静态 HTML/CSS/SVG 阅读、外置 OpenViking 0.5.1 的写读和重启回读已有受限实测；普通工作台完成过知识候选→审阅→发布、来源变化需复核与 Task 显式采用。两次相连 Task 已有交付、独立 Agent 使用观察与阶段回看；后一次消费者下载新旧 HTML、CSS、SVG 的实际哈希均匹配，首次旧客户端失败观察仍保留。真实人的使用反馈、Wiki 语义索引和生产能力仍未验证。飞书真实租户由使用者明确延后，不是当前退出条件；尚无生产部署。

## 环境与启动

使用 Node.js **24.x**、npm、PostgreSQL **18** 的独立数据库；备份工具 `pg_dump`/`pg_restore` 也须是 18.x。连接串、身份文件、外部 Blob 和 Wiki 正文均留在仓库外。先在 PostgreSQL 中建立专用空库及有建表权限的用户，然后安装、构建：

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

命令需稳定的 `operationId`、`projectId`；修改已有对象还需读入的 `expectedVersion`。同一 ID、身份和内容返回原回执；不同内容复用 ID 被拒绝。结果未知时先查 `/api/projects/PROJECT_ID/operations/OPERATION_ID`；404 只表示当次未查到，不能证明外部动作没发生。未知 Turn 必须按已有原生 thread 和 operation 标记对账，不能换 ID 盲目重派。工作台临时恢复索引在当前标签页 `sessionStorage`，不存令牌或正文；关闭标签页可能失去索引，重要操作应另存 ID。

Codex 适配基于本机核过的 **codex-cli 0.154.0** App Server 协议。受控 `gpt-6-astra` owned Turn 已真实完成，重启后可读回完整答复；当前账号对默认 `gpt-6.1-sol` 请求返回 400，需按实际能力选择。另一次后续运行曾在原生 `completedAt` 为空时过早记为 interrupted，约 89 秒后才报告 completed；终态闸已修复，普通工作台显式复核将同一 Turn 的记录更正为 completed，旧事件保留并追加有署名的 `run.reconciled`，Task/Basis 未改。后续新运行报告实际读到固定 Wiki 和所需源码，但原生 Turn 完成不自动证明技术验收、交付、消费者使用或 Task 关闭。启用前核对安装版本、授权目录和隔离真实任务；CLI 升级须重新核 schema、审批、终态、断线与恢复。HTML/CSS/SVG 原件的二次重写已在真实浏览器核对背景、SVG 与空 sandbox，脚本仍按静态隔离规则不执行。结果未知时保留原操作并人工核对，审批默认拒绝越权请求。

App Server、版本检查与协议探测使用同一份明确的子进程环境白名单，保留本机 Codex 登录目录、基本运行环境和代理/证书配置，不转发协调服务的数据库连接、身份配置路径、API 密钥或 Node 执行注入参数。本片沿用 Codex 的本机 ChatGPT 登录；这项环境筛选不限制读取 HOME 文件，工作目录也不是文件读取白名单。runtime 的 authorizationScope 当前用于精确匹配授权，不应把形似 Task ID 的字符串宣称为单任务执行隔离。

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

恢复前建立**新的空 PostgreSQL 18 数据库**，不要先运行迁移；选不存在的 Blob 目标目录。脚本先校验清单和全部文件，再确认目标数据库没有用户对象、目标目录不存在，并以单事务运行 `pg_restore`。有 Wiki 快照时给不存在的仓库外导出目标；脚本只解包快照，**不会替 OpenViking 服务导入**：

```bash
export EVOLOOP_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/evoloop_restored_empty'
node scripts/restore.mjs --from /absolute/private-backups/evoloop-20261020 \
  --blob-root /absolute/restored/evoloop-blobs
# 含 Wiki 快照时还需 --wiki-snapshot-out /absolute/restored/wiki-export。
```

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
