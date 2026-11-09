// An HTML report read from first section to last inside one sandboxed frame that fills the page below the header.
// The frame shows a static copy built from the fixed original (scripts, forms, embedded pages, redirects and outside
// resources removed; registered assets inlined; restrictive CSP); the original itself is never changed. The original's
// facts, the HTML source and the assets sit in a foot under the frame. 修订与发布 stays in that foot whatever happens to
// the original, so a broken report can still be replaced or archived.
import React, { useMemo } from "react";
import { Button, ErrorState, LoadingState, UnknownState } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { imagePreview } from "../../shared/ui/imagePreview";
import { blobBytes, bytes, download, staticHtml, type AvailableOriginal } from "../../shared/ui/OriginalDocumentReader";
import { useOriginal } from "./useOriginal";

function usePrepared(original: AvailableOriginal | null) {
  return useMemo(() => {
    if (!original) return null;
    try { return { ...staticHtml(original), failed: false }; }
    catch { return { html: "", urls: [], internalLinks: [], failed: true }; }
  }, [original]);
}

export function HtmlReport({ projectId, documentId, revisionId, foot }: {
  projectId: string; documentId: string; revisionId: string; foot?: React.ReactNode;
}) {
  const query = useOriginal(projectId, documentId, revisionId);
  const original = query.data;
  const available = original?.status === "available" ? original : null;
  const prepared = usePrepared(available);
  const retry = () => void query.refetch();
  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    {available ? <Report original={available} prepared={prepared} revisionId={revisionId} />
      : original?.status === "unavailable" ? <UnknownState title="原件暂时不能完整读取" lastKnown="这一版已登记原件和资源清单"
        reason={`资源不可用或没有通过校验（${original.reason}）`} howToCheck="检查存储与登记状态后重新核对。"
        action={<Button size="compact" onClick={retry}>重新核对</Button>} />
      : query.isError ? <ErrorState title="原件没有读回" happened={errorText(query.error)} next="可以重试；正文要从固定原件读出，不用摘要代替。"
        action={<Button size="compact" onClick={retry}>重试读取</Button>} />
      : <div className="flex-1 py-4"><LoadingState lines={6} label="正在读取原件及其资源" /></div>}
    <div className="flex flex-col gap-1.5">
      {prepared && prepared.internalLinks.length > 0 && <Foot summary={`报告里的站内链接 · ${prepared.internalLinks.length}`}>
        <p className="mb-1 text-caption text-muted-foreground">打开后可以用浏览器返回这份报告。</p>
        <ul className="flex flex-col gap-1">{prepared.internalLinks.map(link => <li key={link.href}><a href={link.href} className="text-label text-primary hover:underline">{link.label}</a></li>)}</ul>
      </Foot>}
      {available && <Foot summary={`原件信息、HTML 原文与配套资源${available.assets.length ? ` · ${available.assets.length} 项` : ""}`}>
        <div className="flex flex-col gap-3">
          <p className="text-caption text-muted-foreground">静态隔离预览，脚本没有运行。原件按固定修订保存，下面是完整 HTML 原文和资源。</p>
          <Button size="compact" className="self-start" onClick={() => download(available.revision.originalName,
            new Blob([available.body], { type: `${available.revision.mediaType};charset=utf-8` }))}>下载原件</Button>
          <details><summary className="cursor-pointer text-label text-foreground">查看 HTML 原文</summary>
            <pre className="mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-caption [overflow-wrap:anywhere]">{available.body}</pre></details>
          {available.assets.length > 0 && <Assets original={available} />}
        </div>
      </Foot>}
      {foot}
    </div>
  </div>;
}

/** The sandboxed static copy, or why it could not be built. */
function Report({ original, prepared, revisionId }: { original: AvailableOriginal; prepared: ReturnType<typeof usePrepared>; revisionId: string }) {
  if (prepared?.failed) return <ErrorState title="不能安全地构造预览" happened="配套资源没有通过预览前的检查。" next="可以下载原件核对，或在下方查看 HTML 原文。" />;
  if (!prepared) return <p role="status" className="text-label text-muted-foreground">正在准备这一版的隔离预览…</p>;
  return <iframe key={`${revisionId}:${original.revision.contentHash}`} title="HTML 报告（静态隔离预览）" sandbox="" referrerPolicy="no-referrer"
    srcDoc={prepared.html} data-report-frame="" className="block min-h-[150px] w-full flex-1 rounded-lg border border-border bg-raised" />;
}

/** One folded line under the frame; opened, its body scrolls on its own so the frame keeps its height. */
export function Foot({ summary, children }: { summary: string; children: React.ReactNode }) {
  return <details className="rounded-md border border-border bg-raised">
    <summary className="cursor-pointer px-3 py-1.5 text-label font-medium text-text-secondary">{summary}</summary>
    <div className="max-h-[42vh] overflow-auto border-t border-border p-3">{children}</div>
  </details>;
}

function Assets({ original }: { original: AvailableOriginal }) {
  return <section aria-label="配套资源"><h3 className="text-label font-semibold">配套资源 · {original.assets.length} 项</h3>
    <ul className="mt-1 flex flex-col">{original.assets.map(asset => {
      const image = imagePreview(asset.mediaType, asset.base64);
      const hash = original.revision.assetsManifest.find(item => item.path === asset.path)?.contentHash;
      return <li key={asset.path} className="flex flex-col gap-1.5 border-t border-border py-2 first:border-t-0">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 text-label [overflow-wrap:anywhere]">{asset.path}
            <span className="block text-caption text-muted-foreground">{asset.mediaType}{hash && <> · SHA-256 <code className="font-mono">{hash}</code></>}</span></span>
          <Button size="compact" variant="ghost" onClick={() => download(asset.path.split("/").at(-1) ?? "resource", new Blob([blobBytes(asset.base64)], { type: asset.mediaType }))}>下载</Button>
        </span>
        {image ? <details><summary className="cursor-pointer text-caption text-muted-foreground">预览</summary>
          {image.mismatch && <p className="text-caption text-muted-foreground">资源声明为 {asset.mediaType}，图片字节识别为 {image.mediaType}。预览按图片解码，下载保留原字节。</p>}
          <img alt={`资源 ${asset.path} 的静态预览`} src={`data:${image.mediaType};base64,${asset.base64}`} className="mt-1 max-h-[320px] w-auto" /></details>
          : asset.mediaType === "text/css" ? <details><summary className="cursor-pointer text-caption text-muted-foreground">预览</summary>
            <pre className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap font-mono text-caption">{new TextDecoder().decode(bytes(asset.base64))}</pre></details>
          : null}
      </li>;
    })}</ul>
  </section>;
}
