# 运行时后续目标：Session 能力配置、登录与通信

> 性质：目标与提议，**不是采纳决定**。初稿 2026-11-08。2026-11-09 按使用者反馈改写了第 2 节的出发点（§2.0）：
> - 先做到每个 Session 带了什么都看得见；
> - skill 按范围选择，不固定内容版本；
> - plugin 和 MCP 先由各运行时自己加载，evoLoop 只负责展示。
>
> 代码基线是本分支上尚未合入的运行时修复和 Claude 适配器改动。正式采纳后，登记到[决定记录](../decisions.md)。
>
> 输入文档：[运行时修复与 Claude 接入计划](runtime-fix-and-claude-plan-20261108.md)（下称“计划”）、[会话间通信与 DeepSeek 执行模型](session-communication-and-deepseek-20261108.md)（下称“通信文档”）、[Claude Agent SDK 接入方案](claude-agent-sdk-integration-20261108.md)。
>
> 本文编号：需求 R1–R4，场景 S1–S7，目标 O1–O8，原则 A1–A7，阶段 L1–L8，待决定 Q1–Q15。

## 0. 结论

**目标。** 在同一个项目里，Session 可以跑在 Codex 上（模型可以经本机模型网关接 DeepSeek），也可以跑在 Claude 上。每个 Session 都满足四点：
- 打开就能看到它带了哪些 skill、plugin 和 MCP，以及各自来自哪里；
- skill 按范围选择：项目的、个人的、运行时自带的，再加单项增减。Role 给默认值，执行中可以追加；
- 用哪份登录、能和谁通信，由 evoLoop 明确配置；
- 每次改动都有修订记录，每个 Turn 实际带上的清单也被记录下来。

plugin 和 MCP 先由各运行时自己加载，evoLoop 只负责展示；账号类连接默认关闭。使用者个人目录里的 skill 默认不带，需要时打开开关。

**现在的位置：**

| 已经成立（有运行证据） | 还没有成立 |
| --- | --- |
| Codex 0.167 经适配器真实运行，模型为 DeepSeek，10 个场景全部通过（通信文档 §5.4） | Claude 经适配器、在完全访问模式下的真实运行（需要使用者批准，Q6） |
| Claude 适配器对真实 CLI 的一致性运行，API 为本地模拟，43 项全部通过（§2.7） | 经 coordinator 和工作台的真实 Session、消息、Turn 端到端运行 |
| Claude 的能力目录、两种上下文模式和每个 Turn 的实际清单：用专用登录真实运行，9 项全部通过（§2.7） | Role 运行时绑定与 skill 选择经 coordinator 驱动真实 Codex 与 Claude Session（实现与测试见 §2.11） |
| 两种运行时各从哪里加载 skill、plugin 和 MCP，已在本机核对（§2.0） | Codex Session 带了什么还看不见：现在共用个人 home，每个 Session 都带着个人 skill 和 4 个 MCP server，没有记录 |
| Claude 子进程关闭账号连接器，并记录运行时报告的 MCP server（§2.7） | Codex 专用 home 和能力配置落地（L4） |
| Codex 按 Thread 控制送到模型的 skill：模拟 API 和真实 DeepSeek 都成立（§2.8） | 角色卡片的真人使用；Claude Session 的模型修订 |
| 空的专用 Codex home 关闭 plugin 后，启动时没有外连（§2.8） | Session 间通信的 P0–P2 修正；运行时版本记录和 Codex 一致性脚本（L8） |

本分支上的代码改动都还**没有提交**（Q7）。

**顺序：**

1. 先把本文定下来（L1）。
2. 做 Claude 的能力目录和实际清单记录（L2）。已实现，并通过真实运行。
3. 把能力清单写进合同、执行配置修订和 PostgreSQL（L3）。
4. 做 Codex 专用 home 和能力落地（L4）。
5. 做工作台展示（L5）。

Session 通信（L6）可以与 L2–L5 并行。真实验收矩阵（L7）贯穿全程，每个阶段结束时补上对应的行。运行时版本记录和一致性脚本（L8）在 L4 之前做完，因为 L4 依赖 Codex 未写入文档的配置键。

## 1. 目标

| 目标 | 完成时成立的事实 | 不包括 | 验收证据 |
| --- | --- | --- | --- |
| O1 两种运行时都能真实使用 | Codex 和 Claude 各用一份专为 evoLoop 准备的登录，完成真实 Turn。登录一次之后，coordinator 重启或新建 Session 都不用再登录 | 生产部署；替使用者输入任何凭据 | §5 矩阵里 Codex 和 Claude 两列的真实运行记录 |
| O2 每个 Session 带什么看得见、能指定 | 创建 Session 时就列出将带上的 skill；Turn 开始后列出运行时报告的 skill、plugin 和 MCP，每项标明来源。skill 按三个开关加单项增减来选，Role 给默认值；执行中可以追加，从下一个 Turn 起生效 | 固定 skill 的内容版本；按 Session 选择 plugin 和 MCP；能力市场、在线安装；改动使用者的全局配置 | 解析函数和合同测试；两种运行时各一次真实运行，覆盖默认、打开个人 skill、全部不带三种范围 |
| O3 实际生效结果可观察 | 每个 Turn 记录运行时报告的实际清单和内容哈希；与配置不一致时明确标记 | 证明 Agent 确实“用了”某个 skill | Turn 证据记录；在工作台 Session 详情回读 |
| O4 任意两个 Session 都能通信 | Codex↔Codex、Claude↔Claude、Codex↔Claude 走同一条授权路径收发；记录来源 Session，限制回复链深度 | 同步调用；运行时原生的点对点通道 | 通信文档 §4.8 的测试，加上每种组合各一次真实运行 |
| O5 不污染个人环境 | evoLoop 的 Thread 不出现在使用者的 Codex 历史里；evoLoop 的转录和设置不写进个人的 Claude 目录 | 清理已经写入的历史（另行处理） | 真实运行前后比对个人目录，只看条目，不读正文 |
| O6 真实验收矩阵 | §5 的每个阶段都有对应的真实运行行；没跑过的格子明确写“未验证” | 真人体验和长期收益（见[路线图](../roadmap.md)） | 持续更新 §5 的表格 |
| O7 外部连接看得见 | Session 能连到的外部账号和服务都看得见，账号类默认关闭。具体是三点：登录账号在 claude.ai 上的连接器默认关闭；Codex 专用 home 不做 plugin 同步，`codex_apps` 按 Q14 处理；运行时报告的 MCP server 和 plugin 都记录下来并展示 | 网络层隔离；限制模型提供方本身的连接；按 Session 选择 MCP | 适配器测试；两种运行时各一次真实运行，记录的 MCP 清单与展示一致；专用 home 启动时，除模型提供方外没有外连 |
| O8 运行时升级可回归 | 每个 Turn 记录运行时版本。两种运行时各有一套一致性脚本，覆盖本文依赖的、没有写入文档的行为：Codex 的 Thread 级 `config` 键，Claude 的钥匙串条目、`settingSources` 和连接器开关。升级运行时之前先跑一遍 | 自动升级；锁定桌面应用自带的 Codex 版本 | 脚本的运行记录；Turn 证据里有版本 |

