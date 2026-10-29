import { useEffect, useState } from "react";
import type { DocumentPayloadRevision } from "@evoloop/contracts/process-documents";
import { errorText, request } from "../api";
import { MarkdownBody } from "../ui/MarkdownBody";
import { imagePreview } from "./imagePreview";

interface AvailableOriginal {
  status: "available"; revision: DocumentPayloadRevision; body: string;
  assets: Array<{ path: string; mediaType: string; base64: string }>;
}
interface UnavailableOriginal { status: "unavailable"; revision: DocumentPayloadRevision; reason: string }
type Original = AvailableOriginal | UnavailableOriginal;
const path = (value: string) => encodeURIComponent(value);
const base = (p: string, d: string, r: string) =>
  `/api/projects/${path(p)}/documents/${path(d)}/revisions/${path(r)}/original`;

function bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
}
function blobBytes(base64: string): ArrayBuffer {
  const source = bytes(base64);
  const copy = new Uint8Array(source.length);
  copy.set(source);
  return copy.buffer;
}

function resolveAsset(raw: string, entrypoint: string | null): string | null {
  const clean = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!clean || clean.startsWith("/") || clean.startsWith("#") || clean.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//")) return null;
  let withoutFragment: string;
  try { withoutFragment = decodeURIComponent(clean.split(/[?#]/, 1)[0] ?? ""); }
  catch { return null; }
  if (!withoutFragment || withoutFragment.startsWith("/") || withoutFragment.includes("\\")) return null;
  const baseParts = entrypoint?.split("/").slice(0, -1) ?? [];
  for (const part of withoutFragment.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!baseParts.length) return null; baseParts.pop(); }
    else baseParts.push(part);
  }
  return baseParts.join("/");
}

function staticHtml(original: AvailableOriginal): { html: string; urls: string[] } {
  const urls: string[] = [];
  const registered = new Map<string, string>();
  const assets = new Map(original.assets.map(asset=>[asset.path,asset]));
  for (const asset of original.assets) registered.set(asset.path, `data:${asset.mediaType};base64,${asset.base64}`);
  const rewrite = (value: string) => registered.get(resolveAsset(value, original.revision.entrypoint) ?? "") ?? "";
  const css = (value: string, relativeTo = original.revision.entrypoint) => value.replace(/url\(\s*([^)]*)\s*\)/gi, (_match, address: string) => {
    const url = registered.get(resolveAsset(address, relativeTo) ?? "");
    return url ? `url("${url}")` : "url(about:blank)";
  }).replace(/@import\b[^;]*;?/gi, "");
  const cssBases = new Map<Element,string | null>();
  const template = document.createElement("template");
  template.innerHTML = original.body;
  template.content.querySelectorAll("script,iframe,frame,object,embed,form,base,meta,link[rel=preload],link[rel=modulepreload]")
    .forEach(element => element.remove());
  template.content.querySelectorAll('link[rel="stylesheet"]').forEach(element => {
    const name = resolveAsset(element.getAttribute("href") ?? "", original.revision.entrypoint);
    const asset = name ? assets.get(name) : null;
    if (!asset || asset.mediaType !== "text/css") { element.remove(); return; }
    const style = document.createElement("style");
    style.textContent = new TextDecoder("utf-8", {fatal:true}).decode(bytes(asset.base64));
    cssBases.set(style, name);
    element.replaceWith(style);
  });
  template.content.querySelectorAll("*").forEach(element => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "integrity") element.removeAttribute(attribute.name);
      else if (["src", "href", "poster", "xlink:href"].includes(name)) {
        const url = rewrite(attribute.value);
        if (url) element.setAttribute(attribute.name, url);
        else element.removeAttribute(attribute.name);
      } else if (name === "srcset") element.removeAttribute(attribute.name);
      else if (name === "style") element.setAttribute(attribute.name, css(attribute.value));
    }
    if (element.tagName.toLowerCase() === "style") element.textContent = css(element.textContent ?? "", cssBases.get(element) ?? original.revision.entrypoint);
  });
  const csp = "default-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src data:; media-src data:";
  return { html: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head><body>${template.innerHTML}</body></html>`, urls };
}

function download(name: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function OriginalDocumentReader({ token, projectId, revisionId, documentId }: {
  token: string; projectId: string; revisionId: string; documentId: string;
}) {
  const [storedOriginal, setOriginal] = useState<Original | null>(null);
  const original = storedOriginal?.revision.projectId === projectId && storedOriginal.revision.documentId === documentId && storedOriginal.revision.id === revisionId ? storedOriginal : null;
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [prepared, setPrepared] = useState<{ revisionId: string; hash: string; html: string } | null>(null);
  const preview = original && prepared?.revisionId === original.revision.id && prepared.hash === original.revision.contentHash ? prepared.html : null;
  const [assetPreview, setAssetPreview] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setOriginal(null); setAssetPreview(null); setAssetError(null); setError("");
    request<Original>(token, base(projectId, documentId, revisionId), 30000)
      .then(result => {
        if (result.revision.projectId !== projectId || result.revision.documentId !== documentId || result.revision.id !== revisionId)
          throw new Error("原件响应与所选项目、文档及固定修订不符。");
        if (active) setOriginal(result);
      })
      .catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [token, projectId, documentId, revisionId, refresh]);
  useEffect(() => {
    if (original?.status !== "available" || original.revision.format !== "html") { setPrepared(null); return; }
    try {
      const rendered = staticHtml(original);
      setPrepared({ revisionId: original.revision.id, hash: original.revision.contentHash, html: rendered.html });
      return () => rendered.urls.forEach(URL.revokeObjectURL);
    } catch { setError("配套资源无法安全构造预览。"); return; }
  }, [original]);
  if (error) return <section className="panel"><p role="alert">原件读取失败：{error}</p><button onClick={() => setRefresh(v => v + 1)}>重试读取</button></section>;
  if (!original) return <section className="panel"><p>正在核对原件及其资源…</p></section>;
  if (original.status === "unavailable") return <section className="panel"><h3>原件暂不可完整读取</h3>
    <p role="alert">资源不可用或未通过校验（{original.reason}）。请检查存储与登记状态。</p>
    <button onClick={() => setRefresh(v => v + 1)}>重新核对</button></section>;
  const mime = original.revision.mediaType;
  return <section className="panel reading"><div className="panel-head"><h2>固定修订原件</h2>
    <button onClick={() => download(original.revision.originalName,
      new Blob([original.body], { type: `${mime};charset=utf-8` }))}>下载原件</button></div>
    <p className="muted">正在阅读固定修订：<code>{original.revision.id}</code></p>
    <p className="muted">SHA-256：<code>{original.revision.contentHash}</code></p>
    {original.revision.format === "html" ? <><p>静态隔离预览，脚本未运行。下方保留完整 HTML 原文。</p>
      {preview ? <iframe key={`${revisionId}:${original.revision.contentHash}`} title="HTML 静态隔离预览" sandbox="" referrerPolicy="no-referrer" srcDoc={preview}
        style={{ width: "100%", minHeight: 420, border: "1px solid #d8dfec", borderRadius: 8 }} /> : <p role="status">正在准备此固定修订的隔离预览…</p>}</>
      : <MarkdownBody source={original.body} identity={original.revision.id} projectId={projectId} />}
    <details className="revision-body"><summary>查看完整原文</summary><pre>{original.body}</pre></details>
    {original.assets.length > 0 && <div className="doc-assets"><h3>配套资源 · {original.assets.length} 项</h3><ul>{original.assets.map(asset => { const image = imagePreview(asset.mediaType, asset.base64); return <li key={asset.path}>
      <span className="break-anywhere">{asset.path}<small>{asset.mediaType} · SHA-256 <code>{original.revision.assetsManifest.find(item=>item.path===asset.path)?.contentHash}</code></small></span>
      <span className="actions"><button onClick={() => { setAssetError(null); setAssetPreview(value => value === asset.path ? null : asset.path); }}
        aria-expanded={assetPreview === asset.path}> {assetPreview === asset.path ? "收起预览" : "预览"}</button>
      <button onClick={() => download(asset.path.split("/").at(-1) ?? "resource",
        new Blob([blobBytes(asset.base64)], { type: asset.mediaType }))}>下载</button></span>
      {assetPreview === asset.path && <div className="doc-asset-preview">
        {image && assetError !== asset.path ? <>{image.mismatch && <p>资源声明为 {asset.mediaType}，图片字节识别为 {image.mediaType}。预览按图片解码，下载保留原字节。</p>}<img alt={`资源 ${asset.path} 的静态预览`} src={`data:${image.mediaType};base64,${asset.base64}`} onError={() => setAssetError(asset.path)} /></>
          : asset.mediaType === "text/css" ? <pre>{new TextDecoder().decode(bytes(asset.base64))}</pre>
          : <p>{assetError === asset.path ? "图片未能解码，请下载原件核对。" : "此资源格式暂不支持页面预览，可下载原件查看。"}</p>}
      </div>}
    </li>; })}</ul></div>}
  </section>;
}
