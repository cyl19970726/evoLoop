// The login gate: a local access token, or behind the Hub the browser's own login checked once.
import { useEffect, useState, type FormEvent } from "react";
import { Logo } from "@evoloop/ui";
import { ApiError, api, errorText, type Session } from "../../shared/api";
import { authMode } from "../../shared/identity";

// The login page is part of the first load, so it uses Tailwind classes directly instead of the @evoloop/ui
// components (which bring tailwind-merge and icons). The classes follow Button, Input and Notice.
const button = "inline-flex h-9 cursor-pointer items-center justify-center rounded-md bg-brand px-4 text-small font-medium text-on-brand outline-none transition-colors hover:bg-brand-hover active:bg-brand-pressed focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50";
const noticeClass = { error: "rounded-lg bg-danger-soft px-4 py-3 text-label leading-(--leading-body) text-text-secondary", waiting: "rounded-lg bg-warning-soft px-4 py-3 text-label leading-(--leading-body) text-text-secondary" };

/** Shown on development servers so a preview is never mistaken for the released workbench. */
export function DevelopmentBanner() {
  if (!import.meta.env.DEV) return null;
  return <div data-ui="" role="status" className="development-preview bg-warning-soft px-4 py-1.5 text-center text-caption font-semibold text-warning">
    {window.location.port === "5181" ? "开发测试预览 · 模拟数据 · 尚未发布" : "开发预览 · 连接现有数据 · 尚未发布"}
  </div>;
}

export function AuthGate({ onSuccess, hasReceipts, notice, prefetch }: {
  onSuccess: (token: string, session: Session) => void; hasReceipts: boolean; notice: string; prefetch: () => void;
}) {
  const [input, setInput] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Behind the Hub the first look at the cookie is not a failure: no login yet just means the form is shown.
  const [looked, setLooked] = useState(false);
  const hub = authMode() === "hub";
  async function check(value: string) {
    setBusy(true); setError("");
    try {
      const session = await api(value).session();
      setInput(""); setPassword("");
      onSuccess(value, session);
    } catch (cause) {
      if (hub && cause instanceof ApiError && cause.status === 401) { if (looked) setError("登录没有成功或已过期，请重新登录。"); }
      else setError(errorText(cause));
    }
    finally { setBusy(false); setLooked(true); }
  }
  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password || busy) return;
    setBusy(true); setError("");
    try {
      await api("").hubLogin(email.trim(), password);
      setPassword("");
      await check("");
    } catch (cause) { setError(errorText(cause)); setPassword(""); setBusy(false); }
  }
  useEffect(() => { prefetch(); }, [prefetch]);
  // Behind the Hub the browser already carries the login; check it once instead of asking for a token.
  useEffect(() => { if (hub) void check(""); }, [hub]); // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    await check(input.trim());
  }
  return <div data-ui="" className="auth-shell flex min-h-dvh flex-col bg-background">
    <DevelopmentBanner />
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="auth-card flex w-full max-w-[400px] flex-col gap-5 rounded-xl bg-raised p-6 border border-border compact:p-8">
        <div className="flex items-center gap-3">
          <Logo size={40} />
          <div>
            <p className="text-caption text-muted-foreground">evoLoop · {hub ? "工作台" : "本机工作台"}</p>
            <h1 className="text-heading font-semibold text-foreground">进入项目工作台</h1>
          </div>
        </div>
        {notice && <p role="alert" className={noticeClass.error}>{notice}</p>}
        {hub
          ? !looked ? <p role="status" className="text-small text-text-secondary">正在核对登录…</p>
          : <form onSubmit={signIn} className="flex flex-col gap-4" aria-label="登录">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="hub-email" className="text-label font-semibold text-foreground">邮箱</label>
              <input id="hub-email" type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required
                className="h-9 w-full rounded-md border-0 bg-field px-3 text-small text-foreground outline-none transition-shadow focus-visible:shadow-[var(--focus-ring)]" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="hub-password" className="text-label font-semibold text-foreground">密码</label>
              <input id="hub-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required aria-describedby="hub-hint"
                className="h-9 w-full rounded-md border-0 bg-field px-3 text-small text-foreground outline-none transition-shadow focus-visible:shadow-[var(--focus-ring)]" />
              <p id="hub-hint" className="m-0 text-caption text-muted-foreground">用 Hub 账号登录；刷新页面后登录仍然有效，不需要重新填写。</p>
            </div>
            <button type="submit" className={button} disabled={busy}>{busy ? "正在登录…" : "登录"}</button>
          </form>
          : <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="token" className="text-label font-semibold text-foreground">访问令牌</label>
              <input id="token" type="password" autoComplete="off" value={input} onChange={event => setInput(event.target.value)} required aria-describedby="token-hint"
                className="h-9 w-full rounded-md border-0 bg-field px-3 text-small text-foreground outline-none transition-shadow focus-visible:shadow-[var(--focus-ring)]" />
              <p id="token-hint" className="m-0 text-caption text-muted-foreground">令牌只保存在当前页面内存中，刷新后需要重新输入。</p>
            </div>
            <button type="submit" className={button} disabled={busy}>{busy ? "正在核对…" : "进入"}</button>
          </form>}
        {hasReceipts && <p role="status" className={noticeClass.waiting}>本浏览器会话保留了尚未核对的操作 ID。用原身份登录后可逐项查询；回执不包含令牌或复核正文。</p>}
        {error && <p role="alert" className={noticeClass.error}>{error}</p>}
      </div>
    </main>
  </div>;
}
