# 仓库规范：正式规则在哪里，怎样登记固定 Git 来源

仓库规范页把仓库 `docs/` 里的正式规则和项目的过程文档分开：这里放仓库文档的入口，以及把仓库里某个文件的固定版本登记成来源的表单。读者是要查产品、架构和开发规范的人，以及要登记来源、记录正式采用的审核人。

## 这一页回答什么

- 产品、架构和开发规范从哪里读，和过程文档有什么区别？
- 怎样把仓库里一个文件的固定版本登记为来源？
- 某份过程文档的某一版，有没有被正式文档采用或吸收？

## 布局

| 区域 | 放什么 |
| --- | --- |
| 内层栏 | 文档与知识下的分区导航，高亮“仓库规范”；没有对象列表 |
| 中间（单栏） | 从这里开始（贡献与变更入口、按任务选择阅读路径）；按问题查阅（前端页面与交互、产品目标、当前决定）；一句说明和“查看过程文档”；登记固定 Git 来源与正式采用：两张默认折叠的表单 |
| 右栏 | 没有 |

外壳与内层栏见[布局](../layout.md)；设置类页面的单栏布局同[项目设置](settings.md)。

## 内容与状态

通用的空、加载、失败、未知规则见[设计原则](../principles.md)。

- **入口是外链**：在新标签页打开 GitHub 上 evoLoop 仓库 main 分支的现行文档，不是固定版本；任务实际采用哪一版，回任务看固定的 commit。仓库文档不进过程文档列表（[对象关系与能力职责](../../product/workbench.md#对象关系与能力职责)）。
- **登记 Git 固定来源**（要写入权限）：填仓库（服务端给本项目配置的仓库标识）、相对路径、完整 commit（40 或 64 位）和原文 SHA-256。服务端按这个 commit 读原文、核对摘要，一致才登记。保存后，登记的固定引用自动填进下一张表单。
- **记录正式文档与过程文档的关系**（要复核权限）：固定 Git 引用、过程文档与修订、决定（人工认定为正式依据、人工拒绝纳入、人工确认已纳入该过程修订）和理由。系统只核验固定原文能读，不证明正式文档已包含过程成果，所以理由里要写出具体段落或差异。
- 没有对应权限时，表单换成一句说明，例如“当前身份没有写入权限，不能登记 Git 固定来源。”
- 两张表单都是共同的[提交表单](../components.md#提交表单)：提交前保存回执，结果未知时按原操作 ID 查回（见[待核对操作](operations.md)），项目有未核对的回执时暂停提交。这一块渲染出错只替换这一块，页面其余部分照常。
- 本页打开时不读数据，所以没有读取中、空和失败状态。为任务采用、保留或替换外部依据在任务的“运行与关联”里做，用的是同一个组件，并带上任务修订和已登记的依据（见[任务](tasks.md)）。

## 从哪里来，到哪里去

| 从 | 到 |
| --- | --- |
| 文档与知识 › 仓库规范；账号菜单 › 仓库规范；项目设置 › 各类记录在哪里 | 仓库文档（新标签页）；“查看过程文档”→ 文档与知识 › 过程文档 |

## 截图

由 `npm run docs:screenshots` 用合成夹具生成，怎样重新生成见[页面截图](../architecture.md#页面截图)。

![仓库规范，1440：没有右栏](../../assets/frontend-pages/repository-1440.png)

![仓库规范，1024：内层栏收起](../../assets/frontend-pages/repository-1024.png)

![仓库规范，390](../../assets/frontend-pages/repository-390.png)

## 代码与测试

| 范围 | 路径 |
| --- | --- |
| 源码（`apps/workbench/src/`） | `features/settings/RepositoryPage.tsx`（入口与说明）、`features/references/ReferencePanel.tsx`（登记表单，任务的“运行与关联”也用它）、`features/references/referenceCommands.ts`（各写入的地址与字段）、`features/references/referencePresentation.ts`（决定与来源的中文）；局部出错边界 `shared/ui/SectionBoundary.tsx` |
| 测试（`apps/workbench/test/`） | `reference-commands.test.ts`、`legacy-bits-browser.test.ts`（仓库规范上的登记表单）、`entry-pages-browser.test.ts` |

## 相关

- 合同：[DocumentStore 与 RelationStore](../../architecture/contracts.md#2a-documentstore-与-relationstore)（`GitSourceRef`）
- 本机配置：[本机运行与恢复](../../development/local-run.md#环境与启动)（`.local/integrations.json` 的 `repositories`）
- 前端：[过程文档](documents.md)、[任务](tasks.md)
