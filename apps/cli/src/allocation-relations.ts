import { idSchema } from '@evoloop/contracts';

/** One bounded read page. The CLI returns the server's cursor/reset metadata unchanged. */
export function allocationRelationsPath(options: Map<string, string | true>): string {
  const filters = ['role', 'session', 'discussion'].filter(key => options.has(key));
  if (filters.length !== 1) throw new Error('Choose exactly one of --role, --session, or --discussion.');
  for (const key of options.keys())
    if (!['project', 'role', 'session', 'discussion', 'limit', 'cursor'].includes(key))
      throw new Error(`--${key} does not apply to allocations.`);
  const selected = filters[0]!;
  const value = options.get(selected);
  if (typeof value !== 'string') throw new Error(`--${selected} requires a value.`);
  if (selected === 'session') {
    if (!/^(owned|external):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
      throw new Error('--session requires an owned:UUID or external:UUID key.');
  } else if (!idSchema.safeParse(value).success) throw new Error(`--${selected} must be a UUID.`);
  const rawLimit = options.get('limit');
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('--limit must be 1..50.');
  const query = new URLSearchParams({ [selected === 'role' ? 'roleId' : selected === 'discussion' ? 'discussionId' : 'sessionKey']: value,
    limit: String(limit) });
  const cursor = options.get('cursor');
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 4096) throw new Error('--cursor must be 1..4096 characters.');
    query.set('cursor', cursor);
  }
  return `/allocation-relations?${query}`;
}
