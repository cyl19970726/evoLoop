# 运行本机首片

S1a 提供过程 Markdown 文档、任务固定依据、需求改版影响和逐项复核。它使用真实 PostgreSQL；界面和 CLI 经过同一 API，不能直接写数据库。当前只有 `proposed`、`ready` 两种任务状态，没有执行、完成、Wiki、飞书或 Codex 接入。

## 环境与启动

使用 Node.js 24.x、npm 与独立 PostgreSQL 18 数据库。运行数据、连接串和令牌均不进 Git。安装与构建：

```bash
npm ci
npm run build
```

先在你的 PostgreSQL 中创建专用开发数据库和有建表权限的用户。不要把测试指向已有业务数据库。设置本次终端环境：

```bash
export EVOLOOP_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/evoloop_dev'
export EVOLOOP_AUTH_FILE="$PWD/.local/auth.json"
mkdir -p .local
```

以下命令在本机生成一个项目范围和访问身份；只输出项目 ID。它拒绝覆盖已有身份文件：

```bash
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
const projectId = randomUUID();
writeFileSync(process.env.EVOLOOP_AUTH_FILE, JSON.stringify([{
  token: randomBytes(32).toString('hex'),
  actorId: 'local-owner',
  projectIds: [projectId],
  permissions: ['read', 'write', 'review']
}], null, 2), { mode: 0o600, flag: 'wx' });
console.log({ projectId });
JS
npm run db:migrate
npm start
```

访问 `http://127.0.0.1:4318`，使用身份文件中的 token 登录。令牌只留在页面内存，刷新需要重新登录。项目尚未创建时列表不会自动生成示例；可用下节的明确示例入口或 CLI 建立。`EVOLOOP_PORT` 可以改本机端口。服务只监听回环地址，不提供公网登录。

迁移是显式步骤，启动服务不会自动改表。同一数据库只允许一个协调者持有专用连接锁；重复启动会失败。数据库连接锁不等于分布式 fencing；当前没有外部副作用或自动双机接管。

## 从正常入口体验一次复核

另开终端，设置同一身份文件与 `EVOLOOP_TOKEN`（从身份文件读取，避免把令牌写入命令历史）：

```bash
export EVOLOOP_AUTH_FILE="$PWD/.local/auth.json"
export EVOLOOP_TOKEN="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.env.EVOLOOP_AUTH_FILE,"utf8"))[0].token)')"
```

将下列项目 ID 替换为上一步生成的 ID，再明确创建合成示例。若使用其他 API 端口，先设置 `EVOLOOP_API_URL`：

```bash
node scripts/seed-review-demo.mjs --project YOUR_PROJECT_UUID
```

脚本经 API 创建一份需求、两个已接受但未运行的任务，然后修订并采纳需求新版。它不会覆盖现有项目；中断后先查原操作结果，不要重复执行整段。示例不会自动随应用启动生成。

1. 脚本完成后打开它输出的项目 URL，再登录；若此前已经登录空列表，可使用“刷新项目”再进入。看到两项待复核和过程文档表。
2. 打开任务 A，比较原依据与新版，填写理由并采用新版。
3. 打开任务 B，填写理由并保留旧版。两任务可以得到不同决定。
4. 从“已作决定”读取之前的任务依据，再打开对应的完整历史文档。
5. 回到工作列表核对待复核减少；任务仍为 `ready`，不是已执行或已完成。

当前 Markdown 按原文安全展示，尚未实现富文本预览、HTML 报告或附件。知识入口会明确显示尚未接通。

## CLI、冲突与恢复

CLI 使用同一令牌/API。把命令 JSON 保存到本地文件，使用：

```bash
npm run cli -- command .local/command.json
npm run cli -- get /api/projects/YOUR_PROJECT_UUID/tasks
```

命令必须带稳定 `operationId` 与 `projectId`。具体联合类型与校验在 `packages/contracts/src/index.ts`；修改已有对象还需其读入 `expectedVersion`。同一 ID、相同身份和内容返回原结果；不同内容复用 ID 会被拒绝。相同版本的竞争更新只能接受一个。

结果未知时，先用同一身份查询 `/api/projects/PROJECT_ID/operations/OPERATION_ID`。查到 `applied` 或 `rejected` 才能作相应判断；404 只说明当次未查到，不能证明操作从未发生。不得通过换 ID 盲目重发。

工作台把待核对操作的身份、项目、任务、操作 ID、类型和时间存入当前标签页的 `sessionStorage`，不存令牌、文档正文或决定理由。刷新后以原身份登录可继续核对；多项回执互不覆盖，未确认前禁止同任务新复核。关闭标签页可能失去这份临时恢复索引，因此必要时复制操作 ID。编辑草稿只在页面内存；409 保留当前草稿供重新核对，刷新会丢弃草稿。

## 验证与范围

```bash
npm run build
npm run typecheck
npm test
npm run docs:check
npm run docs:build
git diff --check
```

数据库检查要求单独的、可丢弃测试数据库，名称须以 `evoloop_` 开头并包含 `test`；例如：

```bash
TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/evoloop_local_test' npm run test:integration
```

适配器测试使用临时 schema，API 测试在该专库创建合成项目。集成测试包含终止**测试库**协调者连接的故障用例，不能与正在使用的应用共用测试数据库。应用 CI 使用独立 PostgreSQL 18 服务；文档检查只证明文档可构建。

详情历史和单次关联任务扫描当前上限为 10,000 条，超出显式拒绝而非截断成功。没有历史分页、后台大批次 fanout、出站消费者、备份恢复演练或生产认证。完整产品目标和首片完成状态见[阶段路线](../roadmap.md)，已运行证据见[审阅报告](../research/design-review-20261020.md)。
