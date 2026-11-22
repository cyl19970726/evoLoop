# 里程碑改读本项目的阶段：设计（待需求 Session 确认）

Task `3614a089`。只设计，不含代码和迁移。依据：决定文档 `2c668825` 修订 `bc0c2913` 的“里程碑就是阶段”一节（与下文冲突时以它为准）；甲线报告 `1f2364cd`@`3d21cc20`、`30be9870`@`2b45da66` §4.4，乙线报告 `e8938c31`@`cbc80f19`、`e9e043d7`@`944df843` §4.4（其中“本期在上、M0 到 M4 各一行”已被取代）；现有 [总览顶部设计](overview-top-design.md)、[总览页](pages/overview.md)、[目标与阶段页](pages/journey.md)。读到的现状：`packages/contracts/src/milestones.ts`、`apps/coordinator/src/milestones/index.ts`（读随部署的 `docs/roadmap.md`，不分项目）、迁移 101（`stage_phase_key`）、`project_stage`/`stage_revision`/`stage_review`/`task_proposal.stage_id`、`stage.propose`/`stage.accept`/`stage.review`/`task.create`/`task.update` 命令。

## 一、数据：阶段加四个字段

| 字段 | 含义 | 存放 |
| --- | --- | --- |
| 短名 `shortName` | 表格里一行的名称，≤ 40 字 | 新表 `stage_milestone.short_name` |
| 到期日 `dueOn` | 日期，可空（空写“未定”） | `stage_milestone.due_on date` |
| 检查办法 `checkMethod` | 怎样算到了：谁来查、用什么样本、什么算没到 | `stage_milestone.check_method` |
| 补哪一级 `ladderKeys` | 验证阶梯的级别，多值，如 `{M1,M4}`，元素同 `^M[0-9]+(\.[0-9]+)?$` | `stage_milestone.ladder_keys text[]` |

**为什么用旁表而不是给 `project_stage` 加列**：沿用迁移 101 的做法，`project_stage` 与 `stage_revision` 的既有行和修订链原样不动；旁表一阶段一行，每次改动另追加一行到 `stage_milestone_history`（`stage_id、version、四个字段、actor_id、reason、created_at`，只追加）。

**命令。**
- `stage.propose` 增加四个字段：`shortName`、`checkMethod` 必填，`dueOn` 可空，`ladderKeys` 可为空数组；提出时同时写 `stage_milestone` 与第一条历史。没有这四个字段的老调用仍被接受（见下“向后兼容”）。
- 新增 `stage.milestone.set`（权限同 `stage.phaseKey.set`：review 权限；字段 `stageId、expectedVersion、shortName、dueOn、checkMethod、ladderKeys、reason`）：整组覆盖并追加历史；已回看（`reviewed`）的阶段不允许改到期日，其余字段可改但要写 `reason`。到期日变更必须写 `reason`，历史里可见前后值。
- `stage.phaseKey.set` 保留一个版本只读兼容，之后由 `ladderKeys` 取代。

**现有阶段的补填（backfill），遵守现有修订与决定规则。**
1. 迁移只建表，不猜内容：已有阶段在 `stage_milestone` 里没有行，页面写“未登记”。
2. 把 `stage_phase_key.phase_key` 原样复制成 `ladder_keys = {phase_key}`，其 `actor_id/reason/updated_at` 带入历史，`reason` 前加“迁移自 stage_phase_key”。原表不删，不改。
3. 已有的 M0 到 M4 五个已回看阶段：不补短名之外的字段（到期日留空，检查办法留空），回看记录和修订链不动；它们不在里程碑表里显示（见第二节“哪些阶段进表”）。
4. 五个新阶段 `c6331be2`、`8707e35b`、`972e76f0`、`9824a2d5`、`cd79bfb5`：正文前四行按固定格式“名称、到期、怎样算到了、补哪一级”写成。迁移脚本（一次性，单独的数据迁移，不放进建表迁移）逐个阶段读 `stage_revision` 当前版本的 `deliverable` 前四行，解析成 `shortName/dueOn/checkMethod/ladderKeys` 写旁表；任何一行格式对不上就**整阶段跳过并在迁移输出里列出**，由需求 Session 手工 `stage.milestone.set` 补。正文不删不改（前四行仍在正文里，只是不再是唯一来源），因此不产生新的阶段修订。“到期”写作“12-02（……顺延）”这类带说明的，日期取括号前的 `MM-DD`，年取到期日所在年的最近将来，括号内说明进检查办法前缀，由人核对后才算数（迁移输出标“待人核”）。
5. 迁移后在读回里核对：每个新阶段四个字段都有值，或在输出里被列为跳过。

