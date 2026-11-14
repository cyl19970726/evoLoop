import type { Principal } from "./auth.js";
import type { PublicAccount, PublicPersonalToken } from "./service.js";
import type { Project, ProjectMember } from "./store.js";

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const layout = (title: string, body: string): string => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · evoLoop Hub</title>
  <style>
    :root { color-scheme: light; --ink:#20201d; --muted:#6b6a64; --line:#d8d5ca; --paper:#fbf9f2; --accent:#8a3f2d; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    main { width:min(960px, calc(100% - 32px)); margin:40px auto 80px; }
    h1,h2 { line-height:1.2; letter-spacing:-.02em; }
    h1 { font-size:clamp(1.8rem,5vw,2.8rem); margin:0 0 12px; }
    h2 { font-size:1.15rem; margin-top:36px; border-bottom:1px solid var(--line); padding-bottom:8px; }
    p,li { color:var(--muted); }
    a { color:var(--accent); }
    fieldset { border:1px solid var(--line); border-radius:10px; padding:16px; margin:16px 0; background:#fffdf7; }
    label { display:block; margin:10px 0 4px; font-weight:600; }
    input[type=email], input[type=password], input[type=text], select, textarea { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:7px; background:#fff; font:inherit; }
    input[type=checkbox] { margin-right:6px; }
    button { border:0; border-radius:7px; background:var(--accent); color:#fff; padding:9px 14px; font:inherit; cursor:pointer; }
    button.secondary { background:#5f5d55; }
    .row { display:flex; gap:14px; flex-wrap:wrap; align-items:end; }
    .row > * { flex:1 1 180px; }
    .error { border-left:3px solid #a33; background:#fff1ee; padding:10px 14px; border-radius:6px; }
    .notice { border-left:3px solid #4d6b52; background:#eff7ef; padding:10px 14px; border-radius:6px; }
    code, .token { overflow-wrap:anywhere; background:#f0ede3; padding:2px 5px; border-radius:4px; }
    table { width:100%; border-collapse:collapse; }
    th,td { text-align:left; vertical-align:top; border-bottom:1px solid var(--line); padding:8px 6px; }
    .muted { color:var(--muted); font-size:.92em; }
    .inline { display:inline; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;

export function loginPage(): string {
  return layout("登录", `<h1>进入 evoLoop Hub</h1>
<p>这是 Hub 骨架的最小登录表单，正式登录页属于 PR4。</p>
<form method="post" action="/form/login">
  <fieldset>
    <label for="email">邮箱</label>
    <input id="email" name="email" type="email" autocomplete="username" required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <p><button type="submit">登录</button></p>
  </fieldset>
</form>
<p>没有账号？使用邀请链接注册。</p>`);
}

export function registerPage(inviteToken: string): string {
  return layout("邀请注册", `<h1>接受邀请</h1>
<p>邀请只能使用一次，并会在过期后失效。</p>
<form method="post" action="/form/register">
  <fieldset>
    <input type="hidden" name="inviteToken" value="${escapeHtml(inviteToken)}">
    <label for="displayName">显示名称</label>
    <input id="displayName" name="displayName" type="text" maxlength="120">
    <label for="password">密码（至少 12 个字符）</label>
    <input id="password" name="password" type="password" minlength="12" autocomplete="new-password" required>
    <p><button type="submit">创建账号</button></p>
  </fieldset>
</form>`);
}

export function dashboardPage(
  principal: Principal,
  projects: Array<Project & { membership: unknown }>,
  tokens: PublicPersonalToken[],
  csrf: string,
): string {
  const human = principal.kind === "human" ? principal : null;
  const projectList = projects.length
    ? `<ul>${projects.map(project => `<li><a href="/projects/${escapeHtml(project.projectId)}">${escapeHtml(project.name)}</a> <span class="muted">${escapeHtml(project.projectId)}</span></li>`).join("")}</ul>`
    : `<p>你还没有加入任何项目。</p>`;
  const tokenList = tokens.length
    ? `<table><thead><tr><th>名称</th><th>项目范围</th><th>创建时间</th><th></th></tr></thead><tbody>${tokens.map(token => `<tr>
      <td>${escapeHtml(token.name)}</td><td>${token.projectId ? escapeHtml(token.projectId) : "全部所属项目"}</td>
      <td>${escapeHtml(token.createdAt)}</td>
      <td><form method="post" action="/form/tokens/${escapeHtml(token.tokenId)}/revoke" class="inline">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">撤销</button>
      </form></td></tr>`).join("")}</tbody></table>`
    : `<p>还没有个人令牌。</p>`;
  const projectOptions = projects.map(project => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.name)}</option>`).join("");
  return layout("我的项目", `<h1>我的项目</h1>
<p>${escapeHtml(human?.displayName ?? principal.displayName)} · ${escapeHtml(human?.email ?? principal.actorId)}</p>
<form method="post" action="/form/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">退出登录</button></form>
<h2>项目</h2>${projectList}
<h2>个人令牌</h2>
<p>令牌只在创建时显示一次；数据库只保存 SHA-256 哈希。</p>
<form method="post" action="/form/tokens">
  <fieldset>
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <div class="row"><div><label for="tokenName">名称</label><input id="tokenName" name="name" type="text" maxlength="120" required></div>
    <div><label for="tokenProject">项目范围</label><select id="tokenProject" name="projectId"><option value="">全部所属项目</option>${projectOptions}</select></div></div>
    <p><button type="submit">创建令牌</button></p>
  </fieldset>
</form>${tokenList}
${human?.hubAdmin ? `<h2>Hub 管理</h2><p><a href="/admin">账号、邀请、项目与服务身份</a></p>` : ""}`);
}

export function projectPage(project: Project, members: ProjectMember[], csrf: string): string {
  const rows = members.map(member => `<tr>
    <td>${escapeHtml(member.displayName)}<div class="muted">${escapeHtml(member.email)}</div></td>
    <td><form method="post" action="/form/projects/${escapeHtml(project.projectId)}/members/${escapeHtml(member.accountId)}/update">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label><input type="checkbox" name="task" ${member.canTask ? "checked" : ""}>任务</label>
      <label><input type="checkbox" name="document" ${member.canDocument ? "checked" : ""}>文档</label>
      <label><input type="checkbox" name="session" ${member.canSession ? "checked" : ""}>Session</label>
      <label><input type="checkbox" name="isProjectAdmin" ${member.isProjectAdmin ? "checked" : ""}>项目管理员</label>
      <label>限定 Session（逗号分隔，留空表示全部）</label>
      <input type="text" name="sessionIds" value="${escapeHtml(member.sessionIds.join(","))}">
      <p><button type="submit">保存</button></p>
    </form></td>
    <td><form method="post" action="/form/projects/${escapeHtml(project.projectId)}/members/${escapeHtml(member.accountId)}/remove">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">移除</button>
    </form></td>
  </tr>`).join("");
  return layout(project.name, `<h1>${escapeHtml(project.name)}</h1>
<p class="muted">${escapeHtml(project.projectId)}${project.machineId ? ` · ${escapeHtml(project.machineId)}` : ""}</p>
<p><a href="/app">返回我的项目</a></p>
<h2>成员与权限</h2>
<table><thead><tr><th>成员</th><th>权限</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<h2>添加成员</h2>
<form method="post" action="/form/projects/${escapeHtml(project.projectId)}/members">
  <fieldset>
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <label>邮箱</label><input type="email" name="email" required>
    <label><input type="checkbox" name="task">任务</label>
    <label><input type="checkbox" name="document">文档</label>
    <label><input type="checkbox" name="session">Session</label>
    <label><input type="checkbox" name="isProjectAdmin">项目管理员</label>
    <label>限定 Session（逗号分隔，留空表示全部）</label><input type="text" name="sessionIds">
    <p><button type="submit">添加</button></p>
  </fieldset>
</form>`);
}

export function adminPage(projects: Project[], accounts: PublicAccount[], csrf: string): string {
  const accountOptions = accounts.map(account => `<option value="${escapeHtml(account.accountId)}">${escapeHtml(account.displayName)} · ${escapeHtml(account.email)}</option>`).join("");
  const projectOptions = projects.map(project => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.name)} · ${escapeHtml(project.projectId)}</option>`).join("");
  const projectRows = projects.map(project => `<tr><td>${escapeHtml(project.name)}</td><td><code>${escapeHtml(project.projectId)}</code></td><td>${escapeHtml(project.machineId ?? "未登记")}</td></tr>`).join("");
  return layout("Hub 管理", `<h1>Hub 管理</h1>
<p>Hub 管理员管理账号、邀请、项目元数据与服务身份；不会因管理员身份自动获得项目内容权限。</p>
<p><a href="/app">返回我的项目</a></p>
<h2>邀请人类账号</h2>
<form method="post" action="/form/admin/invites">
  <fieldset><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <label>邮箱</label><input type="email" name="email" required>
    <p><button type="submit">创建一次性邀请</button></p>
  </fieldset>
</form>
<h2>创建项目</h2>
<form method="post" action="/form/admin/projects">
  <fieldset><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <div class="row"><div><label>项目名称</label><input type="text" name="name" required></div>
    <div><label>项目 ID（可留空，PR3 接通时应使用 coordinator 的项目 ID）</label><input type="text" name="projectId"></div></div>
    <label>所在机器占位（可留空）</label><input type="text" name="machineId">
    <label>第一位项目管理员</label><select name="projectAdminAccountId" required>${accountOptions}</select>
    <p class="muted">第一位项目管理员默认获得任务、文档、Session 三类内容权限和项目管理权限。</p>
    <p><button type="submit">创建项目</button></p>
  </fieldset>
</form>
<h2>项目元数据</h2>
<table><thead><tr><th>名称</th><th>项目 ID</th><th>机器占位</th></tr></thead><tbody>${projectRows}</tbody></table>
<h2>创建服务身份</h2>
<form method="post" action="/form/admin/service-identities">
  <fieldset><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <div class="row"><div><label>actorId（可留空）</label><input type="text" name="actorId"></div>
    <div><label>显示名称</label><input type="text" name="displayName" required></div></div>
    <label>人类所有者</label><select name="ownerAccountId" required>${accountOptions}</select>
    <label>用途</label><input type="text" name="purpose" required>
    <label>项目范围（可多选）</label><select name="projectIds" multiple size="4">${projectOptions}</select>
    <p><button type="submit">创建服务身份并签发令牌</button></p>
  </fieldset>
</form>`);
}

export function oneTimeSecretPage(title: string, label: string, secret: string, backHref = "/app"): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1>
<p class="notice">${escapeHtml(label)}只显示这一次。请立即把它放进受控的私密位置。</p>
<p class="token">${escapeHtml(secret)}</p>
<p><a href="${escapeHtml(backHref)}">继续</a></p>`);
}

export function errorPage(status: number, message: string): string {
  return layout("请求失败", `<h1>请求失败</h1><p class="error">${escapeHtml(message)}</p><p><a href="/app">返回</a></p>`);
}
