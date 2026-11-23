# 里程碑改读本项目的阶段：设计（第二版，待需求 Session 再读）

Task `3614a089`。只设计，不含代码和迁移。第二版按需求 Session 的核对记录（Document `91fe9562`@`737a6105`）修订，条目 A 到 J 与第三节的结论已并入正文；数字读自生产库 11-22 20:40（需求 Session 提供，我没有重读）。依据：决定文档 `2c668825` 修订 `bc0c2913` 的“里程碑就是阶段”一节（与下文冲突时以它为准）；甲线报告 `1f2364cd`@`3d21cc20`、`30be9870`@`2b45da66` §4.4，乙线报告 `e8938c31`@`cbc80f19`、`e9e043d7`@`944df843` §4.4（其中“本期在上、M0 到 M4 各一行”已被取代）；现有 [总览顶部设计](overview-top-design.md)、[总览页](pages/overview.md)、[目标与阶段页](pages/journey.md)。读到的现状：`packages/contracts/src/milestones.ts`、`apps/coordinator/src/milestones/index.ts`（读随部署的 `docs/roadmap.md`，不分项目）、迁移 101（`stage_phase_key`）、`project_stage`/`stage_revision`/`stage_review`/`task_proposal.stage_id`、`stage.propose`/`stage.accept`/`stage.review`/`task.create`/`task.update` 命令。

## 一、数据：阶段加四个字段

| 字段 | 含义 | 存放 |
| --- | --- | --- |
| 短名 `shortName` | 表格里一行的名称，≤ 40 字 | 新表 `stage_milestone.short_name` |
| 到期日 `dueOn` | 日期，可空（空写“未定”） | `stage_milestone.due_on date` |
| 检查办法 `checkMethod` | 怎样算到了：谁来查、用什么样本、什么算没到 | `stage_milestone.check_method` |
| 补哪一级 `ladderKeys` | 验证阶梯的级别，多值，如 `{M1,M4}`，元素同 `^M[0-9]+(\.[0-9]+)?$`，可空 | `stage_milestone.ladder_keys text[]` |

**为什么用旁表而不是给 `project_stage` 加列**：沿用迁移 101 的做法，`project_stage` 与 `stage_revision` 的既有行和修订链原样不动；旁表一阶段一行，每次改动另追加一行到 `stage_milestone_history`（`stage_id、version、四个字段、actor_id、reason、created_at`，只追加）。

**命令与权限。**
- `stage.propose` 增加四个字段：`shortName`、`checkMethod` 必填，`dueOn` 与 `ladderKeys` 可空。**不留老调用**：不带 `shortName` 或 `checkMethod` 的 `stage.propose` 被拒（提出阶段的只有需求 Session 和 Leader，同一项里一起改 skill 与模板）。提出时同时写 `stage_milestone` 与第一条历史。
- 新增 `stage.milestone.set`（字段 `stageId、expectedVersion、shortName、dueOn、checkMethod、ladderKeys、reason`，整组覆盖并追加历史）。权限分两档：阶段未接受（`proposed`）时有回看权限即可；阶段已接受（`active`）时改 `dueOn` 或 `checkMethod` 要有阶段决定权（同 `stage.accept`），因为这两项是接受时认可的内容；改 `shortName`、`ladderKeys` 仍是回看权限。已回看（`reviewed`）的阶段不允许改 `dueOn`。每次改动必须写 `reason`，历史里留前后值。
- `stage.phaseKey.set` 保留一个版本只读兼容，之后由 `ladderKeys` 取代。