**不做：**
- 不把能力配置当成安全边界（见 A5）。
- 不统一两种运行时的 plugin 格式；暂不按 Session 选择 plugin 和 MCP（见 A4）。
- 不支持 Windows。
- 不做运行时原生的跨会话通道。适配器已经把它关闭（通信文档 §2.4）。

## 2. Session 能力配置

### 2.0 产品场景与需求（2026-11-09）

本节按使用者 2026-11-09 的反馈，重新确定了出发点。§2.2–§2.6、§2.9 和 §2.10 已按本节改写。§2.7 和 §2.8 是之前的实现与实测记录，保持原样。同日稍后，使用者把选择从 Session 移到 Role：Role 绑定一种运行时后不可更换，skill 跟着 Role 走并实时可见，一个协调服务同时驱动两种运行时。这一方向已登记为 DEC-035，实现见 §2.11；本节和 §2.9、§2.10 中按 Session 修订范围、逐 Run 建表和只读展示的部分不再实施。

**真正要的：**
- **R1 看得见。** 打开任何一个 Session，都能看到它带了哪些 skill、plugin 和 MCP，以及各自来自哪里。创建时看到“将带上的”；Turn 开始后，看到运行时报告的“实际带上的”。这一条最重要。
- **R2 能指定。** 特定任务的 Session，能带上我们为它设计的 skill。创建时选范围；执行中可以追加，从下一个 Turn 起生效。
- **R3 两种运行时一致。** 同样的配置，不管 Session 跑在 Codex 还是 Claude 上，带上的项目 skill 都一样。
- **R4 不做过头。** skill 不固定内容版本，跟着所在目录走；配置也不当安全边界。plugin 和 MCP 由各运行时自己加载，evoLoop 先只负责展示，按 Session 选择以后再做。两种运行时的 plugin 格式不互通，不做统一。

**两种运行时各从哪里加载（2026-11-09 本机核对）：**

| | Codex 0.167 | Claude Code 2.1.319 |
| --- | --- | --- |
| 项目 skill | 工作目录所在仓库的 `.agents/skills` | 工作目录的 `.claude/skills`；**不读** `.agents/skills` |
| 个人 skill | `~/.agents/skills`；个人 plugin 带来的 skill，在 Codex home 的 plugin 缓存里 | `~/.claude/skills`，用专用 configRoot 时换成 configRoot 下的 `skills`；个人 plugin 带来的 skill |
| 自带 skill | 5 个系统 skill | 约 20 个 |
| plugin | 装在 Codex home 里的；启动时还会在后台同步 | 个人配置里安装并启用的；SDK 传入的本地 plugin；运行时自带的 |
| MCP | Codex home 的 `config.toml`；plugin 带的；名为 `codex_apps` 的账号应用服务 | configRoot 里的用户配置；项目 `.mcp.json`；plugin 带的；claude.ai 账号连接器 |
| 怎么列出来 | `skills/list`、`plugin/list`、`mcpServerStatus/list`，创建 Session 时就能查 | 每个 Turn 开始时的初始化消息，里面有 skill、plugin、MCP 三份清单 |

由此有两个现在就要处理的事实：
- **Codex Session 现在带着很多看不见的东西。** 适配器共用个人 home，所以每个 Codex Session 都带着 8 个个人 skill（其中 7 个来自 plugin），还有 4 个 MCP server。其中 `codex_apps` 有 107 个工具，用账号令牌认证。这些现在既没有记录，也没有展示。
- **Claude 读不到项目的 `.agents/skills`。** 这个仓库的 skill 都放在那里，所以要由 evoLoop 替 Claude 接上。

**场景：**

| # | 场景 | 带什么 | 在哪看到 |
| --- | --- | --- | --- |
| S1 | Role 派发的业务 Session（最常见） | 默认范围：项目 skill，加 evoLoop 业务 skill（`evoloop-workflow`），加运行时自带；不带个人的 | Session 详情 |
| S2 | 人自己开一个 Session 做探索，希望和自己终端里一样 | 打开“个人 skill”；plugin 和 MCP 照该运行时的个人配置 | 同上，个人项单独标出 |
| S3 | 专项 Role，比如只做前端评审 | 关掉“项目 skill”，单独加 `frontend-design` 和 `web-design-guidelines` | 同上 |
| S4 | 执行中发现缺一个 skill | 经 CLI 追加（Agent 代人操作），下一个 Turn 生效 | 修订历史里能看到谁、什么时候加的 |
| S5 | 同一个 Role 换运行时 | 项目 skill 相同。Claude 经 plugin 加载时，名字会带来源前缀 | 实际清单 |
| S6 | 项目里的 skill 改了 | 下一个 Turn 自动用新内容 | 实际清单里，内容哈希变了 |
| S7 | 运行时带进了没选的东西，比如 plugin 同步来的 skill、账号连接器 | 照实显示 | 标为“没选却出现” |

**配置模型：三个开关，加单项增减。**

| 开关 | 管什么 | 业务 Session 默认 |
| --- | --- | --- |
| 项目 skill | 工作目录所在仓库的 `.agents/skills` 和 `.claude/skills` | 开 |
| 个人 skill | `~/.agents/skills`、`~/.claude/skills` 这类个人目录 | 关 |
| 运行时自带 | 运行时二进制自带的 skill | 开 |

- **单项增减。** 在开关之外，可以单独加一个 skill（来自项目、个人目录或 evoLoop 仓库），也可以单独去掉一个。
- **业务 skill。** evoLoop 的业务 skill 对业务 Session 是必带的，不受开关影响。
- **全部不带。** 三个开关都关，就是“全部不带”，之后再逐个加。
- **默认值和修改。** Role 给默认值，创建 Session 时可以改。之后每次改，都是一次执行配置修订，从下一个 Turn 起生效。

**plugin 和 MCP：先展示，不选择。**
- 各运行时照自己的配置加载。evoLoop 读出运行时报告的清单，和 skill 放在一起展示。
- 账号类连接是例外：claude.ai 账号连接器默认关闭（§2.7）；Codex 的 `codex_apps` 要不要也默认关闭，见 Q14。

### 2.1 现状

**evoLoop 现有机制。** 配置项 `runtime.roleSkills` 按项目和 Role 列出 evoLoop 仓库里 `.agents/skills/<name>/SKILL.md` 的路径，默认是 `evoloop-workflow`。coordinator 把这些 skill 固定到 commit 和内容哈希，写进受管首包；Agent 再用材料 CLI 按固定版本读取全文。这种方式是“输入注入”，不依赖运行时自己的 skill 发现。计划 §1 采用的就是它。

**运行时自己的发现。** 下表是 2026-11-08 的本机实测。每次只做初始化和列出清单，没有调用模型。

