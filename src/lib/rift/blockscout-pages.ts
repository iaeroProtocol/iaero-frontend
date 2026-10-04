// Blockscout's address token endpoint is paginated. Keep page traversal separate from the edge route so
// malformed cursors, partial failures and the work cap can be tested without a network or a Worker.

export interface TokenPages { items: unknown[]; complete: boolean }
const MAX_TOKEN_ROWS = 300;

export async function collectTokenPages(
  url: string,
  get: (url: string) => Promise<unknown>,
  maxPages = 6,
): Promise<TokenPages> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let next = url;
  for (let page = 0; page < maxPages; page++) {
    if (seen.has(next)) return { items, complete: false };
    seen.add(next);
    let raw: unknown;
    try { raw = await get(next); } catch (e) {
      if (page === 0) throw e;
      return { items, complete: false };
    }
    const data = raw as { items?: unknown; next_page_params?: unknown } | null;
    if (!data || !Array.isArray(data.items)) {
      if (page === 0) throw new Error('Blockscout returned no token list');
      return { items, complete: false };
    }
    if (items.length + data.items.length > MAX_TOKEN_ROWS) {
      items.push(...data.items.slice(0, MAX_TOKEN_ROWS - items.length));
      return { items, complete: false };
    }
    items.push(...data.items);
    if (data.next_page_params == null) return { items, complete: true };
    if (typeof data.next_page_params !== 'object' || Array.isArray(data.next_page_params)) return { items, complete: false };
    const cursor = new URL(url);
    for (const [key, value] of Object.entries(data.next_page_params)) {
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return { items, complete: false };
      cursor.searchParams.set(key, String(value));
    }
    next = cursor.toString();
  }
  return { items, complete: false };
}