**现有阶段的补填（backfill），遵守现有修订与决定规则。**
1. 迁移只建表，不猜内容：已有阶段在 `stage_milestone` 里没有行，页面写“未登记”。
2. 把 `stage_phase_key.phase_key` 原样复制成 `ladder_keys = {phase_key}`（旁表行的 `short_name` 为空），其 `actor_id/reason/updated_at` 带入历史，`reason` 前加“迁移自 stage_phase_key”。原表不删不改。
3. 旧的 M0 到 M4 五个阶段与 S5：**不补短名**，到期日、检查办法也留空。它们是否进主表按“短名有没有登记”判断（第二节），所以一直在“已回看的阶段”折叠里；回看记录和修订链不动。
4. 五个新阶段 `c6331be2`、`8707e35b`、`972e76f0`、`9824a2d5`、`cd79bfb5`：**不写解析脚本**。`stage.milestone.set` 上线后由需求 Session 手工填五次，并读回核对（正文前四行不动，仍留在正文里）。
5. 填完后读回：五个阶段四个字段都有值才算补填完成。

**回退。** 本迁移只增不改：新建 `stage_milestone`、`stage_milestone_history`（第六节的归属旁表另见），不动 `project_stage`、`stage_revision`、`stage_review`、`stage_phase_key`。回退 = 前端回到读旧接口（旧 `/milestones` 在改造期间保留）后，用一个新的前向迁移删这些表；项目迁移约定 `down=false`，所以回退写成前向迁移，合并前按 `local-run.md` 备份。`stage_phase_key` 与所有回看记录从未被修改，回退不丢它们。

## 二、读：阶段只读投影

新接口 `GET /api/projects/:projectId/stages/milestones?timeZone=Asia/Tashkent`（项目读权限；`timeZone` 为 IANA 名，缺省 UTC；旧 `/api/projects/:id/milestones` 在新页面上线并验过之前不删）：

```
{ asOf, today, timeZone,
  stages: [{ id, goalId, shortName | null, dueOn | null, checkMethod | null, ladderKeys,
             state, status, statusLabel, latestReview: { id, adopted, rejected, gap, nextChoice, createdAt } | null,
             tasks: { inProgress, blocked, notStarted, closed, total } }],
  tasksNoStage: { unowned, declared },   // 未关闭：没有归属记录的；明确“不属于阶段”的
  currentStageId | null, currentNote | null }
```

| 内容 | 来源（表/字段） |
| --- | --- |
| 短名、到期日、检查办法、补哪一级 | `stage_milestone` |
| 状态 | `project_stage.state` + 最新的 `stage_review`（含 `supersedes_review_id` 更正）+ `today`，规则见第五节 |
| 最新回看 | `stage_review` 取该阶段最新一条未被更正取代的记录 |
| 任务个数 | 第六节的归属旁表 `task_stage`（一任务一行）；按任务当前状态分：进行中（已开始、未被阻塞）、卡住（任务页“受阻”同一判定）、未开始（待办）、已关闭；个数与任务页按阶段过滤的行数同源 |
| 未归属 / 不属于阶段 | `task_stage` 里没有行且任务未关闭 → 未归属；有行且 `stage_id IS NULL`（明确“不属于阶段”）→ 单独计数 `declared`，页面单独写，不混进“未归属”；已关闭的不数 |
| 今天 | 由请求的 `timeZone` 算出，随响应返回 `today` 与 `timeZone`；页面传浏览器时区（建任务表单已经这样取），并在“已到期待回看”旁写明按哪个时区算。**不写死城市**：库里没有项目时区，`runtime.dailyBudget.timeZone` 现在没配（按 UTC），本设计不新增配置 |
| 当前阶段 | 服务端给：已接受（`state='active'`）、没有回看、`dueOn` 最早的那一个；到期日相同取创建更早的；全部没有到期日时不给（`currentNote:"当前阶段未登记"`）。**不依赖今天的日期**：已过期没回看的仍是“当前”，状态写“已到期待回看”；未接受（`proposed`）的阶段不参与。不要求“恰有一个进行中” |

**哪些阶段进主表**：按“短名有没有登记”判断，不按有没有行。登记了短名的 `proposed`、`active` 阶段进主表，登记了短名且最近一次回看在 14 天内的 `reviewed` 也进主表；其余（含没有短名的旧 M0 到 M4 五个阶段和 S5，它们 11-22 刚回看也一样）进“已回看的阶段”折叠区，名称回落为正文首行。

