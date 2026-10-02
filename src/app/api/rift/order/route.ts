// src/app/api/rift/order/route.ts
import { type NextRequest } from 'next/server';
import { BTC_ADDRESS_RE, EVM_ADDRESS_RE, UUID_RE, badRequest, forward } from '@/lib/rift/server';

export const runtime = 'edge';

/** Bind a quote to a one-time deposit address. iAERO is delivered to `to_address` on Base. */
export async function POST(request: NextRequest) {
  let body: { quote_id?: unknown; to_address?: unknown; refund_address?: unknown };
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const quoteId = typeof body.quote_id === 'string' ? body.quote_id : '';
  const to = typeof body.to_address === 'string' ? body.to_address.trim() : '';
  const refund = typeof body.refund_address === 'string' ? body.refund_address.trim() : undefined;
  if (!UUID_RE.test(quoteId)) return badRequest('invalid quote id');
  if (!EVM_ADDRESS_RE.test(to)) return badRequest('iAERO is delivered on Base: to_address must be an EVM address');
  if (refund !== undefined && !EVM_ADDRESS_RE.test(refund) && !BTC_ADDRESS_RE.test(refund)) return badRequest('invalid refund address');
  return forward('/order', {
    method: 'POST',
    body: JSON.stringify({ quote_id: quoteId, to_address: to, ...(refund ? { refund_address: refund } : {}) }),
  });
}
