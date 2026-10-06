// src/app/error.tsx
//
// Last line of defence: an error while rendering the page shows this instead of a blank "Application error",
// with a way back that keeps the wallet connection.

'use client';

import React, { useEffect } from 'react';

export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <div className="mx-auto mt-24 max-w-lg space-y-4 rounded-2xl border border-slate-700/50 bg-slate-800/60 p-8 text-center text-slate-200">
      <h2 className="text-xl font-semibold text-white">Something went wrong on this page</h2>
      <p className="text-sm text-slate-400">Your funds and orders are not affected. Try again, or reload the page.</p>
      <div className="flex justify-center gap-3">
        <button type="button" onClick={reset} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Try again</button>
        <button type="button" onClick={() => window.location.reload()} className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-slate-400">Reload</button>
      </div>
    </div>
  );
}