**第一天的真实数据**（11-22 20:40）：未关闭任务 36 项（待办 22、进行中 14），其中 7 项带阶段（`8707e35b` 名下 4 项：进行中 3、未开始 1；`9824a2d5` 名下 3 项：进行中 1、未开始 2），其余 `c6331be2`、`972e76f0`、`cd79bfb5` 还没有任务；未归属 29 项。（此前写的“639 条任务提议均无阶段”是提议修订数，不是任务数，已作废。）

## 三、验证阶梯（M0 到 M4）

| 项 | 设计 |
| --- | --- |
| 来源 | 仍是仓库 `docs/roadmap.md` 的阶段表；每级的“最新状态一句话”取“各阶段现在在哪”表里同级的“现在的状态”首句 |
| 接口 | `GET /api/projects/:projectId/ladder`：`{ available, source:{commit}, levels:[{ key, name, status, evidenceStages:[{id,shortName}] }] }` |
| 谁供证据 | `stage_milestone.ladder_keys` 含该级的阶段，按到期日排；旧 M0 到 M4 阶段（没有短名）照常列出，名称回落为正文首行；没有阶段补这一级的写“暂无阶段补这一级”，不隐藏 |
| 没有这条阶梯的项目 | 现在的实现读 evoLoop 自己部署目录的路线图，不分项目，**这一点要改**：路线图改为读该项目登记的仓库；读不到文件或没有“阶段/要交付什么”表头时 `available:false, levels:[]` |
| 怎样读（本项目登记的是裸仓库，`repositories[].root` 指向 `…/repos/evoLoop.git`，没有工作目录文件，现有的 `readFile` 读不到） | 用 `git -C <root> show <默认分支提交>:docs/roadmap.md`（与 `completion/merge-facts.ts` 同样的只读 git，无网络、无 fetch）；分支取 `refs/remotes/origin/main`，没有就取 `refs/heads/main`；响应的 `source.commit` 写这个提交。项目登记多个仓库时，按登记顺序取**第一个读得到这份文件的**。裸仓库由合并后的同步更新，所以路线图合并后到页面跟上的时间等于仓库同步的间隔（页面写 `source.commit` 的短哈希，让人看出读的是哪一版） |
| 反例处理 | 另一个项目没有路线图：接口返回 `available:false`，总览不渲染阶梯那一行，里程碑页不渲染阶梯小节，也不写“路线图读不到”的报错（那是错误态，这里是“没有”）。读文件出错（权限、IO）才写“阶梯读不到”。必须有测试：无路线图的项目 → 响应 `available:false` 且页面无阶梯 DOM |
| 页面 | 总览折成一行“验证阶梯：M0…M4 · 展开”，里程碑页底部一节，点开每级一行：级别名、状态一句话、供证据的阶段（可点） |

## 四、版面

**总览里程碑块**（只替换该块，其他块的顺序与导航不动）。一阶段一行，五格：名称、到期日、怎样算到了、任务、状态。只有一行标“当前”（浅底加左侧色条）。

**任务格的写法**：有进行或卡住的写“进行 a · 卡住 b”；两个都是 0 但有未开始的写“未开始 c”；全部关闭写“已关闭 d”；一项都没有写“还没有任务”。

1440 宽（线框，按 11-22 20:40 的真实数据；当前 = 已接受、无回看、到期最早的 `c6331be2`）：

```
里程碑                                                      验证阶梯：M0 … M4 · 展开 ▸
| 名称                       | 到期日 | 怎样算到了                  | 任务              | 状态               |
|----------------------------|--------|-----------------------------|-------------------|--------------------|
▌当前 组织连续 7 天不用你催   | 12-02  | 7 天内 Leader 没有停摆…     | 还没有任务        | 已接受还没有任务   |
| 你只看简报和总览就能做完当天 | 12-07  | 使用者自己沿三条路径用一遍… | 进行 3 · 卡住 0   | 进行中             |
| 分工按负载收紧               | 12-09  | 接不到活的 Session 关掉…    | 还没有任务        | 已接受还没有任务   |
| 你能在工作台里直接交活       | 12-14  | 带文件或图片交代一件真实的… | 进行 1 · 卡住 0   | 进行中             |
| 第二个项目跑通第一个任务     | 12-16  | 用接入 skill 接入，第一项…  | 还没有任务        | 已接受还没有任务   |
                                              29 项未关闭任务未归属阶段 · 归到阶段 ▸
```

