// src/app/api/rift/health/route.ts
import { NextResponse } from 'next/server';
import { RIFT_API } from '@/lib/rift/server';

export const runtime = 'edge';

export async function GET() {
  try {
    const res = await fetch(`${RIFT_API}/health`, { cache: 'no-store' });
    return NextResponse.json({ ok: res.ok }, { status: res.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not reach Rift' }, { status: 503 });
  }
}
