# Hub 账号、邀请与项目成员

状态：2026-11-14 实现 H1 PR2 的独立 Hub 骨架。它管理人类账号、邀请、登录会话、个人令牌、服务身份、项目元数据、项目成员与审计；**尚未接入机器，也不转发任何 coordinator 请求**。PR1（三类权限）、PR3（机器加入与转发）和 PR4（正式登录与项目列表）仍按 DEC-048 的顺序推进。决定依据见 [DEC-048](../decisions.md)（PR #428；在它合入前以该 PR 的正文为准）与 [issue #219](https://github.com/cyl19970726/evoLoop/issues/219)。

## 1. 为什么单独做 Hub

今天的 coordinator 身份来自静态令牌文件。多人使用时，需要先回答：谁是账号、谁邀请了谁、登录是否过期、智能体用哪个身份、某个成员能看哪些项目和 Session。Hub 先只承担这些账号与成员事实；项目内容仍归 coordinator 的 PostgreSQL。这样可以在不改变在途运行时的前提下，把“人是谁”和“智能体是谁”从项目数据中分开。

Hub 是一个独立进程，也是独立 PostgreSQL 数据库。它**不保存** Task、Document 正文、附件、Delivery、原生 Session、Thread 或工具输出。它只保存引用这些对象的元数据，例如项目 ID、成员权限和一个可限定的 Session ID 列表。

## 2. 进程、数据库与代码边界

| 项 | 当前做法 |
| --- | --- |
| 进程 | `apps/hub` 的 Fastify 服务；默认只监听 `127.0.0.1:4319`，由同站 HTTPS 入口反向代理 |
| 数据库 | `HUB_DATABASE_URL` 指向**独立** Hub 数据库；若同时设置 `EVOLOOP_DATABASE_URL`，两者相同会拒绝启动 |
| 迁移 | `apps/hub/migrations/NNN_name.sql`，从 `001` 开始，由 Hub 自己的 runner 记录到 `hub_schema_migrations`；不占用 coordinator 的迁移号 |
| 公共地址 | `HUB_PUBLIC_ORIGIN` 是唯一允许的写请求 Origin，例如 `https://hub.example`；不能带路径、凭据或查询串 |
| 与 coordinator | PR2 不连接、不代理、不共享数据库；PR3 才会加入机器、目录确认与请求转发。项目 ID 在那一阶段与 coordinator 的项目对齐 |

`apps/hub` 只依赖 Fastify 与 `pg`，不导入 `core`、`contracts` 或 coordinator。账号和成员规则因此不会反向污染业务核心，也不会让 Hub 成为第二个运行时协调者。

## 3. 数据模型与权威边界

| 表 | 保存的事实 | 不保存 |
| --- | --- | --- |
| `hub_account` | 人类账号、`actor_id`、邮箱、显示名、Argon2id 密码哈希、是否为 Hub 管理员 | 明文密码、项目内容 |
| `hub_invite` | 邮箱绑定的邀请、一次性 token 的 SHA-256、创建者与过期时间 | 邀请明文（响应只显示一次） |
| `hub_login_session` | 登录会话的 token 哈希、所属账号、到期与撤销时间 | 浏览器可读的会话内容 |
| `hub_personal_token` | 个人令牌名称、项目范围、token 哈希、撤销与最后使用时间 | 令牌明文 |
| `hub_service_identity` | 服务身份的 actor、显示名、人类所有者、用途、token 哈希与吊销 | 密码、网页登录会话 |
| `hub_service_identity_project` | 服务身份可进入的项目范围 | 项目内容 |
| `hub_project` | 项目 ID、名称、机器占位、创建者 | Task、文档正文、Session 记录 |
| `hub_project_member` | 账号 × 项目 × 任务/文档/Session 三类权限 × Session 列表 × 项目管理员 | 对象级读权限、项目正文 |
| `hub_project_actor` | 每个项目里 actor 的身份种类；`(project_id, actor_id)` 唯一 | 密码或令牌 |
| `hub_audit` | 账号、邀请、登录、令牌、服务身份、项目与成员的审计事件 | 密码、令牌、原始请求正文 |
| `hub_login_throttle` | 连续登录失败的计数、窗口与封禁截止 | 密码错误细节 |