“怎样算到了”一格两行截断，完整文字在里程碑页展开；`8707e35b` 那行的“未开始 1”和 `9824a2d5` 的“未开始 2”在展开里（任务格已写进行个数，未开始个数在展开的任务分组里）。当前阶段没有任务时仍是“当前”，状态写“已接受还没有任务”。

390 宽（线框，每阶段一张两行卡，没有阶段被隐藏）：

```
里程碑                  验证阶梯 · 展开 ▸
▌当前 组织连续 7 天不用你催
  12-02 · 还没有任务 · 已接受还没有任务
  7 天内 Leader 没有停摆…（两行）
------------------------------------------
  你只看简报和总览就能做完当天的决定
  12-07 · 进行 3 · 卡住 0 · 进行中
  使用者自己沿三条路径用一遍…
------------------------------------------
  另 3 个阶段同样收成两行 · 29 项未归属 ▸
```

实现时还要出真实页面截图（1440×900、390×844），并按 `overview-top-browser.test.ts` 的办法实测首屏：其他首屏块（“要你决定或处理的”）不能因此被推出首屏。

**里程碑页**（现称“目标与阶段”，首屏改为同一张对照表，列与总览相同，“怎样算到了”不截断）：点一行展开：该阶段的任务列表（按状态分组：进行、卡住、未开始、已关闭，链到任务页）、最新回看（采纳、拒绝、缺口、下一步，链到回看原文）、检查办法全文、补哪一级（链到阶梯对应级）。展开状态写进地址（`?stage=<id>`）。表下方：“未归属的 N 项未关闭任务”折叠区（见第六节）和单独一行“明确不属于阶段 M 项”，再下面是“验证阶梯”小节与“已回看的阶段”折叠区。

**缺数据（两种宽度相同的文字）：**

| 缺什么 | 页面写 |
| --- | --- |
| 没有回看 | 最新回看一格写“暂无回看”，不写 0 或“未达成”；状态按第五节推出 |
| 有未归属任务 | “N 项未归属”，链到未归属列表；绝不显示成 0；读不全时写“已读 X 项，未读全” |
| 没有到期日 | 到期日格写“未定”，该阶段不参与“当前”的比较，排在有到期日的阶段之后 |
| 没有检查办法 / 短名 | 检查办法写“未登记”；没有短名的阶段不进主表（第二节） |
| 阶段还没有任务 | 任务格写“还没有任务”（不是“进行 0 · 卡住 0”） |
| 没有任何登记了短名的阶段 | 整块写“这个项目还没有阶段”，给提出阶段的入口，不画空表 |
| 时区 | “已到期待回看”旁写“按 <timeZone> 的 <today> 算” |

## 五、状态词与推导

| 词 | 推导（数据） |
| --- | --- |
| 已接受还没有任务 | `state='active'`，没有回看，且 `task_stage` 里挂在它名下的任务数（所有状态）为 0；**只在一项任务都没有时出现** |
| 进行中 | `state='active'`，没有回看，任务数 ≥ 1，且 `today` ≤ `dueOn`（或无到期日） |
| 已到期待回看 | `state='active'`，没有回看，`dueOn` < `today`（`today` 按请求的 `timeZone`，缺省 UTC）；它仍可是“当前” |
| 达成 | `state='reviewed'`，最新回看 `adopted` 有内容、`rejected` 与 `gap` 都按 `isNoneMarker` 算空 |
| 部分达成 | 最新回看 `adopted` 有内容且 `rejected` 或 `gap` 有内容 |
| 未达成 | 最新回看 `adopted` 按 `isNoneMarker` 算空 |
| 未接受 | `state='proposed'`；不参与“当前”，不是“已接受还没有任务” |

