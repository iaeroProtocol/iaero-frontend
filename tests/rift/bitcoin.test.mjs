// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { btcToSats, findBtcDeposits, isBtcAddress, normalizeBtcAddress } from '../../src/lib/rift/bitcoin.ts';

test('Bitcoin addresses are checked with their checksums', () => {
  // BIP-173 / BIP-350 / BIP-86 / Bitcoin wiki examples.
  for (const a of [
    '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
    '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ',
    'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
    'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
  ]) assert.equal(isBtcAddress(a), true, a);
  for (const a of [
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr', // one character off
    '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3',         // one character off
    '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLz',
    'bc1qqqqqqqq',
    'Bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', // mixed case
    'bc1par0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', // v1 with a bech32 (not bech32m) checksum
    // Valid encodings (BIP-350 vectors) that anyone can spend today: a refund sent there could be taken.
    'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', // v1 with a 40-byte program
    'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', // v2
    'BC1SW50QGDZ25J', // v16
    'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', // testnet
    '0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc',
  ]) assert.equal(isBtcAddress(a), false, a);
  assert.equal(normalizeBtcAddress(' BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ '), 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
  assert.equal(btcToSats('0.00012345'), 12345n);
  assert.equal(btcToSats('1.5'), 150000000n);
});

test('a confirmed payment counts at least one confirmation, and a capitalised bech32 address is matched', async () => {
  // Round 2, Low: with the tip height refused (a 429), a confirmed payment read as 0 confirmations and could then
  // be marked missing. Suspected: Rift writing a deposit address in capitals would never be matched.
  const address = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async url => {
    asked.push(String(url));
    if (String(url).endsWith('/blocks/tip/height')) return { ok: false, status: 429, text: async () => '' };
    return { ok: true, status: 200, json: async () => [{ txid: 'ab'.repeat(32), status: { confirmed: true, block_height: 900000 }, vout: [{ scriptpubkey_address: address, value: 100000 }] }] };
  };
  try {
    const d = await findBtcDeposits(address.toUpperCase());
    assert.equal(d.payments.length, 1, 'matched');
    assert.equal(d.payments[0].confirmations, 1);
    assert.ok(asked[0].includes(`/address/${address}/txs`), 'asked in lower case');
  } finally {
    globalThis.fetch = real;
  }
});