**Session 列表的语义**：`session_ids=[]` 表示该成员在该项目中不额外限制 Session；非空数组表示只允许列出的 Session。这里只存 ID，不存原生 Session 记录。H1 不实现对象级读权限；如果以后确有“某份文档只给部分人看”的需要，再另加保密标记。

**同一 actor 的两种身份**：人类账号与服务身份都有稳定的 `actor_id`。把人类加入项目、或把服务身份限定到项目时，都会写入 `hub_project_actor`。主键使同一项目不能同时把同一 actor 记为人类和智能体；应用层在创建服务身份和添加成员时都先检查并返回 `ACTOR_IDENTITY_CONFLICT` 或 `ACTOR_ID_TAKEN`。当前实现还把 actor 的唯一性扩展到 Hub 全局，避免同一字符串在另一个项目里被静默当成另一个人。

## 4. 身份、登录与浏览器会话

### 4.1 第一位 Hub 管理员

第一位 Hub 管理员只能由服务器上的初始化命令创建：

```sh
HUB_DATABASE_URL=postgres://.../evoloop_hub \
HUB_PUBLIC_ORIGIN=https://hub.example \
npm run hub:init -- --email admin@example.test --name "Hub Admin" --password-file /private/hub-initial-password
```

命令会先应用 Hub 迁移，再在事务和 advisory lock 内确认没有其他 Hub 管理员。已有管理员时拒绝，不能用网页或普通 API 绕过。密码只从私有文件或 stdin 读取，不进入命令行参数、日志或数据库明文。

### 4.2 邀请注册

- Hub 管理员创建邀请，邮箱由邀请固定；响应只显示一次邀请链接。
- 注册在事务中锁定邀请，检查未使用、未过期、邮箱无账号，然后创建账号并标记邀请已使用。
- 重复使用同一邀请返回 `INVITE_USED`；过期返回 `INVITE_EXPIRED`；无效 token 不返回内部差异。
- 邀请 token 在库里只存 SHA-256。

### 4.3 密码与登录

- 密码用 Node 24 的 Argon2id（`m=32768,t=2,p=1`，16 字节随机 salt，32 字节 tag）哈希；库里只存 `$argon2id$...` 字符串。
- 每次登录创建新的随机会话 token；会话 token 的 SHA-256 存在 `hub_login_session`。数据库不存浏览器 token 明文。
- 连续失败按邮箱计数，默认 5 次、15 分钟窗口、封禁 15 分钟；失败响应不区分“账号不存在”和“密码错误”。成功登录清除计数。
- 修改密码要求当前密码和浏览器会话；保留当前会话，撤销该账号的其他登录会话。
- 登出撤销当前会话。

### 4.4 Cookie、Origin 与 CSRF

登录和注册成功后设置：

```text
__Host-hub_session=<opaque-token>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200
```

- `HttpOnly` 使脚本读不到登录 cookie；`__Host-` 前缀要求 Secure、Path=/ 且无 Domain。
- 所有没有 Bearer token 的写请求（POST/PUT/PATCH/DELETE）必须带与 `HUB_PUBLIC_ORIGIN` 完全相同的 `Origin`。缺失或跨站都返回 403。
- 浏览器 cookie 的写请求还要带 `X-Hub-CSRF`（API）或表单里的 `csrf`（最小页面）。CSRF token 从会话 token 派生，不额外存明文，也不放在可被脚本读取的 cookie 里。
- Bearer token 写请求不依赖 Origin/CSRF，因为它们不携带浏览器环境凭据；这使未来的 coordinator 到 Hub 的机器请求不必伪造浏览器 Origin。

## 5. 个人令牌与服务身份

### 5.1 个人令牌

- 人类账号可以创建不限定项目或限定一个项目的个人令牌；限定项目时必须是该项目成员。
- 创建响应只显示一次 token；库里只存 SHA-256、名称、项目范围、创建/最后使用/撤销时间。
- 请求携带 `Authorization: Bearer <token>`。撤销后下一次请求即返回 401；限定项目的令牌访问其他项目返回 403。项目范围令牌不能使用 Hub 全局管理接口，读取审计时也只能读到该项目的记录。
- 个人令牌不能替代浏览器会话执行改密码或登出。