新块和新页只用这七个词，不与旧词（已退出／部分成立／已回看）并存；旧接口和旧词随旧块在收口那一项下线，期间旧块不改词。没有回看时一律不写达成类词。回看仍用 `stage.review`（采纳、拒绝、缺口三项加 `nextChoice`），更正用 `stage.review.correct`；状态**不按任务完成比例推算**。“已到期待回看”不改数据，到期不会自动关闭阶段。

## 六、任务归属

**归属放旁表，不动任务修订链。** 新表 `task_stage`（`project_id、task_id` 主键一行；`stage_id` 可空，空 = 明确“不属于阶段”；`no_stage_reason`；`actor_id、reason、updated_at`）和只追加的 `task_stage_history`。投影只读这张旁表。没有行 = 未归属。

**为什么不走任务修订链**（核对记录 A）：`task.update` 改阶段会撞三条现有规则，旁表一条都不碰：
1. `REOPEN_REQUIRED`（`packages/core/src/index.ts`）：阶段变化而任务不是待办时拒绝——36 项未关闭任务里 14 项在进行中。旁表不改任务修订，不触发。
2. `INCOMPLETE_PROPOSAL`：带阶段的任务要有消费者、依据、停止条件——老任务大多没有后两项，这正是此前没有任务带阶段的原因。**`task.create` 带阶段的新任务仍要求这三项**（要写进 `agent-cli.md`，让建任务的人事先知道）；`task.stage.set` 给已有任务归属不要求。
3. `STALE_DELIVERY` 与派发保护（`workflow.ts`、`task-dispatch-guard.ts`）按“最新交付属于当前任务修订”判断；追加“只改阶段”的任务修订会让已交付的任务关不了、还被当成没派过。旁表不新增任务修订，不影响。

**命令。**
- `task.create`：必须给 `stageId`，或给 `noStage: true` 并写 `noStageReason`（理由必填）；两者都没有被拒，拒绝信息写明两种选法。**不要过渡开关**：强制、表单里的阶段选择、文档、三个 skill 的建任务示例、Leader 每日评估模板在同一项里上线。`stageId` 仍写 `task_proposal.stage_id`，同时写一行 `task_stage`。
- 日程自动建的任务（`packages/contracts/src/scheduling.ts` 的模板没有阶段字段）：默认记 `noStage`，理由“不属于阶段（日程例行）”，不被拒；给日程模板加阶段不在这一轮。
- `task.stage.set`（`taskId、stageId | null+noStageReason、reason`，需 Task 写权限；不带任务的 `expectedVersion`，只对旁表行用自己的乐观版本）：写/改旁表一行并追加历史。可用于待办、进行中、已交付待验收的任务；已关闭的任务拒绝（决定文档：已关闭的不补）。不要求消费者、依据、停止条件。
- 页面入口：里程碑页“未归属”折叠区每行一个“归到阶段”选择；批量归属由 Leader 或需求 Session 用同一命令（Leader 停着时需求 Session 来做）。
- 任务页头：阶段短名（链到里程碑页该阶段）、或“未归属”、或“不属于阶段”。

**回填。** 已有 7 项带阶段的任务：迁移把它们最新修订的 `task_proposal.stage_id` 复制进 `task_stage`（历史注“迁移自 task_proposal”）；其余不填，保持未归属。

## 七、实现时要改的文档