| 运行时与配置 | 实际看到的 | 说明 |
| --- | --- | --- |
| Codex 0.167，共用个人 home | 项目 6 个、个人 8 个、系统 5 个 | 项目 skill 来自 Session cwd 的 `.agents/skills`。个人 skill 大多来自个人 home 里的 plugin 缓存，其中有的会使用个人已登录的浏览器 |
| Codex 0.167，专用的空 home | 项目 6 个、系统 5 个 | 个人 skill 全部消失 |
| Claude Code 2.1.319（SDK 0.3.319），`settingSources: ["project"]` | 只读 `<cwd>/.claude/skills`，**不读** `.agents/skills` | 适配器目前就是这个设置，所以 Claude Session 看不到项目 skill |
| 同上，加 `user` 来源 | 读 `CLAUDE_CONFIG_DIR/skills`，不读个人 Claude 目录下的 skill | 专用 configRoot 本身就隔开了个人 skill |
| 同上，运行时自带 | 18 个 skill、4 个 plugin | 目录隔离去不掉它们 |
| 同上，本地 plugin（`plugins: [{type: "local", path}]`） | plugin 里的 skill 可用，名字变成 `plugin:skill` | plugin 的 `skills/` 是符号链接时也可用 |
| 同上，SDK `skills` 参数 | 只过滤进入模型上下文的列表，初始化消息里的清单不变 | 不是沙箱 |

**问题有三个：**
- Session 能用什么，取决于它跑在哪个运行时、哪台机器、用谁的家目录。
- Codex Session 会看到使用者个人的 skill，Claude Session 却看不到项目 skill。
- 两边都没有记录实际加载了什么。

### 2.2 原则

- **A1 看得见优先。** 每个 Session 带了什么，配置的和实际的都要能看到。
- **A2 范围显式。** 带什么，由三个开关和单项增减决定。个人目录默认不带；要带，就打开开关。
- **A3 改动有记录。** 改范围要走执行配置修订，从下一个 Turn 起生效，旧修订可以查。skill 的内容版本不固定，跟着所在目录走；每个 Turn 记录实际的内容哈希。
- **A4 先 skill，后 plugin。** skill 是给模型读的说明，两种运行时格式通用，由 evoLoop 选择。plugin 和 MCP 的格式因运行时而异，先由运行时自己加载，evoLoop 只负责展示。
- **A5 配置不是安全边界。** 在完全访问权限下，Agent 仍然能读到磁盘上任何一个 `SKILL.md`。边界仍然是 sandbox、授权和 grant。能力配置只管默认给模型看什么、自动加载什么。
- **A6 以观察为准。** 以运行时自己报告的实际清单为准，并记录下来。选了却没加载，和没选却出现，都要醒目地标出来。
- **A7 外部连接也是能力。** 账号连接器、MCP server、plugin 同步，都能让 Session 连到外部账号或服务。它们至少要看得见；账号类连接默认关闭（Q10、Q14）。

### 2.3 来源

| 来源 | 位置 | 由哪个开关管 | 说明 |
| --- | --- | --- | --- |
| evoLoop 业务 skill | evoLoop 仓库的 `.agents/skills/` | 业务 Session 必带 | 例如 `evoloop-workflow`，与具体工作项目无关 |
| 工作项目 | 工作目录所在仓库的 `.agents/skills/`，以及 `.claude/skills/` | 项目 skill | 项目自己的方法和约定 |
| 个人目录 | `~/.agents/skills`、`~/.claude/skills` 等 | 个人 skill | 使用者自己装的 skill |
| 运行时自带 | 运行时的二进制 | 运行时自带 | 只能过滤或关闭，不能移除 |
| plugin 带来的 | 各运行时自己的 plugin | 不由 evoLoop 选择 | 随 plugin 加载，只展示 |

单项增减可以从前四类来源里任选一项。

### 2.4 配置与合同

配置分三层：Role 默认 → 创建 Session 时修改 → 执行配置修订。执行配置修订和 model、effort 共用一条修订链。

- **Role 默认。** 现有的 `runtime.roleSkills` 扩展为 Role 默认的范围。旧格式继续可读：其中列出的路径视为单项追加，开关取新的默认值。
- **校验。** 只有两条：单项追加的 skill 必须找得到；业务 skill 不能去掉。不满足就拒绝这次修改，并指出是哪一项。
- **修订。** 现有的 `runtime.session.executionProfile.revise` 已经带有 `expectedExecutionProfileRevisionId`。skill 范围作为同一个修订的一部分，沿用它的乐观并发和激活流程。

合同草案。字段名以后可以改，要点在结构：

```ts
type SkillScope = {
  project: boolean;  // 工作项目的 .agents/skills 和 .claude/skills
  personal: boolean; // 个人目录
  builtin: boolean;  // 运行时自带
  add: string[];     // 单独加的 skill：名字，或相对来源目录的路径
  remove: string[];  // 单独去掉的 skill 名字
};

type ResolvedSkill = { // evoLoop 按 SkillScope 解析出的“将带上的”一项
  name: string;
  source: "evoloop" | "project" | "personal" | "builtin";
  contentHash?: string; // 解析时的内容哈希；自带项不填
};

type ObservedCapabilities = { // 每个 Turn 一份
  turnId: string;
  reportedBy: "codex" | "claude.init";
  derived: boolean; // Codex 的 skill 清单是推导出来的（§2.8）
  skills: { name: string; source: ResolvedSkill["source"] | "plugin" | "unknown"; contentHash?: string; selected: boolean }[];
  plugins: string[];
  mcpServers: string[];
  runtimeVersion: string; // O8
};
```

### 2.5 各运行时怎样落地

**共同做法。** 两种运行时用同一个函数，从各来源目录解析出“将带上的”清单。不复制文件，直接用原目录，内容跟着目录走。

| | Claude | Codex |
| --- | --- | --- |
| 登录 | 共用的 configRoot 只放登录凭据，不放 skill（§3.1） | 现在共用个人 home；目标是专用 home（§3.2） |
| 项目和个人 skill | 每个来源生成一个本地 plugin，它的 `skills/` 链接到来源目录，经 SDK 的 `plugins` 参数加载。名字带来源前缀，例如 `project:frontend-design` | 项目 skill 由运行时自己发现。用专用 home 时，个人目录作额外根 |
| 选择 | SDK 的 `skills` 白名单放解析出的清单。它只过滤模型上下文（见 A5） | 每个 `thread/start` 之前重新调用 `skills/list`，用 Thread 级 `skills.config` 按路径关闭没选的项；自带项用 `skills.bundled.enabled: false` 关闭（§2.8） |
| 中途修改 | 每个 Turn 都重新传参数，下一个 Turn 就生效 | Thread 级配置在 `thread/start` 时给定，`turn/start` 不接受 `config`。中途修改要靠 `thread/resume` 带新的 `config`，是否生效待实测（Q15） |
| plugin 和 MCP | 照运行时配置加载；账号连接器默认关闭 | 照运行时配置加载 |
| 实际清单 | 初始化消息里的 `skills`、`plugins` 和 `mcp_servers` | skill 由 `skills/list` 减去关闭的项推导；plugin 用 `plugin/list`；MCP 用 `mcpServerStatus/list` |

**Claude 的已知代价：**
- 经 plugin 加载的 skill，名字会带前缀，例如 `evoloop:evoloop-workflow`。好处是从名字就看得出来源；代价是 skill 正文或首包里按名字引用其他 skill 的地方，要一起改。
- 适配器原来的 `settingSources: ["project"]` 会隐式读入 `<cwd>/.claude/` 下的三类内容：skill；设置，包括 hook、权限和启用的 plugin；以及 CLAUDE.md。实测结果和现在的两种模式见 §2.7，取舍见 Q3。