### 5.2 服务身份

- 只有 Hub 管理员能创建；必须填写人类所有者、显示名、用途和一个或多个项目范围。
- 服务身份没有密码、邮箱登录或网页会话；只能以 Bearer token 认证。响应不设置 cookie。
- 吊销只影响该服务身份；它的项目范围记录保留用于审计。
- 服务身份只能读取自己的项目元数据与 Session 身份视图；不能读取成员管理、项目审计或项目内容。PR3 才会用它做受控转发。

## 6. 两层管理与成员权限

| 身份 | 可以做什么 | 不能做什么 |
| --- | --- | --- |
| Hub 管理员 | 建项目、指定第一位项目管理员、邀请账号、管理项目元数据、创建/吊销服务身份、读取全局审计 | 因 Hub 管理员身份自动获得项目成员权限；读取项目成员或项目内容（除非另行被加入项目） |
| 项目管理员 | 管理本项目成员、三类权限、Session 列表、项目管理员集合 | 管理其他项目、创建服务身份、改 Hub 全局账号或审计范围 |
| 项目成员 | 读取自己所属项目元数据；持有被授予的三类权限和 Session 列表 | 管理成员；读取不属于自己的项目 |

项目必须始终保留至少一位项目管理员。修改或移除最后一位项目管理员会在事务中返回 `LAST_PROJECT_ADMIN`。第一位项目管理员由 Hub 管理员创建项目时指定；Hub 管理员自己的账号不会被自动加入该项目。

## 7. 最小 API 合同

以下路径是 PR2 的稳定骨架。JSON 请求使用 `application/json`；响应错误统一为 `{ "error": { "code", "message", "details" } }`。除登录、注册和健康检查外，都需要浏览器 cookie 或 Bearer token。

| 方法与路径 | 作用 | 认证 |
| --- | --- | --- |
| `GET /api/health` | 进程健康 | 公开 |
| `POST /api/auth/register` | 用邀请 token 注册并建立会话 | Origin |
| `POST /api/auth/login` | 邮箱密码登录并建立会话 | Origin |
| `GET /api/session` | 当前 principal、项目范围与 CSRF token | cookie 或 Bearer |
| `POST /api/auth/logout` | 撤销当前浏览器会话 | cookie + CSRF |
| `POST /api/account/password` | 改密码并撤销其他会话 | cookie + CSRF |
| `GET /api/projects` | 我的项目元数据（服务身份返回其项目范围） | cookie 或 Bearer |
| `GET /api/projects/:projectId` | 项目元数据 + 我的成员权限 | cookie 或 Bearer |
| `GET /api/projects/:projectId/members` | 成员与权限 | 项目管理员 |
| `POST /api/projects/:projectId/members` | 加成员、三类权限、Session 列表 | 项目管理员 |
| `PATCH /api/projects/:projectId/members/:accountId` | 改成员权限/管理员标记 | 项目管理员 |
| `DELETE /api/projects/:projectId/members/:accountId` | 移除成员，拒绝移除最后管理员 | 项目管理员 |
| `GET /api/tokens` / `POST /api/tokens` | 列出/创建个人令牌 | 人类账号 |
| `DELETE /api/tokens/:tokenId` | 撤销个人令牌 | 人类账号 |
| `GET /api/audit?projectId=&limit=` | 审计查询 | Hub 管理员；项目管理员仅限自己的项目 |
| `GET /api/admin/accounts` | 人类账号列表（无密码哈希） | Hub 管理员 |
| `POST /api/admin/invites` | 创建一次性邀请 | Hub 管理员 |
| `GET /api/admin/projects` / `POST /api/admin/projects` | 项目元数据与建项目 | Hub 管理员 |
| `PATCH /api/admin/projects/:projectId` | 改项目名称/机器占位 | Hub 管理员 |
| `GET /api/admin/service-identities` / `POST /api/admin/service-identities` | 服务身份列表/创建 | Hub 管理员 |
| `DELETE /api/admin/service-identities/:id` | 单独吊销服务身份 | Hub 管理员 |

