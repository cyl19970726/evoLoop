// 仓库标识 of 登记 Git 固定来源: chosen from the repositories the service configured for the project (GET /repositories).
// While the list is read nothing is concluded; when it cannot be read, or the service cannot list repositories, the
// identifier is typed as before (an address or a local path said wrong at once). When the project has none, or the
// whole registration is refused, the form says so and does not send what the service would refuse.
import { Button, Field, Input, Notice, Select } from "@evoloop/ui";
import type { ProjectRepository } from "@evoloop/contracts/project-configuration";
import { errorText } from "../../shared/api";
import { useProjectRepositories } from "../../shared/projectConfiguration";
import { allowedPathsText, repositoryStanding, type RepositoryStanding } from "../../shared/repositoryPresentation";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { repositoryProblem } from "./referencePresentation";

/** The repository list as the form uses it: the chosen repository, and why sending is held back (else null). */
export function useRepositoryChoice(projectId: string, enabled: boolean, repositoryId: string) {
  const read = useProjectRepositories(projectId, { enabled });
  const standing: RepositoryStanding | null = read.data ? repositoryStanding(read.data) : null;
  const chosen: ProjectRepository | null = standing?.items.find(item => item.repositoryId === repositoryId.trim()) ?? null;
  // Only an answer read just now holds the form back; one kept after a failed reread does not.
  const held = !standing || read.stale ? null : standing.kind === "none" ? "本项目没有配置仓库，登记 Git 固定来源会被拒绝。"
    : standing.kind === "refused" ? "服务端的仓库登记有误，现在所有项目都读不了 Git 固定来源，登记会被拒绝。" : null;
  return { read, standing, chosen, held };
}

export function RepositoryChoice({ choice, value, onChange }: {
  choice: ReturnType<typeof useRepositoryChoice>; value: string; onChange(value: string): void;
}) {
  const { read, standing, chosen } = choice;
  const typed = <Field label="仓库标识" hint="服务端为本项目配置的仓库名（不是网址或本地路径），请向管理员确认。" error={repositoryProblem(value)}>
    {props => <Input {...props} value={value} autoComplete="off" spellCheck={false} onChange={event => onChange(event.target.value)} />}</Field>;
  if (!standing) return read.isError ? <>
    <Notice tone="error" action={<Button size="compact" variant="ghost" onClick={() => void read.refetch()}>重新读取</Button>}>
      本项目的仓库清单没有读回：{errorText(read.error)}。读回之前无法判断有哪些仓库，可以按仓库标识填写。</Notice>
    {typed}
  </> : <Field label="仓库标识">{props => <Select {...props} className="w-full" value="" disabled><option value="">正在读取本项目的仓库…</option></Select>}</Field>;
  if (standing.kind === "unknown") return <>
    <Notice tone="waiting">{standing.text}</Notice>
    <FullIdentifiers rows={[{ label: "原因代码", value: standing.code }]} />
    {typed}
  </>;
  const listed = standing.items;
  const strange = value.trim() && !listed.some(item => item.repositoryId === value.trim());
  return <>
    {read.stale && <Notice tone="waiting" title="上次读回，当前待核对">仓库清单重新读取失败：{errorText(read.error)}。</Notice>}
    {standing.kind !== "listed" && <Notice tone={standing.kind === "refused" ? "error" : "waiting"}>{standing.text}</Notice>}
    <Field label="仓库标识" hint={chosen ? `允许读取：${allowedPathsText(chosen.allowedPaths)}。` : "从服务端为本项目配置的仓库中选择。"}>
      {props => <Select {...props} className="w-full" value={value.trim()} disabled={!listed.length} onChange={event => onChange(event.target.value)}>
        <option value="">{listed.length ? "选择一个仓库" : "本项目没有可选的仓库"}</option>
        {strange && <option value={value.trim()}>{value.trim()}（不在读回的仓库清单里）</option>}
        {listed.map(item => <option key={item.repositoryId} value={item.repositoryId}>{item.repositoryId}</option>)}
      </Select>}</Field>
  </>;
}