**Codex 的关键约束：**
- 适配器是一个 coordinator 一个 app-server 进程，所有 Session 共用。
- `CODEX_HOME` 和 `skills/extraRoots/set` 都在进程级生效；`skills/config/write` 会持久写进 home 里的 `config.toml`。
- 适配器已经在 `thread/start` 上为每个 Thread 传入它自己的 `config` 覆盖，并且已经实测有效（§2.8）。

所以 Codex 走单进程方案：一个 app-server，按 Thread 覆盖。plugin 和 MCP 是进程级的，要按 Session 选择就得分进程，暂不做。

### 2.6 记录与展示

- **记录。** 每个 Turn 开始时，读取实际清单，与解析出的清单对比，写入 Turn 证据（`ObservedCapabilities`）。不一致只标记，不拒绝派发（Q5）。
- **展示。** 工作台的 Session 详情增加“能力”一栏，见 §2.10。
- **入口。** 按 DEC-029 和 DEC-030，工作台先只读展示；选择和修改走 CLI，由 Agent 代人操作。CLI 在创建 Session 时就打印“将带上的”清单。工作台要不要加创建表单，等有真实需要再定。

### 2.7 Claude 的 L2 实现与实测（2026-11-08）

本节记录本分支上已经写好、但**尚未提交**的实现。清单仍沿用现有的 `runtime.roleSkills`，合同和修订（L3）还没做。

**`settingSources` 实测。** 用 SDK 自带的 CLI 2.1.319 和本地模拟 API，不用真实凭据：

| 设置 | 带入了什么 |
| --- | --- |
| `["project"]` | 项目 `.claude/settings.json` 里的 hook 会执行；读入项目 CLAUDE.md（没有 CLAUDE.md 时，由运行时自带的 `cc-plugin-agents-md` 读 AGENTS.md）；读入项目 `.claude/` 下的 skill、agent 和命令 |
| `[]` | 以上都不带入。配置目录和 HOME 下的 CLAUDE.md、hook 和命令，两种设置下都不出现 |

**两种上下文模式。** 配置项 `runtime.claude.contextMode`：

- `project`（默认）：保持 `settingSources: ["project"]`，行为和原来一样。
- `explicit`：`settingSources: []`。适配器自己读取 Session cwd 根目录的 AGENTS.md，没有就读 CLAUDE.md，经 `systemPrompt.append` 传给模型，前面加一句说明来源。上限 64 KiB，超出就截断并记录；内容哈希按全文计算。每个 Turn 都重新读取，并关闭系统提示快照，所以每个 Turn 的请求里就是该 Turn 记录的内容。

**能力目录。** 配置项 `runtime.claude.skillBundle` 默认开启：

- coordinator 按 Role 的 `roleSkills` 取出固定的 skill，从 git 的固定 commit 复制进 `<configRoot>/evoloop-capabilities/<bundleHash>/`，做成名为 `evoloop` 的本地 plugin。
- 目录按内容寻址，文件只读。遇到符号链接或子模块就拒绝。有数量和大小上限。先写进临时目录，再原子改名。
- 每个 Turn 启动前，适配器重新核对目录里的文件、内容哈希和可执行位。核对不过，Turn 不发送（`RuntimeNotSentError`），也不启动进程。
- 经 SDK 的 `plugins` 加载，带 `skipMcpDiscovery`，对应 CLI 的 `--plugin-dir-no-mcp`。
- SDK 的 `skills` 白名单是 `evoloop:<skill>`，加上 `roleSkills[].builtinSkills` 列出的运行时自带项，默认为空。SDK 还会把这份白名单转成 `--allowedTools=Skill(<name>)`。在完全访问模式下，这只是权限放行规则，不限制其他工具。

**每个 Turn 的实际清单。** 适配器读取初始化消息，写入 Turn 账本，经 `RuntimeTurn.observedCapabilities` 返回。内容包括：发现的 skill、白名单、缺失项（在白名单里、但没被发现）、plugin、plugin 错误的类型、上下文模式、说明文件名和哈希、能力目录哈希。不记录本地路径。

**真实 CLI 一致性运行。** 用 `scripts/claude-conformance.mjs`，API 为本地模拟：原有检查和新增的 16 项 L2 检查全部通过。L2 的结果：

- 两种模式下，Turn 都能完成。初始化消息报告 `evoloop:conformance-skill`，缺失项为空，没有 plugin 错误。
- `explicit` 模式：
  - AGENTS.md 只出现一次，来自适配器；
  - 项目 CLAUDE.md 不进入请求；
  - 项目 hook 不执行；
  - 配置目录和 HOME 下的说明也不出现。
- `project` 模式加能力目录：仍读项目 CLAUDE.md，项目 hook 照常执行，适配器不额外添加说明。
- 白名单生效。不设白名单时，请求里能看到 `update-config`、`fewer-permission-prompts`、`simplify`；设了白名单，两种模式下都看不到，只看到能力目录里的 skill。
- 初始化消息里的清单不受白名单影响：仍列出全部 16 个自带 skill，以及 3 个自带 plugin（`cc-plugin-agents-md`、`cc-plugin-privacy`、`cc-plugin-plugin-authoring`）。数量随 CLI 版本和环境变化。

**和 §2.6、Q5 的差异。** 初始化消息要等提示送出后才到达，所以“配置了但没加载”没法在同一个 Turn 发送前拒绝。现在的做法：

- 能力目录的完整性在启动进程前把关；
- 初始化时的缺失只记录下来。

要在发送前拒绝，需要先做一次不调用模型的探测，或者改为拒绝下一个 Turn。2026-11-09 改了方向：不一致只标记，不拒绝（Q5），所以这里不需要再改。

**真实凭据运行（2026-11-08）。**

方法：
- 用专用 configRoot 里的登录。子进程环境逐项列出，不带任何 `ANTHROPIC_*` 或 `CLAUDE_CODE_OAUTH_TOKEN`。
- 为了不在完全访问模式下跑真实模型，这次没有经过适配器，而是直接调用 SDK。传给 SDK 的能力选项与适配器相同：能力目录 plugin、skill 白名单、`settingSources`、附加说明，以及 `CHILD_SETTINGS`。
- 只开放只读的 `Skill` 工具，`permissionMode` 为 `dontAsk`。
- `evoloop-workflow` 从 evoLoop 仓库的固定 commit 复制进能力目录。

结果：9 项全部通过，每个 Turn 花费约 0.01–0.06 美元。
- 两种模式的 Turn 都完成。运行时报告没有使用 API key（`apiKeySource: none`），认证来自 configRoot 的登录。
- 初始化消息报告 `evoloop:evoloop-workflow`，缺失项为空，没有 plugin 错误。
- 模型看到的 skill 只有 `evoloop:evoloop-workflow`，没有未列出的自带 skill。
- `explicit` 模式：模型拿到的是 AGENTS.md 里的标记，不是 CLAUDE.md 里的；项目 hook 没有执行。
- `project` 模式：模型拿到 CLAUDE.md 里的标记；项目 hook 执行了。
- 转录只写进 configRoot，个人 Claude 目录下没有对应条目。
- 没有 MCP server，也没有 `mcp__` 开头的工具。
- 初始化消息列出 19–20 个自带 skill 和 4 个自带 plugin，比模拟 API 时多一个遥测类的 `cc-plugin-telemetry`。

