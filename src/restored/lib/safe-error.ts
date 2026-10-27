// src/lib/safe-error.ts
//
// An error as one line that is safe to log or return: viem errors repeat the request URL ("URL: https://…"),
// and an RPC URL can carry an API key in its path. URLs are cut out, and only the first line is kept.
// Pure, with no imports, so `node --test` can run it (tests/rift/).

export function safeErrorText(e: unknown): string {
  const x = (e && typeof e === 'object' ? e : {}) as { name?: unknown; shortMessage?: unknown; message?: unknown };
  const raw = typeof x.shortMessage === 'string' ? x.shortMessage : typeof x.message === 'string' ? x.message : String(e);
  const line = raw.split('\n')[0].replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[url]').slice(0, 300);
  return typeof x.name === 'string' && x.name && x.name !== 'Error' ? `${x.name}: ${line}` : line;
}
