// src/lib/rift/client.ts
//
// Calls to Rift's API straight from the browser (Rift allows any origin and needs no key). Going direct
// keeps each user on their own rate limit; through this site's server, every user would share one (Rift
// throttles per address, and Cloudflare Workers reach other Cloudflare-hosted sites from shared addresses).
// Every request pins the destination to iAERO on Base and carries our integrator id; every response is
// validated (validate.ts) before the app acts on it.
//
// Rift allows a browser about 10 calls a minute (measured, not documented). Every call is logged, across tabs,
// so background calls give way: background status polls go only while fewer than 8 calls were made in the
// last minute, the order card's own polls while fewer than 6 (so a fast-polling card leaves the background some
// room), route checks while fewer than 5 and at most one per 15 s, and after a 429 all stop for a minute.
// Calls the user is waiting on (quotes, orders, "Check payment") always go.

import { RIFT_DESTINATION, RIFT_INTEGRATOR_ID } from './config';
import { RiftApiError, classifyRiftError } from './errors';
import { AMOUNT_RE, EVM_ADDRESS_RE, SOURCE_ASSET_RE, UUID_RE } from './validate';
import { isBtcAddress } from './bitcoin';

export { RiftApiError, classifyRiftError, explainRiftError } from './errors';

const RIFT_API = 'https://api.rift.trade';
const TIMEOUT_MS = 25_000;

// --- The shared call budget ---

/** Who is calling: the user (always goes), a background status poll, the order card's poll, or a route check
 *  (lowest). */
export type RiftCallKind = 'user' | 'poll' | 'track' | 'probe';
const BUDGET_KEY = 'iaero.rift.calls.v1';
const WINDOW_MS = 60_000;
const LIMIT: Record<Exclude<RiftCallKind, 'user'>, number> = { poll: 8, track: 6, probe: 5 };
const PROBE_SPACING_MS = 15_000;
const PAUSE_AFTER_429_MS = 60_000;
const PAUSE_AFTER_FAILURE_MS = 20_000;

interface CallLog { t: number[]; pausedUntil: number; lastProbe: number }
let memLog: CallLog = { t: [], pausedUntil: 0, lastProbe: 0 };

/** Two lists of call times as one, each time as often as either list has it. */
function union(a: number[], b: number[]): number[] {
  const count = new Map<number, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  const other = new Map<number, number>();
  for (const x of b) other.set(x, (other.get(x) ?? 0) + 1);
  for (const [x, n] of other) count.set(x, Math.max(count.get(x) ?? 0, n));
  return [...count].flatMap(([x, n]) => Array<number>(n).fill(x));
}

/** The shared log, together with this tab's own: while storage refuses writes, the stored one goes stale, and
 *  calls (or a 429 pause) would be forgotten. */
function readLog(now: number): CallLog {
  let log = memLog;
  try {
    const raw = JSON.parse(window.localStorage.getItem(BUDGET_KEY) ?? 'null');
    if (raw && Array.isArray(raw.t)) {
      log = {
        t: union(raw.t.filter((x: unknown) => typeof x === 'number'), memLog.t),
        pausedUntil: Math.max(Number(raw.pausedUntil) || 0, memLog.pausedUntil),
        lastProbe: Math.max(Number(raw.lastProbe) || 0, memLog.lastProbe),
      };
    }
  } catch { /* storage blocked: this tab's own log */ }
  return { ...log, t: log.t.filter(x => now - x < WINDOW_MS && x <= now + 1000) };
}
function writeLog(log: CallLog) {
  memLog = log;
  try { window.localStorage.setItem(BUDGET_KEY, JSON.stringify(log)); } catch { /* memory only */ }
}

/** Whether a background call of this kind may go now. */
export function riftBudget(kind: Exclude<RiftCallKind, 'user'>, now = Date.now()): boolean {
  if (typeof window === 'undefined') return true;
  const log = readLog(now);
  if (now < log.pausedUntil) return false;
  if (kind === 'probe' && now - log.lastProbe < PROBE_SPACING_MS) return false;
  return log.t.length < LIMIT[kind];
}

/** How long calls that are not the user's must still wait after a 429 (ms; 0 when they may go). */
export function riftPauseLeft(now = Date.now()): number {
  if (typeof window === 'undefined') return 0;
  return Math.max(0, readLog(now).pausedUntil - now);
}

