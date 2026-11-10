// 诊断信息 under a failure the page says in Chinese (docs/frontend/principles.md 界面用语): the service's original
// answer with its code, folded, the same way every page shows it (ErrorState `diagnostics`, the command form's outcome).
// Nothing is drawn when the original would only repeat the sentence above it.
import { diagnosticOf, type Failure } from "../errorPresentation";

export function ErrorDetails({ error, failure }: { error?: unknown; failure?: Failure | null | undefined }) {
  const detail = failure ? failure.detail : diagnosticOf(error);
  if (!detail) return null;
  return <details className="mt-1 text-caption text-muted-foreground">
    <summary className="w-fit cursor-pointer">诊断信息</summary>
    <p className="mt-1 whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">{detail}</p>
  </details>;
}