**账号连接器。**
- **发现。** 早些时候的一次真实运行里，初始化消息带出了登录账号在 claude.ai 上配置的连接器：它们作为 MCP server 挂上，工具名以 `mcp__claude_ai_` 开头。在完全访问模式下，这些工具可以直接调用，相当于 Session 能在 evoLoop 的授权之外操作这个账号。
- **开关。** 从 CLI 代码看，用 claude.ai 登录时 CLI 会加载这些连接器，除非满足两个条件之一：环境变量 `ENABLE_CLAUDEAI_MCP_SERVERS` 为假；或者设置 `disableClaudeAiConnectors` 为真，经 `--settings` 传入的也算。
- **重现。** 之后用五种组合重跑，包括什么都不关的组合，都没有再出现。触发条件还没弄清，可能和账号侧的状态有关。
- **现在的做法。** 适配器两处都关：
  - `CHILD_SETTINGS` 加上 `disableClaudeAiConnectors: true`；
  - 子进程环境固定 `ENABLE_CLAUDEAI_MCP_SERVERS=false`，调用方不能覆盖。
- **记录。** 每个 Turn 的实际清单增加 `mcpServers`。evoLoop 不给 Session 配置任何 MCP server，所以只要出现一项，就说明有没配置的 server 挂上了。
- **检查。** 一致性脚本增加了对应检查（S10），现在 43 项全部通过。

**还没覆盖：**
- 经适配器、在完全访问模式下的真实运行：多 Turn、工具、中断、归档。这需要使用者批准（Q6）。
- `explicit` 模式只读 cwd 根目录的一个说明文件：不展开其中的 `@` 引用，也不读子目录里的说明文件。
- `skillBundle` 默认开启后，项目 `.claude/skills` 里没被列出的 skill，也会被白名单挡在模型上下文之外。

### 2.8 Codex 按 Thread 控制 skill 的实测（2026-11-08）

**方法。**
- Codex 0.167.0-alpha.3.2，只起一个 app-server 进程。
- 临时的 `CODEX_HOME` 和 HOME；模型提供方指向本地模拟的 Responses API，用假密钥，不调用真实模型。
- 工作目录里有项目 skill `alpha`、`beta`；`gamma` 经 `skills/extraRoots/set` 加为额外根。
- 每种 `thread/start` 的 `config` 覆盖各开一个 Thread、跑一个 Turn，检查送到模拟 API 的请求里出现了哪些 skill。只记录有或没有，不保存请求正文。

**结果：**

| `thread/start` 的 `config` 覆盖 | 送到模型的 skill |
| --- | --- |
| 不覆盖 | `alpha`、`beta`、`gamma`，加 4 个系统 skill |
| `skills.config: [{name: "beta", enabled: false}]` | 没有 `beta`，其余不变 |
| `skills.config: [{path: <beta 的 SKILL.md>, enabled: false}]` | 同上 |
| `skills.bundled.enabled: false`（点号键和嵌套对象两种写法都有效） | 没有系统 skill |
| `skills.include_instructions: false` | 整个 skill 清单都不发送 |
| 关闭系统 skill，再按名字关闭 `beta` 和 `gamma` | 只剩 `alpha` |
| 上面这些之后，再开一个不覆盖的 Thread | 全部恢复，没有串到别的 Thread |

**其他事实：**
- **覆盖的范围。** 覆盖在同一个 Thread 的后续 Turn 里保持。它不写 `config.toml`，`skills/list` 的结果也不受影响。
- **系统 skill。** `skills/list` 列出 5 个，送到模型的是其中 4 个，`review-agent` 不在模型清单里。
- **额外根是进程级的。** 改动后，新 Thread 按新根生成清单。已有的 Thread 在下一个 Turn 会追加一份新清单，旧清单仍留在历史里。所以 Session 运行期间，不应该改动额外根。
- **空 home 的副作用。** 空的专用 home 首次启动时，app-server 会做几件事：
  - 把系统 skill 写进 `$CODEX_HOME/skills/.system`；
  - 建立几个 SQLite 存储，其中有名为 memories 和 goals 的；
  - 在后台做 plugin 同步，可以看到 `.tmp/plugins-clone-*` 下的 git 目录和 `plugins.sync.lock`。

**专用 home 的外连（2026-11-08）。**

方法：
- 临时的 `CODEX_HOME` 和 HOME，模型提供方指向模拟 API。
- 代理环境变量指向一个本地记录代理。代理只记目标主机名，并拒绝所有隧道，所以没有数据真正出去。
- 每种配置跑一个 Turn，再等 20 秒。

| `config.toml` | 尝试连接的主机 | home 里的 plugin 同步痕迹 | `skills/list` |
| --- | --- | --- | --- |
| 只有模型提供方 | chatgpt.com、github.com、api.github.com | `.tmp/plugins.sync.lock` | 项目 1 个、系统 5 个 |
| 再加 `[features]` 下的 `plugins = false` | 没有 | 没有 | 项目 1 个、系统 5 个 |

- 两种配置下，都没看到进程绕过代理直接连外网。方法是每 0.7 秒用 lsof 采样一次进程树的连接。
- 放行网络时，同步会装入哪些 plugin、带来哪些 skill，这次没有测。
- 结论：专用 home 的模板应该写上 `plugins = false`（Q11）。

**真实模型复核（DeepSeek，2026-11-08）。**

方法：和上面相同的 skill 布置，但改用共用的个人 home 和本机模型网关。只读 sandbox，审批策略 `untrusted`，用临时 Thread，结束后归档；服务端发来的请求一律拒绝。模型用 JSON 回答自己看到的 skill 名字，报告只记名字。

结果：
- `skills/list` 按范围列出：项目 2 个，user 范围 9 个，系统 5 个。
- 不覆盖时，模型看到 `alpha`、`beta`、`gamma`、4 个系统 skill，另外还有 8 个个人 skill。
- 按 evoLoop 的形状覆盖，即关闭系统 skill、按路径关闭 `beta`：`beta` 和系统 skill 都不见了。但个人 skill 还在，而且从 8 个变成 18 个。多出的 10 个来自 plugin，进程启动时的 `skills/list` 里没有它们。
- 把 `skills/list` 列出的非系统项按路径全部关闭（共 9 条），再关闭系统 skill：模型只看到 `alpha` 和 `gamma`。Thread 级加不加 `features.plugins: false`，结果相同。不过这次另起的进程里，那 10 个 plugin skill 没有再出现，所以这个开关单独的效果没能对照。
- 模型没有调用工具。个人 `config.toml` 前后不变。临时 Thread 没有留下 rollout 文件。

**对 L4 的含义。** 单进程方案可行，具体做法：
- 用专用 home，并关闭 plugin。共用个人 home 时，plugin 会在进程运行期间带进新 skill，按启动时的全集算出来的黑名单会过时。
- 额外根取所有在用能力目录的并集，保持稳定。
- 每个 Thread 先用 `skills/list` 得到发现的全集，再按路径关闭清单以外的项，关闭系统 skill，只放开 Role 列出的那几个。这是黑名单，所以每次 `thread/start` 之前都要重新取一次全集，不能用进程启动时的结果。
- Codex 没有按 Thread 报告实际清单的接口，`skills/list` 只按 cwd 返回。所以 Codex 的“实际清单”只能由“发现的全集减去关闭的项”推出来，要在记录里标明是推导出来的，不是运行时报告的。
- 同名 skill 用名字关闭会一起关掉，所以用路径。