**回退。** 本迁移只增不改：新建 `stage_milestone`、`stage_milestone_history` 两表，不动 `project_stage`、`stage_revision`、`stage_review`、`stage_phase_key`。回退 = 前端回到读旧接口（旧 `/milestones` 在改造期间保留，见第八节顺序）后，用一个新的前向迁移删这两表；项目迁移约定 `down=false`，所以回退写成前向迁移，需在合并前备份（`local-run.md` 的迁移要求）。数据层面：`stage_phase_key` 与所有回看记录从未被修改，所以回退不丢它们。

**向后兼容。** 没有四个字段的阶段照常显示，缺哪项写“未登记”；`stage.propose` 不带四个字段时 `shortName` 回落为 `deliverable` 首行前 40 字，只是显示回落，不写入旁表。

## 二、读：阶段只读投影

新接口 `GET /api/projects/:projectId/stages/milestones`（项目读权限；旧 `/api/projects/:id/milestones` 在新页面上线并验过之前不删）：

```
{ asOf, today,
  stages: [{ id, goalId, shortName, dueOn, checkMethod, ladderKeys,
             state, status, statusLabel, latestReview: { id, adopted, rejected, gap, nextChoice, createdAt } | null,
             tasks: { inProgress, blocked, closed, total } }],
  unownedTasks: { unclosed },       // 未关闭且没有阶段的任务数
  currentStageId | null, currentNote | null }
```

| 内容 | 来源（表/字段） |
| --- | --- |
| 短名、到期日、检查办法、补哪一级 | `stage_milestone` |
| 状态 | `project_stage.state` + 最新的 `stage_review`（含 `supersedes_review_id` 更正）+ 今天日期，规则见第五节 |
| 最新回看 | `stage_review` 取该阶段最新一条未被更正取代的记录 |
| 任务个数 | `task_proposal.stage_id` 取每个任务最新修订的阶段，再按任务状态分：进行中（已开始、未被阻塞）、卡住（任务页“受阻”同一判定，见 `tasks` 页）、已关闭；个数与任务页按阶段过滤的行数同源 |
| 未归属 | 最新修订的 `task_proposal.stage_id IS NULL` 且任务未关闭的个数（已关闭的不数，决定文档规定不补） |
| 当前阶段 | 服务端给：`state='active'`、没有回看、`dueOn` 最近的那一个；到期日相同取创建更早的；全部没有到期日时不给（`currentNote:"当前阶段未登记"`）。**不要求“恰有一个进行中”**，多个进行中时仍给最近到期的一个，其余照常显示 |

**哪些阶段进表**：默认显示 `proposed`、`active`，以及最近一次回看在 14 天内的 `reviewed`；其余已回看的在“已回看的阶段”折叠里。没有 `stage_milestone` 行的阶段（含迁移前的五个 M0 到 M4）进折叠区，写“未登记短名”，不占主表。

## 三、验证阶梯（M0 到 M4）

| 项 | 设计 |
| --- | --- |
| 来源 | 仍是仓库 `docs/roadmap.md` 的阶段表；每级的“最新状态一句话”取“各阶段现在在哪”表里同级的“现在的状态”首句 |
| 接口 | `GET /api/projects/:projectId/ladder`：`{ available, source:{commit}, levels:[{ key, name, status, evidenceStages:[{id,shortName}] }] }` |
| 谁供证据 | `stage_milestone.ladder_keys` 含该级的阶段，按到期日排；没有阶段补这一级的写“暂无阶段补这一级”，不隐藏 |
| 没有这条阶梯的项目 | 现在的实现读 evoLoop 自己部署目录的路线图，不分项目，**这一点要改**：路线图改为读该项目登记的仓库（`repositories` 里项目自己的 root）的 `docs/roadmap.md`；读不到文件或没有“阶段/要交付什么”表头时 `available:false, levels:[]` |
| 反例处理 | 另一个项目没有路线图：接口返回 `available:false`，总览不渲染阶梯那一行，里程碑页不渲染阶梯小节，也不写“路线图读不到”的报错（那是错误态，这里是“没有”）。读文件出错（权限、IO）才写“阶梯读不到”。必须有测试：无路线图的项目 → 响应 `available:false` 且页面无阶梯 DOM |
| 页面 | 总览折成一行“验证阶梯：M0…M4 · 展开”，里程碑页底部一节，点开每级一行：级别名、状态一句话、供证据的阶段（可点） |

