// src/lib/rift/client.ts
//
// Calls to Rift's API straight from the browser (Rift allows any origin and needs no key). Going direct
// keeps each user on their own rate limit; through this site's server, every user would share one (Rift
// throttles per address, and Cloudflare Workers reach other Cloudflare-hosted sites from shared addresses).
// Every request pins the destination to iAERO on Base and carries our integrator id; every response is
// validated (validate.ts) before the app acts on it.

import { RIFT_DESTINATION, RIFT_INTEGRATOR_ID } from './config';
import { RiftApiError } from './errors';
import { AMOUNT_RE, EVM_ADDRESS_RE, SOURCE_ASSET_RE, UUID_RE } from './validate';
import { isBtcAddress } from './bitcoin';

export { RiftApiError, classifyRiftError, explainRiftError } from './errors';

const RIFT_API = 'https://api.rift.trade';
const TIMEOUT_MS = 25_000;

async function call(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  init.signal?.addEventListener('abort', onAbort);
  let res: Response;
  try {
    res = await fetch(`${RIFT_API}${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new RiftApiError(0, controller.signal.aborted ? 'Rift took too long to answer' : 'Could not reach Rift');
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text, e.g. Cloudflare's "error code: 1015" */ }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : text.slice(0, 200) || `HTTP ${res.status}`;
    throw new RiftApiError(res.status, msg);
  }
  return data;
}

/** A quote for `from_amount` of `from`, always into iAERO on Base. */
export async function fetchQuote(body: { from: string; from_amount: string; quote_mode?: 'fast' | 'optimal' }, signal?: AbortSignal) {
  const from = body.from.trim();
  if (!SOURCE_ASSET_RE.test(from) || from.toLowerCase() === RIFT_DESTINATION) throw new RiftApiError(400, 'unsupported source asset');
  if (!AMOUNT_RE.test(body.from_amount)) throw new RiftApiError(400, 'invalid amount');
  return call('/quote', {
    method: 'POST', signal,
    body: {
      from, to: RIFT_DESTINATION, from_amount: body.from_amount, return_full_route: true,
      quote_mode: body.quote_mode ?? 'optimal', format: 'formatted', integrator_id: RIFT_INTEGRATOR_ID,
    },
  });
}

/** Binds a quote to a one-time deposit address. iAERO is delivered to `to_address` on Base. */
export async function createOrder(body: { quote_id: string; to_address: string; refund_address?: string }) {
  if (!UUID_RE.test(body.quote_id)) throw new RiftApiError(400, 'invalid quote id');
  if (!EVM_ADDRESS_RE.test(body.to_address)) throw new RiftApiError(400, 'iAERO is delivered on Base: to_address must be an EVM address');
  const refund = body.refund_address;
  if (refund !== undefined && !EVM_ADDRESS_RE.test(refund) && !isBtcAddress(refund)) throw new RiftApiError(400, 'invalid refund address');
  return call('/order', { method: 'POST', body: { quote_id: body.quote_id, to_address: body.to_address, ...(refund ? { refund_address: refund } : {}) } });
}

export async function getOrder(id: string, signal?: AbortSignal) {
  if (!UUID_RE.test(id)) throw new RiftApiError(400, 'invalid order id');
  return call(`/order/${id}`, { signal });
}
