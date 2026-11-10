// 基础职责: the seven starting templates and whether this project has established each one. The service's single
// projection is checked by parseRoleTemplateSummary; a partial Role listing never proves a template is absent.
import { RefreshCw } from "lucide-react";
import { Button, LoadingState, Notice, StatusTag, type StatusTone } from "@evoloop/ui";
import { errorText, request } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { parseRoleTemplateSummary, roleTemplateHref, type TemplateRow } from "../../shared/RoleTemplateSummary";
import { PageSection, mutedText } from "../../shared/ui/PageParts";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

const stateTag: Record<TemplateRow["state"], { tone: StatusTone; label: string }> = {
  established: { tone: "done", label: "已建立" }, "not-established": { tone: "idle", label: "未建立" }, unknown: { tone: "unknown", label: "未知" },
};
const stamp = (value: number) => new Date(value).toLocaleString("zh-CN", { hour12: false });

export function RoleTemplates({ projectId }: { projectId: string }) {
  const read = useProjectQuery(projectId, ["roles", "templates"], signal =>
    request<unknown>("", `/api/projects/${encodeURIComponent(projectId)}/role-templates`, 15000, { signal })
      .then(value => parseRoleTemplateSummary(value, projectId)));
  const summary = read.data;
  const error = read.error ? errorText(read.error) : "";
  const fresh = !!summary && !read.isFetching && !error;
  return <PageSection title="基础职责" description="初始组合只作参考；试行或持续生效的正式职责才算“已建立”。承载和执行权限另行核对。"
    action={<Button size="compact" variant="ghost" disabled={read.isFetching} onClick={() => void read.refetch()}>
      <RefreshCw aria-hidden="true" className={read.isFetching ? "animate-spin" : undefined} />回读当前状态</Button>}>
    {read.isPending && <LoadingState lines={4} label="正在读取基础职责" />}
    {error && <Notice tone="error" title="基础职责读取失败">{error}{summary ? "；保留上次观察，不能视为当前状态。" : "；尚无可信状态。"}<ErrorDetails error={read.error} /></Notice>}
    {summary && <>
      <p className={mutedText} role="status">{fresh ? "观察于" : read.isFetching ? "正在核对，下列仍是上次观察，观察于" : "上次观察于"} {stamp(read.dataUpdatedAt)}；
        {summary.nextCursor ? "职责列表尚有未读页，缺项显示未知。" : "已读本次模板投影。"}</p>
      <ul aria-label="基础职责模板" className="flex flex-col overflow-hidden rounded-xl bg-raised shadow-sm">
        {summary.rows.map(row => <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2.5 first:border-t-0">
          <span className="min-w-24 text-small font-medium text-foreground">{row.title}</span>
          <span className={mutedText}>{row.roleClass === "system" ? "系统职责" : "业务职责"}</span>
          <StatusTag tone={stateTag[row.state].tone} label={stateTag[row.state].label} />
          <span className="flex min-w-0 flex-1 flex-wrap justify-end gap-x-3 gap-y-1">
            {row.roles.map(role => <a key={role.id} href={roleTemplateHref(projectId, role.id)!} className="text-small text-primary hover:underline">{role.title}</a>)}
            {row.unresolvedIds.map(id => <span key={id} className={mutedText}>关联职责不可核</span>)}
          </span>
        </li>)}
      </ul>
    </>}
  </PageSection>;
}
