# 组织复盘观察期的一次性修复

这页说明怎样修复“选择性迁移后，组织复盘修订的 `organizationReview` 为空”这一数据缺口。它不是 schema 迁移，也不是长期业务命令；只在确认源归档与目标库对应修订仍然一致后执行一次。

## 适用范围与安全边界

修复只改 `document_revision.organization_review`。正文、`content_hash`、作者、创建时间、`previous_revision_id`、理由、格式、原件引用和资源清单都不改；`process_document` 的版本、状态和当前修订也不改。修复不会新增修订或伪造作者。

脚本默认 dry-run。只有显式 `--apply` 才写库；写库前必须：

- 停掉协调服务，确认当前进程不再持有单一协调者租约。脚本会在同一事务里再取 `731209842` 咨询锁，取不到就停止，不会与运行中的协调者并发写。
- 先按[本机运行与恢复](local-run.md#本机运行与恢复)做好数据库与 Blob 备份。
- 把迁移归档、修复报告放在仓库外、当前用户私有可读的目录。源 dump 与报告都不进入 Git。
- 明确源 dump 的 SHA-256、项目 ID、执行者身份和要修复的 Document ID。脚本不会从正文、标题或时间猜对象。

## 输入与核对

脚本从 `pg_restore --data-only --table=document_revision` 读取源库的 `document_revision`，按 `revision_id` 与目标行逐列比较以下字段：

- 身份与正文：`project_id`、`document_id`、`revision_id`、`body`；
- 固定原件：`format`、`content_hash`、`author`、`created_at`、`previous_revision_id`、`reason`、`media_type`、`original_name`、`payload_ref`、`entrypoint`、`assets_manifest`。

任何一项不一致都会阻止修复。目标已有不同 `organizationReview` 也不会被覆盖；脚本只填 `NULL`，重复执行会报告已修复并停止写入。

## Dry-run

连接串从 `EVOLOOP_DATABASE_URL`、`EVOLOOP_REPAIR_DATABASE_URL` 或 `--database-url` 读取。先在目标库上跑只读计划：

```bash
node scripts/repair-organization-review-periods.mjs \
  --source-dump /absolute/private/evoloop-source.dump \
  --source-sha256 <source-dump-sha256> \
  --source-schema <source-schema> \
  --source-main <source-main-commit> \
  --project <project-uuid> \
  --actor <operator-actor-id> \
  --document <organization-review-uuid> \
  --document <organization-review-uuid>
```

输出是 JSON，`status` 应为 `planned`；`changes` 只含目标 `organization_review` 为空的修订。`blocked` 非空时先查原因，不得直接加 `--apply` 跳过。

## 执行与审计

确认 dry-run 与源归档一致后，加上 `--apply` 与仓库外的报告路径：

```bash
node scripts/repair-organization-review-periods.mjs \
  --source-dump /absolute/private/evoloop-source.dump \
  --source-sha256 <source-dump-sha256> \
  --project <project-uuid> \
  --actor <operator-actor-id> \
  --document <organization-review-uuid> \
  --document <organization-review-uuid> \
  --apply \
  --report-out /absolute/private/organization-review-repair-report.json
```

同一事务内依次：取协调者租约；临时禁用 `immutable_document_revision` 与 `document_revision_allocation_observation`；逐条只写 `organization_review`；回读并断言其他列未变；向 `operation_journal` 写入 `command_type=repair.organization_review_period`；恢复触发器；提交。随后在新的读取中核对当前修订的观察期和操作记录。

操作记录包含执行者、时间、源 dump 的 SHA-256、源 schema/main、每条修订的修复前后值、正文 SHA-256（不存正文）、作者和内容哈希。它可以用普通读取回查：

```bash
evoloop get /api/projects/<project-uuid>/operations/<operation-id>
```

修复报告还会列出三份复盘文档的全部修订和当前修订的观察期。报告文件用 `0600` 创建，已存在时拒绝覆盖。

## 悬空 `previous`

选择性迁移可能保留一个指向源主机文档的固定 `previous`，而该文档没有迁来。这类链接是历史来源，不是本机可导航的现行依据。修复保留原值，并在操作记录中留下它；服务端只在“修订继续沿用已存链接”时容忍文档不存在，新建或改指到不存在的文档仍返回 `INVALID_PREVIOUS_REVIEW`。因此：

- 读取当前修订、按观察期排序和新建下一轮链接不受影响；
- 修订该文档时，只要不改变原 `previous`，仍可保存；
- 不要把悬空链接改成 `NULL` 再假装它从未存在；如果确实要清理，另做有记录的决定。

## 其他按修订存放的字段

首次适用样本对源归档与目标库的 312 条共同 `document_revision` 做了逐列比较：只有 10 条 `organization_review` 不同；`body`、`content_hash`、作者、时间、上一修订、理由、格式、原件引用和资源清单全部一致。目标库另有 069 迁移派生的 `revision_number`，不是迁移丢失字段；源归档中未迁来的 975 条修订属于选择性迁移未选中的文档，不是字段缺失。三个复盘文档的修订附属记录也做了集合比较：`document_blob_ref` 7/7、`document_decision` 2/2 完全一致；源归档另有 8 条 `basis_member` 和 4 条 `task_document_link` 指向未迁来的 Task `2a0e658f`、`2d5fbc86`，属于选择性迁移未选中的任务引用，不是修订字段缺失。该清单用于本次判断，不把未迁来的运行现场或未选中历史误算成缺陷。

## 失败与回滚

任何校验失败、锁不可用、触发器状态异常或更新行数不为 1 都会回滚整个事务，不留下半修复状态。提交后若要撤回，必须按新的、可审计的修复重做并保留理由；不能直接改修订正文、哈希或时间。报告、操作 ID 和源 dump 哈希应随本次发布记录保存。
