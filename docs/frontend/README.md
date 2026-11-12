# 前端文档：改什么，看哪篇

工作台帮助人观察项目进展、读懂证据和成果，并在需要时与 Agent 沟通；大多数修改由 Agent 经业务 skill 和 CLI 完成（[DEC-030](../decisions.md#用户已确定的方向)）。本目录维护工作台的设计语言、页面说明和前端实现。产品为什么这样做见[产品定义](../product/definition.md)和[产品工作台](../product/workbench.md)；接口、数据与权限见[接口合同](../architecture/contracts.md)和[项目数据](../architecture/project-data.md)。

## 按要做的事阅读

| 要做的事 | 先读 |
| --- | --- |
| 改任何界面之前 | [设计原则](principles.md)、[场景与交互](scenarios.md)，再读[布局](layout.md) |
| 选颜色、字号、间距、状态标签 | [设计基础](foundations.md) |
| 使用或新增按钮、弹窗、列表、空状态等组件 | [组件清单](components.md) |
| 改某一页 | 下面的页面说明 |
| 改路由、数据读取、实时更新、分包 | [前端架构](architecture.md) |
| 看一条真实使用路径的截图证据 | [实景旅程](journeys/current-work.md) |

## 页面说明

| 页面 | 这页回答 |
| --- | --- |
| [项目总览](pages/overview.md) | 目标还差什么，最近的使用说明了什么，谁接下一步？ |
| [总览顶部重做设计（待确认）](overview-top-design.md) | 目标、线上版本、里程碑怎样一眼看清？实现前的设计，确认后再做。 |
| [任务](pages/tasks.md) | 哪项与我有关，谁真正接住，成果和使用怎样？ |
| [目标与阶段](pages/journey.md) | 目标分成哪些阶段，每个阶段做到哪里，回看说明了什么？ |
| [过程文档](pages/documents.md) | 从哪读完整原件，任务用了哪版，新版影响谁？ |
| [知识空间](pages/knowledge.md) | 当前认识、适用条件、支持和反例在哪里？ |
| [日程](pages/schedules.md) | 为什么检查，下次何时，上次产生的工作怎样？ |
| [评价与后果](pages/evaluations.md) | 同一任务两种条件，每次真实运行交付、使用、成本与判断怎样，结论和下一步是什么？ |
| [Sessions](pages/sessions.md) | 哪个 Session 在做什么、做到哪一步，需不需要我；Leader 怎样安排这些 Session？ |
| [团队](pages/team.md) | 哪些持续职责由谁承担，用什么运行时与 skill？ |
| [微信连接](pages/connectors.md) | 哪个微信会话转给哪个智能体，最近的投递处理得怎样？ |
| [登录与项目列表](pages/entry.md) | 用哪个身份登录，能进哪些项目，进入前有没有要先核对的操作？ |
| [项目设置](pages/settings.md) | 在哪个项目，以谁的身份，有哪些权限，各类记录在哪里？ |
| [结果未知的操作](pages/operations.md) | 哪次提交结果未知，怎样按原操作 ID 查回或重试？ |
| [仓库规范](pages/repository.md) | 正式规则在哪里读，怎样登记固定 Git 来源和正式采用？ |

## 目标与现状

设计语言（原则、基础、组件、布局）记录已选定的目标：Tailwind v4 + shadcn/ui、设计体系放进 `packages/ui`、双左栏导航加“中间内容、右侧信息”的布局（[DEC-036](../decisions.md#用户已确定的方向)）。代码迁移由[前端改版 issue #229](https://github.com/cyl19970726/evoLoop/issues/229) 跟踪。每篇文档把“现状”和“目标”分开写；目标没有实现之前，不写成现状。

## 怎样维护

- **一项事实只写一处。** 产品理由在 `docs/product/`，接口和权限在 `docs/architecture/`，本目录只写界面怎样表达，需要时链接过去。
- **数值只在代码里。** 颜色、字号等 token 的唯一来源是代码；文档说明用途和规则，不复制一份数值表去单独维护。
- **页面说明用固定模板。** 每篇包含：这一页回答什么、布局、内容与状态、截图、代码与测试、相关；正文控制在约 1200 字（检查上限 1600 字，不计表格、图片和链接地址）。`npm run docs:check` 会检查模板小节、篇幅和“代码与测试”里列出的路径是否存在。
- **改页面时同步改文档。** 改了某页的源码，同一个 PR 更新对应的页面说明和截图。检查脚本加 `--base origin/main` 运行时，会列出源码改了但页面说明没改的页面。
- **文档只写现在。** 页面说明描述当前界面和目标，不记某一次的复测数据；单次验收、失败和恢复过程留在对应的过程 Document，可继承的跨页证据进[实景旅程](journeys/current-work.md)。
- **截图由脚本生成。** 页面说明的“截图”一节只引用 `npm run docs:screenshots` 生成的 `docs/assets/frontend-pages/` 图，不手工放图；改了页面的 PR 重跑并提交变化的图。用法、夹具和什么时候重跑见[前端架构 · 页面截图](architecture.md#页面截图)。真实使用的截图属于实景旅程，规则见[前端旅程与截图](../development/documentation.md#前端旅程与截图怎样进入仓库)。组件外观以组件样例页为准，不放单个组件的截图。