| 文档 | 改什么 |
| --- | --- |
| `docs/roadmap.md` | 写明 M0 到 M4 是验证阶梯，不是里程碑；阶段与阶梯的关系（阶段的“补哪一级”）；回看时更新阶梯状态 |
| `docs/frontend/pages/overview.md`、`journey.md` | 里程碑块、里程碑页改写；状态词；缺数据 |
| `docs/frontend/overview-top-design.md` | 在“六个阶段”“phaseKey”“当前阶段”相关处标“已被 milestones-design.md 取代”，保留原文 |
| `docs/architecture/project-data.md` | 新增 `stage_milestone`、`stage_milestone_history`；`task_proposal.stage_id` 的“不属于阶段”；两个新命令 |
| `docs/development/agent-cli.md` | `stage.propose` 新必填字段、`stage.milestone.set` 及两档权限、`task.stage.set`、`task.create` 的 `stageId/noStage` 与“带阶段仍要消费者、依据、停止条件” |
| 三个 skill 的建任务示例、Leader 每日评估模板 | 示例带阶段或 `noStage`（与 `task.create` 强制同一项上线） |
| `docs/development/local-run.md` | 迁移与数据迁移步骤、备份与回退 |

## 八、实施拆分

先做不改界面的数据与读，再改页面，最后收口。每一项用独立 PR，前一项合并后再做下一项。规模按 1–2 天为小、3–5 天为中。**原第 2 项（解析五个阶段正文的数据迁移）不做**：命令上线后由需求 Session 用 `stage.milestone.set` 手工填五次并读回核对。编号沿用第一版，所以没有第 2 项。

| # | Task | 规模 | 验收方法（样本、操作、预期、反例） |
| --- | --- | --- | --- |
| 1 | 旁表与命令：迁移（`stage_milestone`、`stage_milestone_history`、`task_stage`、`task_stage_history`）、`stage.propose` 必填字段、`stage.milestone.set`（两档权限）、从 `stage_phase_key` 与已带阶段的任务提议复制 | 中 | 样本：真实 PG 测试库里先有带 `stage_phase_key` 的阶段与回看、7 项带阶段的任务。操作：跑迁移，再 `stage.milestone.set`。预期：`stage_phase_key`、`stage_review`、`stage_revision` 行数与内容不变；旁表有复制出的 `ladder_keys` 与 7 行 `task_stage`。反例：不带 `shortName`/`checkMethod` 的 `stage.propose` 被拒；已接受阶段改 `dueOn` 无阶段决定权被拒；已回看阶段改 `dueOn` 被拒；错格式 `ladderKeys` 被拒；改动不写 `reason` 被拒 |
| 3 | 投影接口 `/stages/milestones` 与状态推导 | 中 | 样本：覆盖第五节七个状态各一个阶段，另有未归属、明确不属于阶段、无到期日、无短名的旧阶段。预期：状态与个数和任务页过滤行数一致；任务格四种文字（进行/卡住、未开始、已关闭、还没有任务）各一个样本；`timeZone` 参数改变 `today` 与“已到期待回看”的判定、缺省 UTC、响应带 `today` 与 `timeZone`。反例：12-02 过期未回看与 12-07 未到期同时存在时“当前”是 12-02；无回看的阶段绝不出现达成类词；个数为 0 与“未归属”不混；无短名的旧阶段不进主表 |
| 4 | 验证阶梯接口，按项目读自己的路线图 | 小 | 样本：有路线图的**裸仓库**项目、没有路线图的项目、登记两个仓库而第一个没有这份文件的项目。预期：前者返回各级、`source.commit` 与供证据的阶段；没有的 `available:false`；两个仓库取第一个读得到的。反例：没有路线图的项目不得返回 evoLoop 的 M0 到 M4；仓库没有 main 分支引用写“阶梯读不到”而不是“没有” |
| 5 | `task.create` 的 `stageId`/`noStage` 强制、`task.stage.set`、日程任务豁免、任务页头；表单、文档、三个 skill 示例、Leader 每日评估模板同项上线 | 中 | 样本：新建一项带阶段（有消费者、依据、停止条件）、一项明确不属于阶段（有理由）、一项两者都不带、一项带阶段但缺依据；一项“已交付待验收”的任务；一项进行中任务；一项没有依据和停止条件的老任务；一次日程触发建任务。预期：第三项被拒且信息写明两种选法，第四项被拒（`INCOMPLETE_PROPOSAL`）；日程任务记“不属于阶段（日程例行）”未被拒；页头分别写短名、“不属于阶段”、“未归属”。反例（核对记录 A）：给“已交付待验收”的任务归阶段后，它的交付、验收、关闭和派发状态都不变；进行中的任务可以归（不触发 `REOPEN_REQUIRED`）；没有依据和停止条件的老任务可以归；已关闭任务拒绝；任务修订链没有新增行 |
| 6 | 总览里程碑块与里程碑页（两种宽度）、阶梯折叠、缺数据文案、时区提示 | 中 | 样本：Playwright 夹具含全部缺数据情形与第四节的真实数据形态。预期：1440×900、390×844 实测首屏，无水平溢出，只一行“当前”；点行展开任务与回看。反例：未归属任务显示“N 项未归属”而不是 0；无路线图项目页面无阶梯 DOM；去掉“只一行当前”的限制，测试要失败 |
| 7 | 文档收口与旧接口下线（**已完成**，Task 523938fb：旧块、`/milestones` 与 `api().milestones` 已删，`overview-top-design.md` 已标“已被取代”） | 小 | 样本：第七节清单。预期：`docs:check` 通过，旧 `/milestones` 无调用方后才删。反例：`overview-top-design.md` 没标“已取代”的地方由检查搜到 |
| 8 | 补归属：Leader 或需求 Session（Leader 停着时）用 `task.stage.set` 给未关闭任务归阶段；需求 Session 为五个新阶段填字段（运营，不改代码） | 小 | 样本：真实项目的未关闭任务（11-22 为 29 项未归属）。预期：未归属计数下降到明确的个数；五个阶段四个字段读回有值。反例：已关闭任务未被改动 |

