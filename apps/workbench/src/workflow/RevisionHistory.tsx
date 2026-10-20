import { useState } from "react";
import { errorText } from "../api";
import { Notice } from "./ActionForm";

export interface HistoryEntry { key: string; title: string; body: string; reason: string; actorId: string; createdAt: string }
export function RevisionHistory({ label, load }: { label: string; load(): Promise<HistoryEntry[]> }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function read() {
    setBusy(true); setError("");
    try { setEntries(await load()); } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <section className="revision-history">
    <button onClick={read} disabled={busy}>{busy ? "读取历史中…" : label}</button>
    {error && <Notice error>{error}；可重试读取历史。</Notice>}
    {entries?.length === 0 && <p>尚无修订记录。</p>}
    {entries?.map(entry => <article className="decision" key={entry.key}>
      <h3>{entry.title}</h3><p className="history-body">{entry.body}</p><p><strong>当次理由：</strong>{entry.reason}</p>
      <small>{entry.actorId} · {entry.createdAt}</small>
    </article>)}
  </section>;
}
