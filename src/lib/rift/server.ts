// src/lib/rift/server.ts
//
// Server side of the /api/rift proxy (edge runtime, like /api/0x). It forwards only what this feature
// needs: quotes always end in iAERO on Base and carry our integrator id; inputs are checked before Rift
// sees them. Rift needs no API key.

import { NextResponse } from 'next/server';

export const RIFT_API = 'https://api.rift.trade';

const TIMEOUT_MS = 25_000;

/** Source assets this version supports: native coins or ERC-20 contract addresses. */
export const SOURCE_ASSET_RE = /^(ethereum\.eth|arbitrum\.eth|base\.eth|bitcoin\.btc|(ethereum|arbitrum|base)\.0x[0-9a-fA-F]{40})$/;
export const AMOUNT_RE = /^(?=.*[1-9])\d{1,24}(\.\d{1,18})?$/;
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const BTC_ADDRESS_RE = /^(bc1[02-9ac-hj-np-z]{8,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function forward(path: string, init?: RequestInit): Promise<NextResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${RIFT_API}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
      cache: 'no-store',
    });
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch { body = { error: text || `Rift returned HTTP ${res.status}` }; }
    if (!res.ok && (!body || typeof body !== 'object')) body = { error: `Rift returned HTTP ${res.status}` };
    return NextResponse.json(body, { status: res.status, headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return NextResponse.json({ error: aborted ? 'Rift took too long to answer' : 'Could not reach Rift' }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
