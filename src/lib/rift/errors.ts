// src/lib/rift/errors.ts
//
// What a failed Rift call means, so the page neither calls an outage "no route" nor caches it as one (on
// 2026-10-02 every quote failed for an hour with 422 "execution costs could not be priced" while /health said
// ok). Pure, with no imports, so `node --test` can run it (tests/rift/).

export class RiftApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'RiftApiError';
  }
}

export type RiftErrorKind =
  | 'no_route'      // Rift looked and found no route for this token and amount: an answer
  | 'unsupported'   // Rift does not know the asset: an answer
  | 'unavailable'   // Rift could not evaluate routes right now (pricing outage, timeouts): try later
  | 'rate_limited'  // too many requests from this browser
  | 'quote_used' | 'quote_expired' | 'sanctions' | 'screening' | 'network' | 'bad_request' | 'other';

export function classifyRiftError(e: unknown): RiftErrorKind {
  if (!(e instanceof RiftApiError)) return 'other';
  const m = e.message.toLowerCase();
  switch (e.status) {
    case 0: return 'network';
    case 429: return 'rate_limited';
    case 409: return 'quote_used';
    case 410: return 'quote_expired';
    case 403: return 'sanctions';
    case 503: return /screen/.test(m) ? 'screening' : 'unavailable';
    case 422:
      if (/no venue returned an executable quote|no route/.test(m)) return 'no_route';
      if (/not a valid asset|unknown asset|unsupported/.test(m)) return 'unsupported';
      return 'unavailable';
    case 400:
      if (/not a valid asset|unknown chain|unsupported/.test(m)) return 'unsupported';
      return 'bad_request';
  }
  if (e.status >= 500) return 'unavailable';
  return 'other';
}

/** Plain-language versions of the errors a user can act on. */
export function explainRiftError(e: unknown): string {
  if (!(e instanceof RiftApiError)) return e instanceof Error ? e.message : String(e);
  switch (classifyRiftError(e)) {
    case 'no_route': return 'No route found for this token and amount. Try a larger amount or a different token.';
    case 'unsupported': return 'Rift does not support this token.';
    case 'unavailable': return 'Rift can’t price routes right now (a problem on Rift’s side). Nothing was sent; try again in a few minutes.';
    case 'rate_limited': return 'Rift is limiting requests from this browser. Wait a minute and try again.';
    case 'quote_used': return 'This quote was already used. Get a fresh quote and try again.';
    case 'quote_expired': return 'The quote expired. A fresh one is being fetched.';
    case 'sanctions': return 'Rift declined this address after its sanctions screening.';
    case 'screening': return 'Rift’s address screening is briefly unavailable. Please try again in a minute.';
    case 'network': return 'Could not reach Rift. Check your connection and try again.';
    case 'bad_request': return `Rift rejected the request: ${e.message}`;
    default: return e.message;
  }
}
