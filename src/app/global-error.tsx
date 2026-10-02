// src/app/global-error.tsx
//
// An error in the root layout itself (the wallet providers, the header) that app/error.tsx can't catch: this
// replaces the whole document, so it brings its own <html>/<body> and inline styles rather than relying on the
// layout's stylesheet.

'use client';

import React, { useEffect } from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  const button: React.CSSProperties = { borderRadius: 8, padding: '8px 16px', fontSize: 14, cursor: 'pointer' };
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', background: '#0f172a', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: 480, margin: '96px auto 0', padding: 32, textAlign: 'center', border: '1px solid #334155', borderRadius: 16, background: '#1e293b' }}>
          <h2 style={{ margin: 0, fontSize: 20, color: '#fff' }}>Something went wrong</h2>
          <p style={{ margin: '12px 0 20px', fontSize: 14, color: '#94a3b8' }}>Your funds and orders are not affected. Try again, or reload the page.</p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
            <button type="button" onClick={reset} style={{ ...button, border: 0, background: '#4f46e5', color: '#fff' }}>Try again</button>
            <button type="button" onClick={() => window.location.reload()} style={{ ...button, border: '1px solid #475569', background: 'transparent', color: '#e2e8f0' }}>Reload</button>
          </div>
        </div>
      </body>
    </html>
  );
}
