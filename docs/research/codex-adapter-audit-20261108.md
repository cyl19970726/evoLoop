# Codex 适配器审计，以及任务引擎怎样给受管会话推送信息

> 性质：研究证据和建议，**不是采纳决定**。代码基线为 `main@d8f60eb`，日期 2026-11-08。
> 配套文档：[Claude Agent SDK 集成方案](claude-agent-sdk-integration-20261108.md)、[Codex × Claude 并存抽象](runtime-coexistence-codex-claude-20261108.md)。
> 权威设计以 [codex-integration.md](../architecture/codex-integration.md) 为准，本文只做核对和提问。

## 0. 结论

1. **整体设计是合理的。** 它有四个支柱：
   - 先落库，再发一次；
   - 每个 owned Thread 只有一个写者；
   - 不在 Turn 中途插话（不用 `turn/steer`），所有输入都开一个新 Turn；
   - 用输入首行的操作标记对账，结果未知就停下，不重试。

   这四条足以保证“同一业务意图不会被执行两次”，也让换 provider 的成本可控。主要短板有三处：
   - **单个共享 App Server 进程的故障影响面**：一处协议错误会断开所有 Session；
   - **推送全靠 2 秒轮询、只能按 Turn 粒度送达**；
   - **普通消息执行至今只做过 fake adapter 与 PG 验证**。
2. **推送路径共有五条**，见 §1。前四条是推：Run 首包、普通会话消息（含 Leader 通知）、Task 通道答复（通过新 Run）、原生提问应答。第五条是拉：执行者用业务 CLI 自取原件。
3. **“send to thread”要分两种情况**，见 §2：
   - 从 evoLoop 工作台或 CLI 给 owned Session 发消息：**支持，但有条件**，最好的状态也只是 `unverified`。
   - 从 Codex Desktop、`codex` CLI 或其他 App Server 客户端直接往 evoLoop 创建的 Thread 里发：**明确不支持**，见 `codex-integration.md` 的排他条款。
4. **适配器审计**（§4）：
   - **1 个高危**，已复现：stdin 上没有 `error` 监听，EPIPE 会让整个 coordinator 崩溃。
   - **4 个中危**：共享进程的故障影响面；托管压缩基本多余，它重复了 App Server 的自动压缩，却漏了识别上下文超限；用户全局 Codex 配置会透传给子进程；没写出去的请求也被标成 unknown。
   - 另有若干低危和潜在问题。
5. **Claude Agent SDK 的推送**（§5）可以原样沿用这套语义，只把原生调用从 `thread/resume + turn/start` 换成 `query({resume})`。MVP 推荐“每个 Turn 起一次 query”。Claude 支持中途插话（流式输入的 `priority`），但按不变量**默认关闭**。

---

## 1. 任务引擎怎样给受管 Codex Session 推送信息

### 1.1 总览

```mermaid
flowchart LR
  subgraph 业务源
    T[Task / Loop Dispatch / 常驻队列 / 评审包]
    H[人在工作台发消息]
    N[PG 触发器：交付、提问、阻塞、待办…]
    Q[执行者在 Task 通道提问 → Lead 答复]
    U[原生 requestUserInput]
  end
  subgraph 协调器（全部 2s 轮询）
    RR[RuntimeRunner.pump<br/>runner.ts:402]
    MP[SessionMessagePump<br/>session-messages/pump.ts]
    LN[LeaderResultNoticePump<br/>leader-results/pump.ts]
  end
  subgraph Codex App Server（单个子进程）
    TS[thread/start]
    TR[thread/resume full/never]
    TT[turn/start]
    RU[RPC 应答 requestUserInput]
  end
  T -->|runtime.session.reserve / runtime.run.reserve| RR
  Q -->|答复固定进下一个 Run 的输入| RR
  H --> MP
  N --> LN -->|写成普通消息| MP
  U -->|session.input.reply 先落库| RR
  RR --> TS
  RR --> TR --> TT
  MP -->|qualify → resume| TR
  RR --> RU
```

### 1.2 五条通道

| # | 通道 | 谁触发 | 代码入口 | 原生调用 | 幂等与对账 | 时延 |
|---|---|---|---|---|---|---|
| A | **Run 派发**：Task 首包 | Loop 派发、常驻队列、手工 Run、评审包 | `runtime/runner.ts:940-1040` | 没有 Thread 时先 `thread/start`；之后 `thread/resume`，再 `turn/start` | 先 `beginDispatch` 落库输入哈希。首行写 `[evoloop-run-operation:<id>]`，结果未知时扫描前 20 个 Turn 找这个标记 | 轮询间隔 2s |
| B | **普通会话消息** | 人在工作台发；Leader 通知；Task 待办 | `session-messages/pump.ts:73-130` | `qualifyConversationThread`（`thread/read` 指纹），然后 `startConversationTurn`（resume 加 turn/start） | 先 `beginDispatch` 落库，并保存只读策略指纹。首行写 `[evoloop-message-operation:<id>]` | 2s，每轮最多处理 30 条 |
| C | **Task 通道问答** | 执行者经 CLI 提问，Lead 答复 | Task 通道和 runner | **不单独发**。答复只在原 Turn 已知终态后，作为**下一个 Run 的固定输入** | 同 A | 原 Turn 结束，再加一次派发 |
| D | **原生提问应答** | 模型调用 `item/tool/requestUserInput` | `runtime/native-input.ts`、适配器 `handleNativeInput` | 在同一条活连接上回 RPC 应答 | 先落库署名回复意图，最多发一次。重启后不会向新连接重放 | 2s；连接断开后就答不了了 |
| E | **拉取**（不是推送） | 执行者自己 | `evoloop-workflow` skill、业务 CLI | 模型用 shell 调 CLI | 由 `ordinary.submit` 落库 | 即时 |