顺序 1→3、4（可并行）→5→6→7→8。1 须先于 3，因为投影读旁表；5 须先于 8；6 在 3、4、5 之后。

## 已确认与待确认

**已确认**（需求 Session 在核对记录第三节定了，已并入正文）：旁表、只增不改、回退用前向迁移（第一节）；“当前”不要求恰有一个进行中、未接受的阶段不参与（第二节）；`stage.milestone.set` 分两档权限、`task.stage.set` 走旁表、`noStage` 理由必填且单独计数、已回看阶段不改到期日（第一、六节）；到期不自动改数据、日期按 `timeZone` 参数（第二、五节）；路线图读哪个仓库（第三节）；14 天窗口按短名判断（第二节）；新旧状态词不并存（第五节）；不要过渡开关，带阶段的新任务仍要消费者、依据、停止条件（第六节）。

**仍待确认**（我在这一版新增的设想，核对记录没有定）：

1. 回填：把已带阶段的 7 项任务从 `task_proposal.stage_id` 复制进 `task_stage`（第六节），而不是让它们也走 `task.stage.set` 重填。
2. `task.stage.set` 不要求消费者、依据、停止条件，只对已有任务成立，新任务建立时仍要求；这条分界是否可以接受。
3. 旧 `stage.phaseKey.set` 保留一个版本只读兼容的期限。
4. 页面“已到期待回看”旁的时区文字写法，真实页面出来后看是否太吵。

## 没有验证的

本文只是设计：没有运行迁移，线框不是真实页面（只是按 11-22 的真实数据排的文字线框），没有量过首屏，没有人使用过。第一天的数字来自需求 Session 的核对记录（生产库 11-22 20:40），我没有重读。五个新阶段的名称与日期来自决定文档的表格，不是从库里读的。核对记录 A 的旁表建议是需求 Session 的判断，没有试做；我读了 `packages/core/src/index.ts` 里的 `REOPEN_REQUIRED` 与 `INCOMPLETE_PROPOSAL` 两处，没有读 `workflow.ts` 和 `task-dispatch-guard.ts` 的 `STALE_DELIVERY` 与派发判断，这一条按核对记录写。规模是估计。

线框里五个阶段编号与到期日的对应（`c6331be2` 12-02、`8707e35b` 12-07、`972e76f0` 12-09、`9824a2d5` 12-14、`cd79bfb5` 12-16）是按决定文档表格与任务写的编号顺序推的，没有从库里核对。