### 2.9 L3 设计：Session 的 skill 范围和实际清单

本节是设计，**还没有实现**，等 Q1 和 Q7。

**现在的缺口：**
- **不能选。** Claude Session 只看得到 `roleSkills` 列出的 skill，项目里的其他 skill 都看不到；Codex Session 则带着全部个人 skill 和 MCP。两边都不能按 Session 选择。
- **看不到。** 每个 Turn 的实际清单只写进 Claude 适配器自己的 Turn 账本，没有进 PostgreSQL；Codex 根本没有记录。工作台和 CLI 都读不到。

**设计：**
1. **解析。** 写一个与运行时无关的函数，输入工作目录、个人目录、Role 默认和 `SkillScope`，输出“将带上的”清单（§2.4）。创建 Session 时调用一次，用来展示；每个 Turn 开始前再调用一次，用来下发。
2. **合同。** 执行配置修订增加可空的 `skillScope`。为空表示旧 Session，按 Role 默认处理（Q13）。
3. **PostgreSQL 迁移。** 编号在实现时按主干顺延；合入时排在主干 062–066 之后，为 067 与 068。
   - `session_execution_profile_revision` 增加可空的 `skill_scope jsonb`，受现有的不可变触发器保护。
   - 运行快照触发器 `session_recovery_run_profile` 只在该字段非空时，把它加进快照。这样历史快照逐字节不变，沿用 051 加 `reasoningEffort` 的做法。
   - 新建一张表，存每个 Run 的实际清单：skill、plugin、MCP 和运行时版本。一个 Run 一行，只追加，不可改。适配器的账本仍是原始记录，这张表是可查询的副本。
4. **core。** `revise` 判断“有没有变化”时，把 `skillScope` 算进去。现在没有变化会报 `EXECUTION_PROFILE_UNCHANGED`。校验见 §2.4。并发、激活和忙碌检查都沿用现有流程。
5. **CLI。**
   - 创建或准备 Session 时，可以给三个开关和单项增减；命令输出“将带上的”清单。
   - `session profile show` 显示范围、将带上的清单和最近一次的实际清单。
   - `session profile set` 可以改开关、增减单项，每次改动都生成新修订。
6. **适配器。**
   - Claude：能力目录从“复制固定版本”改成“每个来源一个本地 plugin，链接到原目录”；白名单按解析出的清单计算。
   - Codex：每个 `thread/start` 前重取 `skills/list`，按清单生成 `skills.config`；用 `plugin/list` 和 `mcpServerStatus/list` 读出 plugin 和 MCP，一起记录。
7. **不一致。** 只标记，不拒绝派发（Q5）。

**验收：**
- 解析函数的单元测试：三个开关、单项增减、找不到的项、业务 skill 必带。
- 迁移测试：历史快照逐字节不变，修订不可改。
- CLI 往返：创建时打印的清单，和第一个 Turn 的实际清单一致。
- 两种运行时各一次真实运行，覆盖三种范围：默认、打开个人 skill、全部不带。

### 2.10 L5 设计：工作台的能力展示

本节是设计，**还没有实现**。位置按[团队与具体 Session](../frontend/pages/team-and-sessions.md)现有的结构安排：

- **Agent 信息（紧凑区）。** 在模型、思考强度、权限旁边加一项“能力”，显示“skill N · plugin N · MCP N”，不展开清单。有差异时加一个标记：选了没加载，或者没选却出现。
- **会话详情（低频详情）。** 加“能力”一节，分三块，每块都标明数据来源：
  1. **范围。** 三个开关的状态和单项增减；修订历史，包括版本、时间、操作者和改了什么。
  2. **skill。** 每项显示名称、来源（evoLoop、项目、个人、自带、plugin）、是否选中、最近一次是否实际加载，以及内容哈希的短号。自带项默认折叠。
  3. **plugin 和 MCP。** 运行时报告的清单。账号类连接单独标出。

规则：
- **只读。** 修改走 CLI，由 Agent 代人操作（DEC-029、DEC-030）。
- **措辞。** “实际加载”只说明运行时加载了这些项，不写成“模型用了”（O3 不包括这一点）。Codex 的 skill 清单是推导的，要注明。
- **未核的数据。** 第一个 Turn 之前，只显示“将带上的”；实际清单显示“未观察”，不显示为空。

**验收：**
- 在隔离实例上，用浏览器回读；桌面和 390px 宽度都要看。
- 覆盖四种状态：一致、选了没加载、没选却出现、未观察。

### 2.11 采纳与实现：Role 的运行时与 skill（2026-11-09）

使用者的决定（DEC-035）：Role 绑定 Codex 后就只能用 Codex，可以改模型，不能换运行时；要实时知道一个 Role 有哪些 skill；一个协调服务同时运行 Codex 与 Claude；逐 Turn 记录由实现者判断。与 §2.9、§2.10 的差别如下。

| 方面 | 原设计 | 实现 |
| --- | --- | --- |
| 选择挂在哪里 | Session 的执行配置修订 | Role 的运行时修订表 `role_runtime_revision`（迁移 068），只追加；修订 1 固定运行时，之后只改 skill |
| 运行时 | 一个协调服务一种 | `runtime.providers` 列出同时驱动的运行时，Session 按创建时的运行时分发；未绑定的 Role 在首个 Session 预留时按默认运行时绑定 |
| 逐 Turn 清单 | 新建每 Run 一行的表 | 不建表。Claude 沿用适配器 Turn 账本的启动报告（`observedCapabilities`）；Codex 在读取时向运行中的 App Server 列出 |
| 展示 | Session 详情只读 | 团队分工页的角色卡片和 `role runtime show`，每次读取实时取值；有 review 权限者可在卡片或 `role runtime set` 修改，下一个 Turn 生效 |

**实现要点：**
- 选择沿用 §2.0 的三个开关加单项增减，业务 skill 必带；会修改运行时自身配置的内置 skill 默认不加载。Codex 经线程配置关闭未选项，业务 skill 走 Role 上下文；Claude 把选中的 skill 链接成每个 Turn 的本地插件（不再复制固定版本），计划哈希不含本机路径。
- 绑定在 core 与 PostgreSQL 两层都检查：运行时不可更换、修订连续、另一运行时还有未关闭 Session 时不能绑定、绑定 Role 的新 Session 必须用同一运行时。迁移 068 按既有 Session 为已有 Role 补绑定，未关闭 Session 横跨两种运行时的保持未绑定。
- 读取结果标明来源：`codex.list`、`claude.init` 或 `files`。运行时不可用或尚无 Turn 时退回按文件推断并注明；Claude 当前选择与最近一次 Turn 加载的不同时提示“下一个 Turn 生效”。
- 同时驱动两种运行时后，压缩维护按 Session 自己的运行时判断是否支持，不再看默认运行时。