几点补充：

- **Leader 通知是 B 通道的一个来源。** PG 触发器写入 inbox 后，`LeaderResultNoticePump` 把它写成 `SessionMessage` 投给 Lead 的 owned Session（`leader-results/pump.ts`）。所以“worker 交付后 Lead 被唤醒”本质上就是一条普通消息。
- **Loop 派发每次新建 Session。** 编排器先 `runtime.session.reserve`，再 `runtime.run.reserve`（`orchestration/runner.ts:467,488`），由 `RuntimeRunner.pump` 发 `thread/start` 和首包。常驻队列则在一个已采纳的顺序内复用同一个 Session。
- **同一 Session 的 A、B 通道共享“槽位 + 恢复门”。** `canStart` 保证两点：Task 答复先于普通消息；普通 Turn 之后要先放行一个已就绪的业务 Turn（`pump.ts:36`）。
- **首包内容有边界。** 只放固定的 TaskRevision、Basis、材料目录、CLI 入口和角色上下文，正文上限 256 KiB（`runner.ts:788`）。长正文由执行者通过通道 E 自取。

### 1.3 共同规则（两个 provider 都必须保持）

1. **先落库，再发一次。** 原生应答丢了也不是重试信号，状态转成 `unknown`，再按原操作标记回读。
2. **只开新 Turn，不中途插话。** 不用 `turn/steer`，所以答复、纠偏和新消息都要等当前 Turn 结束。
3. **一个 Thread 只有一个写者。** 数据库槽位只能协调 evoLoop 自己的写者，挡不住外部客户端。
4. **Turn 完成不等于任务被接受。** 普通消息 Turn 完成、执行画像 active、Task 验收是三件各自记录的事。

---

## 2. 我们创建的 Session 能不能“send to thread”

| 发送方 → 目标 | 结论 | 依据 |
|---|---|---|
| evoLoop 工作台或 CLI → **owned** Session（普通消息） | **支持，但有条件**。最好的状态是 `unverified`：已保存，不保证回复 | `session-messages/execution-capability.ts`；`codex-integration.md` 关于 `capabilities.ordinaryExecution` 的段落 |
| Leader 通知 → Lead 的 owned Session | 支持，走同一条 B 通道 | `leader-results/pump.ts` |
| evoLoop → **external** Codex Desktop 会话 | **只能人工转交**（`manual-handoff`），不会自动唤醒 | `execution-capability.ts:33-37` |
| **Codex Desktop、`codex` CLI 或其他 App Server 客户端 → owned Thread** | **不支持，明令禁止** | `codex-integration.md`：“owned Thread 由 evoLoop 排他派发；不能同时用其他原生客户端向同一 Thread 发送输入” |

### 2.1 evoLoop 自己发：要逐项满足的条件

按 `execution-capability.ts` 的判定顺序：

1. 当前身份对项目有 read 和 write 权限。
2. 目标是 owned Session；`runtimeState=ready`；`capabilities.send.mode='owned-conversation'`。
3. Session 已绑定 `nativeThreadId` 和 `nativeSessionId`。
4. 配置里 `sessionMessages.enabled` 和 `runtime.enabled` 都已打开，runner 可用。
5. Session 是 `danger-full-access + never`，执行画像为 `active`。
6. 当前 Session 执行授权存在。
7. **存在精确的消息 grant**：projectId、sessionId、发送人、接收角色和 cwd 全部一致。接收 actor 不能是发送人本人，并且两人都是项目写者。
8. cwd 经过核对。
9. `maxTurns` 额度没有用完。这里的 Turn 指普通消息 Turn，不是模型的单步。
10. 会话不忙。

即使全部满足，返回的也是 `unverified / NATIVE_EXECUTION_UNVERIFIED`：真正执行前还要再核原生权限回执、Task 答复顺序和持久占用。按 `codex-integration.md` 的说法，这条路目前**只经过 fake adapter 和专用 PG 测试**，“尚无 Lead 对该策略的实际原生使用”。

