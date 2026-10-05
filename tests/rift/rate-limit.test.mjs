// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, rateKey, touch } from '../../src/lib/rift/rate-limit.ts';

test('IPv6 callers count per /64; IPv4 callers per address', () => {
  const k = '2001:db8:1:2::/64';
  assert.equal(rateKey('2001:db8:1:2:3:4:5:6'), k);
  assert.equal(rateKey('2001:db8:1:2::9'), k, 'any address in the /64');
  assert.equal(rateKey('2001:0DB8:0001:0002:ffff::1'), k, 'leading zeros and case');
  assert.equal(rateKey(' 2001:db8:1:2::1%eth0 '), k, 'a zone index');
  assert.equal(rateKey('2001:db8::'), '2001:db8:0:0::/64');
  assert.equal(rateKey('::1'), '0:0:0:0::/64');
  assert.notEqual(rateKey('2001:db8:1:3::1'), k, 'the next /64 is someone else');
  assert.equal(rateKey('::ffff:203.0.113.5'), '203.0.113.5', 'an IPv4-mapped address is that IPv4 caller');
  assert.equal(rateKey('203.0.113.5'), '203.0.113.5');
  assert.equal(rateKey('unknown'), 'unknown');
  assert.equal(rateKey('1:2:3:4:5:6:7:8:9'), '1:2:3:4:5:6:7:8:9', 'malformed: as given');
  assert.equal(rateKey('zz::1'), 'zz::1');
  assert.equal(rateKey('1::2::3'), '1::2::3');
});

test('the limit counts every request in the last minute', () => {
  const l = new RateLimiter(3, 60_000, 100);
  const t = 1_000_000;
  assert.deepEqual([1, 2, 3, 4].map(i => l.over('a', t + i)), [false, false, false, true]);
  assert.equal(l.over('b', t + 5), false, 'others are unaffected');
  assert.equal(l.over('a', t + 200_000), false, 'a quiet minute clears it');
  const one = new RateLimiter(1, 60_000, 100);
  one.over('c', t);
  assert.equal(one.over('c', t + 30_000), true);
  assert.equal(one.over('c', t + 60_001), true, 'a refused request still counts, so hammering stays refused');
});

test('a full table drops its least recently seen callers, never everyone', () => {
  const l = new RateLimiter(2, 60_000, 3);
  const t = 2_000_000;
  l.over('a', t); l.over('a', t + 1); // a is at its limit
  l.over('b', t + 2); l.over('c', t + 3);
  l.over('a', t + 4); // over, and now the most recently seen
  l.over('d', t + 5); // evicts b, the least recently seen
  assert.equal(l.size, 3);
  assert.equal(l.over('a', t + 6), true, 'a busy caller keeps its count when the table fills');

  const m = new Map([['x', 1], ['y', 2]]);
  touch(m, 'x', 3, 2);
  touch(m, 'z', 4, 2);
  assert.deepEqual([...m.entries()], [['x', 3], ['z', 4]]);
});
