// src/components/rift/RecentOrders.tsx
'use client';

import React from 'react';
import { History, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { badgeStyle } from './status';
import { phaseOf } from '@/lib/rift/timing';
import { SOURCE_CHAINS } from '@/lib/rift/config';
import { clearable, isFinalStatus, isTerminalStatus, needsAttention, phaseInput, shownOutOfDate } from '@/lib/rift/order-state';
import type { StoredOrder } from '@/lib/rift/types';

const ago = (ts: number) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
};
const fmt = (v?: string | null) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';
};

interface Props {
  orders: StoredOrder[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClearFinished: () => void;
}

export default function RecentOrders({ orders, activeId, onSelect, onClearFinished }: Props) {
  if (!orders.length) return null;
  const now = Date.now();
  const finished = orders.filter(o => clearable(o, now)).length;
  return (
    <Card className="border-slate-700/50 bg-slate-800/50 backdrop-blur-xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base text-white">
          <span className="flex items-center gap-2"><History className="h-4 w-4" /> Your orders</span>
          {finished > 0 && (
            <button type="button" onClick={onClearFinished} className="flex items-center gap-1 text-xs font-normal text-slate-400 hover:text-white">
              <Trash2 className="h-3.5 w-3.5" /> Clear finished
            </button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {orders.map(o => {
          const phase = phaseOf(phaseInput(o, SOURCE_CHAINS[o.sourceChain].kind));
          const stale = shownOutOfDate(o, now);
          const style = badgeStyle(phase, stale, !!o.btc?.missing);
          const outcome = o.status === 'delivered' ? `${fmt(o.amountOut)} iAERO`
            : o.status === 'refunded' ? `refunded ${o.amountOut ? `${fmt(o.amountOut)} ` : ''}${o.token.symbol}`
            : isTerminalStatus(o.status) || stale ? '—'
            : `~${fmt(o.expectedOut ?? o.estimatedOut)} iAERO`;
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={o.id === activeId}
              onClick={() => onSelect(o.id)}
              className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                o.id === activeId ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-slate-700/40 bg-slate-900/40 hover:border-slate-500/60'
              }`}
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-white">
                  {fmt(o.fromAmount)} {o.token.symbol} ({SOURCE_CHAINS[o.sourceChain].name}) → {outcome}
                </div>
                <div className="text-xs text-slate-400">{ago(o.createdAt)}</div>
              </div>
              <Badge className={`shrink-0 ${style.className}`}>{style.label}</Badge>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
