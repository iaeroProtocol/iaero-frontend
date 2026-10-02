// src/app/api/rift/order/[id]/route.ts
import { type NextRequest } from 'next/server';
import { UUID_RE, badRequest, forward } from '@/lib/rift/server';

export const runtime = 'edge';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return badRequest('invalid order id');
  return forward(`/order/${id}`);
}
