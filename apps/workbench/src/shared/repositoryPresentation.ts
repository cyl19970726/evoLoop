// The repositories configured for a project (GET /repositories), in words, for 仓库规范 and the Git registration form
// (features/references). The service lists only entries its Git source accepts; when any project's entry is invalid,
// the Git source refuses the whole registration and no project can read Git, which is said as such, never as "this
// project has no repository". A path is readable when it is one of a repository's allowed paths, or under one that
// ends in “/”, the Git source's own rule. Pure, so the pages and their tests agree.
import type { ProjectRepositoriesView, ProjectRepository } from "@evoloop/contracts/project-configuration";

export type RepositoryStanding =
  /** Repositories listed; a fixed Git source names one of them. */
  | { kind: "listed"; items: ProjectRepository[]; text: string }
  /** The list was read and this project has none: registering is refused. */
  | { kind: "none"; items: []; text: string }
  /** The whole registration is refused: this project's entries are listed, none readable now. */
  | { kind: "refused"; items: ProjectRepository[]; text: string }
  /** The service cannot say (no source, or its read failed): the identifier is typed. */
  | { kind: "unknown"; items: []; text: string; code: string | null };

export function repositoryStanding(view: ProjectRepositoriesView): RepositoryStanding {
  if (view.status === "available") return view.items.length
    ? { kind: "listed", items: view.items, text: `服务端为本项目配置了 ${view.items.length} 个仓库；登记 Git 固定来源时从中选择，路径要在允许读取的范围内。` }
    : { kind: "none", items: [], text: "服务端没有为本项目配置仓库，登记 Git 固定来源会被拒绝。要读仓库里的文件，请管理员在服务端登记仓库后重启服务。" };
  if (view.reason === "registration_invalid") return { kind: "refused", items: "items" in view ? view.items : [],
    text: "服务端的仓库登记有误（某个项目的条目允许路径是绝对路径或越出仓库，或同一仓库登记了两次），整份登记被拒，所有项目现在都读不了 Git 固定来源，登记也会被拒绝。请管理员修正登记后重启服务。" };
  if (view.reason === "not_provided") return { kind: "unknown", items: [], code: null,
    text: "服务端没有提供仓库清单，列不出本项目配置了哪些仓库。登记时的仓库标识请向管理员确认。" };
  if (view.reason === "read_failed") return { kind: "unknown", items: [], code: null,
    text: "服务端读取仓库配置失败，现在无法判断本项目配置了哪些仓库。登记时的仓库标识请向管理员确认，或稍后重新读取。" };
  return { kind: "unknown", items: [], code: String(view.reason),
    text: "服务端说仓库清单暂不可用，原因用了界面不认识的代码，现在无法判断本项目配置了哪些仓库。" };
}

/** Whether the Git source would read `path` in a repository with these allowed paths. */
export function pathAllowed(path: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some(entry => path === entry || (entry.endsWith("/") && path.startsWith(entry)));
}

/** One allowed path in words: a directory (ends in /) covers the files under it; anything else is that one file. */
export const allowedPathText = (entry: string) => entry.endsWith("/") ? `${entry} 下的文件` : entry;

/** The allowed paths of a repository, for a hint: “docs/ 下的文件、README.md”. */
export const allowedPathsText = (allowedPaths: readonly string[]) => allowedPaths.map(allowedPathText).join("、");

/** A typed path the chosen repository does not allow, said before sending; empty input or no repository says nothing. */
export function allowedPathProblem(value: string, repository: ProjectRepository | null | undefined): string | undefined {
  const path = value.trim();
  if (!path || !repository || pathAllowed(path, repository.allowedPaths)) return undefined;
  return `仓库 ${repository.repositoryId} 只允许读取 ${allowedPathsText(repository.allowedPaths)}；这个路径不在其中，服务端会拒绝。`;
}
