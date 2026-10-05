// src/lib/rift/rate-limit.ts
//
// Per-instance request limits for /api/rift/holdings. IPv6 callers are counted per /64 (a subscriber usually
// holds a whole /64, so a per-address key is dodged by rotating addresses), IPv4 callers per address. The
// tables are bounded: past their size the least recently seen keys go first, never every caller at once.
// Pure, with no imports, so `node --test` can run it (tests/rift/).

/** The key a caller is counted under: an IPv6 address's /64 prefix, anything else as given. */
export function rateKey(ip: string): string {
  const s = ip.trim().toLowerCase().replace(/%.*$/, '');
  if (!s.includes(':')) return s;
  // An IPv4 address mapped into IPv6 (::ffff:203.0.113.5) is that IPv4 caller.
  const mapped = /^(?:0{1,4}:){0,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s.replace(/^::/, '0:'));
  if (mapped) return mapped[1];
  const halves = s.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return s;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...tail];
  if (!groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** Set `key` as the most recently seen entry, dropping the least recently seen ones past `max`. */
export function touch<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  for (const k of map.keys()) {
    if (map.size <= max) break;
    map.delete(k);
  }
}

/** At most `perWindow` requests per key in any `windowMs`; every request counts, refused ones included. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly perWindow: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(perWindow: number, windowMs = 60_000, maxKeys = 5_000) {
    this.perWindow = perWindow;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** Count a request from `key`; true when it is over the limit. */
  over(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    recent.push(now);
    touch(this.hits, key, recent, this.maxKeys);
    return recent.length > this.perWindow;
  }

  get size() { return this.hits.size; }
}