## 四、版面

**总览里程碑块**（只替换该块，其他块的顺序与导航不动）。一阶段一行，五格：名称、到期日、怎样算到了、任务、状态。只有一行标“当前”（浅底加左侧色条）。

1440 宽（线框）：

```
里程碑                                                     验证阶梯：M0 … M4 · 展开 ▸
┌──────────────────────┬────────┬───────────────────────────────┬───────────────┬──────────────┐
│ 名称                 │ 到期日 │ 怎样算到了                    │ 任务          │ 状态         │
├──────────────────────┼────────┼───────────────────────────────┼───────────────┼──────────────┤
▌当前 组织连续7天不用你催 │ 12-02  │ 7 天内 Leader 没有停摆，日程…  │ 进行 2 · 卡住 1 │ 进行中       │
│ 你只看简报和总览就能做完 │ 12-07  │ 使用者自己沿三条路径用一遍…   │ 进行 1 · 卡住 0 │ 已接受还没有任务│
│ 分工按负载收紧         │ 12-09  │ 接不到活的 Session 关掉…      │ 进行 0 · 卡住 0 │ 已接受还没有任务│
│ 你能在工作台里直接交活 │ 12-14  │ 带文件或图片交代一件真实的事… │ 进行 0 · 卡住 0 │ 已接受还没有任务│
│ 第二个项目跑通第一个任务│ 12-16  │ 用接入 skill 接入，第一项任务…│ 进行 0 · 卡住 0 │ 已接受还没有任务│
└──────────────────────┴────────┴───────────────────────────────┴───────────────┴──────────────┘
                                                      另有 N 项未关闭任务未归属阶段 · 去归属 ▸
```

“怎样算到了”一格两行截断，完整文字在里程碑页展开；任务格写“进行 a · 卡住 b”，已关闭数在展开里。

390 宽（线框，每阶段一张两行卡，没有阶段被隐藏）：

```
里程碑            验证阶梯 · 展开 ▸
┌──────────────────────────────┐
▌当前 组织连续 7 天不用你催      │
│ 12-02 · 进行 2 · 卡住 1 · 进行中│
│ 7 天内 Leader 没有停摆…（两行）│
├──────────────────────────────┤
│ 你只看简报和总览就能做完当天的…│
│ 12-07 · 进行 1 · 卡住 0 · 已接受还没有任务│
│ 使用者自己沿三条路径用一遍…   │
└──────────────────────────────┘
5 个阶段中另 3 个同样收成两行 · N 项未归属 ▸
```

实现时还要出真实页面截图（1440×900、390×844），并按 `overview-top-browser.test.ts` 的办法实测首屏：其他首屏块（“要你决定或处理的”）不能因此被推出首屏。

**里程碑页**（现称“目标与阶段”，首屏改为同一张对照表，列与总览相同，宽一些、“怎样算到了”不截断）：点一行展开：该阶段的任务列表（按状态分组，链到任务页）、最新回看（采纳、拒绝、缺口、下一步，链到回看原文）、检查办法全文、补哪一级（链到阶梯对应级）。展开状态写进地址（`?stage=<id>`）。表下方：“未归属的 N 项未关闭任务”折叠区（见第六节），再下面是“验证阶梯”小节。

**缺数据（两种宽度相同的文字）：**

| 缺什么 | 页面写 |
| --- | --- |
| 没有回看 | 状态按第五节推出，最新回看一格写“暂无回看”，不写 0 或“未达成” |
| 有未归属任务 | “N 项未归属”，链到未归属列表；绝不显示成 0；读不全时写“已读 X 项，未读全” |
| 没有到期日 | 到期日格写“未定”，该阶段不参与“当前”的比较，排在有到期日的阶段之后 |
| 没有检查办法 / 短名 | 写“未登记”，短名回落见第一节 |
| 阶段还没有任务 | 任务格写“还没有任务”（不是“进行 0 · 卡住 0”） |
| 没有任何阶段 | 整块写“这个项目还没有阶段”，给提出阶段的入口，不画空表 |

