# 报告与提交：保存并读到一份完整复盘

## 报告要帮助读者理解什么

参考此前company.html的工作方式：先恢复项目全貌和目标，再解释当前团队怎样协作、实际工作怎样流动、这轮有哪些进步与问题、原因是什么，以及下一步值得怎样改进。

同时回看团队协作、单角色方法与skill、真实产品体验、职责与容量，带上上轮改进的实际效果。让用户读完能理解公司现在怎样运转，并对接下来作取舍。内容按这轮事实和读者问题组织，不要求固定栏目、图工具或前端组件。

Evo自己写成一份完整的HTML或Markdown报告。图片可以来自ImageGen，图可以来自archify、Mermaid或其他合适工具。HTML可以自带布局、样式与图；需要的图片、脚本或其他资源随报告保留。视觉效果图指导页面表现，报告内容和图应反映本轮真实工作。

当前Session列表提供实时团队入口；每轮复盘是一份类型为 organization_review 的 Document。组织复盘仅按该类型列出文档，点击后进入通用 Document 阅读器；文档库和组织复盘引用同一 documentId，没有右侧固定预览。报告正文由Evo自由编写，页面负责原件阅读。

## 时段与历史

每轮显示观察起止、时区、上一份报告和提交时刻。默认从上轮观察截止点续读，不能拿上次提交时刻代替；首份入库可沿外部旧报告起点接续并说明。专项或补查注明自选范围。

一轮新复盘保存为新报告；勘误或表达改版保存为原报告的新修订，保留旧版和原因。正文保留观察时判断，之后的事实进入下一轮或明确补充。来源和未覆盖项留在报告里，便于接续。

## CLI只负责把成果保存并交到阅读入口

写好report.html或report.md；相关文件放在同目录assets/。使用项目内已有授权的正常CLI配置，提交：

```text
node .agents/skills/evoloop-evocation/scripts/review-cli.mjs submit /path/report.html CLI_CONFIG.json RECEIPT_DIR --title "本轮复盘标题" --from OBSERVED_FROM --to OBSERVED_TO --timezone Asia/Taipei
```

后续周期可省略from，程序沿上一份报告的观察截止点接续；to仍是本次观察截止时刻。CLI_CONFIG只给正常项目CLI的argv、projectId和可选timeZone，认证沿原CLI，不把令牌写入报告或网页。

脚本复用原生 Document 创建／原件导入，设置 kind=organization_review；观察时段和上一轮固定引用存入 DocumentRevision.organizationReview，标题、作者、时间和版本沿用 Document。报告原件字节不插入分类注释或协议头，列表无需下载并解释正文。Evo不需要把自由正文拆成一套数据库字段，也不用为了保存报告制造Task、Discussion或Role。

返回固定报告地址、修订和回执后，从组织复盘列表打开原件，实际检查正文、图、资源与来源链接。页面能显示、图能读到，才完成这次报告交付。提交不等于建议已采纳，也不证明方法已经有效。

```text
node .agents/skills/evoloop-evocation/scripts/review-cli.mjs list PROJECT_ID CLI_CONFIG.json
node .agents/skills/evoloop-evocation/scripts/review-cli.mjs status /path/report.html CLI_CONFIG.json RECEIPT_DIR
```

修订同一报告时，先读取该 Document 的版本，再加 --document DOCUMENT_ID --version OBSERVED_VERSION 和明确理由；新一轮仍创建新 Document。早期普通 report 文档可在同一 ID 上明确归类为组织复盘，旧修订保留。

HTML及其assets走既有资源存储；Markdown使用现有正文／Mermaid阅读能力。上传后实际打开确认图可读，需要外置图片时可选择完整HTML报告。图工具自由，最终产物遵循普通Document阅读器的真实能力。

未知结果沿原回执查询，不换操作号重发。当前这是项目内增强脚本；原生业务CLI与操作恢复仍遵守[evoloop-workflow](../../evoloop-workflow/SKILL.md)。当前服务与正常项目CLI需支持 organizationReviewDocuments 和 organization_review 类型；缺少能力时明确停止，不退回正文标记分类。

## 从历史避免两类误判

过去名为“验收”的会话收到文案提炼或有界研究任务，短时间交稿不能证明敷衍，也不能证明完整产品亲用已完成。分别核目标、实际派单、行为和消费结果，把原因放在有证据的断点。

工程检查和局部亲用通过后，用户仍可能否定整体体验。保留各自判据和证据，把改进用于后续真实工作；报告、Task关闭、skill文件和新增Session本身都不是效果证明。