**所以，“工作台上能发”成立，“发了一定会被处理”没有保证，“真实模型下验证过”还没有。** 常见卡点有：没配 grant、`sessionMessages.enabled` 默认关闭、执行画像还没 active。

### 2.2 为什么不允许 Desktop 往 owned Thread 里发

- **会被并进正在跑的 Turn。** 当前协议可能把后到的输入并入已有 Turn，也没有跨客户端的原子“仅空闲时启动”。外部消息会混进 evoLoop 的 Run，污染它的结果和对账。
- **数据库槽位看不到外部写者。** 原生空闲检查做完之后，外部客户端仍可能抢先启动。
- **对账会失效。** 外部 Turn 里没有操作标记，`listTurns` 前 20 个窗口里会出现“陌生 Turn”。轻则把窗口挤满，重则让结果未知的 Run 永远找不到匹配。
- **已有的防护只能事后发现。** 外部客户端占住 Thread 时，`thread/resume` 会被 `-32600` 拒绝（`preTurnWriterConflict`），Run 或消息就转成 `unknown`，要复核后才能继续（`runner.ts:998-1003`、`pump.ts:117-121`）。它不会损坏数据，但需要人工处理。

### 2.3 Desktop 为什么可能“看得见”这些 Thread（未验证，建议修）

适配器给子进程透传了 `HOME` 和 `CODEX_HOME`（`adapter-codex-app-server/src/index.ts:49-56`）。owned Thread 的 rollout 因此写在用户自己的 `~/.codex` 下，Desktop 很可能在会话列表里列出它们，并允许直接输入。**这正是最容易诱发误发的入口**。建议给 coordinator 单独设一个 `CODEX_HOME`（见 §4 C4）。这样还能顺带解决用户全局配置污染 owned Thread 的问题。

---

## 3. 设计评估

### 3.1 做得对的地方

- **没有“恰好一次”的假设。** 原生 request ID 不被当作幂等键，而是用业务操作 ID 写进用户输入作为对账依据。这是在不可靠 RPC 上能做到的最稳的方案。
- **不中途插话。** 一个 Turn 对应一份固定输入和一个结果，审计、评审包、重放都有清楚的边界。
- **知识外置。** 首包有边界，长正文按需拉取，换 provider 不需要迁移上下文。
- **结果未知时停在 `unknown`**，再由复核者带证据放行（`preTurnProof`）。这一条没有让步。
- **对整个原生协议钉版本**（对 schema 做 SHA-256），升级时必须显式复核。

### 3.2 值得商榷的地方

| 问题 | 现状 | 建议 |
|---|---|---|
| **故障影响面** | 所有 owned Session 共用一个 App Server 子进程。非法 server request、审批监听失败、EPIPE、协议错误都会 `disconnect()` 整条连接，所有进行中的 Turn 一起变成 unknown | 短期：单个请求失败只拒绝这个请求，不断开整条连接。中期：可选每个 Session（或每 N 个）一个子进程；Claude 天然就是每会话一个进程 |
| **时延** | runner、消息 pump、Leader 通知都是 2s 轮询；Lead 的纠偏要等当前 Turn 结束 | 用 PG `LISTEN/NOTIFY` 唤醒 pump，保留轮询兜底。“Turn 结束才送达”是有意的取舍，应在 UI 上明说 |
| **执行状态不透明** | 普通消息最好也只显示 `unverified` | 在真实原生环境做一轮有界验收，产出可展示的“上次实跑时间和结果” |
| **对账窗口有界** | 结果未知时只扫描前 20 个 Turn，归档回读窗口是 20×100 | 现在够用；外部误写或长寿命 Session 会把窗口挤满，届时需要游标式回读 |
| **Loop 每次派发都新建 Session** | 没有池化，每次都要重新加载上下文、skill 和项目文件 | 这对“知识外置”是好事，但成本高。先量化，再决定是否引入有界复用 |
| **全局配置透传** | 见 §4 C4 | 单独设 `CODEX_HOME` |

**总体判断：这套语义可以作为并存抽象的基线。** 抽象层要中立化的是“怎样开一个新 Turn、怎样按操作 ID 找回它”，而不是推送策略本身。

---

## 4. 适配器审计发现

状态说明：**已复现** 指本机实测；**代码确认** 指读代码能确定行为，但没有跑真实原生环境；**潜在** 指现有调用路径不会触发；**未验证** 指推测。

