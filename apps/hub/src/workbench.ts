import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * The workbench pages and files, served by the Hub (H1 PR4). The pages know they are behind the Hub from one meta tag (`evoloop-auth=hub`): they sign in with the
 * Hub's cookie instead of a pasted token. Nothing here reads or writes a credential; the files are static.
 *
 * A page chunk that is no longer on disk (a tab opened before a release) is answered with a small module that says what happened, as the coordinator does; the Hub's
 * login cookie stays valid, so the tab needs a reload and nothing else.
 */
export const HUB_STALE_CHUNK = `(() => {
  if (typeof document !== "undefined" && !document.getElementById("evoloop-stale-chunk")) {
    const box = document.createElement("div");
    box.id = "evoloop-stale-chunk"; box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,calc(100vw - 32px));padding:12px 16px;border-radius:12px;background:#fde9e9;color:#1c1714;font:14px/1.5 sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.25)";
    box.textContent = "工作台已经更新到新版本，这一页的文件已不在服务器上。请刷新页面后再打开（你的登录仍然有效，不需要重新填写令牌）。";
    const button = document.createElement("button");
    button.type = "button"; button.textContent = "刷新页面"; button.style.cssText = "margin-left:12px;padding:4px 12px;border-radius:999px;border:0;background:#1c1714;color:#fcfbf8;cursor:pointer";
    button.addEventListener("click", () => location.reload());
    box.append(button); document.body.append(box);
  }
  throw new Error("Failed to fetch dynamically imported module: this file is no longer on the server (the workbench has been updated)");
})();
`;

const WORKBENCH_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' blob:; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data:; frame-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
  ".woff": "font/woff", ".json": "application/json", ".map": "application/json", ".ico": "image/x-icon", ".webp": "image/webp" };
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROOT_FILES = ["favicon.svg", "theme-init.js"];

/** The workbench's index page, with the one tag that tells it to use the Hub's login. */
export function hubIndexHtml(html: string): string {
  if (html.includes('name="evoloop-auth"')) return html;
  const tag = '<meta name="evoloop-auth" content="hub" />';
  return /<meta charset="UTF-8"\s*\/?>/i.test(html) ? html.replace(/<meta charset="UTF-8"\s*\/?>/i, match => `${match}\n    ${tag}`) : html.replace("<head>", `<head>\n    ${tag}`);
}

export function registerWorkbench(app: FastifyInstance, webRoot: string): void {
  const page = async (reply: FastifyReply) => {
    let html: string;
    try { html = await readFile(join(webRoot, "index.html"), "utf8"); }
    catch { return reply.code(503).type("text/plain; charset=utf-8").send("The workbench files are not installed on this Hub."); }
    return reply.header("content-security-policy", WORKBENCH_CSP).type("text/html; charset=utf-8").send(hubIndexHtml(html));
  };
  app.get("/", async (_request, reply) => page(reply));
  app.get("/ui", async (_request, reply) => page(reply));
  app.get("/p/*", async (_request, reply) => page(reply));
  const file = async (reply: FastifyReply, name: string, stale: boolean) => {
    const extension = name.slice(name.lastIndexOf("."));
    try {
      const body = await readFile(join(webRoot, stale ? "assets" : ".", name));
      return reply.header("content-security-policy", WORKBENCH_CSP).type(TYPES[extension] ?? "application/octet-stream").send(body);
    } catch {
      if (stale && extension === ".js") return reply.code(200).header("cache-control", "no-store").type("text/javascript; charset=utf-8").send(HUB_STALE_CHUNK);
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "The file does not exist.", details: null } });
    }
  };
  app.get("/assets/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!ASSET.test(name)) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "The file does not exist.", details: null } });
    return file(reply, name, true);
  });
  for (const name of ROOT_FILES) app.get(`/${name}`, async (_request, reply) => file(reply, name, false));
  for (const name of ["/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) app.get(name, async (_request, reply) => reply.redirect("/favicon.svg"));
}
