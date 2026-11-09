# 前端架构：项目工作台与共同 API

本页只写工作台怎样实现。页面内容见[页面说明](README.md#页面说明)，共同原则见[设计原则](principles.md)，外壳见[布局](layout.md)，产品理由见[产品工作台](../product/workbench.md)；字段、状态与权限以[接口合同](../architecture/contracts.md)为准。

“现状”指当前 main 的代码；“目标”是已选定、由[前端改版 issue #229](https://github.com/cyl19970726/evoLoop/issues/229) 实施的方向，落地前不能当作现状引用。

## 1. 工作台的职责与部署位置

工作台是登录后使用的单页应用，只经共同 Query／Command API 读写，不在浏览器维护第二套状态机。Agent 经业务 skill＋CLI 调用同一 API，授权、固定修订与操作回执规则相同（[DEC-030](../decisions.md#用户已确定的方向)）。浏览器不引入 core、数据库驱动、平台 SDK 或凭据，共用类型只从 `@evoloop/contracts` 的浏览器出口导入。

- **现状**：本机 coordinator 同源提供 `apps/workbench/dist` 与 `/api/`；开发时 Vite 把 `/api` 代理到 coordinator。
- **目标**：多机器方案（[#219](https://github.com/cyl19970726/evoLoop/issues/219)）后由 Hub 托管静态文件，经 Hub 网关访问各机器上的项目；单机模式不变。

公开文档站与工作台的认证空间分开。

## 2. 组件、路由与查询模型

**代码分层。** 现状：`apps/workbench/src` 下 16 个领域目录，有循环依赖（sessions↔workflow、workflow↔runtime、workflow↔orchestration），`ui/shared.tsx` 反向依赖 `documents`。目标：

| 层 | 内容 |
| --- | --- |
| `app/` | 外壳、路由表、身份与查询客户端装配 |
| `features/<领域>/` | 页面、领域组件、该领域的查询与命令 |
| `shared/` | API 客户端、对象引用、修订标签等跨领域部件 |
| `@evoloop/ui`（`packages/ui`） | tokens、基于 shadcn 的基础组件、布局骨架、通用状态与对话流条目；不依赖 `@evoloop/contracts`，不发请求 |

依赖只能向下，领域之间只经对方的 `index.ts`，不许循环；用一个小的 node 检查脚本放进 `npm test`。

**路由。** URL 承载项目、对象稳定 ID、修订和筛选，刷新或分享后回到同一位置；改标题或移动 Git 路径不改链接。历史修订 URL 不跳到最新版。导航入口由[布局](layout.md)决定，不按路由生成。

- **现状**：`App.tsx` 监听 `hashchange`，手写解析 `#/p/{项目}/{区域}/{ID}?revision=…`；所有页面在一个包里。
- **目标**：TanStack Router，路径 URL `/p/{项目}/…`，旧 `#/p/…` 链接（含正文里保存的）兼容跳转，按路由拆包，静态服务对非 `/api` 路径回退 `index.html`。以后要服务端渲染，可在同一套路由上换 TanStack Start。

**读取。** 列表返回有界游标页，不首次加载全项目 Wiki 或全部 trace。搜索按任务、文档、知识分组，各给来源与修订，不把不同后端的分数合并排名。

- **现状**：组件直接调用 `api(` 约 84 处，没有缓存层；令牌以 `token: string` 传递约 63 处。
- **目标**：TanStack Query。query key 以项目开头；切换项目或身份时取消旧请求、清除旧范围缓存；重读时保留旧内容并标“正在核对”。缓存只加速读取，不裁定当前版本或批准状态。

QueryService 返回 `observedAt`、对象与 revision、权限能力、分源状态和缺项。PG 部分在一个只读事务内取得；Wiki/Git 分别读固定版本，不声称跨系统原子快照。知识服务不可用时任务仍可读，依据标为暂不可核对。服务端只装配已授权对象，前端隐藏按钮不是授权；空项目返回空态，前端不注入示例。

现状 `WorkbenchShell` 按项目保留已挂载页面以保住内存草稿，这不是持久恢复。

### 过程文档表格与完整阅读

`DocumentTable` 只请求列表元数据；用 `<table>` 和可聚焦的标题入口，行内 Task 链接不触发打开行，返回时恢复筛选、分页、选中行和焦点。`DocumentReader` 按项目、文档、修订读完整内容，按 `format` 字段而非文件后缀选择阅读器。

| 阅读器 | 实现边界 |
| --- | --- |
| Markdown | 现状用 markdown-it，关闭原始 HTML 与图片，链接按白名单校验；Mermaid 懒加载，SVG 放进带 CSP 的 sandbox iframe |
| HTML 报告 | 从固定原件构造静态副本：清除脚本、表单、内嵌页面、自动跳转和外部资源，重写已登记资源路径；副本带限制来源的 CSP，放进禁脚本的 sandbox iframe，不写入父页面 `innerHTML`；原件不改 |
| 原文 | 按纯文本显示；大包另给授权下载，不以同源可执行 HTML 响应 |

`srcdoc` 只用于小型自包含预览，大包由隔离来源提供。缺资源或省略动态内容时列出缺项。需要脚本的交互报告须用与工作台不同的来源、限定网络、不带工作台凭据；不对上传报告同时开放 `allow-scripts` 与 `allow-same-origin`。

### Session 的单一时间线

`SessionTimeline` 只消费共同服务的 typed entry/page，不自行拼接历史。历史游标与 live 位置分别推进，同一 Item 原位替换，迟到的 running 不覆盖终态；切换身份、项目或 Session 时取消旧请求；401/403 后清空内容，普通刷新不恢复。见[原生读取合同](../architecture/codex-integration.md#session-工作区的历史与实时读取)。

## 3. 修改、刷新与失败如何呈现

每条命令带 `operationId` 和所读 revision。服务端同事务校验权限与基线、写入并登记 outbox；冲突时返回当前 revision，前端保留输入并给差异入口。

- 接受、发布、采纳和派发只显示服务端确认后的状态，不做乐观完成。
- 回包丢失按同一 `operationId` 查询，不换新 ID 重发；`unknown` 显示为“正在核对”。
- 成功读取不清除未知回执。

**实时更新。**

- **现状**：coordinator 没有 SSE 或 WebSocket，前端有 7 处定时轮询（如 Session 时间线 1.5 秒一次）；另有只读的“回读当前状态”。
- **目标**：项目级 SSE 只推“什么变了”，前端让对应查询失效重读；Session 进行中的输出也走推送；断线退回轮询。需要 coordinator 与 #219 网关支持流式响应。

事件到达不代替业务状态。轮询只覆盖当前页面与未结束操作，后台降频，失败退避并显示最后核对时间。

**本地状态。** 服务端数据不长期存入 localStorage；现状操作回执和返回位置存 sessionStorage。草稿留在页面内，离开前提示；登出或换身份清除查询缓存；新修订出现时不替换正在编辑的草稿。

### 状态复核与命令边界

接受、交付、使用观察、阶段选择与交接的状态只来自共同 API，按钮、表单或缓存不能自行裁定。同一对象在各入口使用同一 revision；业务、运行、同步、知识和效果状态分列。命令成功后让相关查询一起失效；日程暂停只失效日程查询，不改在途 Run。业务规则见[日常闭环](../product/daily-loop.md)。

## 4. 会话与权限边界

讨论入口准备带固定版本的交接包，再打开或在授权内创建会话。工作台不嵌入、不伪造 Codex Desktop 聊天，不自动发送消息；无法跳转时给可复制引用。

- **现状**：用户在登录门输入 bearer 令牌，令牌只在内存，随请求放入 `Authorization` 头。
- **目标**：外壳抽象“Hub 登录”和“本机令牌”两种方式；Hub 模式用 httpOnly cookie 并校验 Origin/CSRF，组件间不再传令牌。

公网访问须先有 HTTPS 与登录。Git、Wiki、飞书和模型凭据只在服务端；附件下载经授权并限定内容类型。

## 5. 推荐前端技术与取舍

工作台保持 React + TypeScript + Vite 单页应用。暂不用 Next.js：工作台是登录后的工具；数据在各台机器上，Hub 网关要承载机器长连接；单机模式要简单；Server Actions 会形成 API／CLI 之外的第二条写入路径，与 DEC-030 冲突。以后做公开产品时新增独立的 `apps/site`（Next.js：官网、定价、用户文档、注册、公开分享页），共用设计体系，工作台不重写。

| 责任 | 现状 | 目标 |
| --- | --- | --- |
| 样式 | 7 个全局 CSS（style、workbench、editorial、reading-pages、team-pages、completion、task-production）按导入顺序互相覆盖，另有 22 个领域 CSS；Tailwind 几乎只用于 shadcn 的 Button、Sheet | Tailwind v4 + shadcn/ui（DEC-036），token 只在 `@evoloop/ui` 定义，见[设计基础](foundations.md) |
| 动效 | 无统一做法 | Radix `data-state` + tw-animate-css；列表与布局用 Motion（`motion` 包）；尊重 `prefers-reduced-motion` |
| 构建 | 主 JS 一个文件约 1264 KB（gzip 380 KB），仅 mermaid 懒加载 | 按路由拆包 |

第三方组件来源与许可证记在 `apps/workbench/THIRD_PARTY.md`。知识空间的组件接缝见[知识工作区架构](../architecture/wiki-workspace.md#焦点图的组件接缝与阅读联动)；图渲染器只消费 API 给的授权子图。

### nashsu 的技术组合如何取舍

知识阅读参考 nashsu/llm_wiki，[逐文件核查](../research/nashsu-llm-wiki/frontend-reuse.md)记录其锁定版本；上游锁文件不是本项目已验证的依赖，复用按[移植验证约定](../development/standards.md#上游前端复用与工作台验证)。

| 能力 | evoLoop 的做法 |
| --- | --- |
| 应用壳 | 去掉 Tauri 入口与文件命令，构建普通 Web 应用 |
| Markdown | 若改用 `react-markdown` + `remark-gfm`，保持现有安全边界，链接与图片走授权 API |
| 图关系 | 子图较大时用 Graphology + Sigma + ForceAtlas2 worker；输入由 API 限量提供 |
| 状态 | 不移植 `useWikiStore`，服务数据交给 TanStack Query |
| 知识编辑 | 只产生候选；富文本确有需要再评估 Milkdown |

## 6. 实现切片与验收

按以下顺序拆成小 PR，具体以前端改版 issue 为准：

1. **地基**：token 收进 `@evoloop/ui` 并接入 Tailwind 主题；基础、状态与对话流组件和组件样例页；`app/ → features/ → shared/` 分层，拆除循环，依赖检查进 `npm test`。
2. **路由与读取**：TanStack Router、路径 URL、旧链接跳转、按路由拆包；TanStack Query 替换直接请求；身份抽象。
3. **外壳与页面**：双左栏、中间与右栏的新骨架，再依次迁移 Session、任务、文档和其余页面，每迁一页删掉该页旧 CSS。
4. **收口**：删除旧全局 CSS，颜色字面量只允许在 token 文件里；页面自动截图。
5. **实时与 Hub**：随 #219 网关与 coordinator 事件流接入 SSE 与 Hub cookie。

每片验收：`npm test`、typecheck、build 通过；旧 hash 深链、历史修订链接和返回位置可用；切换项目不串入旧内容；断线后能恢复；首屏 JS 小于现状。
