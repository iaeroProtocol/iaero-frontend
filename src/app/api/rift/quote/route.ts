// src/app/api/rift/quote/route.ts
import { type NextRequest } from 'next/server';
import { RIFT_DESTINATION, RIFT_INTEGRATOR_ID } from '@/lib/rift/config';
import { AMOUNT_RE, SOURCE_ASSET_RE, badRequest, forward } from '@/lib/rift/server';

export const runtime = 'edge';

/** Price `from_amount` of `from` into iAERO on Base. The destination is fixed here, not by the browser. */
export async function POST(request: NextRequest) {
  let body: { from?: unknown; from_amount?: unknown };
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  const amount = typeof body.from_amount === 'string' ? body.from_amount.trim() : '';
  if (!SOURCE_ASSET_RE.test(from)) return badRequest('unsupported source asset');
  if (from.toLowerCase() === RIFT_DESTINATION) return badRequest('the source asset is already iAERO');
  if (!AMOUNT_RE.test(amount)) return badRequest('invalid amount');
  return forward('/quote', {
    method: 'POST',
    body: JSON.stringify({
      from, to: RIFT_DESTINATION, from_amount: amount, return_full_route: true,
      quote_mode: 'optimal', format: 'formatted', integrator_id: RIFT_INTEGRATOR_ID,
    }),
  });
}
