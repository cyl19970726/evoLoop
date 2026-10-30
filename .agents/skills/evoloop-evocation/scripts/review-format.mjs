export const prefix = '<!-- evoloop.organization-review.v1\n';
const end = '\n-->\n';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateReview(meta) {
  if (meta?.schemaVersion !== 1 || !uuid.test(meta.projectId) || (meta.writerThreadId && !uuid.test(meta.writerThreadId)) || (meta.leaderThreadId && !uuid.test(meta.leaderThreadId))) throw new Error('Invalid review identity metadata');
  if (typeof meta.summary !== 'string' || !meta.summary.trim() || meta.summary.length > 500) throw new Error('A readable review summary is required');
  const p = meta.period;
  const date = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
  if (!p || !date(p.from) || !date(p.to) || Date.parse(p.from) >= Date.parse(p.to)) throw new Error('Observation period must contain ordered timestamps with time zones');
  if (typeof p.timeZone !== 'string' || !p.timeZone) throw new Error('Declare the observation time zone');
  try { new Intl.DateTimeFormat('en', { timeZone: p.timeZone }).format(); } catch { throw new Error('Invalid time zone'); }
  if (!['initial','since_previous','custom'].includes(p.mode)) throw new Error('Declare initial, since_previous or custom period mode');
  if (p.mode === 'since_previous') {
    const previous = meta.previousReview;
    if (!previous || !uuid.test(previous.documentId) || !uuid.test(previous.revisionId) || !date(previous.observedTo) || Date.parse(previous.observedTo) !== Date.parse(p.from)) throw new Error('Continuous reviews must start at the fixed previous review observation cutoff');
  }
  if (p.mode === 'custom' && !p.reason?.trim()) throw new Error('A custom window needs an explanation');
  for (const followup of meta.followups ?? []) if (!uuid.test(followup.taskId)) throw new Error('Followups must reference real Task IDs');
  return meta;
}
export function encodeReview(meta, markdown) {
  validateReview(meta);
  if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('Write the full report body before submitting');
  const json = JSON.stringify(meta).replaceAll('-->', '--\\u003e');
  if (json.length > 16000) throw new Error('Review metadata exceeds the header limit');
  const body = `${prefix}${json}${end}\n${markdown}`;
  if (Buffer.byteLength(body, 'utf8') > 16 * 1024 * 1024) throw new Error('Report exceeds the existing document storage limit');
  return body;
}
export function decodeReview(body) {
  if (typeof body !== 'string' || !body.startsWith(prefix)) return null;
  const offset = body.indexOf(end, prefix.length);
  if (offset < 0 || offset > 16000 + prefix.length) throw new Error('Malformed review header');
  const meta = validateReview(JSON.parse(body.slice(prefix.length, offset)));
  return { meta, markdown: body.slice(offset + end.length).trimStart() };
}