function logCall(kind: RiftCallKind, now: number) {
  if (typeof window === 'undefined') return;
  const log = readLog(now);
  writeLog({ ...log, t: [...log.t, now], lastProbe: kind === 'probe' ? now : log.lastProbe });
}
function logRateLimited(now: number, pause = PAUSE_AFTER_429_MS) {
  if (typeof window === 'undefined') return;
  const log = readLog(now);
  writeLog({ ...log, pausedUntil: Math.max(log.pausedUntil, now + pause) });
}

async function call(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal; kind?: RiftCallKind } = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  init.signal?.addEventListener('abort', onAbort);
  logCall(init.kind ?? 'user', Date.now());
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${RIFT_API}${path}`, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    text = await res.text(); // within the timeout: a stalled body must not hang the caller
  } catch (e) {
    if (init.signal?.aborted) throw e;
    // Rift's rate-limit answers come from its CDN, possibly without the header a browser needs to read them: a call
    // that can't be read at all may be one, so the calls that aren't the user's wait a little too.
    logRateLimited(Date.now(), PAUSE_AFTER_FAILURE_MS);
    throw new RiftApiError(0, controller.signal.aborted ? 'Rift took too long to answer' : 'Could not reach Rift');
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text, e.g. Cloudflare's "error code: 1015" */ }
  if (!res.ok) {
    if (res.status === 429) logRateLimited(Date.now());
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : text.slice(0, 200) || `HTTP ${res.status}`;
    throw new RiftApiError(res.status, msg);
  }
  return data;
}

/** A quote for `from_amount` of `from`, always into iAERO on Base. `raw` answers in base units with canonical
 *  ids (`evm:42161.0x…`) and takes `from_amount` in base units; it is used only to learn token names (names.ts). */
export async function fetchQuote(
  body: { from: string; from_amount: string; quote_mode?: 'fast' | 'optimal'; format?: 'formatted' | 'raw' }, signal?: AbortSignal,
  kind: RiftCallKind = 'user',
) {
  const from = body.from.trim();
  const format = body.format ?? 'formatted';
  if (!SOURCE_ASSET_RE.test(from) || from.toLowerCase() === RIFT_DESTINATION) throw new RiftApiError(400, 'unsupported source asset');
  if (!(format === 'raw' ? /^[1-9]\d{0,39}$/ : AMOUNT_RE).test(body.from_amount)) throw new RiftApiError(400, 'invalid amount');
  return call('/quote', {
    method: 'POST', signal, kind,
    body: {
      from, to: RIFT_DESTINATION, from_amount: body.from_amount, return_full_route: true,
      quote_mode: body.quote_mode ?? 'optimal', format, integrator_id: RIFT_INTEGRATOR_ID,
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

export async function getOrder(id: string, signal?: AbortSignal, kind: RiftCallKind = 'user') {
  if (!UUID_RE.test(id)) throw new RiftApiError(400, 'invalid order id');
  return call(`/order/${id}`, { signal, kind });
}

// --- Is Rift pricing anything at all? ---

/** A route Rift always has (USDC on Base). */
const CONTROL = { from: 'base.0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', from_amount: '20' };
const CONTROL_TTL_MS = 2 * 60_000;
let control: { at: number; up: boolean } | null = null;

/**
 * Rift's "execution costs could not be priced, so no route was evaluated in full" means an outage, or that
 * this token has no route: a control quote tells them apart. true: Rift prices other routes (so this token
 * has none); false: Rift is down; null: can't tell now (rate limit, network, or no budget for a background check).
 * `background`: asked right after a route check, so held to the poll limit rather than the route checks' 15 s
 * spacing (which would never let it go).
 */
export async function riftPricing(kind: 'user' | 'background' = 'background'): Promise<boolean | null> {
  const now = Date.now();
  if (control && now - control.at < CONTROL_TTL_MS) return control.up;
  if (kind === 'background' && !riftBudget('poll', now)) return null;
  try {
    await fetchQuote({ ...CONTROL, quote_mode: 'fast' }, undefined, kind === 'user' ? 'user' : 'probe');
    control = { at: Date.now(), up: true };
  } catch (e) {
    const kind = classifyRiftError(e);
    if (kind !== 'unavailable' && kind !== 'no_route') return null;
    control = { at: Date.now(), up: false };
  }
  return control.up;
}
