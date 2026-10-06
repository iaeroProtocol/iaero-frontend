// Run: npm run test:rift
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../src/lib/rift/support.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports,
  require: n => ({
    react: { useEffect() {}, useRef() {}, useState() {} },
    './client': {}, './config': { CURATED_TOKENS: [], RIFT_DESTINATION: 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc' },
    './rift-tokens': { RIFT_LISTED: [] }, './holdings': { probeAmount: () => '1', PROBE_USD: 100 },
    './quote-check': {}, './validate': {},
  })[n] ?? (() => { throw new Error(`unexpected import ${n}`); })(),
});
const { knownSupport } = exports;

const ASSET = 'arbitrum.0x1111111111111111111111111111111111111111';
const holding = { chain: 'arbitrum', asset: ASSET, valueUsd: 10 };
const entry = over => ({ [ASSET]: { ok: false, at: Date.now(), ttl: 30 * 60_000, usd: 10, ...over } });

test('round 7: a cached route check stamped in the future (the clock ran ahead) is not trusted', () => {
  const now = Date.now();
  assert.equal(knownSupport(holding, entry({ at: now - 10 * 60_000 }), now), 'unsupported', 'no route, 10 minutes ago');
  assert.equal(knownSupport(holding, entry({ at: now - 40 * 60_000 }), now), undefined, 'expired: asked again');
  assert.equal(knownSupport(holding, entry({ at: now + 864e5 }), now), undefined, 'a day ahead: asked again, not hidden for a day');
  assert.equal(knownSupport(holding, entry({ ok: true, ttl: 864e5, at: now + 3600_000 }), now), undefined);
});
