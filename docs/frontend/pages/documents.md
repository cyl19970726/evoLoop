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

现状：列表和阅读是两页。列表是四列表格；阅读页顶部有返回来源和所读修订，正文在主区，右侧可收起的栏放页内目录、版本与来源、引用此文档的任务。

## 内容与状态

共同规则见[设计原则](../principles.md)。

### 从表格打开完整过程文档

- 过程文档用表格逐行查阅，点标题读完整正文（[DEC-024](../../decisions.md)）；卡片摘要不代替列表和全文。
- 标题支持键盘打开；行内的任务链接单独跳转。
- 搜索、筛选和分页写明覆盖范围；从全文返回时保留原条件和位置。
- 窄屏时表格横向滚动或收起次要列，标题和打开入口始终可读。

| 格式 | 怎样读 | 怎样保存 |
| --- | --- | --- |
| Markdown | 排版后的完整正文，可切回原文；保留标题、列表、表格、代码块和附件引用 | 保存原文和固定修订，渲染结果可重建 |
| HTML 报告 | 在隔离区域保留原排版、样式和已保存的图片、图表；可查看 HTML 原文 | 原件和所需资源一起保存，绑定同一修订；单文件报告也适用 |

HTML 报告直接作为过程文档保存，脚本不执行，默认静态阅读；交互能力单独验证后再开放。未保存的外部资源列为缺项，这时不称“完整报告”。实现边界见[前端架构](../architecture.md#过程文档表格与完整阅读)。

### 版本与状态

- 草稿、已发布、已归档是生命周期；正在读的固定版、当前版、已发布版分开标明，读旧版时提示一直可见。
- 从任务的固定依据进入时保持那一版。
- 任务主正文只从任务修改，文档页只读并链到所属任务。
- 普通文档修订保留读入时的版本和草稿，冲突时先比较。
- 原件缺失、无权限、服务不可达分别说明原因；摘要不代替原件。
- “影响哪些工作”尚未实现：从新版逐项看引用旧版的任务及处理理由，规则见[需求纠正](../../product/daily-loop.md#需求纠正怎样处理)。

### 过程文档和仓库正式文档的关系

三类正文各有入口：过程文档记这次工作的讨论和决定，仓库正式文档（“仓库规范”）存已采纳的规则，知识空间读当前认识。来源可以往返，各自的正文和修订保持独立。权威归属见[对象关系](../../product/workbench.md#对象关系与能力职责)。

“整理到仓库文档”尚未实现。目标是：核对来源固定修订、成立与未决部分、目标路径和候选差异；完成后能从来源查到实际 commit，构建、部署、采用分别显示，不改也留理由。流程见[项目数据](../../architecture/project-data.md#6-工作文档怎样沉淀为仓库正式文档)。

## 截图

![固定 Markdown 文档的阅读页](../../assets/frontend-journey-20261108/document-1440x900.png)

2026-11-08，正式发布版 36cb620，1440×900。固定 Markdown：页头有返回来源和所读修订；右栏收起后正文按可读行宽排版，右侧留白较多。

![固定 HTML 报告的阅读页](../../assets/frontend-journey-20261108/html-report-1440x900.png)

同一版本的 HTML 报告：隔离区域占满页头以下并在内部滚动；版本与来源收在按钮里，原件和资源收在正文下方。

## 代码与测试

源码在 `apps/workbench/src/documents/`，测试在 `apps/workbench/test/`。

| 部分 | 主要源码 | 相关测试 |
| --- | --- | --- |
| 文档表格 | `DocumentIndex.tsx`、`documentListModel.ts`、`apps/workbench/src/workflow/leaderWorkLoad.ts`（用途与关联补读） | `document-list-model.test.ts`、`leader-work-load.test.ts` |
| 阅读页 | `DocumentPage.tsx`、`DocumentOutline.tsx`、`apps/workbench/src/ui/MarkdownBody.tsx`、`apps/workbench/src/ui/markdownContent.ts` | `markdown-content.test.ts` |
| HTML 原件与资源 | `OriginalDocumentReader.tsx`、`imagePreview.ts` | `document-full-html-reading-browser.test.ts`、`document-image-preview.test.ts` |
| 来源与返回 | `DocumentOrigin.tsx`、`originValidation.ts`、`apps/workbench/src/ui/returnRoute.ts` | `document-origin.test.ts`、`document-origin-refresh-browser.test.ts`、`session-document-return-browser.test.ts` |
| 保存与修订 | `UploadDocument.tsx` | 暂无专门测试 |

## 相关

- 产品：[Document 的用途、格式和状态](../../product/tasks-and-documents.md#document-的用途格式和状态)、[链接和改版](../../product/tasks-and-documents.md#链接和改版)
- 合同：[DocumentStore 与 RelationStore](../../architecture/contracts.md#2a-documentstore-与-relationstore)、[项目数据](../../architecture/project-data.md)、[存储设计](../../architecture/storage.md)
- 前端：[布局](../layout.md)、[设计原则](../principles.md)、[实景旅程：读固定成果并回到工作](../journeys/current-work.md#4-读固定成果并回到工作)