| ID | 严重度 | 状态 | 一句话 |
|---|---|---|---|
| C1 | **高** | 已复现 | `child.stdin` 没有 `error` 监听，EPIPE 会让 coordinator 进程崩溃 |
| C2 | 中 | 代码确认 | 单进程共享连接，任何一处协议错误都会断开所有 Session |
| C3 | 中 | 代码确认（含 Codex 源码） | 托管压缩基本多余：App Server 在 Turn 前、中、后都会自动压缩，超限失败后下一个 Turn 也会先压缩。此外它只在 alpha.6 下能用；真正缺的是识别 `contextWindowExceeded` |
| C4 | 中 | 代码确认（影响未验证） | 透传 `HOME`/`CODEX_HOME`，用户全局配置会进入 owned Thread，Desktop 也能看到这些 Thread |
| C5 | 中低 | 代码确认 | 明确没写出去的请求也被标成 `RuntimeUnknownError`，产生多余的 unknown 和恢复门阻塞 |
| C6 | 低 | 代码确认（已更正） | 浏览器读取是全局单飞，其他 Session 并发调用会直接被拒；超时会拆掉整个浏览器后端。初稿说的“误伤其他 Session”不成立 |
| C7 | 低 | 潜在 | `create()` 忽略 `spec.reasoningEffort`，绑定和 `specOf` 的字段不对称 |
| C8 | 低 | 代码确认 | `seenToolCalls` 和 `bindings` 只增不减，长时间运行会占用越来越多内存 |
| C9 | 低 | 未验证 | 关闭时只 SIGTERM 直接子进程，Codex 拉起的 shell 命令可能成为孤儿 |
| C10 | 信息 | 代码确认 | 有不可达分支；readline 没有单行长度上限 |

### C1【高】stdin 没有 `error` 监听，EPIPE 会让进程崩溃

- **位置**：`packages/adapter-codex-app-server/src/index.ts:475-508` 拉起子进程，只给 `child`、`stdout`（readline）挂了监听，`stderr` 也只是 `resume()`。`:547-550` 的 `send()` 只同步检查 `stdin.writable`。
- **复现**（Node v24.22.2）：子进程先关闭自己的 fd 0 并保持存活，父进程再写入，结果是 `Unhandled 'error' event … write EPIPE`，**父进程以退出码 1 退出**。另一种情况是子进程已经退出、stdin 已被销毁，这时写入不会崩溃，所以问题只出在“正在退出、还没被回收”的窗口里。
  ```js
  const child = spawn('/bin/sh', ['-c', 'exec 0<&-; sleep 2'], { stdio: ['pipe','pipe','pipe'] });
  setTimeout(() => { for (let i=0;i<4;i++) child.stdin.write('x'.repeat(1<<20)+'\n'); }, 300);
  // → node:events: throw er; // Unhandled 'error' event — Error: write EPIPE
  ```
- **触发场景**：App Server panic、被 OOM kill，或者升级时进程正在退出。此时协调器可能刚好在写 `turn/start`、审批应答或动态工具结果。
- **影响**：coordinator 整个进程退出，HTTP API、所有 pump 和所有 Session 一起断掉。`dispatching` 状态的记录要等重启后再对账。
- **建议**：
  ```ts
  child.stdin.on('error', () => { if (this.child === child) this.disconnect('stdin error', 'stdin_error'); });
  ```
  `NativeChildStopReason` 里增加 `stdin_error`。再补一个用例：在 fixture 里先关 stdin、再写入，断言进程不崩，并且 pending 请求以 `RuntimeUnknownError` 结束。
- **对并存的意义**：Claude SDK 也会拉起 CLI 子进程，并且通过 stdin 传流式输入，同样要做这项防护。建议写进契约测试（并存文档 §7）。

### C2【中】单进程共享连接，故障影响面是全部 Session

- **位置**：`index.ts:714`（非法 server request 时 disconnect）、`:766-767`（审批监听失败时 disconnect）、`:799-831`（`disconnect()` 让所有 pending 请求失败并清空 freshThreads）。
- **影响**：一个 Session 的异常输入会让**所有** Session 进行中的 Turn 一起变成 unknown，带来大批人工复核。
- **建议**：只拒绝那一个请求（回 `-32600`），不断开整条连接；只有协议层确实失去同步（比如 JSON 解析失败）时才断开。中期在 `RuntimeCapabilities.process` 里区分 `shared` 和 `perSession`（并存文档 §4 已有这个字段）。

### C3【中】托管压缩基本是多余的，真正缺的是“上下文超限”的失败识别

- **版本限制**：`index.ts:1235`、`:1279` 要求 `expectedVersion === "codex-cli 0.166.0-alpha.6"`；`apps/coordinator/src/configuration.ts:125` 的默认值是 `0.166.0-alpha.5.1`，同时允许 `0.167.0-alpha.3.2`。所以默认配置下，`runtime.compact.start` 每次都会抛 `compaction observation requires pinned alpha.6`。`docs/development/owned-compaction.md` 没写这个限制。
- **前提站不住。** 我读了 Codex 源码 `codex-rs/core/src/session/turn.rs`，核对了 tag `rust-v0.166.0-alpha.5.1`、`rust-v0.166.0-alpha.6` 和 main。App Server 自己会在三个时机自动压缩：
  - **Turn 开始前**（`run_pre_sampling_compact`）：超过 `model_auto_compact_token_limit` 就先压缩，再接收新输入；
  - **Turn 进行中**（`CompactionPhase::MidTurn`）：达到上限、而模型还要继续时压缩，然后接着跑；
  - **Turn 结束后**（`PostTurn`）：可配置阈值。
- **超限失败后也能自愈。** 采样请求遇到 `ContextWindowExceeded` 时，Codex 会让本 Turn 失败，同时调用 `set_total_tokens_full()`。这个调用会发出一个 `TokenCount` 事件并写进 rollout；resume 时由 `last_token_info_from_rollout()` 读回（`session/mod.rs`）。所以**在同一个 Thread 上开下一个 Turn，会先自动压缩再执行，进程重启后也一样**。对 evoLoop 来说，就是恢复门 retry 或 resume 时发出的那个 Turn。
- **手动压缩也帮不上自动压缩失败的情况。** 自动压缩本身失败时（比如压缩请求或远端压缩出错），`thread/compact/start` 走的是同一段压缩实现，大概率同样失败。这一点没有实测。
- **实现上的缺口。** 准入只检查原 Run 或消息是 `failed`/`interrupted`，**不检查失败原因**。而 `turnFailure()`（`index.ts` 顶部）只从错误消息里解析 HTTP 状态，**没有读取 App Server 的 `codexErrorInfo`**，上下文超限只会被归成 `native_failure`。也就是说，系统分不出“这次失败该不该压缩”。
- **结论**：它不是有 bug，安全上反而很谨慎：先落库、对账有边界、不会自己打开恢复门。问题是方向偏了：它为一件原生运行时会自动完成的事，加了一张表（迁移 058）、HTTP/CLI 入口和对账逻辑；真正缺的失败识别却没做。
- **建议**：
  1. 在 `RuntimeTurnFailure` 里增加 `category: 'context_window_exceeded'`，来源是原生 `codexErrorInfo`。恢复界面据此提示：“在原 Thread 上 retry 或 resume 即可，原生会在下一个 Turn 开始前自动压缩。”
  2. 托管压缩降级为**可选维护工具**，不再列入并存 MVP，能力位设为 `compaction.mode='provider-auto'`。是否删除请维护者决定；保留的话，修正 alpha.6 的版本限制，并在文档里写明。
  3. 在真实原生环境里补一次验证：制造一个超限失败的 Turn，在同一个 Thread 上 retry，确认 rollout 里出现 `contextCompaction` Item，并且 retry 成功。
- 这条动机来自 PR #210“Leader 维护”。当时 Leader 的那次故障是不是上下文超限、自动压缩有没有失败，仓库里**没有证据**，需要问维护者。

### C4【中】用户全局 Codex 配置透传给子进程

- **位置**：`index.ts:49-56` 的 `CHILD_ENV_KEYS` 包含 `HOME`、`CODEX_HOME` 和 `XDG_*`。
- **影响**（未逐项实测）：
  1. 用户 `~/.codex/config.toml` 里的 MCP server、model provider、profile 和 hooks，以及全局 `AGENTS.md`，会进入 owned Thread，**同一份 Task 在不同机器上行为不同**。
  2. rollout 写进用户自己的会话目录，Desktop 能看到，诱发 §2.2 的误发。
  3. `owned-compaction.md` 要求压缩前回读“有效 hooks”，说明维护者已经意识到这类污染，但没有从根上隔离。
- **建议**：coordinator 使用专用的 `CODEX_HOME`（例如 `~/.evoloop/codex-home/<deployment>`），只放入认证材料，其余配置全部通过 `threadConfig` 显式下发。对 Claude，对应的做法是 `settingSources: []` 或 `['project']` 加专用 `CLAUDE_CONFIG_DIR`（并存文档 F25）。

### C5【中低】没写出去的请求被标成 unknown

- **位置**：`index.ts:578-588`。`write()` 里 `send()` 同步抛出的 `"App Server disconnected"`（这时**确定没有写出**）被 `fail()` 包成 `RuntimeUnknownError`。`runner.ts:1022-1028` 又把 `startTurn` 的任何异常一律 `markRunUnknown`。
- **影响**：断线瞬间派发的 Run 或消息会被标成“结果未知”，堵住恢复门，需要人工复核。普通消息 pump 对“明确拒绝”有 `failBeforeStart` 分支，Run 路径没有，两边处理不一致。
- **建议**：`send()` 同步失败时，抛一个带 `notSent: true` 的 `RuntimeProtocolError`，runner 对它走 `rejectDispatch`（可以安全重派），和消息 pump 保持一致。
- **对并存的意义**：并存文档 §4 的中立错误类型应包含 `RuntimeNotSentError`，与 `RuntimeUnknownError` 明确区分。

### C6【低】浏览器读取是全局单飞，超时会拆掉整个后端（2026-11-08 更正）