## 五、状态词与推导

| 词 | 推导（数据） |
| --- | --- |
| 已接受还没有任务 | `state='active'`，没有回看，且挂在它名下的任务数（`task_proposal.stage_id`，所有状态）为 0 |
| 进行中 | `state='active'`，没有回看，任务数 ≥ 1，且今天 ≤ `dueOn`（或无到期日） |
| 已到期待回看 | `state='active'`，没有回看，`dueOn` < 今天（服务端日期，上海时区） |
| 达成 | `state='reviewed'`，最新回看 `adopted` 有内容、`rejected` 与 `gap` 都按 `isNoneMarker` 算空 |
| 部分达成 | 最新回看 `adopted` 有内容且 `rejected` 或 `gap` 有内容 |
| 未达成 | 最新回看 `adopted` 按 `isNoneMarker` 算空（沿用 `milestones.ts` 的判定；现状这类写“已回看”，新词替换它） |

没有回看时一律不写达成类词。已提出未接受的（`proposed`）阶段写“未接受”，不进上表也不是“当前”。回看仍用 `stage.review`（采纳、拒绝、缺口三项加 `nextChoice`），更正用 `stage.review.correct`；状态**不按任务完成比例推算**，决定文档如此规定。“已到期待回看”不改数据，只是页面把“到期且无回看”写出来；到期不会自动关闭阶段。

## 六、任务归属

- `task.create` 已有可选 `stageId`；新增规则：必须给 `stageId`，或明确写 `noStage: true`（新字段，含 `noStageReason`）。两者都没有时命令被拒，提示选择。已有的无 `stageId` 老调用在过渡期仍被接受，开关由实现 Task 控制。
- “不属于阶段”：写入任务修订，页面写“不属于阶段”，不计入“未归属”个数（它是明确的选择，不是缺数据）。
- 未关闭任务补归属：现有 `task.update` 已有 `stageId` 但要整份重写正文，容易误改；新增窄命令 `task.stage.set`（`taskId、expectedVersion、stageId | null+noStage、reason`），只追加一个任务修订（只改阶段，其余与上一修订相同）。页面入口：里程碑页“未归属”折叠区每行一个“归到阶段”选择，批量归属由 Leader 用同一命令。已关闭任务不补。
- 任务页头：阶段短名（链到里程碑页该阶段）、或“未归属”、或“不属于阶段”。现有数据里 639 条任务提议均无阶段，第一天任务数全在“未归属”里，这是如实显示。

## 七、实现时要改的文档

| 文档 | 改什么 |
| --- | --- |
| `docs/roadmap.md` | 写明 M0 到 M4 是验证阶梯，不是里程碑；阶段与阶梯的关系（阶段的“补哪一级”）；回看时更新阶梯状态 |
| `docs/frontend/pages/overview.md`、`journey.md` | 里程碑块、里程碑页改写；状态词；缺数据 |
| `docs/frontend/overview-top-design.md` | 在“六个阶段”“phaseKey”“当前阶段”相关处标“已被 milestones-design.md 取代”，保留原文 |
| `docs/architecture/project-data.md` | 新增 `stage_milestone`、`stage_milestone_history`；`task_proposal.stage_id` 的“不属于阶段”；两个新命令 |
| `docs/development/agent-cli.md` | `stage.propose` 新字段、`stage.milestone.set`、`task.stage.set`、`task.create` 的 `stageId/noStage` |
| `docs/development/local-run.md` | 迁移与数据迁移步骤、备份与回退 |

## 八、实施拆分

先做不改界面的数据与读，再改页面，最后收口。每一项用独立 PR，前一项合并后再做下一项。规模按 1–2 天为小、3–5 天为中。

