# 过程文档：读完整原件，知道工作用了哪一版

这一页帮人找到一份过程文档，从头读到尾，并知道读的是哪一版、来自哪里、被哪些任务使用。

## 这一页回答什么

- 这项工作的完整说明、方案或报告在哪里？
- 我读的是哪一版，和当前版、已发布版是什么关系？
- 它来自哪项任务，又被哪些任务引用？
- 出了新版，哪些工作要复核？

## 布局

| 位置 | 放什么（目标） |
| --- | --- |
| 左栏 | 文档目录与列表，每行一个标题和状态；可按用途、状态筛选和搜索 |
| 中间 | 所选文档的全文，Markdown 和 HTML 都从首段连续读到末段；未选文档时显示文档表格 |
| 右栏 | 版本（正在读、当前版、已发布版）、来源、关联任务；可收起 |

现状（#229 PR8）：已按上表实现。内层栏可切换“文档 / 知识”，带搜索、类型和状态筛选，打开的文档高亮，并写明载入范围；内层栏不在屏上时，搜索和筛选移到表格上方。没选文档时中间是四列文档表格。选中后是全文：Markdown 可切换排版和原文；HTML 报告在隔离区域里占满页头以下，原件、HTML 原文和资源收在区域下方。右栏依次是版本、来源、引用它的任务（点开在右栏查看，正文不动）和页内目录。固定历史链接停在原修订，提示一直可见并给“查看当前版”。返回时保留来源、筛选、载入范围和刚打开的那一行。“修订与发布”折叠在正文下方，全部是共同的提交表单；HTML 原件读取中、读取失败或不可用时，它仍留在区域下方，可以上传修正版或归档。

上传或导入的 Markdown 只存原件，正文从原件读出，页内目录照常可用。固定修订和原件只读一次，写入后不重读。

## 内容与状态

共同规则见[设计原则](../principles.md)。

### 从表格打开完整过程文档

- 过程文档用表格逐行查阅，点标题读完整正文（[DEC-024](../../decisions.md)）；卡片摘要不代替列表和全文。
- 标题支持键盘打开；行内的任务链接单独跳转。
- 搜索、筛选和分页写明覆盖范围；从全文返回时保留原条件和位置。
- 页首写回到哪里：“返回任务：<名称>”“返回智能体：<名称>”“返回总览”“返回文档列表”。从文档或文档列表打开任务，任务页写“返回文档：<名称>”或“返回文档列表”。
- 载入更多只读下一页，失败只重试该页；重读失败标“上次读回”。
- 窄屏时表格横向滚动，标题和打开入口始终可读。

| 格式 | 怎样读 | 怎样保存 |
| --- | --- | --- |
| Markdown | 排版后的完整正文（字号、行距与颜色只用 token；Mermaid 图在隔离框里静态显示），可切回原文；保留标题、列表、表格、代码块、引用块和附件引用；标题整体排在页面标题之下（正文最高一级从二级起，页面只有一个一级标题），页内目录按原文的二、三级标题（`##`、`###`）列出；不显示原始 HTML 和图片，链接按白名单 | 保存原文和固定修订，渲染结果可重建 |
| HTML 报告 | 在隔离区域保留原排版、样式和已保存的图片、图表；可查看 HTML 原文 | 原件和所需资源一起保存，绑定同一修订；单文件报告也适用 |