- **位置**：`apps/coordinator/src/main.ts:348` 的 `cancelDynamicTool:()=>browserRead.close()`，由 `index.ts:754-757` 在超时后调用。适配器传入的参数已经带了 `call`（含 callId）和 `binding`，只是 `main.ts` 没用。
- **更正**：初稿写的“一个 Session 的慢页面会让其他 Session 正在进行的读取失败”**不成立**。原因是 `BrowserReadBridge.call()`（`apps/coordinator/src/runtime/browser-read.ts:310-316`）是全局单飞的：`busy` 时直接返回拒绝，后端也只绑定一个 token 和 scope（`:334-336`）。超时的时候，被关掉的只能是这一次在途调用自己。
- **实际问题**：
  1. 超时后整个 Chromium 后端被关闭，下一次调用要重新拉起。这只是性能代价。
  2. 更值得注意的是单飞本身。多个 Session 同时用浏览器读取时，后来的调用直接拿到 `Browser read unavailable`，不会排队。Session 并发多了以后，模型看到的就是随机失败。
- **建议**：关闭逻辑短期不用改。要支持多个 Session 并发读取时，改成按 binding 分 context 的池，忙的时候排队，或者明确告诉模型“正忙、稍后重试”，不要返回 `unavailable`。这是容量问题，不是正确性问题。

### C7【低｜潜在】`create()` 忽略 reasoningEffort

- **位置**：`index.ts:865-899`。`thread/start` 不发 effort，生成的绑定里也没有 `reasoningEffort`；而 `runner.ts:97-105` 的 `specOf` 会带上它。
- **现状**：`runtime.session.reserve` 命令没有 effort 字段（`contracts/src/runtime.ts:38`），保留时的执行画像 effort 恒为 NULL；带 effort 的修订只在 Thread 绑定之后、经 `activateExecutionProfile` 生效（`index.ts:980`），所以**目前不会触发**。
- **风险**：一旦以后在保留阶段加入 effort，`registerBinding(bindingOf(session))` 会因 `sameBinding` 不一致抛 `conflicting runtime binding`。
- **建议**：要么在 `thread/start` 里发 effort 并写进绑定，要么在 `create()` 收到带 effort 的 spec 时明确拒绝。

### C8–C10【低】

- **C8**：`seenToolCalls`（`:276`）从不清理，`bindings` 只在关闭时清理。建议按 Turn 结束或连接更换清理，或者加 LRU 上限。
- **C9**：`disconnect()` 用 SIGTERM 杀直接子进程。如果 Codex 没把信号转给它拉起的 shell 命令，就会留下孤儿进程（未验证）。建议用进程组启动（`detached: true` 再 `process.kill(-pid)`），或者在关闭时回读确认。
- **C10**：`:779` 处对 `mcpServer/elicitation/request` 的分支不可达，因为 `:718` 已经提前分流了。readline 没有单行长度上限，一行超大 JSON 会全部缓存在内存里。

### 4.1 已核对、没有问题

- `stderr` 已经 `resume()` 排空，不会因为管道写满而卡住子进程。
- resume 时会按当前业务范围重建动态工具白名单，旧声明不会残留。
- 审批默认 `decline`，Thread 创建期间的审批一律拒绝。
- 超时之后迟到的 `turn/start` 应答会被丢弃，这没问题，因为标记对账能找回。
- `open()` 重入和关闭后不能再用：runner 每次都会新建适配器（`runner.ts:449-480`），所以只是潜在问题。
- `startTurn` 的 effort 校验（`:1446`）与绑定一致；之前怀疑的“effort 来源不一致”**排除**。

---

## 5. 任务引擎怎样给 Claude Agent SDK 推送信息

### 5.1 原则：语义不变，只换原生调用

§1.3 的四条共同规则全部保留。只有“开新 Turn”和“按操作 ID 找回 Turn”两件事由 provider 实现。

| 通道 | Codex（现状） | Claude Agent SDK（建议） |
|---|---|---|
| A. Run 派发 | 先 `beginDispatch` 落库，再 `thread/resume`（full/never），再 `turn/start`（首行带标记） | 先 `beginDispatch` 落库，**并预先生成 `SDKUserMessage.uuid` 一起落库**，然后 `query({ prompt: [该消息], options: { resume: nativeSessionId, cwd, model, permissionMode: 'bypassPermissions', settingSources, mcpServers, hooks, maxTurns: maxAgentSteps, maxBudgetUsd, abortController } })`。首行仍写 `[evoloop-run-operation:<id>]`，让两个 provider 共用同一套对账代码 |
| 新 Session 创建 | `thread/start` 应答之后才拿到 threadId | `Options.sessionId` 由我方预先生成并**先落库**，消除“创建应答丢失”这种未知态 |
| B. 普通消息 | 先 `thread/read` 算指纹，再 resume 和 turn/start | 同 A，开一个新的 query。**不用 `priority: 'now'`** |
| C. Task 通道答复 | 作为新 Run 的固定输入 | 不变 |
| D. 原生提问 | RPC 只能在活连接上答；重启后就答不了 | 两种做法：一是 `canUseTool` 拦下 `AskUserQuestion`，转给 `session.input.reply`（同样依赖活进程）；二是 PreToolUse hook 返回 **`defer`**，`result.deferred_tool_use` 落库，结束本次 query，答复后再 `resume` 带回答案。第二种能**跨重启**，比 Codex 强，需要 spike 验证（S6） |
| 中断 | `turn/interrupt(turnId)` | `abortController.abort()` 或 `Query.interrupt()`。不按 turnId 区分，适配器要先核对当前 inflight 的是不是那个 Turn |
| 结果未知时对账 | `thread/turns/list` 加 `listItems`，查找标记 | 用 `getSessionMessages(sessionId)` 在转录里找**预生成的 uuid**，没找到再退回找标记 |
| 观测 | 8 类原生通知 | 流式的 `SDKMessage`（assistant、user、tool_use、result、system），投影到 NativeObservation |
| E. 拉取 | 模型调用 shell 运行 evoloop CLI | 同样用 Bash 工具运行同一个 CLI。可选：用 `createSdkMcpServer` 提供进程内 MCP 工具，例如 browser-read |