示例（省略真实值）：

```json
{
  "email": "member@example.test",
  "permissions": { "task": true, "document": false, "session": true },
  "sessionIds": ["session-id-1"],
  "isProjectAdmin": false
}
```

项目创建的第一个管理员使用同样的权限结构；省略 `permissions` 时默认三类全开。`sessionIds` 留空表示不额外限定 Session。

## 8. 最小页面

`/login`、`/register?invite=...`、`/app`、`/admin` 与 `/projects/:projectId` 只提供无 JavaScript 的最小管理表单：登录、注册、创建/撤销个人令牌、邀请账号、建项目、创建服务身份和调整项目成员。正式登录页、完整导航和项目列表属于 PR4；这些页面不作为产品体验验收。

## 9. 审计与日志

- 审计记录账号注册、邀请创建、登录成功/失败、登出、改密码、令牌创建/撤销、服务身份创建/吊销、项目创建/更新、成员新增/更新/移除。
- 审计 `detail` 只放对象 ID、范围、权限和原因，不放密码、token、cookie、请求正文或私密路径。
- Fastify 默认请求日志不记录 JSON 请求体；启动日志只打印监听地址与公共 Origin，不打印数据库 URL。
- 错误响应不返回 SQL 语句、数据库 URL 或 token。

## 10. 备份与恢复

Hub 数据库是独立数据库；备份也必须独立。下面的演练在**一次性测试实例**上做，不能使用正式 coordinator 的端口 `55432`，也不能在项目库上执行。

```sh
# 1. 备份（Hub 服务停写或停止后）
pg_dump --format=custom --file=/private/hub.dump "$HUB_DATABASE_URL"

# 2. 在空的新库里恢复
createdb "$HUB_RESTORE_DATABASE_URL"
pg_restore --dbname="$HUB_RESTORE_DATABASE_URL" --clean --if-exists --no-owner /private/hub.dump

# 3. 起服务指向恢复库，确认 hub_account 数量、审计水位与登录
HUB_DATABASE_URL="$HUB_RESTORE_DATABASE_URL" HUB_PUBLIC_ORIGIN=... npm run start:hub
```

恢复后必须用至少一个恢复的人类账号实际登录一次；只检查表存在不算恢复演练通过。备份包含密码哈希、令牌哈希与审计数据，按密钥材料保护；不要把 dump、数据库 URL 或恢复后的会话带进公开仓库。

当前没有自动备份调度、跨主机复制或密钥轮换；H1 只验证手工备份/恢复路径。正式主机上的备份周期和保留期仍属于需求 Session 的发布决定。

## 11. 验证与未验证范围

已实现并有自动测试覆盖：

- 邀请一次性/过期/重复注册；未登录读防护。
- Argon2id 密码哈希；HttpOnly + Secure + SameSite cookie；缺 Origin/跨站写拒绝；连续失败限流；登出与改密后旧会话失效。
- 个人令牌只显示一次、库中只有哈希、项目范围隔离、撤销后立即拒绝。
- 服务身份仅 Hub 管理员创建、有所有者/用途/范围、无密码登录、不能拿 cookie、actor 冲突拒绝、单独吊销。
- Hub 管理员不自动获得项目成员权限；项目管理员加人/改权限/限定 Session；非管理员改成员被拒；最后一位项目管理员不可移除。
- 我的项目只返回所属项目元数据；审计不含密码或 token 明文。

未验证或未实现：

- 没有连接机器、目录确认、请求转发或 coordinator 权限改造（PR1/PR3）。
- 没有正式主机部署、自动备份、密钥轮换、邮件发送、密码找回或两步验证（H2）。
- 没有在真实多人、真实浏览器 HTTPS 入口或真实机器上做使用验收；候选阶段只证明自建 Hub 与真实 PostgreSQL 的账户路径。
- 外部 Wiki、Task、Document 与 Session 原生记录仍不在 Hub 数据库内；PR3 之后也不能把 Hub 当成内容库。
