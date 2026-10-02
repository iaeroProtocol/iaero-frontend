// src/lib/rift/server.ts
//
// Helpers for this feature's server routes (edge runtime). Quotes and orders go from the browser to Rift
// directly (client.ts); the server only assembles wallet holdings (/api/rift/holdings).

import { NextResponse } from 'next/server';

export { EVM_ADDRESS_RE } from './validate';

export const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });
