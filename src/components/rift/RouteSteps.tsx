// src/components/rift/RouteSteps.tsx
//
// The route as a vertical list of steps, each with its usual duration. With `progress`, each step also
// shows done / in progress / waiting, and the step in progress shows its own timer.

'use client';

import React from 'react';
import { CheckCircle2, Circle, Loader2, AlertTriangle, ExternalLink } from 'lucide-react';
import { formatRange, type Progress, type RouteEstimate } from '@/lib/rift/timing';

export interface StepLink { href: string; text: string }

interface Props {
  estimate: RouteEstimate;
  progress?: Progress;
  links?: Partial<Record<string, StepLink>>;
  extras?: Partial<Record<string, React.ReactNode>>;
}

export default function RouteSteps({ estimate, progress, links = {}, extras = {} }: Props) {
  const moving = progress && !['delivered', 'refunded', 'expired', 'frozen', 'underfunded', 'pay'].includes(progress.phase);
  return (
    <ol className="space-y-3">
      {estimate.steps.map((step, i) => {
        // Underpaid: the deposit arrived, but short, so it is not "done".
        const warn = progress?.phase === 'underfunded' && i === 0;
        const done = progress ? i < progress.activeIndex && !warn : false;
        const active = progress ? i === progress.activeIndex && moving : false;
        // Rift reports "executing" without saying which hop is running, so hops in progress are marked estimated.
        const estimated = active && progress?.phase === 'executing' && step.kind !== 'deposit';
        const link = links[step.key];
        return (
          <li key={step.key} className="flex items-start gap-3">
            <div className="mt-0.5 shrink-0">
              {!progress ? (
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-600 text-[11px] text-slate-400">{i + 1}</span>
              ) : warn ? (
                <AlertTriangle className="h-5 w-5 text-red-400" />
              ) : done ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              ) : active ? (
                progress?.slow ? <AlertTriangle className="h-5 w-5 text-amber-400" /> : <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
              ) : (
                <Circle className="h-5 w-5 text-slate-600" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className={`text-sm ${done ? 'text-slate-300' : active ? 'font-medium text-white' : 'text-slate-400'}`}>
                  {step.label}
                  {estimated && <span className="ml-2 rounded bg-slate-700/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">estimated</span>}
                </span>
                <span className="text-xs text-slate-500">usually {formatRange(step.typicalSec, step.slowSec)}</span>
              </div>
              {step.detail && <div className="text-xs text-slate-500">{step.detail}</div>}
              {extras[step.key] && <div className="mt-1 text-xs text-slate-300">{extras[step.key]}</div>}
              {link && (
                <a href={link.href} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300" aria-label={`${link.text} (opens in a new tab)`}>
                  {link.text} <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