### 5.2 进程形态：选 A，B 以后再说

| | **A. 每个 Turn 起一次 query 并 resume**（推荐 MVP） | **B. 常驻流式输入**（一个 Session 一个长连接） |
|---|---|---|
| 对应 Codex 的 | `thread/resume` 加 `turn/start` | 长连接加 steer |
| 故障隔离 | **单个 Session 级别**，顺带解决 C2 | 单个 Session 级别 |
| 重启恢复 | 无状态，下一次 resume 即可 | 要重建长连接 |
| 冷启动 | 每个 Turn 都要拉起一次 CLI（秒级） | 只拉起一次 |
| 中途插话 | 不可能，天然满足“不插话”不变量 | **可以**（`priority`），必须用策略关掉 |
| 结论 | 与现有 runner 和 pump 的形状完全一致，适配器内部就能实现 | 等需要低时延对话时，作为 `delivery.midTurnInput` 能力位再开放 |

### 5.3 Claude 特有的风险

1. **排他规则同样适用。** 用户在终端 `claude --resume <id>` 打开同一个 owned Session，就相当于 Desktop 往 owned Thread 里发。转录是追加写入的 JSONL，两个写者会让历史分叉。对策有三条：使用专用 `CLAUDE_CONFIG_DIR`，相当于 C4 的隔离；人工查看用 `forkSession`；排他规则写进并存文档的 I3。
2. **没有显式的“Turn 终态”记录。** 转录里只有消息。要判定“我方 uuid 后面出现 `result`，或者末尾是一条不含未决 `tool_use` 的 assistant 消息”才算终态，否则保持 unknown。协调器在 Turn 进行中崩溃时，CLI 子进程会随之退出，这一类要归到“中断，结果未知”，**不能视为失败后重派**。
3. **插话能力要按策略关闭。** `SDKUserMessage.priority`（`now`/`next`/`later`）和 `result.queued_turn_count` 让 Claude 能在 Turn 进行中排队或打断。默认禁用，留给以后显式开放（spike S2/S14）。
4. **`maxTurns` 的命名冲突。** evoLoop 的 `grant.maxTurns` 是普通消息 Turn 的额度；Claude 的 `Options.maxTurns` 是一次 query 内模型来回的步数。并存文档已建议把后者改名为 `maxAgentSteps`。

### 5.4 对并存抽象的补充

在并存文档 §4 的 `RuntimeCapabilities` 里建议增加：

```ts
delivery: {
  newTurnOnly: true;                       // 两个 provider 当前都按策略只开新 Turn
  midTurnInput: 'none' | 'queued' | 'interrupting'; // Codex 为 'none'（不用 steer）；Claude 能力上是 'queued'，按策略关闭
  callerAssignedTurnKey: boolean;          // Codex 为 false（靠标记对账）；Claude 为 true（SDKUserMessage.uuid）
  callerAssignedSessionId: boolean;        // Codex 为 false；Claude 为 true（Options.sessionId）
};
errors: 'unknown' | 'notSent' | 'rejected'; // 对应 C5
```

---

## 6. 建议的处理顺序

1. **C1**：改一行，再加一个用例。和 Claude 适配器共用同一条契约测试。
2. **C5**：把 `notSent` 从 `unknown` 里分出来，减少无谓的人工复核。可以并入并存 P1 的中立错误类型。
3. **C4**：使用专用的 `CODEX_HOME`，同时消除 Desktop 误发的入口。属于部署层改动，需要迁移 auth。
4. **C3**：先补 `context_window_exceeded` 失败分类，并用一次真实超限失败验证“在原 Thread 上 retry 会自动压缩”。托管压缩降为可选维护工具，是否保留由维护者决定。
5. **C2**：缩小故障影响面，随并存 P1 的 `process` 能力位一起设计。C6 已更正为容量问题，等 Session 并发真的上来再处理。
6. 在真实原生环境下对普通消息做一次有界验收，把 §2.1 的 `unverified` 变成有证据的状态。
7. C7–C10 顺手修。
8. **版本绑定**：按 §7 把“精确版本 + 整份 schema 哈希”改成“检查实际用到的接口 + 一致性冒烟测试”。