**验证（2026-11-09）：** core 绑定与预留自动绑定、视图的三种来源、HTTP 路由的权限与未提供能力、CLI 往返、工作台展示模型均有单元测试；迁移 067/068 在临时 PostgreSQL 上用旧数据样本验证了补绑定规则、触发器与重复迁移。全量单元测试只余与本工作无关、已另行登记的 material CLI 用例失败；PostgreSQL 集成测试 49 个文件在临时实例（PostgreSQL 17）上全部通过。

隔离实例回读：新建临时库并迁移到 068，协调服务同时列出 Codex 与 Claude，Codex 使用专用状态目录，授权目录只读，没有预留任何 Session。唯一的固定 Task 按集成测试的做法直接写库，其余都经真实 CLI 与 HTTP 路由完成。
- 未绑定的 Role 显示将用默认运行时，并注明未读取项目 skill。
- Codex Role：绑定前由运行中的 Codex 列出项目与内置 skill，自修改类内置默认不加载；绑定并关闭内置后，内置全部不加载；移除项目 skill 后显示“已移除”。再提交相同选择被拒为 `ROLE_RUNTIME_UNCHANGED`，改为 Claude 被拒为 `ROLE_RUNTIME_BOUND`。
- Claude Role：尚无 Turn，按文件推断并注明内置 skill 待首个 Turn 上报；单独加入的不存在名称列为缺失；改为 Codex 同样被拒。
- 数据库中两种 Role 的修订连续、运行时不变、都带 operation ID。

工作台卡片本轮未在浏览器中登录查看。经 coordinator 驱动真实 Codex 与 Claude Session、Claude 真实模型的凭据与费用，以及角色卡片的真人使用，都还没有验证。Codex 由插件提供的个人 skill 可能不出现在 `skills/list` 中，视图因此可能少列。

## 3. 登录与运行环境

### 3.1 Claude

- **为什么不能自动复用个人登录。** 适配器给每个子进程设置一个专用的 `CLAUDE_CONFIG_DIR`，即 `runtime.claude.configRoot`。从 SDK 自带 CLI 2.1.319 的二进制字符串推断：指定了专用目录时，macOS 钥匙串里的凭据条目名会带上该目录路径的哈希后缀，所以子进程找的不是个人登录的那一条。此外，桌面宿主注入当前会话的令牌，在子进程里返回 401（通信文档 §7.1）；把这个令牌挪给子进程用的做法也被拒绝了。
- **目标做法：在 configRoot 里登录一次。** 运行 `CLAUDE_CONFIG_DIR=<configRoot> claude auth login`；机器上没装 `claude` 时，用 SDK 自带的同一个 CLI。这样做：
  - 凭据只存在钥匙串里（Linux 上是 configRoot 里的凭据文件）；
  - 所有 Claude Session 共用这一份登录；
  - 令牌刷新不影响个人登录；
  - evoLoop 不读、也不存令牌。
- **备选：**
  - 用 `claude setup-token` 生成长期令牌，经 coordinator 环境变量 `CLAUDE_CODE_OAUTH_TOKEN` 传入；
  - 或使用 `ANTHROPIC_API_KEY`。如果 evoLoop 以后给其他人用，SDK 文档要求产品使用 API key，而不是 claude.ai 登录。
- **不用的做法。** CLI 里有一个未写入文档的环境变量，可以让子进程读个人默认登录。它不稳定，而且会和个人 CLI 共用同一份会刷新的凭据。
- **重试。** 正式 coordinator 环境建议设 `CLAUDE_CODE_MAX_RETRIES=2`。

### 3.2 Codex

- **现在（做法一，已验证）。** 共用个人 Codex home，登录和本机模型网关都能直接用。代价有三个：evoLoop 的 Thread 进入个人 Codex 历史；个人 skill/plugin 进入 Session；桌面应用升级时会连带更换二进制。
- **目标（做法二）。** 用 coordinator 专用 home。其中的 `config.toml` 由 evoLoop 按模板生成，只含两样东西：模型提供方配置，以及 `[features]` 下的 `plugins = false`。关闭 plugin 后，启动时不再连 chatgpt.com 和 GitHub 做 plugin 同步（§2.8）。密钥放在 `env_key` 指定的环境变量里，由适配器的 `envPassthrough` 传入，不复制进生成的文件。这是 O2、O5 和 O7 的前提。
- **切换。** 已有的 owned Thread 在个人 home 里，换到新 home 后无法 resume。按计划 I1 的维护窗口方式，先排空再切换。

## 4. Session 间通信

沿用通信文档的设计：
- 发送走材料 CLI，与运行时无关；
- 存储和授权在 PostgreSQL；
- 投递方式由接收方的运行时决定。

落地顺序：

1. **P0 修正消息泵**（通信文档 §4.5）；
2. **P1 Claude `ConversationFacet`**（§4.4）；
3. **P2 `RuntimeRegistry`**（§4.2）：按 Session 的运行时选择适配器。以后如果要按 Session 选择 Codex 的 plugin，就得分进程，也在这里扩展。

另外增加 `sender_session_id` 和回复链深度上限（§4.7），防止两个 Session 互相回复、形成回环。

**与能力配置的关系。** 发送靠材料 CLI，而 CLI 怎么用写在 `evoloop-workflow` 里，所以这个 skill 应该是业务 Session 的必备项（§2.4）。

## 5. 阶段与验收

| 阶段 | 内容 | 依赖 | 完成的证据 | 现在 |
| --- | --- | --- | --- | --- |
| L1 | 本文；确认后登记决定 | — | 决定记录 | 等 Q1 |
| L2 | Claude：能力目录（清单先沿用现有 `roleSkills`）；读取并记录实际清单；关闭账号连接器 | L1 | 适配器单元测试；一致性脚本；一次真实 Claude 运行，初始化清单与配置一致 | 已实现，真实运行通过（§2.7）；未提交。按 §2.5 还要调整：能力目录从复制固定版本改成链接原目录，并接上项目的 `.agents/skills` |
| L3 | 合同、core 和 PostgreSQL 迁移：与运行时无关的解析函数；执行配置修订带上 skill 范围；每个 Run 的实际清单入库；CLI 在创建时打印将带上的清单，并能修改范围 | L1、L2 | 见 §2.9 的验收 | 有设计（§2.9），未实现 |
| L4 | Codex：生成关闭 plugin 的专用 home，接入模型网关。按 §2.5 落地：项目 skill 由运行时发现；个人 skill 开关打开时，把个人目录作额外根；按 Thread 关闭没选的项。记录 skill、plugin 和 MCP | L3、L8 | 一次真实 DeepSeek 运行：推导出的 skill 清单与解析结果一致，个人 skill 默认不出现，启动时除模型提供方外没有外连 | 前提已实测（§2.8），未实现；等 Q4、Q14 |
| L5 | 工作台：Session 详情里的“能力”一栏 | L2、L3 | 见 §2.10 的验收 | 有设计（§2.10），未实现；等 Q6 |
| L6 | Session 通信：P0 → P1 → P2 | 可与 L2–L5 并行 | 通信文档 §4.8 的测试；四种组合各一次真实运行 | 未开始 |
| L7 | 真实验收矩阵 | 贯穿全程 | 下表 | 持续更新 |
| L8 | 每个 Turn 记录运行时版本；Codex 一致性脚本补上行为检查，覆盖 §2.8 用到的配置键和 plugin 开关；升级运行时前先跑两套脚本 | L2 | Turn 证据里有版本；脚本的运行记录 | Claude 的脚本已覆盖本文用到的行为（`scripts/claude-conformance.mjs`）。Codex 的脚本（`scripts/codex-conformance.mjs`）只比对协议 schema，不启动 app-server，所以还没覆盖 §2.8 的行为 |