| # | Task | 规模 | 验收方法（样本、操作、预期、反例） |
| --- | --- | --- | --- |
| 1 | 旁表与命令：迁移（两表）、`stage.propose` 字段、`stage.milestone.set`，从 `stage_phase_key` 复制 | 中 | 样本：真实 PG 测试库里先有带 `stage_phase_key` 的阶段与回看。操作：跑迁移，再 `stage.milestone.set`。预期：`stage_phase_key`、`stage_review`、`stage_revision` 行数与内容不变；旁表有复制出的 `ladder_keys`。反例：不带新字段的 `stage.propose` 仍被接受；已回看阶段改到期日无 `reason` 被拒；错格式的 `ladderKeys` 被拒 |
| 2 | 五个新阶段的数据迁移：解析前四行写旁表 | 小 | 样本：五个阶段正文的拷贝。预期：每阶段四个字段与正文一致，或被列为跳过。反例：一个正文把“补哪一级”行删掉，必须被跳过并列出，不写出猜测值 |
| 3 | 投影接口 `/stages/milestones` 与状态推导，含任务个数、未归属 | 中 | 样本：覆盖第五节六个状态各一个阶段，另有未归属任务、明确“不属于阶段”任务、无到期日阶段。预期：状态与个数和任务页过滤行数一致；`currentStageId` 是最近到期的未回看阶段。反例：无回看的阶段绝不出现达成类词；个数为 0 与“未归属”不混；两个进行中阶段不触发“未登记” |
| 4 | 验证阶梯接口，按项目读自己的路线图 | 小 | 样本：有路线图的项目与没有的项目。预期：前者返回各级与供证据的阶段，后者 `available:false`。反例：没有路线图的项目不得返回 evoLoop 的 M0 到 M4 |
| 5 | `task.create` 的 `stageId`/`noStage`、`task.stage.set`、任务页头 | 中 | 样本：新建一项任务带阶段、一项明确不属于阶段、一项两者都不带。预期：第三项被拒（过渡开关关闭时），页头分别写短名、“不属于阶段”、“未归属”。反例：`task.stage.set` 不改正文与验收；已关闭任务拒绝 |
| 6 | 总览里程碑块与里程碑页（两种宽度）、阶梯折叠、缺数据文案 | 中 | 样本：Playwright 夹具含全部缺数据情形。预期：1440×900、390×844 实测首屏，无水平溢出，只一行“当前”；点行展开任务与回看。反例：未归属任务显示“N 项未归属”而不是 0；无路线图项目页面无阶梯 DOM；去掉“当前”只剩一行的限制测试要失败 |
| 7 | 文档收口与旧接口下线 | 小 | 样本：第七节清单。预期：`docs:check` 通过，旧 `/milestones` 无调用方后才删。反例：`overview-top-design.md` 没标“已取代”的地方由检查搜到 |
| 8 | 补归属：Leader 用 `task.stage.set` 给未关闭任务归阶段（运营，不改代码） | 小 | 样本：真实项目的未关闭任务。预期：未归属计数下降到明确的个数。反例：已关闭任务未被改动 |

顺序 1→2→3→4（3、4 可并行）→5→6→7→8。1 和 2 须先于 3，因为投影要读旁表；5 须先于 8；6 在 3、4、5 之后。

## 待确认

以下是为落地增加的设想，与决定文档的方向不冲突，但决定文档没有写，需要需求 Session 确认：

1. 旁表而不是给 `project_stage` 加列，及“只增不改、回退用前向迁移”。
2. “当前”不要求恰有一个进行中，取最近到期的未回看阶段（决定文档写“到期日最近的未回看阶段标当前”，与此一致；`proposed` 阶段是否参与比较，设计取不参与）。
3. 新增的三个命令/字段：`stage.milestone.set`、`task.stage.set`、`task.create` 的 `noStage`，以及“已回看阶段不改到期日”。
4. “已到期待回看”用服务端日期判断，到期不自动改任何数据。
5. 路线图改读各项目自己登记的仓库，需确认哪个仓库登记算该项目的路线图所在。
6. “14 天内已回看的阶段进主表”这个窗口只是设想。
7. “达成/部分达成/未达成”三个词取代现有“已退出/部分成立/已回看”，需确认迁移期是否并存。

## 没有验证的

本文只是设计：没有运行迁移，没有用真实阶段正文试解析（五个阶段正文来自决定文档的表格，不是从库里读的），线框不是真实页面，没有量过首屏，没有人使用过。规模是估计。
