// src/lib/rift/client.ts
//
// Browser calls to Rift, through this app's own /api/rift proxy (src/app/api/rift). The proxy pins the
// destination to iAERO and tags orders as ours; responses are validated in validate.ts before use.

export class RiftApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'RiftApiError';
  }
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`/api/rift${path}`, { ...init, cache: 'no-store' });
  } catch {
    throw new RiftApiError(0, 'Could not reach the Rift service. Check your connection.');
  }
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain-text body */ }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new RiftApiError(res.status, msg);
  }
  return data;
}

export const fetchQuote = (body: { from: string; from_amount: string }, signal?: AbortSignal) =>
  call('/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

export const createOrder = (body: { quote_id: string; to_address: string; refund_address?: string }) =>
  call('/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const getOrder = (id: string) => call(`/order/${id}`);

export async function riftHealthy(): Promise<boolean> {
  try { await call('/health'); return true; } catch { return false; }
}

/** Plain-language versions of the errors a user can actually do something about. */
export function explainRiftError(e: unknown): string {
  if (e instanceof RiftApiError) {
    if (e.status === 422) return 'No route found for this token and amount. Try a larger amount or a different token.';
    if (e.status === 403) return 'Rift declined this address after its sanctions screening.';
    if (e.status === 409) return 'This quote was already used. Get a fresh quote and try again.';
    if (e.status === 410) return 'The quote expired. A fresh one is being fetched.';
    if (e.status === 503) return 'Rift’s address screening is briefly unavailable. Please try again in a minute.';
    if (e.status === 400) return `Rift rejected the request: ${e.message}`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