---

## 7. 版本绑定：为什么要绑，绑得对不对

### 7.1 现在怎么绑的

- `PINNED_PROTOCOLS`（`index.ts:16-37`）硬编码了 5 个版本，其中 4 个是 alpha。`open()` 要求 `codex --version` 和配置的版本**字符串完全一致**（`:472`），还要用 `codex app-server generate-json-schema` 生成**整份** v2 schema，SHA-256 必须和登记值完全一致（`:537-543`）。任何一项不符，就拒绝接入。
- 各项能力的开关散落在代码里，靠比较版本字符串决定：`supportsModernProtocol`、`supportsExperimentalWorkspace`，以及 compaction 的 `=== alpha.6`。

### 7.2 绑定有它的道理

1. **evoLoop 用了实验接口，而官方不保证实验接口的兼容性。** 官方文档原话是：“Omit capabilities … to stay on the stable API surface”。我对照了 Codex 源码 `app-server-protocol/src/protocol/common.rs`（alpha.5.1 和 main），evoLoop 用到的以下接口都标了 `#[experimental]` 或在文档里注明是实验接口：
   - `thread/settings/update`：执行画像激活，也就是换模型或 effort；
   - `dynamicTools` 和 `item/tool/call`：browser-read；
   - `currentTime/read`；
   - `tool/requestUserInput`：原生提问。
2. **用的都是 alpha 版。** 默认的 `0.166.0-alpha.5.1` 和最新登记的 `0.167.0-alpha.3.2` 都是预发布版。
3. **正确性依赖语义，而不只是字段形状。** 恢复和对账都依赖这些字段的具体含义：Turn 状态、`thread.status` 里的 `notLoaded`/`systemError`、`-32600` 写者冲突、`userMessage`/`contextCompaction` 这些 Item 类型、分页方向。在“结果未知不重试”的前提下，一旦误读，可能导致重复派发，或者把失败当成完成。

### 7.3 但现在的做法既过严又不够

- **过严。** 对整份 schema 取哈希，意味着上游的任何改动都会让接入失败，哪怕只是新增一个 evoLoop 根本不用的方法、改一句描述，或者给通知加一个可选字段。版本又要求字符串完全相等，所以每个 Codex 小版本都得改 evoLoop 的代码并重新发布。版本判断散落各处，就会出现 C3 那种“功能开关和默认版本对不上”的错误。
- **不够。** 哈希只能证明字段形状没变，证明不了语义没变。schema 完全相同、但行为变了的情况，照样能通过检查。
- **部署成本高。** 用户要在 Desktop 之外，再单独安装一个指定 alpha 版本的 `codex`。Desktop 自带的二进制会自动更新，没法复用。

### 7.4 建议

1. **先写清执行画像切换的理由，不按接口是否稳定来取舍（2026-11-08 更正）。** 初稿这里建议“尽量只用稳定接口”，和运行时设计准则（提案 PROP-012，草稿尚未进入仓库）的准则 3 不一致：实验接口可以用，前提是做成能力位、写明关闭后的行为，并有一致性用例。所以要问的不是 `thread/settings/update` 稳不稳定，而是“不跑 Turn 就激活并回读”这项要求的理由（准则 2）。理由成立，就保留它并做成能力位；不成立，可以改用 `turn/start` 的按 Turn 覆盖参数。官方文档写明这些参数“会成为该 Thread 后续 Turn 的默认值”，实现更简单。browser-read、原生提问同样做成能力位，可以单独关闭。
2. **schema 只检查实际用到的部分。** 维护一份清单，列出 evoLoop 用到的方法、字段和枚举值。启动时从生成的 schema 里抽出这一部分，规范化后再比较；上游新增内容不再阻断接入。
3. **能力靠探测，不靠版本号。** 例如 schema 里有 `thread/compact/start` 就开启 compaction。把散落的 `expectedVersion === ...` 判断全部换成 `RuntimeCapabilities`，即并存文档 §4 的能力位。
4. **语义用一致性冒烟测试来保证。** 对目标二进制跑一遍真实的最小流程：创建、Turn、标记回读、中断、归档、超限失败，留下证据。用“最低版本 + 已知坏版本名单”替代版本白名单。
5. **精确锁版本是部署时的选择，不是代码里的白名单。** 生产环境仍然可以用配置锁定 `executable` 和版本，但升级只需要重跑冒烟测试，不需要改代码。

**对 Claude 的意义**：`@anthropic-ai/claude-agent-sdk` 的 npm 包里自带 CLI，版本由 lockfile 锁定，属于正常的依赖管理，不需要运行时哈希。两个 provider 的共同点应该是“能力探测 + 冒烟测试”，而不是“版本字符串白名单”。

> 本文没有修改任何代码。C1 的复现脚本只放在本地临时目录，不进仓库。
