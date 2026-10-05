// Blockscout's address token endpoint is paginated. Keep page traversal separate from the edge route so
// malformed cursors, partial failures and the work cap can be tested without a network or a Worker.

/** At most this many rows are read: Blockscout sorts by USD value, so the rest is the long tail. */
export const MAX_TOKEN_ROWS = 300;

/** `complete`: every page was read. `truncated`: the scan stopped at its own row or page cap, a deliberate
 *  limit rather than a failure. Neither: a page failed or its cursor was unusable, so rows may be missing. */
export interface TokenPages { items: unknown[]; complete: boolean; truncated: boolean }

export async function collectTokenPages(
  url: string,
  get: (url: string) => Promise<unknown>,
  maxPages = 6,
): Promise<TokenPages> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  const failed = (): TokenPages => ({ items, complete: false, truncated: false });
  const capped = (): TokenPages => ({ items, complete: false, truncated: true });
  let next = url;
  for (let page = 0; ; page++) {
    // Only reached with another page to read.
    if (page >= maxPages || items.length >= MAX_TOKEN_ROWS) return capped();
    if (seen.has(next)) return failed();
    seen.add(next);
    let raw: unknown;
    try { raw = await get(next); } catch (e) {
      if (page === 0) throw e;
      return failed();
    }
    const data = raw as { items?: unknown; next_page_params?: unknown } | null;
    if (!data || !Array.isArray(data.items)) {
      if (page === 0) throw new Error('Blockscout returned no token list');
      return failed();
    }
    const room = MAX_TOKEN_ROWS - items.length;
    items.push(...data.items.slice(0, room));
    if (data.items.length > room) return capped();
    if (data.next_page_params == null) return { items, complete: true, truncated: false };
    if (typeof data.next_page_params !== 'object' || Array.isArray(data.next_page_params)) return failed();
    const cursor = new URL(url);
    for (const [key, value] of Object.entries(data.next_page_params)) {
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return failed();
      cursor.searchParams.set(key, String(value));
    }
    next = cursor.toString();
  }
}