**真实验收矩阵（随阶段更新）：**

| 场景 | Codex（DeepSeek） | Claude |
| --- | --- | --- |
| 经适配器直接运行：多 Turn、工具、中断、归档 | 通过（通信文档 §5.4） | 未验证。真实凭据只跑了只读的能力检查（§2.7）；完全访问模式需要批准（Q6） |
| 能力清单生效 | Thread 级覆盖在真实模型上生效；共用个人 home 时，个人 skill 和 plugin 带来的 skill 会漏进来（§2.8）；适配器还没实现 | 真实凭据下通过（§2.7） |
| 实际清单被记录 | 未实现，只能推导 | 写进适配器的 Turn 账本；还没进 PostgreSQL（L3） |
| 外部连接看得见（O7） | 空的专用 home 关闭 plugin 后，启动时没有外连（模拟 API）。共用个人 home 时不成立：带着 4 个 MCP server，其中 `codex_apps` 用账号令牌，都没有记录 | 账号连接器两处关闭；真实运行里没有 MCP server（§2.7） |
| 经 coordinator 和工作台的端到端运行 | 未验证（需要 Q6） | 未验证 |
| 跨 Session 消息（同运行时 / 跨运行时） | 未验证 | 未验证 |
| 个人环境未被写入（O5） | 做法一下不成立 | 转录只写进 configRoot（§2.7）；设置和其他文件没有逐项核对 |

## 6. 待决定

| # | 问题 | 推荐 | 卡住哪些阶段 |
| --- | --- | --- | --- |
| Q1 | 是否采纳本文方向并登记决定 | 采纳 | L2 之后的全部 |
| Q2 | plugin 放在仓库里的什么位置 | 暂不需要。plugin 先由运行时自己加载，evoLoop 只展示（A4）；真要按 Session 选 plugin 时再定 | — |
| Q3 | Claude 的 `settingSources` 怎么设 | 两种模式都已实现，真实凭据运行也已通过（§2.7）。推荐现在把 `contextMode` 的默认值切到 `explicit`，单独一个 PR，说明里写明：项目 CLAUDE.md 和项目 hook 从此不再生效 | L2 |
| Q4 | Codex 什么时候切换到专用 home | L4 开工时切换，先在隔离实例上验证。模板里关闭 plugin（Q11） | L4 |
| Q5 | 配置与实际不一致时怎么办 | 只标记，不拒绝派发。“选了没加载”和“没选却出现”都在工作台醒目显示（§2.6） | L3、L4 |
| Q6 | 是否批准在隔离实例上创建完全访问的测试 Session，做端到端核对 | 批准，只用于临时工作目录 | L5、L7 |
| Q7 | 当前分支上未提交的改动怎么处理 | 拆成三个 PR，依次合入：① 运行时合同和 Codex 适配器审计修复；② 运行时提供方选择和 Claude 适配器，含 L2；③ 研究文档。每个 PR 单独构建和测试。合入之后再开始 L3，避免新工作叠在未合入的改动上 | L3 及之后 |
| Q8 | 是否加 `sender_session_id` 和回复链深度上限 | 加；深度上限的默认值取小 | L6 |
| Q9 | 运行时自带的 skill 默认怎么处理 | “运行时自带”开关默认打开。会修改自身配置的几项默认去掉：Codex 的 `skill-installer`，Claude 的 `update-config` 和 `fewer-permission-prompts` | L2、L4 |
| Q10 | 登录账号在 claude.ai 上的连接器怎么处理 | 默认关闭（已实现，§2.7）。哪个 Session 真需要某个连接器，再单独打开并记录 | O7 |
| Q11 | Codex 专用 home 是否关闭 plugin | 关闭（§2.8）。个人 skill 开关打开时，用额外根加入个人目录，不靠 plugin 同步 | L4 |
| Q12 | 运行时自带的 plugin（包括遥测类）怎么处理 | 先只记录，在工作台里归入“自带”。要不要关、怎么关，先查清 CLI 提供的开关再定 | L2、L5 |
| Q13 | 修订里没有 skill 范围的旧 Session 怎么办 | 按 Role 默认处理，工作台标“Role 默认”。要改就由 Agent 经 CLI 发一次修订；不做批量自动迁移 | L3 |
| Q14 | Codex 的 `codex_apps` 是否默认关闭 | 关闭。它用账号令牌认证，带 107 个工具，现在每个 Codex Session 都带着。先查清两点：专用 home 里它还会不会出现；用什么开关关闭。然后在 L4 落地 | L4 |
| Q15 | Codex Session 中途改 skill 范围，怎样生效 | 先实测 `thread/resume` 带新的 `config` 是否生效。不生效就退回输入注入：新加的 skill 经材料 CLI 读全文，工作台注明“经材料 CLI” | L3、L4 |

## 7. 风险与未知

- Codex 的 Thread 级 `config` 能控制送到模型的 skill，模拟 API 和真实 DeepSeek 都已实测（§2.8）。剩下两项风险：这是未写入文档的配置键，升级后可能变化（O8）；实际清单只能推导。
- 共用个人 home 时，plugin 会在进程运行期间带进新的 skill（§2.8）。专用 home 关闭 plugin 后没有观察到这种情况，但只测了空 home 的 20 秒。
- 专用 home 里会建 memories、goals 等存储。所有 Session 共用一个 home 时，这些存储会不会让一个 Session 的内容进入另一个 Session，还没查。
- 账号连接器只出现过一次，后来没能重现（§2.7）。两个开关都来自 CLI 代码和这一次观察，没有文档依据。
- Claude 的自带 plugin 随 CLI 版本增加，真实运行里就多了一个遥测类的。skill 白名单只管 skill，管不了 plugin 的其他行为。
- Codex 的 plugin 接口仍在开发中，格式可能会变。
- Claude 的 plugin 前缀会改变 skill 名字，现有正文里按名字的引用要随之调整。
- 钥匙串条目名的规律，是从二进制字符串推断的，不是来自文档；CLI 升级后可能改变。
- Claude 的初始化消息在提示送出后才到达，“配置了但没加载”只能事后记录，不能在同一个 Turn 发送前拒绝（§2.7）。
- skill 跟着目录走，不固定内容版本，所以同一个 Session 前后两个 Turn 可能读到不同内容。每个 Turn 记录内容哈希，能看出变化，但不会阻止。
- Claude 在 project 上下文模式下，会经原生发现读一次 `<cwd>/.claude/skills`；如果再经链接的 plugin 读一次，同一个 skill 会出现两份。实现时只能取一条路径。
- 共用个人 home 时，每个 Codex Session 都带着 `codex_apps`：它用账号令牌认证，有 107 个工具，现在没有记录（Q14）。
- 本文列出的目标，目前都还没有真人使用的证据。