HTML 报告直接作为过程文档保存，脚本不执行，默认静态阅读；交互能力单独验证后再开放。未保存的外部资源列为缺项，这时不称“完整报告”。实现边界见[前端架构](../architecture.md#过程文档表格与完整阅读)。

### 版本与状态

- 草稿、已发布、已归档是生命周期；正在读的固定版、当前版、已发布版分开标明，读旧版时提示一直可见。
- 从任务的固定依据进入时保持那一版。
- 任务主正文只从任务修改，文档页只读并链到所属任务。
- 修订的作者和理由由服务端写成时（如日程生成的 `schedule:<ID>`、`Initial task content`）改写成中文，原文在“完整标识与哈希”；人写的理由照原样。
- 普通文档修订保留读入时的版本和草稿，冲突时先比较；修订、发布、归档、恢复和上传都用共同的[提交表单](../components.md#提交表单)。上传先在浏览器读取并核验文件，再保存回执、发送；新修订按打开时的文档版本提交，版本变了先请人保留或重填。文件不存草稿。
- 原件缺失、无权限、服务不可达分别说明原因；摘要不代替原件。Markdown 正文只存在原件里时，读取中、读取失败、原件不可用也分别说明。
- “影响哪些工作”尚未实现：从新版逐项看引用旧版的任务及处理理由，规则见[需求纠正](../../product/daily-loop.md#需求纠正怎样处理)。

### 过程文档和仓库正式文档的关系

三类正文各有入口：过程文档记这次工作的讨论和决定，仓库正式文档（“仓库规范”）存已采纳的规则，知识空间读当前认识。来源可以往返，各自的正文和修订保持独立。权威归属见[对象关系](../../product/workbench.md#对象关系与能力职责)。

“整理到仓库文档”尚未实现。目标是：核对来源固定修订、成立与未决部分、目标路径和候选差异；完成后能从来源查到实际 commit，构建、部署、采用分别显示，不改也留理由。流程见[项目数据](../../architecture/project-data.md#6-工作文档怎样沉淀为仓库正式文档)。

## 截图

由 `npm run docs:screenshots` 用合成夹具生成，怎样重新生成见[页面截图](../architecture.md#页面截图)。

![文档列表，1440](../../assets/frontend-pages/documents-1440.png)

文档列表的其他宽度：[390](../../assets/frontend-pages/documents-390.png)。

![Markdown 文档阅读，1440：右栏内嵌](../../assets/frontend-pages/document-1440.png)

![Markdown 文档阅读，1024：右栏以抽屉打开](../../assets/frontend-pages/document-1024.png)

![Markdown 文档阅读，390](../../assets/frontend-pages/document-390.png)

![HTML 报告在隔离区域里阅读，1440](../../assets/frontend-pages/document-html-1440.png)

HTML 报告的其他宽度：[390](../../assets/frontend-pages/document-html-390.png)。

![HTML 原件没有读回：说明原因，修订与发布仍在](../../assets/frontend-pages/document-html-failed-1440.png)

## 代码与测试

源码在 `apps/workbench/src/features/documents/`，测试在 `apps/workbench/test/`。

| 部分 | 主要源码 | 相关测试 |
| --- | --- | --- |
| 列表与表格 | `DocumentIndex.tsx`、`DocumentRail.tsx`、`DocumentTable.tsx`、`DocumentFilters.tsx`、`useDocumentList.ts`、`documentListState.ts`、`documentListModel.ts`、`apps/workbench/src/shared/leaderWorkLoad.ts`（用途与关联补读） | `document-list-model.test.ts`、`document-presentation.test.ts`、`discovery-browser.test.ts`、`leader-work-load.test.ts`、`document-original-reading-browser.test.ts`（从内层栏打开后返回的焦点、行悬停） |
| 阅读页与右栏 | `DocumentPage.tsx`、`DocumentFacts.tsx`、`DocumentOutline.tsx`、`TaskPeek.tsx`、`documentPresentation.ts`、`apps/workbench/src/shared/ui/readingProse.ts`、`apps/workbench/src/shared/ui/MarkdownBody.tsx`、`apps/workbench/src/shared/ui/markdownContent.ts`、`apps/workbench/src/shared/revisionPresentation.ts` | `document-presentation.test.ts`、`markdown-content.test.ts`、`document-original-reading-browser.test.ts` |
| HTML 原件与资源 | `HtmlReport.tsx`、`useOriginal.ts`（HTML 与只存原件的 Markdown 共用）、`apps/workbench/src/shared/ui/OriginalDocumentReader.tsx`（静态副本，任务页也用）、`apps/workbench/src/shared/ui/imagePreview.ts` | `document-full-html-reading-browser.test.ts`、`document-image-preview.test.ts`、`document-original-reading-browser.test.ts` |
| 读取与重读 | `apps/workbench/src/shared/ui/rereadOnReturn.ts`、`apps/workbench/src/shared/query.ts`（固定内容不随写入重读；列表逐页读取） | `query.test.ts`、`document-original-reading-browser.test.ts` |
| 来源与返回 | `DocumentOrigin.tsx`、`originValidation.ts`、`taskLinks.ts`（打开任务时带上返回）、`apps/workbench/src/shared/ui/returnRoute.ts`、`apps/workbench/src/shared/returnLink.ts`、`apps/workbench/src/shared/ui/ReturnLink.tsx` | `document-origin.test.ts`、`document-origin-refresh-browser.test.ts`、`session-document-return-browser.test.ts`、`return-link.test.ts`、`cross-space-return-browser.test.ts` |
| 保存与修订 | `DocumentRevise.tsx`、`UploadDocument.tsx`、`uploadCommand.ts` | `upload-command.test.ts`、`document-upload-browser.test.ts`（`EVOLOOP_DOCUMENT_SCREENSHOT_DIR`） |

## 相关

- 产品：[Document 的用途、格式和状态](../../product/tasks-and-documents.md#document-的用途格式和状态)、[链接和改版](../../product/tasks-and-documents.md#链接和改版)
- 合同：[DocumentStore 与 RelationStore](../../architecture/contracts.md#2a-documentstore-与-relationstore)、[项目数据](../../architecture/project-data.md)、[存储设计](../../architecture/storage.md)
- 前端：[布局](../layout.md)、[设计原则](../principles.md)、[实景旅程：读固定成果并回到工作](../journeys/current-work.md#4-读固定成果并回到工作)
